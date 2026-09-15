/* ============================================================
   Caha — REAL-BROWSER scroll audit & regression runner

   The headless engine harness (tools/simulate.mjs) models the browser;
   this one *is* the browser. It drives a real Chromium through CDP:

     • real wheel notches / touch flings / End-Home keys (compositor input)
     • Blink's own counters: LayoutCount, RecalcStyleCount, TaskDuration,
       ScriptDuration, LayoutDuration  → forced-layout ground truth
     • live rAF-loop census + non-passive listener census
     • per-frame trace of {scroll, damped playhead, displayed frame} →
       the same "frames of lag behind the scroll" metric the audit used
     • pixel check: the canvas is compared against the frame files for
       the current scroll position (±2 frames) to prove the scrub shows
       the right frame and never holds a stale one
     • CPU throttling (Emulation.setCPUThrottlingRate) for mid-range
       mobile, and viewport-height changes mid-scroll to emulate a
       mobile URL bar collapsing

   Usage:
     node tools/browser-audit.mjs                        # v2, all scenarios
     node tools/browser-audit.mjs --engine v1            # old engine, for A/B
     node tools/browser-audit.mjs --only desktop/wheel
     node tools/browser-audit.mjs --label before-fix

   Env: CAHA_CHROME=<path to a chrome/chromium binary> to use a system
   browser instead of the bundled headless shell.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startServer, DEFAULT_TIERS } from './serve.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes('--' + n);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = opt('engine', 'v2');
const BASELINE_REF = opt('baseline-ref', 'origin/arena/01a09a57-caha');
const LABEL = opt('label', ENGINE === 'v1' ? 'v1' : 'v2');
const ONLY = opt('only', '');
const OUT_DIR = path.resolve(opt('out-dir', path.join(ROOT, 'reports')));
const SHOTS = !flag('no-shots');
const KEEP = !flag('no-cache');   // browser cache on = realistic re-scrub behaviour
const EXTRA = opt('extra', '');   // extra query string, e.g. --extra 'damping=flat'

/* ------------------------------------------------------------------ *
 * browser
 * ------------------------------------------------------------------ */
async function launch() {
  const puppeteer = (await import('puppeteer-core')).default;
  let executablePath = process.env.CAHA_CHROME || '';
  let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio'];
  let env = process.env;
  if (!executablePath) {
    const chromium = (await import('@sparticuz/chromium')).default;
    executablePath = await chromium.executablePath();
    args = [...chromium.args, '--disable-dev-shm-usage', '--hide-scrollbars'];
    // @sparticuz/chromium ships the Amazon Linux 2023 libs separately; the
    // sandbox has no apt, so decompress them next to the binary ourselves.
    const libDir = path.join(os.tmpdir(), 'al2023', 'lib');
    const libBr = path.join(ROOT, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br');
    if (!fs.existsSync(libDir) && fs.existsSync(libBr)) {
      const zlib = await import('node:zlib');
      const tarFile = path.join(os.tmpdir(), 'al2023', 'al2023.tar');
      fs.mkdirSync(path.dirname(tarFile), { recursive: true });
      fs.writeFileSync(tarFile, zlib.brotliDecompressSync(fs.readFileSync(libBr)));
      const { execFileSync } = await import('node:child_process');
      execFileSync('tar', ['-xf', tarFile, '-C', path.dirname(tarFile)]);
    }
    env = { ...process.env, LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  }
  return puppeteer.launch({ executablePath, args, headless: 'shell', env, protocolTimeout: 180000 });
}

/* ------------------------------------------------------------------ *
 * in-page probe — installed before any app code runs
 * ------------------------------------------------------------------ */
const PROBE = `
(() => {
  const P = window.__cahaProbe = {
    startedAt: performance.now(),
    samples: [], loops: new Set(), nonPassive: [], longTasks: [],
    rafCalls: 0,
  };
  const nativeRAF = window.requestAnimationFrame.bind(window);
  let running = null;
  window.requestAnimationFrame = (cb) => {
    P.rafCalls++;
    if (running === cb && !cb.__probe) P.loops.add(cb);
    return nativeRAF((t) => { const prev = running; running = cb; try { cb(t); } finally { running = prev; } });
  };
  const AEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (['wheel', 'touchstart', 'touchmove', 'scroll', 'touchend'].includes(type)) {
      const passive = opts === true ? false : (opts && typeof opts === 'object') ? !!opts.passive : false;
      if (!passive) P.nonPassive.push({ type, stack: (new Error().stack || '').split('\\n')[2]?.trim() });
    }
    return AEL.call(this, type, fn, opts);
  };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push(+e.duration.toFixed(1)); })
      .observe({ entryTypes: ['longtask'] });
  } catch {}
  const sample = () => {
    const a = window.__caha;
    const st = a && a.stats;
    const d = a && a.debug ? a.debug() : null;
    P.samples.push({
      t: +(performance.now() - P.startedAt).toFixed(1),
      scrollY: window.scrollY,
      innerH: window.innerHeight,
      maxScroll: d ? d.maxScroll : null,
      target: d ? +d.target.toFixed(2) : null,
      playhead: d ? +d.playhead.toFixed(2) : null,
      shown: d && d.shown ? d.shown.global : null,
      drawn: st ? st.frames.drawn : null,
      missed: st ? st.frames.missed : null,
      approx: st ? st.frames.approx : null,
      blits: st ? st.frames.blits : null,
      cacheBytes: st ? st.cache.bytes : null,
      loopFrames: st ? st.loop.frames : null,
      longFrames: st ? st.loop.longFrames : null,
      netBytes: st ? st.net.bytes : null,
      netReq: st ? st.net.requests : null,
      autoplayScrolls: st ? st.autoplay.scrolls : null,
    });
    if (P.samples.length > 20000) P.samples.shift();
    nativeRAF(sample);
  };
  sample.__probe = true;
  nativeRAF(sample);
})();
`;

/* ------------------------------------------------------------------ *
 * CDP metric helpers
 * ------------------------------------------------------------------ */
const CDP_KEYS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
  'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'LayoutObjects', 'Frames'];
async function cdpMetrics(client) {
  const { metrics } = await client.send('Performance.getMetrics');
  const out = {};
  for (const m of metrics) if (CDP_KEYS.includes(m.name)) out[m.name] = m.value;
  return out;
}
const delta = (a, b) => Object.fromEntries(CDP_KEYS.map((k) => [k, +((b[k] || 0) - (a[k] || 0)).toFixed(4)]));

/* ------------------------------------------------------------------ *
 * frame-accuracy check: canvas pixels vs the frame file for this scroll
 *
 * The engine *claims* which frame it drew; this verifies it. The canvas is
 * downscaled to 64×40, and so is each of the 5 candidate frames around the
 * expected position — the best match tells us how many frames the screen is
 * actually off by (0 = exact, |d|>1 = stale or wrong frame).
 * ------------------------------------------------------------------ */
async function loadTier(server, engine, preferDir = null) {
  /* `preferDir` is the tier the app itself reported serving (`__caha.setDir`).
     Without it the pixel check compares the canvas against whatever
     assets/web happens to be — which is the wrong reel as soon as a device
     gets a different tier (phones now get web-m at --step 4, so the same
     index is a different source frame). */
  const candidates = preferDir
    ? [`${preferDir}/manifest.json`]
    : engine === 'v1'
      ? ['assets/manifest.json']
      : ['assets/web/manifest.json', 'assets/manifest.json'];
  for (const c of candidates) {
    const res = await fetch(`http://127.0.0.1:${server.port}/${c}`).catch(() => null);
    if (!res || !res.ok) continue;
    const m = await res.json();
    if (m && m.scenes && m.scenes.length) {
      const dir = m.dir || 'assets/frames';
      const prefix = m.prefix !== undefined ? m.prefix : 'ezgif-frame-';
      const pad = m.pad || (m.prefix === undefined ? 3 : 3);
      const ext = m.ext || '.jpg';
      let acc = 0;
      const offsets = m.scenes.map((sc) => { const o = acc; acc += sc.frames; return o; });
      return {
        source: c, dir, prefix, pad, ext, total: acc, offsets,
        scenes: m.scenes,
        url(global) {
          let si = 0;
          while (si + 1 < m.scenes.length && offsets[si + 1] <= global) si++;
          const f = global - offsets[si] + 1;
          return `http://127.0.0.1:${server.port}/${dir}/${m.scenes[si].id}/` +
            `${prefix}${String(f).padStart(pad, '0')}${ext}`;
        },
      };
    }
  }
  return null;
}

async function pixelAccuracy(page, server, tier) {
  const sharp = (await import('sharp')).default;
  const shot = await page.evaluate(() => {
    const c = document.getElementById('frame');
    const off = document.createElement('canvas');
    off.width = 64; off.height = 40;
    const g = off.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, off.width, off.height);
    return off.toDataURL('image/png');
  });
  const canvasRaw = await sharp(Buffer.from(shot.split(',')[1], 'base64'))
    .resize(64, 40, { fit: 'fill' }).greyscale().raw().toBuffer();
  const d0 = await page.evaluate(() => (window.__caha && window.__caha.debug ? window.__caha.debug() : null));
  if (!d0) return null;
  const expected = Math.round(d0.target);
  const out = [];
  for (let d = -3; d <= 3; d++) {
    const g = expected + d;
    if (g < 0 || g >= tier.total) continue;
    const res = await fetch(tier.url(g)).catch(() => null);
    if (!res || !res.ok) continue;
    const raw = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(64, 40, { fit: 'fill' }).greyscale().raw().toBuffer();
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += Math.abs(raw[i] - canvasRaw[i]);
    out.push({ d, mae: +(sum / raw.length).toFixed(2) });
  }
  out.sort((a, b) => a.mae - b.mae);
  return { expected, shown: d0.shown ? d0.shown.global : null, best: out[0] || null, spread: out };
}

/* ------------------------------------------------------------------ *
 * scenarios
 * ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wheel(page, { x, y, deltaY, count, gapMs, burst = false }) {
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel({ deltaY: burst ? deltaY : 0, deltaX: 0 }).catch(() => {});
    if (!burst) await sleep(gapMs);
  }
}

async function setupPage(browser, server, { device, url = '/index.html', engine = ENGINE }) {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Performance.enable');
  await page.setCacheEnabled(KEEP);
  if (device === 'mobile') {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  } else {
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  }
  /* Analyse the *committed* v2.1 engine without touching the working tree:
     `git show` the file and add the same read-only probe surface the current
     engine has (`stats.frames.shown` + `debug()`), so both engines can be
     measured with identical instrumentation. */
  const baselineSrc = () => {
    let src;
    try {
      src = execFileSync('git', ['show', `${BASELINE_REF}:app.js`], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) { throw new Error(`cannot read ${BASELINE_REF}:app.js — ${e.message}`); }
    const shownHook = src.replace('    stats.frames.drawn++;',
      '    stats.frames.drawn++;\n    stats.frames.shown = { si, f: usedFrame, global: offsets[si] + usedFrame - 1 };');
    const dbgHook = shownHook.replace(`  window.__caha = {
    stats, profile: PROFILE, setDir: baseDir,
    get playhead() { return playhead; },
    get maxScroll() { return maxScroll; },
  };`, `  window.__caha = {
    stats, profile: PROFILE, setDir: baseDir,
    get playhead() { return playhead; },
    get maxScroll() { return maxScroll; },
    debug: () => ({ scrollY, maxScroll, totalFrames, innerHeight: window.innerHeight,
      target: targetFromScroll(), playhead,
      shown: stats.frames.shown ? { ...stats.frames.shown } : null,
      metricsDirty, window: { ahead: win.ahead, behind: win.behind } }),
  };`);
    if (dbgHook === shownHook || shownHook === src) {
      console.warn('  ! baseline instrumentation did not apply cleanly — lag numbers for this run may be hollow');
    }
    return dbgHook;
  };

  if (engine === 'v2.1') {
    const src = baselineSrc();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname === '/app.js') {
        return req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: src });
      }
      req.continue();
    });
  }
  if (engine === 'v1') {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && req.url().includes('index.html')) {
        let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        html = html.replace('<script src="app.js"></script>', '<script src="tools/fixtures/app.v1.js"></script>')
          .replace('<script src="diagnostics.js" defer></script>', '');
        return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      }
      req.continue();
    });
  }
  // This sandbox reports a low navigator.deviceMemory, which would flip the
  // engine into its phone profile on a 1440px desktop viewport. Pin the
  // signals we are modelling (docs: deviceMemory is a hint, not a capability).
  if (device !== 'mobile') {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    });
  }
  await page.evaluateOnNewDocument(PROBE);
  const t0 = Date.now();
  const fullUrl = url + (EXTRA ? (url.includes('?') ? '&' : '?') + EXTRA : '');
  await page.goto(`http://127.0.0.1:${server.port}${fullUrl}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, client, bootMs: Date.now() - t0 };
}

async function waitForEngine(page, timeoutMs = 120000) {
  await page.waitForFunction(
    () => (window.__caha && window.__caha.stats && window.__caha.stats.loop.frames > 3) ||
      (window.__cahaProbe && window.__cahaProbe.samples.length > 30),
    { timeout: timeoutMs, polling: 100 });
}

async function runScenario(browser, server, sc) {
  const { page, client } = await setupPage(browser, server, sc);
  const log = [];
  try {
    await waitForEngine(page);
    // let the loader finish + first frames decode
    await sleep(sc.settleMs || 2500);
    if (sc.cpuThrottle) await client.send('Emulation.setCPUThrottlingRate', { rate: sc.cpuThrottle });
    await page.evaluate(() => { window.__cahaProbe.samples.length = 0; window.__cahaProbe.longTasks.length = 0; });
    const m0 = await cdpMetrics(client);

    if (sc.plan) await sc.plan({ page, client, server, log });
    let accuracy = null;
    const traceEnd = await page.evaluate(() => window.__cahaProbe.samples.length);
    if (sc.accuracy) {
      const servedDir = await page.evaluate(() => (window.__caha && window.__caha.setDir) || null);
      const tier = await loadTier(server, ENGINE, servedDir);
      if (tier && await page.evaluate(() => !!(window.__caha && window.__caha.debug))) {
        accuracy = [];
        for (const frac of sc.accuracy) {
          await page.evaluate((f) => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, Math.round(max * f));
          }, frac);
          await sleep(sc.accuracySettleMs || 1200);
          const r = await pixelAccuracy(page, server, tier);
          accuracy.push({ frac, ...r });
        }
      }
    }
    const m1 = await cdpMetrics(client);
    await sleep(sc.tailMs ?? 400);

    const probe = await page.evaluate((KEEP_EVERY, traceEnd) => ({
      sampleCount: window.__cahaProbe.samples.length,
      scrollRange: (() => {
        const ys = window.__cahaProbe.samples.map((x) => x.scrollY);
        return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
      })(),
      rafLoops: window.__cahaProbe.loops.size,
      nonPassive: window.__cahaProbe.nonPassive,
      longTasks: window.__cahaProbe.longTasks,
      traceEndIdx: traceEnd,
      samples: window.__cahaProbe.samples.filter((_, i) => i % KEEP_EVERY === 0),
      engine: window.__caha ? window.__caha.stats : null,
      profile: window.__caha ? window.__caha.profile : null,
      dom: (() => {
        const cs = getComputedStyle(document.documentElement);
        const s = document.getElementById('stage');
        const c = document.getElementById('frame');
        return {
          htmlOverflow: cs.overflowX + '/' + cs.overflowY,
          canvasBacking: c ? c.width + 'x' + c.height : null,
          canvasCSS: c ? c.clientWidth + 'x' + c.clientHeight : null,
          stagePosition: s ? getComputedStyle(s).position : null,
          dpr: window.devicePixelRatio,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
        };
      })(),
    }), sc.dumpTrace ? 1 : 4, traceEnd);
    if (sc.dumpTrace) {
      fs.mkdirSync(path.join(OUT_DIR, 'traces'), { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'traces', `${LABEL}-${sc.name.replace(/[^\w.-]+/g, '-')}.json`),
        JSON.stringify(probe.samples));
    }
    if (SHOTS) {
      fs.mkdirSync(path.join(OUT_DIR, 'shots'), { recursive: true });
      await page.screenshot({ path: path.join(OUT_DIR, 'shots', `${LABEL}-${sc.name.replace(/[^\w.-]+/g, '-')}.png`) });
    }
    const res = summarise(sc, { probe, blink: delta(m0, m1), log, engine: ENGINE });
    res.accuracy = accuracy;
    res.checks = checksFor(res, probe, sc);
    await page.close();
    return res;
  } catch (err) {
    await page.close().catch(() => {});
    return { name: sc.name, error: String(err && err.message || err), stack: String(err && err.stack || '').split('\n').slice(1, 4), log };
  } finally { /* page closed above */ }
}

/* ------------------------------------------------------------------ *
 * analysis
 * ------------------------------------------------------------------ */
function summarise(sc, { probe, blink, log, engine }) {
  // Only the part of the trace that ran *before* the accuracy seek (which
  // teleports on purpose), and drop samples adjacent to a deliberate jump, so
  // the lag/jitter numbers describe scrubbing rather than seeking.
  const rawAll = probe.samples.slice(0, probe.traceEndIdx || probe.samples.length);
  const raw = rawAll.filter((x) => x.playhead !== null);
  /* Deliberate jumps (End/Home, an anchor, a scrollbar drag) are *cuts* in this
     design, so the ticks between the jump and the picture catching up are not
     scrubbing — they are a seek. Keep them out of the lag/jitter statistics and
     measure them separately: how long until the displayed frame matches the
     (already cut) playhead again. */
  const jumpAt = raw.map((x, i) => i > 0 && Math.abs(x.scrollY - raw[i - 1].scrollY) > 1.5 * x.innerH);
  const SEEK_SETTLE_MAX_MS = 3000;
  const s = [];
  const seeks = [];
  let settling = -1, settleStartT = 0, settleStartIdx = 0;
  for (let i = 0; i < raw.length; i++) {
    if (jumpAt[i] || (i > 0 && jumpAt[i])) continue;      // the jump and its neighbours
    if (settling >= 0) {
      const conv = raw[i].playhead !== null && raw[i].shown !== null &&
        Math.abs(raw[i].playhead - raw[i].shown) <= 2;
      if (conv || raw[i].t - settleStartT > SEEK_SETTLE_MAX_MS) {
        seeks.push({ at: +settleStartT.toFixed(0), convergenceMs: conv ? +(raw[i].t - settleStartT).toFixed(0) : null,
          ticks: i - settleStartIdx, converged: !!conv });
        settling = -1;
      } else continue;                                    // still settling
    }
    if (jumpAt[i + 1]) {                                  // the next sample is a jump → arm the settle window
      settling = i;
      settleStartT = raw[i].t;
      settleStartIdx = i;
      continue;
    }
    s.push(raw[i]);
  }

  const lag = s.filter((x) => x.target !== null && x.shown !== null)
    .map((x) => Math.abs(x.target - x.shown));
  const showLag = s.filter((x) => x.playhead !== null && x.shown !== null)
    .map((x) => Math.abs(x.playhead - x.shown));
  const dampLag = s.filter((x) => x.target !== null && x.playhead !== null)
    .map((x) => Math.abs(x.target - x.playhead));
  const stat = (arr) => {
    if (!arr.length) return { mean: null, p95: null, max: null };
    const srt = [...arr].sort((a, b) => a - b);
    return {
      mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2),
      p95: +srt[Math.min(srt.length - 1, Math.floor(0.95 * srt.length))].toFixed(2),
      max: +srt[srt.length - 1].toFixed(2),
    };
  };

  // Stutter proxy: how much the frame-to-frame *velocity* jumps around. A
  // damped scrub that keeps up smoothly has low jitter; a scrub that snaps or
  // starves has high jitter. Reported alongside the lag so the damping can be
  // tuned without trading one for the other.
  const seq = s.map((x) => x.shown);
  const d1 = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === null || seq[i - 1] === null) continue;
    const delta = seq[i] - seq[i - 1];
    d1.push(Math.abs(delta) > 60 ? null : delta);          // |Δ|>60 is a cut, not a scrub
  }
  const d2 = [];
  for (let i = 1; i < d1.length; i++) {
    if (d1[i] === null || d1[i - 1] === null) continue;
    if (d1[i - 1] !== 0 || d1[i] !== 0) d2.push(Math.abs(d1[i] - d1[i - 1]));
  }

  let movingTicks = 0, drawnTicks = 0, approxTicks = 0, advanced = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i].target === null || s[i - 1].target === null) continue;
    if (Math.abs(s[i].target - s[i - 1].target) <= 0.5) continue;   // playhead at rest
    movingTicks++;
    if (s[i].drawn > s[i - 1].drawn) drawnTicks++;
    if (s[i].approx > s[i - 1].approx) approxTicks++;
    if (s[i].shown !== null && s[i - 1].shown !== null) advanced += Math.abs(s[i].shown - s[i - 1].shown);
  }

  const sorted = [...lag].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1) : null);
  const eng = probe.engine || {};
  const loopFrames = eng.loop ? eng.loop.frames : null;
  // per-frame cost is normalised by the number of animation frames we actually
  // observed, so engines without a stats surface (v1) are still comparable
  const tickBase = loopFrames || Math.max(1, rawAll.length);
  return {
    name: sc.name,
    device: sc.device,
    engine,
    ticks: rawAll.length,
    blink: {
      layoutCount: blink.LayoutCount,
      recalcStyleCount: blink.RecalcStyleCount,
      layoutMs: +(blink.LayoutDuration * 1000).toFixed(1),
      recalcStyleMs: +(blink.RecalcStyleDuration * 1000).toFixed(1),
      scriptMs: +(blink.ScriptDuration * 1000).toFixed(1),
      taskMs: +(blink.TaskDuration * 1000).toFixed(1),
      layoutPerTick: +(blink.LayoutCount / tickBase).toFixed(4),
      recalcPerTick: +(blink.RecalcStyleCount / tickBase).toFixed(4),
      scriptMsPerTick: +(blink.ScriptDuration * 1000 / tickBase).toFixed(3),
      heapMB: +((blink.JSHeapUsedSize || 0) / 1048576).toFixed(1),
    },
    rafLoops: probe.rafLoops,
    nonPassive: probe.nonPassive.length,
    nonPassiveSample: probe.nonPassive.slice(0, 3),
    longTasks: { count: probe.longTasks.length, worstMs: probe.longTasks.length ? Math.max(...probe.longTasks) : 0 },
    profile: probe.profile ? probe.profile.id : null,
    engineStats: eng && eng.frames ? {
      drawn: eng.frames.drawn, missed: eng.frames.missed, approx: eng.frames.approx, blits: eng.frames.blits,
      blitsPerDraw: eng.frames.drawn ? +(eng.frames.blits / eng.frames.drawn).toFixed(2) : null,
      cacheMB: +((eng.cache.bytes || 0) / 1048576).toFixed(1),
      cacheEntries: eng.cache.entries, evicted: eng.cache.evicted,
      netMB: +((eng.net.bytes || 0) / 1048576).toFixed(2), netReq: eng.net.requests, netFailed: eng.net.failed,
      scrollReads: eng.layout.scrollReads, layoutWrites: eng.layout.layoutWrites, measures: eng.layout.measures,
      loopFrames: eng.loop.frames, longFrames: eng.loop.longFrames, worstFrameMs: +eng.loop.worst.toFixed(1),
      autoplayScrolls: eng.autoplay.scrolls, autoplayLoops: eng.autoplay.loops,
      measuresPerTick: eng.loop.frames ? +(eng.layout.measures / eng.loop.frames).toFixed(4) : null,
    } : null,
    scrollRange: probe.scrollRange,
    sampleCount: probe.sampleCount,
    lag: {
      // target → shown: how far the picture trails the raw scroll (mostly the
      // damping the design asks for, plus any starvation)
      targetToShown: stat(lag),
      // playhead → shown: starvation only. This must be ~0: the frame on screen
      // should be the frame the damped playhead asks for.
      playheadToShown: stat(showLag),
      // target → playhead: the deliberate smoothing lag
      dampLag: stat(dampLag),
      over12pct: lag.length ? +(100 * lag.filter((x) => x > 12).length / lag.length).toFixed(1) : null,
    },
    jitter: stat(d2),
    seeks,
    // While the playhead is moving, how many animation frames produced no new
    // picture at all (a held frame), and how many showed a substitute frame
    // because the right one had not decoded yet?
    motion: {
      movingTicks,
      drawnTicks,
      noDrawPct: movingTicks ? +(100 * (1 - drawnTicks / movingTicks)).toFixed(1) : null,
      approxPct: movingTicks ? +(100 * approxTicks / movingTicks).toFixed(1) : null,
      // how much the picture advances per tick that the playhead is moving:
      // ~0.4–0.6 at 24 fps film on a 60 Hz (or throttled) clock, ~0 if starving
      framesPerMovingTick: movingTicks ? +(advanced / movingTicks).toFixed(2) : null,
    },
    dom: probe.dom,
    log,
  };
}

/* ------------------------------------------------------------------ *
 * Step-1 checklist, asserted per run — the regression gate
 * ------------------------------------------------------------------ */
function checksFor(r, probe, sc) {
  const na = !probe.engine;   // engines without a stats surface (v1) can't be judged here
  const ok = (name, pass, value) => ({ name, pass: !!pass, value, na });
  const eng = r.engineStats || {};
  const profile = probe.profile || {};
  const budget = profile.cacheBudgetMB || 384;
  const checks = [
    ok('one animation loop (#12)', r.rafLoops <= 1, r.rafLoops),
    ok('no non-passive listeners (#11)', r.nonPassive === 0, r.nonPassive),
    ok('Blink layout < 0.05/frame (#5)', r.blink.layoutPerTick !== null && r.blink.layoutPerTick < 0.05, r.blink.layoutPerTick),
    ok('script < 2 ms/frame', r.blink.scriptMsPerTick !== null && r.blink.scriptMsPerTick < 2, r.blink.scriptMsPerTick),
    ok('long tasks < 10', r.longTasks.count < 10, `${r.longTasks.count} (worst ${r.longTasks.worstMs} ms)`),
    ok('no backdrop-filter (#6)', !(r.dom && r.dom.backdropFilters && r.dom.backdropFilters.length), r.dom ? r.dom.backdropFilters : 'n/a'),
    ok('html overflow not hidden (#8)', !/hidden/.test(r.dom ? r.dom.htmlOverflow : ''), r.dom ? r.dom.htmlOverflow : 'n/a'),
  ];
  if (!na) {
    checks.push(
      ok('no engine layout reads (#5/#7)', eng.measuresPerTick !== null ? eng.measuresPerTick < 0.02 : true, eng.measuresPerTick),
      ok('bitmap cache within budget (#10)', eng.cacheMB === undefined || eng.cacheMB <= budget + 8, `${eng.cacheMB}/${budget} MB`),
      // Sanity ceiling for a 2-core sandbox: a sustained fast scrub is
      // bandwidth/decode-bound, so it may trail a few frames; >10 frames p95
      // means the engine is holding a stale picture, which is a bug.
      ok('p95 starvation ≤ 10 frames (#4)', r.lag.playheadToShown.p95 === null || r.lag.playheadToShown.p95 <= 10, r.lag.playheadToShown.p95),
      ok('picture advances while scrubbing', r.motion.framesPerMovingTick === null || r.motion.framesPerMovingTick >= 0.2, r.motion.framesPerMovingTick),
    );
  }
  if (sc.name.includes('urlbar')) {
    const u = (r.log.find((l) => l.urlBar) || {}).urlBar;
    if (u && u.dShown !== null && !na) {
      checks.push(ok('URL-bar change ≠ film jump (#7/#10)', Math.abs(u.dShown) === 0 && u.dMaxScroll === 0,
        `Δframe ${u.dShown}, ΔmaxScroll ${u.dMaxScroll}`));
    }
  }
  if (sc.name.includes('autoplay')) {
    const a = (r.log.find((l) => l.autoplay) || {}).autoplay;
    if (a && !na) {
      checks.push(ok('autoplay yields to wheel (#3)', a.wheelStopped, a.wheelStopped));
      checks.push(ok('autoplay yields to scrollbar drag (#3)', a.dragYielded && a.dragRespected,
        `yielded=${a.dragYielded} respected=${a.dragRespected}`));
    }
  }
  return checks;
}

/* ------------------------------------------------------------------ *
 * scenario set
 * ------------------------------------------------------------------ */
function scenarios() {
  const wheelBurst = async ({ page }) => {
    // 6 slow notches (a human reading the page)
    for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 220 }); await sleep(180); }
    await sleep(600);
    // then a fast flick: 14 notches with no gap
    for (let i = 0; i < 14; i++) await page.mouse.wheel({ deltaY: 240 });
    await sleep(1200);
    // back up a little, then settle
    for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: -300 }); await sleep(90); }
    await sleep(900);
  };
  // NB: Input.synthesizeScrollGesture with gestureSourceType 'touch' does not
  // scroll in this headless build; raw dispatchTouchEvent sequences do (and
  // they fling, because the compositor sees real velocity).
  const touchDrag = async (client, { x, fromY, toY, steps, stepMs }) => {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
    const dy = (toY - fromY) / steps;
    for (let i = 1; i <= steps; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + dy * i }] });
      await sleep(stepMs);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const touchFling = async ({ page, client }) => {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      .catch(() => {});
    // slow drag (finger-following), then a hard fling, then drag back up
    await touchDrag(client, { x: 195, fromY: 700, toY: 560, steps: 8, stepMs: 34 });
    await sleep(500);
    await touchDrag(client, { x: 195, fromY: 740, toY: 180, steps: 12, stepMs: 6 });
    await sleep(1600);
    await touchDrag(client, { x: 195, fromY: 250, toY: 620, steps: 12, stepMs: 14 });
    await sleep(900);
  };
  const teleport = async ({ page, log }) => {
    const before = await page.evaluate(() => ({ y: window.scrollY, ph: window.__caha && window.__caha.debug ? window.__caha.debug().playhead : null }));
    await page.keyboard.press('End'); await sleep(900);
    const end = await page.evaluate(() => ({ y: window.scrollY, ph: window.__caha && window.__caha.debug ? window.__caha.debug().playhead : null }));
    await page.keyboard.press('Home'); await sleep(900);
    const home = await page.evaluate(() => ({ y: window.scrollY, ph: window.__caha && window.__caha.debug ? window.__caha.debug().playhead : null }));
    log.push({ teleport: { before, end, home } });
  };
  const autoplay = async ({ page, log }) => {
    await sleep(3500);
    const playing = await page.evaluate(() => (window.__caha ? { ...window.__caha.stats.autoplay, y: window.scrollY } : null));
    // (a) grabbing the wheel mid-play must pause it immediately
    await page.mouse.wheel({ deltaY: -120 });
    await sleep(800);
    const afterWheel = await page.evaluate(() => (window.__caha ? { ...window.__caha.stats.autoplay, y: window.scrollY } : null));
    // (b) restart, then move the scroll with NO input event at all — this is
    //     what dragging the scrollbar looks like to the page. v2.1 never
    //     yielded here and kept writing scrollTo, fighting the user.
    await page.evaluate(() => { const b = document.getElementById('playctl'); if (b) b.click(); });
    await sleep(1500);
    const beforeDrag = await page.evaluate(() => (window.__caha ? { ...window.__caha.stats.autoplay, y: window.scrollY } : null));
    await page.evaluate(() => window.scrollBy(0, -400));
    await sleep(1500);
    const afterDrag = await page.evaluate(() => (window.__caha ? { ...window.__caha.stats.autoplay, y: window.scrollY } : null));
    await sleep(900);
    const settled = await page.evaluate(() => (window.__caha ? { y: window.scrollY, ...window.__caha.stats.autoplay } : { y: window.scrollY }));
    log.push({
      autoplay: {
        playing, afterWheel, beforeDrag, afterDrag, settled,
        wheelStopped: !!playing && playing.active === true && afterWheel.active === false,
        dragYielded: !!afterDrag && afterDrag.active === false,
        dragRespected: !!afterDrag && Math.abs(settled.y - afterDrag.y) <= 4,
      },
    });
  };
  const urlBar = async ({ page, client, log }) => {
    // Real mobile behaviour: 100vh (the spacer) does NOT change when the
    // URL bar collapses; only window.innerHeight does. Freeze the spacer in
    // px to reproduce that, then change the viewport height mid-scroll.
    await page.evaluate(() => {
      const sp = document.getElementById('spacer');
      const px = sp.getBoundingClientRect().height;
      sp.style.height = px + 'px';
      window.scrollTo(0, document.documentElement.scrollHeight * 0.4);
    });
    // wait for the damped playhead to actually settle before sampling, so the
    // check measures the URL-bar effect and not the tail of a glide
    await page.waitForFunction(() => {
      const d = window.__caha && window.__caha.debug && window.__caha.debug();
      return d && d.shown && Math.abs(d.target - d.shown.global) <= 1;
    }, { timeout: 15000, polling: 100 }).catch(() => {});
    await sleep(700);
    const before = await page.evaluate(() => {
      const d = window.__caha && window.__caha.debug ? window.__caha.debug() : null;
      return { y: window.scrollY, innerH: window.innerHeight, maxScroll: d ? d.maxScroll : null, target: d ? d.target : null, shown: d && d.shown ? d.shown.global : null };
    });
    const rect = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: rect.w, height: rect.h - 96, deviceScaleFactor: 3, mobile: true,
    });
    await page.waitForFunction(() => {
      const d = window.__caha && window.__caha.debug && window.__caha.debug();
      return d && d.shown && Math.abs(d.target - d.shown.global) <= 1;
    }, { timeout: 15000, polling: 100 }).catch(() => {});
    await sleep(700);
    const after = await page.evaluate(() => {
      const d = window.__caha && window.__caha.debug ? window.__caha.debug() : null;
      return { y: window.scrollY, innerH: window.innerHeight, maxScroll: d ? d.maxScroll : null, target: d ? d.target : null, shown: d && d.shown ? d.shown.global : null };
    });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: rect.w, height: rect.h, deviceScaleFactor: 3, mobile: true,
    });
    await sleep(800);
    const restored = await page.evaluate(() => {
      const d = window.__caha && window.__caha.debug ? window.__caha.debug() : null;
      return { y: window.scrollY, innerH: window.innerHeight, maxScroll: d ? d.maxScroll : null, target: d ? d.target : null, shown: d && d.shown ? d.shown.global : null };
    });
    log.push({
      urlBar: {
        before, after, restored,
        dScroll: +(after.y - before.y).toFixed(1),
        dShown: after.shown !== null && before.shown !== null ? after.shown - before.shown : null,
        dMaxScroll: after.maxScroll !== null && before.maxScroll !== null ? +(after.maxScroll - before.maxScroll).toFixed(1) : null,
      },
    });
  };
  const idle = async ({ page, log }) => {
    await sleep(2500);
    const t0 = await page.evaluate(() => window.__caha?.stats.frames.blits ?? null);
    await sleep(2500);
    const t1 = await page.evaluate(() => window.__caha?.stats.frames.blits ?? null);
    log.push({ idleBlitsPerSecond: t0 !== null ? +(((t1 - t0) / 2.5)).toFixed(1) : null });
  };

  return [
    { name: 'desktop/wheel', device: 'desktop', settleMs: 3000, plan: wheelBurst, accuracy: [0.08, 0.33, 0.61, 0.87] },
    { name: 'desktop/wheel-4x', device: 'desktop', settleMs: 3000, cpuThrottle: 4, plan: wheelBurst },
    { name: 'desktop/teleport', device: 'desktop', settleMs: 3000, plan: teleport },
    { name: 'desktop/idle', device: 'desktop', settleMs: 3000, plan: idle },
    { name: 'mobile/touch-4x', device: 'mobile', settleMs: 3500, cpuThrottle: 4, plan: touchFling, dumpTrace: true },
    { name: 'mobile/accuracy', device: 'mobile', settleMs: 3500, plan: async () => { await sleep(500); }, accuracy: [0.2, 0.7] },
    { name: 'mobile/urlbar-4x', device: 'mobile', settleMs: 3500, cpuThrottle: 4, plan: urlBar, dumpTrace: true },
    { name: 'desktop/autoplay', device: 'desktop', settleMs: 3000, url: '/index.html?autoplay=1', plan: autoplay, tailMs: 100 },
  ];
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
const main = async () => {
  const tiers = DEFAULT_TIERS();
  const srv = await startServer({ port: 0, tiers });
  const { server, port } = srv;
  const browser = await launch();
  const only = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = scenarios().filter((s) => !only.length || only.includes(s.name));
  if (!chosen.length) throw new Error(`--only matched no scenario (asked for: ${ONLY})`);
  const results = [];
  console.log(`\ncaha real-browser audit · engine=${ENGINE} label=${LABEL} · chromium=${await browser.version()}`);
  console.log(`served on :${port} · web tier: ${fs.existsSync(path.join(tiers['assets/web'], 'manifest.json')) ? 'assets/web' : '(source reel)'}\n`);
  for (const sc of chosen) {
    process.stdout.write(`  ${sc.name.padEnd(20)} `);
    const r = await runScenario(browser, srv, sc);
    results.push(r);
    if (r.error) console.log(`ERROR ${r.error}`);
    else {
      const failed = (r.checks || []).filter((c) => !c.pass);
      console.log(`ticks=${String(r.ticks).padStart(5)} ` +
        `lag playhead→screen p95=${String(r.lag.playheadToShown.p95).padStart(6)} ` +
        `damp p95=${String(r.lag.dampLag.p95).padStart(7)} jitter=${String(r.jitter.mean).padStart(6)} ` +
        `missed=${String(r.engineStats ? r.engineStats.missed : '–').padStart(4)} ` +
        (failed.length ? `CHECKS FAIL: ${failed.map((c) => c.name + '=' + c.value).join('; ')}` : 'checks OK'));
    }
  }
  await browser.close();
  server.close();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `browser-audit-${LABEL}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ engine: ENGINE, label: LABEL, at: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, outFile)}${SHOTS ? ` + screenshots in reports/shots/` : ''}\n`);
};

main().catch((e) => { console.error(e); process.exit(1); });
