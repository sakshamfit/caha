/* ============================================================
   Caha — headless engine harness
   Runs the v1 and v2 scroll engines inside a virtual browser with:
     • a virtual 60 Hz clock driving one rAF callback per frame
     • REAL asset bytes read from disk (network model: latency + bandwidth)
     • modelled main-thread cost for full-screen blits (per megapixel,
       from the ACTUAL canvas backing size each engine chooses)
     • instrumented scrollHeight / scrollTo / style writes
     • an identical synthetic scroll trace (wheel bursts, flings,
       idle gaps that trigger autoplay, an end-of-reel stop)

   It exists because this sandbox has no browser; it measures the
   things that actually cause jank (layout thrash, blit fill-rate,
   decode scheduling, memory, payload) on both engines, fairly.

     node tools/simulate.mjs --engine v1 --net local
     node tools/simulate.mjs --engine v2 --net 4g --device mobile
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { URL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const ENGINE = opt('engine', 'v2');
const NET = opt('net', 'local');            // local | 4g
const DEVICE = opt('device', 'desktop');    // desktop | mobile
const SECONDS = +opt('seconds', 60);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const FRAMES = process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames');
const WEB = process.env.CAHA_WEB_DIR || path.join(ROOT, 'assets/web');
const useWeb = ENGINE === 'v2' && fs.existsSync(path.join(WEB, 'manifest.json')) && opt('set', 'web') === 'web';
const SET_DIR = useWeb ? WEB : FRAMES;

const DEV = DEVICE === 'mobile'
  ? { w: 390, h: 844, dpr: 2, blitMsPerMP: 2.2, decodeMs: 14, cores: 4 }
  : { w: 1440, h: 900, dpr: 2, blitMsPerMP: 0.8, decodeMs: 6, cores: 8 };
const NETCFG = NET === '4g'
  ? { latency: 60, mbps: 1.5 }
  : { latency: 1, mbps: 800 };

let lastDrawnUrl = null;

/* ---------------- counters ---------------- */
const C = {
  layoutReads: 0, scrollWrites: 0, layoutStyleWrites: 0, transformWrites: 0,
  blits: 0, drawnFrames: 0, staleFrames: 0, rafCallbacks: 0,
  cpuMs: 0, blitMs: 0, overBudget: 0, peakBitmapMB: 0,
  netBytes: 0, netRequests: 0, decodeMs: 0,
};

/* ---------------- virtual time & scheduling ---------------- */
let now = 0;
let timers = [];       // {at, fn}
let rafQ = [];         // callbacks to run next frame
const FRAME = 1000 / 60;

function setTimeoutV(fn, ms) { const t = { at: now + (ms || 0), fn }; timers.push(t); return t; }
function clearTimeoutV(t) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
function requestAnimationFrameV(fn) { rafQ.push(fn); return rafQ.length; }

/* ---------------- fake DOM ---------------- */
function makeStyle(countLayout) {
  return new Proxy({}, {
    set(t, k, v) {
      if (k === 'width' || k === 'height') C.layoutStyleWrites++;
      if (k === 'transform') C.transformWrites++;
      t[k] = v;
      if (k === 'height' && typeof t.__onHeight === 'function') t.__onHeight(v);
      return true;
    },
    get(t, k) { return t[k]; },
  });
}

function makeCtx(canvasEl) {
  return {
    globalAlpha: 1,
    fillStyle: '#000',
    imageSmoothingQuality: 'low',
    fillRect() { C.blits += 0; },
    drawImage(img) {
      C.blits++;
      if (img && img.__url) lastDrawnUrl = img.__url;
      const w = canvasEl.width, h = canvasEl.height;
      const cost = (w * h / 1e6) * DEV.blitMsPerMP;
      C.blitMs += cost;
      if (img.__firstUse) { img.__firstUse = false; C.cpuMs += ENGINE === 'v1' ? 1.2 : 0; }
    },
  };
}

const elements = {};
function makeEl(id) {
  const el = {
    id,
    style: makeStyle(),
    classList: { add() {}, remove() {}, contains: () => false },
    remove() {},
    textContent: '',
    width: 0, height: 0,
    _listeners: {},
    addEventListener(t, f) { (this._listeners[t] ||= []).push(f); },
    getContext() { return (this._ctx ||= makeCtx(this)); },
  };
  return el;
}

/* scroll model */
let scrollY = 0;
let spacerH = 0;
const listeners = { scroll: [], resize: [] };
const documentElement = {
  get scrollHeight() { C.layoutReads++; return spacerH + DEV.h; },
  clientHeight: DEV.h,
};
const spacerEl = makeEl('spacer');
spacerEl.style.__onHeight = (v) => {
  const m = /([\d.]+)vh/.exec(v);
  if (m) spacerH = parseFloat(m[1]) / 100 * DEV.h;
};

const canvasEl = makeEl('frame');

elements.spacer = spacerEl;
elements.frame = canvasEl;
for (const id of ['loader', 'loader-fill', 'loader-pct', 'progress-fill', 'progress-label', 'scene-index', 'scene-title', 'hint']) elements[id] = makeEl(id);

/* network + decode model over real files */
const fileCache = new Map();
function resolveFrame(urlPath) {
  let rel = urlPath.replace(/^\//, '');
  let base = ROOT;
  if (rel.startsWith('assets/web/')) { rel = rel.slice('assets/web/'.length); base = WEB; }
  else if (rel.startsWith('assets/frames/')) { rel = rel.slice('assets/frames/'.length); base = FRAMES; }
  const p = path.join(base, rel);
  if (fileCache.has(p)) return fileCache.get(p);
  let entry = null;
  if (fs.existsSync(p)) entry = { bytes: fs.statSync(p).size, path: p };
  fileCache.set(p, entry);
  return entry;
}
function deliverMs(bytes) { return NETCFG.latency + (bytes * 8) / (NETCFG.mbps * 1e6) * 1000; }

/* decoded bitmap accounting */
let bitmapBytes = 0;
const bitmaps = new Set();
const birthOrder = [];
function trackBitmap(w, h) {
  bitmapBytes += w * h * 4;
  if (ENGINE === 'v1') {           // v1's cache is count-capped at 100
    birthOrder.push(null);
    while (bitmaps.size > 100) { const old = birthOrder.shift(); if (old && bitmaps.has(old)) old.close(); }
  }
  C.peakBitmapMB = Math.max(C.peakBitmapMB, bitmapBytes / 1048576);
  const b = { w, h, close() { if (bitmaps.delete(b)) bitmapBytes -= w * h * 4; } };
  bitmaps.add(b);
  if (ENGINE === 'v1') birthOrder[birthOrder.length - 1] = b;
  return b;
}

async function fetchV(url, opts) {
  const urlPath = String(url).split('?')[0];
  const isManifest = urlPath.endsWith('manifest.json');
  if (isManifest) {
    if (opt('set', 'web') === 'source' && urlPath.includes('/assets/web/')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const e = resolveFrame(urlPath);
    const p = e ? e.path : null;
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    const txt = fs.readFileSync(p, 'utf8');
    C.netBytes += txt.length; C.netRequests++;
    return { ok: true, status: 200, json: async () => JSON.parse(txt) };
  }
  const entry = resolveFrame(urlPath);
  if (!entry) return { ok: false, status: 404, json: async () => ({}) };
  C.netBytes += entry.bytes; C.netRequests++;
  const ms = deliverMs(entry.bytes);
  await new Promise((r) => setTimeoutV(r, ms));
  // dims: read cheaply from a sidecar table built at first touch
  const dims = dimsOf(entry.path);
  return {
    ok: true, status: 200,
    blob: async () => ({ size: entry.bytes, __path: entry.path, __dims: dims }),
  };
}

const dimsCache = new Map();
function dimsOf(p) {
  if (dimsCache.has(p)) return dimsCache.get(p);
  // parse JPEG/WebP header minimally
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(64);
  fs.readSync(fd, head, 0, 64, 0);
  let dims = [1920, 1080];
  if (head[0] === 0xff && head[1] === 0xd8) {
    const buf = fs.readFileSync(p);
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        dims = [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        break;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } else if (head[0] === 0x52 && head[8] === 0x57) { // RIFF....WEBP
    const buf = fs.readFileSync(p);
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38) {
      const variant = buf[15];
      if (variant === 0x20) dims = [buf.readUInt16LE(26) + 1, buf.readUInt16LE(28) + 1];
      else if (variant === 0x4c) dims = [(buf[24] | buf[25] << 8 | buf[26] << 16) + 1, (buf[27] | buf[28] << 8 | buf[29] << 16) + 1];
      else dims = [buf.readUInt16LE(24) + 1, buf.readUInt16LE(26) + 1];
    }
  }
  fs.closeSync(fd);
  dimsCache.set(p, dims);
  return dims;
}

/* Image stub (v1 path): network + on-main-thread-ish decode completion */
class ImageV {
  constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.decoding = 'sync'; }
  set src(url) {
    this.__url = url;
    const entry = resolveFrame(String(url).split('?')[0].replace(/^\//, ''));
    if (!entry) { setTimeoutV(() => this.onerror && this.onerror(), 5); return; }
    C.netBytes += entry.bytes; C.netRequests++;
    const ms = deliverMs(entry.bytes) + DEV.decodeMs;
    C.decodeMs += DEV.decodeMs;
    setTimeoutV(() => {
      const [w, h] = dimsOf(entry.path);
      this.naturalWidth = w; this.naturalHeight = h;
      this.complete = true;
      this.width = w; this.height = h;
      this.__firstUse = true;
      this.__url = url;
      this.__bmp = trackBitmap(w, h);          // v1 never closes these
      this.onload && this.onload();
    }, ms);
  }
  get src() { return this._src; }
  async decode() { return; }
}

async function createImageBitmapV(blob) {
  const ms = DEV.decodeMs * 0.9;   // off main thread in reality
  C.decodeMs += ms;
  await new Promise((r) => setTimeoutV(r, ms));
  const [w, h] = blob.__dims;
  const b = trackBitmap(w, h);
  return { width: w, height: h, close: b.close, __firstUse: false, __url: blob.__path };
}

/* ---------------- window ---------------- */
const perfStart = Date.now();
const windowObj = {
  innerWidth: DEV.w,
  innerHeight: DEV.h,
  devicePixelRatio: DEV.dpr,
  scrollY: 0,
  matchMedia: (q) => ({ matches: DEVICE === 'mobile' && q.includes('coarse'), addEventListener() {} }),
  addEventListener(t, f) { (listeners[t] ||= []).push(f); },
  scrollTo(x, y) {
    C.scrollWrites++;
    const v = typeof x === 'object' ? x.top : y;
    scrollY = Math.max(0, Math.min(spacerH, v));
    windowObj.scrollY = scrollY;
    for (const f of listeners.scroll || []) f();
  },
  requestAnimationFrame: requestAnimationFrameV,
  fetch: fetchV,
  Image: ImageV,
  createImageBitmap: createImageBitmapV,
  setTimeout: setTimeoutV,
  clearTimeout: clearTimeoutV,
  performance: { now: () => now },
  navigator: { hardwareConcurrency: DEV.cores, deviceMemory: DEVICE === 'mobile' ? 4 : 16, connection: null },
  location: { search: '?autoplay=1' },
  URLSearchParams,
  sessionStorage: { getItem: () => null, setItem() {} },
  document: null,
};
Object.defineProperty(windowObj, 'scrollY', { get: () => scrollY, set: (v) => { scrollY = v; } });

const documentObj = {
  getElementById: (id) => elements[id] || (elements[id] = makeEl(id)),
  documentElement,
  body: makeEl('body'),
  hidden: false,
  fonts: { ready: Promise.resolve() },
  addEventListener() {},
  querySelectorAll: () => [],
};
windowObj.document = documentObj;

/* ---------------- scroll trace ---------------- */
let trace = [];
(function buildTrace() {
  let t = 1000;
  const push = (at, dy) => trace.push({ at, dy });
  const burst = (start, notches, gap = 90) => {
    for (let i = 0; i < notches; i++) push(start + i * gap, 100 + Math.round(Math.random() * 60));
    return start + notches * gap;
  };
  let cursor = burst(t, 5);            // opening scroll
  cursor = burst(cursor + 900, 8);     // steady reading
  cursor += 6000;                      // IDLE → autoplay window #1
  cursor = burst(cursor + 200, 3);     // user grabs back control
  cursor += 500;
  // fling: many small fast deltas
  for (let i = 0; i < 40; i++) push(cursor + i * 16, 45);
  cursor += 40 * 16 + 1200;
  cursor = burst(cursor, 12, 70);      // fast scrub through scenes
  cursor += 6000;                      // IDLE → autoplay window #2
  cursor = burst(cursor, 6);
  push(cursor + 400, 1e9);             // jump to end (End key)
  cursor += 3000;
  push(cursor, -1e9);                  // back to top (Home key)
  trace.sort((a, b) => a.at - b.at);
})();
let traceIdx = 0;

/* ---------------- run ---------------- */
const chosenManifest = (() => {
  const tryPaths = ENGINE === 'v2'
    ? [path.join(WEB, 'manifest.json'), path.join(FRAMES, '..', 'manifest.json')]
    : [path.join(FRAMES, '..', 'manifest.json')];
  for (const p of tryPaths) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return null;
})();
const OFFSETS = (() => {
  let acc = 0;
  return (chosenManifest?.scenes || []).map((s) => { const o = acc; acc += s.frames; return o; });
})();
const TOTAL = (chosenManifest?.scenes || []).reduce((a, s) => a + s.frames, 0) || 4200;
function globalOfUrl(u) {
  if (!u) return -1;
  const m = /scene-(\d+)\/[^/]+?(\d+)\.(jpg|webp|avif)$/.exec(u);
  if (!m) return -1;
  const si = +m[1] - 1;
  const n = +m[2];
  return (OFFSETS[si] ?? 0) + (n - 1);
}

const src = fs.readFileSync(ENGINE === 'v1' ? path.join(ROOT, 'tools/fixtures/app.v1.js') : path.join(ROOT, 'app.js'), 'utf8');
const context = vm.createContext({
  window: windowObj,
  document: documentObj,
  performance: windowObj.performance,
  requestAnimationFrame: requestAnimationFrameV,
  fetch: fetchV,
  Image: ImageV,
  createImageBitmap: createImageBitmapV,
  setTimeout: setTimeoutV,
  clearTimeout: clearTimeoutV,
  navigator: windowObj.navigator,
  location: windowObj.location,
  matchMedia: windowObj.matchMedia,
  URLSearchParams,
  console,
  Math, JSON, Promise, Map, Set, WeakSet, Error, String, Number, Object, Array, Boolean, Date,
  parseInt, parseFloat, isNaN, Infinity, NaN,
});
vm.runInContext(src, context, { filename: `app.${ENGINE}.js` });

const END = SECONDS * 1000;
let prevScrollY = 0;
let lagLastUrl = null, lagDisplayed = -1;
const lagSeries = [];
const lagDebug = {};

async function main() {
while (now < END) {
  now += FRAME;
  // timers
  const due = timers.filter((t) => t.at <= now);
  if (due.length) { timers = timers.filter((t) => t.at > now); for (const t of due.sort((a, b) => a.at - b.at)) t.fn(); }
  // input events
  while (traceIdx < trace.length && trace[traceIdx].at <= now) {
    const ev = trace[traceIdx++];
    const dy = Math.abs(ev.dy) > 1e8 ? (ev.dy > 0 ? spacerH : -spacerH) : ev.dy;
    scrollY = Math.max(0, Math.min(spacerH, scrollY + dy));
    windowObj.scrollY = scrollY;
    for (const f of listeners.scroll || []) f();
    for (const f of listeners.wheel || []) f();
  }
  // rAF callbacks (one frame's worth)
  const q = rafQ; rafQ = [];
  const blitsBefore = C.blits;
  const t0 = process.hrtime.bigint();
  for (const cb of q) { C.rafCallbacks++; cb(now); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  C.cpuMs += ms;
  if (scrollY !== prevScrollY && C.blits === blitsBefore) C.staleFrames++;
  prevScrollY = scrollY;
  // visible lag: how far the frame on screen is from the scroll target
  if (lastDrawnUrl !== lagLastUrl) {
    lagLastUrl = lastDrawnUrl;
    lagDisplayed = globalOfUrl(lastDrawnUrl);
  }
  if (lagDisplayed >= 0 && spacerH > 0) {
    const target = (scrollY / spacerH) * (TOTAL - 1);
    const lag = Math.abs(target - lagDisplayed);
    lagSeries.push(lag);
    if (process.env.LAG_DEBUG && lag > 12) {
      const bucket = Math.floor(now / 5000);
      (lagDebug[bucket] ||= { n: 0, max: 0, sample: null });
      lagDebug[bucket].n++;
      if (lag > lagDebug[bucket].max) { lagDebug[bucket].max = +lag.toFixed(0); lagDebug[bucket].sample = { t: +now.toFixed(0), target: +target.toFixed(0), disp: lagDisplayed, scrollY: +scrollY.toFixed(0) }; }
    }
  }
  await new Promise((r) => setImmediate(r));   // drain microtasks (promise chains)
}
}

await main();

if (process.env.LAG_DEBUG) console.error('LAGDEBUG ' + JSON.stringify(lagDebug));
const stats = windowObj.__caha ? windowObj.__caha.stats : null;
const drawn = stats ? stats.frames.drawn : C.blits;
const result = {
  engine: ENGINE, device: DEVICE, net: NET, set: useWeb ? 'web' : 'source',
  seconds: SECONDS,
  counters: C,
  engineStats: stats || null,
  derived: {
    layoutReadsPerRaf: +(C.layoutReads / Math.max(1, C.rafCallbacks)).toFixed(3),
    blitsPerDrawnFrame: +(C.blits / Math.max(1, drawn)).toFixed(2),
    mainThreadMsPerSec: +((C.cpuMs + C.blitMs) / SECONDS).toFixed(1),
    blitMsTotal: +C.blitMs.toFixed(0),
    jsMsTotal: +C.cpuMs.toFixed(0),
    peakBitmapMB: +C.peakBitmapMB.toFixed(0),
    payloadMB: +(C.netBytes / 1048576).toFixed(1),
    requests: C.netRequests,
    styleLayoutWrites: C.layoutStyleWrites,
    lagFrames: (() => {
      if (!lagSeries.length) return null;
      const s2 = [...lagSeries].sort((a, b) => a - b);
      return {
        mean: +(s2.reduce((a, b) => a + b, 0) / s2.length).toFixed(1),
        p95: +s2[Math.floor(s2.length * 0.95)].toFixed(1),
        pctOver12: +(100 * s2.filter((v) => v > 12).length / s2.length).toFixed(1),
      };
    })(),
    transformWrites: C.transformWrites,
    scrollWrites: C.scrollWrites,
  },
};
console.log(JSON.stringify(result, null, 1));
