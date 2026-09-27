/* ============================================================
   cahā — real-browser check of the scroll site (index.html)

   Scrubs every chapter in headless Chromium and checks what a visitor
   would see: the preloader clears, each chapter's canvas gets real pixels,
   the frame under the playhead is the one drawn once loading settles,
   story beats and dots switch at their frame ranges, the hero overlay
   fades, and nothing logs an error. Desktop and phone profiles.

     npm run check:site                     # starts its own server
     node tools/site-check.mjs --url http://127.0.0.1:5173/
     node tools/site-check.mjs --no-shots

   Writes reports/site-check.json; screenshots go to reports/shots/site/
   (gitignored). Exit code 1 if any check fails.

   Env: CAHA_CHROME=<chrome binary> to skip @sparticuz/chromium.
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i === -1 ? dflt : argv[i + 1]; };
const flag = (name) => argv.includes('--' + name);
const SHOTS = !flag('no-shots');
const SHOT_DIR = path.join(ROOT, 'reports/shots/site');
const OUT = path.join(ROOT, 'reports/site-check.json');

async function launch() {
  const puppeteer = (await import('puppeteer-core')).default;
  let executablePath = process.env.CAHA_CHROME || '';
  let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio'];
  let env = process.env;
  if (!executablePath) {
    const chromium = (await import('@sparticuz/chromium')).default;
    executablePath = await chromium.executablePath();
    args = [...chromium.args, '--disable-dev-shm-usage', '--hide-scrollbars'];
    // same Amazon-Linux lib unpacking as tools/browser-audit.mjs
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

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } },
  phone: {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

const results = { at: new Date().toISOString(), checks: [], profiles: {} };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
};

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name + '.jpg'), type: 'jpeg', quality: 72 });
}

/* scroll to a fraction of chapter i's scrub range and wait until the exact
   frame under the playhead is loaded and drawn (or time out) */
async function scrubTo(page, i, p, timeout = 15000) {
  await page.evaluate((i, p) => {
    const st = window.cahaFilm.chapters[i].st;
    window.scrollTo(0, Math.round(st.start + (st.end - st.start) * p));
  }, i, p);
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 150));
    s = await page.evaluate((i, p) => {
      const ch = window.cahaFilm.chapters[i];
      const want = Math.round(p * (ch.frames.length - 1));
      return {
        want, frame: +ch.play.frame.toFixed(2), target: ch.target, drawn: ch.drawn,
        beat: ch.beats.findIndex((b) => b.active), dot: ch.dot, align: ch.stage.dataset.align || '',
      };
    }, i, p);
    if (Math.abs(s.frame - s.want) < 0.6 && s.drawn === s.target) break;
  }
  s.settledMs = Date.now() - t0;
  return s;
}

/* is the canvas showing an actual picture? (mean luminance + spread of a sample grid) */
async function canvasStats(page, i) {
  return page.evaluate((i) => {
    const c = window.cahaFilm.chapters[i].canvas;
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0, sum2 = 0, n = 0;
    const stepX = Math.max(1, Math.floor(c.width / 40)), stepY = Math.max(1, Math.floor(c.height / 24));
    for (let y = 0; y < c.height; y += stepY) {
      for (let x = 0; x < c.width; x += stepX) {
        const k = (y * c.width + x) * 4;
        const l = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
        sum += l; sum2 += l * l; n++;
      }
    }
    const mean = sum / n;
    return { w: c.width, h: c.height, mean: +mean.toFixed(1), sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1) };
  }, i);
}

async function run(browser, base, profileName) {
  console.log(`\n${profileName}`);
  const prof = PROFILES[profileName];
  const page = await browser.newPage();
  if (prof.userAgent) await page.setUserAgent(prof.userAgent);
  await page.setViewport(prof.viewport);
  const errors = [];
  const failed = [];
  let frameRequests = 0;
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) failed.push(r.url()); });
  page.on('request', (r) => { if (r.url().includes('/assets/frames/')) frameRequests++; });

  const t0 = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('preloader'), { timeout: 20000 });
  const openMs = Date.now() - t0;
  const readyAt = await page.evaluate(() => window.cahaFilm.readyAt || null);
  const P = (results.profiles[profileName] = { openMs, filmReadyMs: readyAt, chapters: [] });
  check(`${profileName}: preloader clears`, true, { ms: openMs, filmReadyMs: readyAt });

  const meta = await page.evaluate(() => ({
    step: window.cahaFilm.stats().step,
    chapters: window.cahaFilm.chapters.map((ch) => ({
      id: ch.id, frames: ch.frames.length, beats: ch.beats.map((b) => [b.start, b.end]),
      scrollPx: Math.round(ch.st.end - ch.st.start),
    })),
    requestsAtOpen: window.cahaFilm.stats().requested,
  }));
  P.step = meta.step;
  P.requestsAtOpen = meta.requestsAtOpen;
  check(`${profileName}: 5 chapters wired`, meta.chapters.length === 5, meta.chapters.map((c) => `${c.id}:${c.frames}`));

  // hero at rest: overlay visible, first frame painted
  await new Promise((r) => setTimeout(r, 600));
  const hero0 = await page.evaluate(() => getComputedStyle(document.querySelector('.hero')).opacity);
  const px0 = await canvasStats(page, 0);
  check(`${profileName}: hero overlay visible at top`, +hero0 > 0.95, { opacity: hero0 });
  check(`${profileName}: hero canvas painted at top`, px0.sd > 8, px0);
  await shot(page, `${profileName}-00-hero`);

  for (let i = 0; i < meta.chapters.length; i++) {
    const c = meta.chapters[i];
    const row = { id: c.id, frames: c.frames, scrollPx: c.scrollPx, stops: [] };
    // one stop in the middle of every beat
    const stops = c.beats.map(([a, b]) => ((a + b) / 2) / (c.frames - 1));
    for (let k = 0; k < stops.length; k++) {
      const s = await scrubTo(page, i, stops[k]);
      const px = await canvasStats(page, i);
      row.stops.push({ p: +stops[k].toFixed(3), ...s, px });
      const ok = s.drawn === s.target && s.beat === k && s.dot === k && px.sd > 8;
      check(`${profileName}: ${c.id} beat ${k + 1} (p=${stops[k].toFixed(2)})`, ok,
        { beat: s.beat, dot: s.dot, target: s.target, drawn: s.drawn, settledMs: s.settledMs, sd: px.sd });
      if (profileName === 'desktop' || k === 0) await shot(page, `${profileName}-${String(i + 1).padStart(2, '0')}-${c.id}-beat${k + 1}`);
    }
    // between two beats (at a scene cut) no panel is up, but the dot holds
    if (c.beats.length > 1) {
      const gap = ((c.beats[0][1] + c.beats[1][0]) / 2) / (c.frames - 1);
      const s = await scrubTo(page, i, gap);
      check(`${profileName}: ${c.id} gap between beats shows film only`, s.beat === -1 && s.dot === 0, { beat: s.beat, dot: s.dot });
    }
    P.chapters.push(row);
  }

  // hero overlay fades once the scroll starts
  await page.evaluate(() => window.scrollTo(0, Math.round(window.innerHeight * 0.8)));
  await new Promise((r) => setTimeout(r, 700));
  const heroGone = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.hero'));
    return { opacity: cs.opacity, visibility: cs.visibility };
  });
  check(`${profileName}: hero overlay faded after scrolling`, +heroGone.opacity < 0.05 && heroGone.visibility === 'hidden', heroGone);

  // content sections render (and their frame stills load)
  for (const id of ['menu', 'counter', 'space', 'about', 'visit']) {
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), id);
    await new Promise((r) => setTimeout(r, 1300));
    const imgs = await page.evaluate((id) => {
      const list = [...document.querySelectorAll(`#${id} img`)].filter((im) => {
        const r = im.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      });
      return { visible: list.length, loaded: list.filter((im) => im.complete && im.naturalWidth > 0).length };
    }, id);
    check(`${profileName}: #${id} images load`, imgs.visible === 0 || imgs.loaded === imgs.visible, imgs);
    await shot(page, `${profileName}-sec-${id}`);
  }

  const stats = await page.evaluate(() => window.cahaFilm.stats());
  P.loader = { requested: stats.requested, loaded: stats.loaded, failed: stats.failed, frameRequests };
  check(`${profileName}: no frame requests failed`, stats.failed === 0 && failed.length === 0, { failed: stats.failed, requestfailed: failed.slice(0, 5) });
  check(`${profileName}: no console errors`, errors.length === 0, errors.slice(0, 5));
  await page.close();

  // a deep link opens on its own chapter: the preloader waits on that chapter's frames, not the hero's
  const deep = await browser.newPage();
  if (prof.userAgent) await deep.setUserAgent(prof.userAgent);
  await deep.setViewport(prof.viewport);
  await deep.goto(base + '#after-dark', { waitUntil: 'domcontentloaded' });
  await deep.waitForFunction(() => !document.getElementById('preloader'), { timeout: 20000 });
  const d = await deep.evaluate(() => {
    const ch = window.cahaFilm.chapters.find((c) => c.id === 'after-dark');
    return { focus: window.cahaFilm.stats().focus, readyAt: window.cahaFilm.readyAt, drawn: ch.drawn, heroLoaded: window.cahaFilm.stats().chapters[0].loaded };
  });
  check(`${profileName}: deep link #after-dark opens on its chapter`, d.focus === 'after-dark' && d.drawn >= 0 && d.readyAt < 5000, d);
  await shot(deep, `${profileName}-deeplink-after-dark`);
  await deep.close();
}

let server = null;
let base = opt('url', '');
if (!base) {
  const { startServer } = await import('./serve.mjs');
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  server = started.server;
  base = `http://127.0.0.1:${started.port}/`;
}
const browser = await launch();
try {
  for (const p of (opt('profiles', 'desktop,phone')).split(',')) await run(browser, base, p.trim());
} finally {
  await browser.close();
  if (server) server.close();
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const failedChecks = results.checks.filter((c) => !c.ok);
results.summary = { total: results.checks.length, failed: failedChecks.length };
fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
console.log(`\n${results.checks.length - failedChecks.length}/${results.checks.length} checks passed → ${path.relative(ROOT, OUT)}`);
process.exit(failedChecks.length ? 1 : 0);
