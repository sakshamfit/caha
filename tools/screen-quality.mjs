#!/usr/bin/env node
/* ============================================================
   Caha — screen-space quality measurement

   frame-quality.mjs answers "how good is the delivered file?".
   This answers the harder question the user actually sees: "how
   good is what lands on the glass?" — because between the file and
   the eye sit four things that can each cost fidelity:

     1. the tier's codec + resolution      (file quality)
     2. the canvas backing-store cap       (app.js FIX B / resCap)
     3. the cover-fit crop + drawImage     (scale filter inside canvas)
     4. the compositor upscale             (backing store → device px)

   Method: pin a viewport, scroll to a scene centre, wait until the
   film has settled (playhead == target and the shown frame is stable
   for 3 frames), screenshot the canvas area, then compare those
   device pixels against the *source JPEG* cover-fitted to the same
   device box with a lanczos3 resize. The reference is therefore the
   ideal rendering of the original frame at this screen size, and one
   PSNR/SSIM number covers the whole chain.

   Overlay chrome (vignette, wordmark, progress, hint, loader) is
   hidden for the capture: we measure the film, not the UI. Nothing
   in the app is modified — the CSS is injected per page.

   Usage:
     CAHA_SRC_FRAMES=/path/to/frames \
     node tools/screen-quality.mjs --tier assets/web-avif --mode desktop --dpr 1 \
       --scenes 2,6,10,13 --label screen-v2

   Options:
     --tier <dir>    delivered tier to force (assets/web-avif | assets/web-m | assets/web)
     --mode desktop|mobile     viewport + profile (mobile → app picks the phone tier)
     --dpr <n>       device pixel ratio (default: 2 desktop, 3 mobile)
     --scenes <list> 1-based scene numbers to sample (default: evenly spread)
     --samples <n>   how many scenes to sample when --scenes is not given
     --label <name>  report name → reports/screen-quality-<label>.json (append/merge)
     --keep-shots    write the captures to reports/shots/ for eyeballing

   The JSON report accumulates one entry per (mode, tier, dpr) so a
   before/after comparison can be run the same day on the same box.
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames'));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes('--' + n);

const TIER = opt('tier', 'assets/web-avif');
const MODE = opt('mode', 'desktop');
const LABEL = opt('label', 'screen');
const KEEP = flag('keep-shots');
const DPR = +(opt('dpr', MODE === 'mobile' ? 3 : 2));
const SAMPLES = +opt('samples', 4);
const ONLY = opt('scenes', '') ? opt('scenes', '').split(',').map(Number) : null;
const QS = opt('qs', '');
const SHOTS = path.join(ROOT, 'reports/shots');
const OUT = path.join(ROOT, 'reports', `screen-quality-${LABEL}.json`);
/* The tier is named (so the app's probe order still picks it) and resolved on
   disk, which lets the source-JPEG reel stand in as the quality *ceiling*. */
const TIER_DIR = opt('tier-dir', '') || path.join(ROOT, TIER);
/* --tier names the slot the app's probe order should land in; --tier-dir says
   what actually sits there; --overrides k=v remaps extra URL prefixes (that is
   how the source-JPEG reel is measured as the pipeline's ceiling). */
const EXPECT_DIR = opt('expect-dir', TIER);
const OVERRIDES = Object.fromEntries((opt('overrides', '') || '').split(',')
  .filter(Boolean).map((kv) => kv.split('=')));

const VSIZE = (opt('viewport', '') || '').split('x').map(Number).filter(Boolean);
const VIEWPORT = MODE === 'mobile'
  ? { width: VSIZE[0] || 390, height: VSIZE[1] || 844, deviceScaleFactor: DPR, isMobile: true, hasTouch: true }
  : { width: VSIZE[0] || 1440, height: VSIZE[1] || 900, deviceScaleFactor: DPR, isMobile: false, hasTouch: false };
/* --against <earlier label>: compare this run's captures with captures of the
   SAME viewport/scene from another run (e.g. the source-JPEG ceiling). Both sat
   through the same cover-fit, the same canvas filter and the same compositor, so
   their difference isolates the delivery tier — the codec loss as seen on
   screen, with the resampler cancelled out. */
const AGAINST = opt('against', '');
const LOOSE = flag('loose');

/* ---------- metrics (identical definitions to frame-quality.mjs) ---------- */
function luma(raw, channels) {
  const out = new Float32Array(raw.length / channels);
  for (let i = 0, j = 0; i < raw.length; i += channels, j++) {
    out[j] = channels === 1 ? raw[i] : 0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2];
  }
  return out;
}
function psnr(a, b) {
  let mse = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; mse += d * d; }
  mse /= a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}
function ssim(a, b, w, h, win = 8) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let total = 0, blocks = 0;
  for (let by = 0; by + win <= h; by += win) {
    for (let bx = 0; bx + win <= w; bx += win) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
      for (let y = 0; y < win; y++) {
        const row = (by + y) * w + bx;
        for (let x = 0; x < win; x++) {
          const u = a[row + x], v = b[row + x];
          sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v; n++;
        }
      }
      const ma = sa / n, mb = sb / n;
      const va = saa / n - ma * ma, vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return blocks ? total / blocks : 0;
}

/* ---------- chrome (same recipe as tools/browser-audit.mjs) ---------- */
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

const HIDE_UI = `#vignette,#progress,#topbar,#scene-info,#playctl,#hint,#wordmark,#loader{visibility:hidden !important}`;

async function settleTo(page, target, budgetMs = 12000, loose = false) {
  return page.evaluate(async (target, budget, loose) => {
    const t0 = performance.now();
    window.scrollTo(0, target);
    let last = '', stable = 0;
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const d = window.__caha.debug();
      const key = d.shown ? `${d.shown.si}:${d.shown.f}` : 'none';
      /* A starved frame passes "the playhead converged" while the canvas still
         shows a neighbour (FIX R's nearest-resident fallback), which would make
         two runs incomparable. Require the drawn frame to BE the frame under the
         playhead — unless --loose is asked for the starved-frame case. */
      /* Deterministic across runs: the frame that belongs to the *target*
         position, not merely a neighbour within 1 — a ±1 frame difference is a
         different picture, and two runs of the same tier would then differ by
         content rather than by the thing under test (this is what made an
         earlier ?smoothing A/B unreadable). */
      const tracked = !d.shown || loose || Math.abs(d.shown.global - Math.round(d.target)) <= 1;
      if (Math.abs(d.target - d.playhead) <= 0.6 && tracked) {
        if (key === last && ++stable >= 5) {
          return { ok: true, ms: performance.now() - t0, shown: d.shown, playhead: d.playhead, target: d.target };
        }
        if (key !== last) stable = 0;
      } else stable = 0;
      last = key;
      if (performance.now() - t0 > budget) {
        return { ok: false, ms: performance.now() - t0, shown: d.shown, playhead: d.playhead, target: d.target };
      }
    }
  }, target, budgetMs, loose);
}

const main = async () => {
  if (!fs.existsSync(path.join(TIER_DIR, 'manifest.json'))) {
    console.error(`no manifest at ${TIER_DIR}/manifest.json — build the tier first`);
    process.exit(2);
  }
  const tierManifest = JSON.parse(fs.readFileSync(path.join(TIER_DIR, 'manifest.json'), 'utf8'));
  const scenes = tierManifest.scenes;
  // the source manifest sits next to assets/frames, as build-frames expects
  const srcManifest = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'manifest.json'), 'utf8'));

  const picks = ONLY || Array.from({ length: SAMPLES }, (_, i) =>
    Math.round(((i + 0.5) * scenes.length) / SAMPLES)).map((n) => Math.min(scenes.length, Math.max(1, n)));

  /* Only the tier under test resolves; everything else 404s, so the app
     cannot silently fall back to a different reel. `setDir` is asserted
     below, which catches a probe-order surprise instead of hiding it. */
  const tiers = {};
  for (const k of ['assets/web-m', 'assets/web-avif', 'assets/web', 'assets/frames', 'assets/web-960', 'assets/web-1600']) {
    tiers[k] = k === TIER ? TIER_DIR : path.join(ROOT, '__caha-tier-off__', k);
  }
  for (const [k, v] of Object.entries(OVERRIDES)) tiers[k] = v;

  const { server, port } = await startServer({ port: 0, tiers });
  const browser = await launch();
  const results = [];
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const client = await page.createCDPSession();
    /* puppeteer's setViewport does not apply deviceScaleFactor on this headless
       build: measured window.devicePixelRatio staying 1, so a "retina" run was
       really a 2x upscale of a CSS-resolution surface and every number from it
       was meaningless. Set the device metrics over CDP and assert that the page
       agrees before measuring anything. */
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: DPR,
      mobile: MODE === 'mobile', screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    if (MODE === 'mobile') {
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 6 });
      });
    } else {
      await page.evaluateOnNewDocument(() => {
        // the sandbox reports low RAM, which would flip the tier hint
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      });
    }
    const url = `http://127.0.0.1:${port}/?audit=1${QS ? '&' + QS : ''}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__caha && window.__caha.debug().shown', { timeout: 60000 });
    await page.addStyleTag({ content: HIDE_UI });

    const setDir = await page.evaluate(() => window.__caha.setDir);
    if (setDir !== EXPECT_DIR) {
      throw new Error(`tier probe served "${setDir}" but "${EXPECT_DIR}" was expected — refusing to measure the wrong reel`);
    }
    const pageDpr = await page.evaluate(() => window.devicePixelRatio);
    if (pageDpr !== DPR) throw new Error(`page devicePixelRatio is ${pageDpr}, expected ${DPR}`);
    const profile = await page.evaluate(() => ({ ...window.__caha.profile }));
    const maxScroll = await page.evaluate(() => window.__caha.maxScroll);
    const boxNow = () => page.evaluate(() => {
      const c = document.getElementById('frame');
      return { backingW: c.width, backingH: c.height, cssW: c.clientWidth, cssH: c.clientHeight };
    });

    for (const n of picks) {
      const scene = scenes[n - 1];
      if (!scene) continue;
      const frac = (n - 0.5) / scenes.length;
      const target = Math.round(frac * maxScroll);
      const st = await settleTo(page, target, 20000, LOOSE);
      if (!st.ok) { results.push({ scene: n, error: `did not settle (playhead ${st.playhead.toFixed(1)} of ${st.target})` }); continue; }

      const shotPath = path.join(SHOTS, `screen-${LABEL}-${MODE}-${VIEWPORT.width}x${VIEWPORT.height}-d${DPR}-s${n}.png`);
      if (KEEP) fs.mkdirSync(SHOTS, { recursive: true });
      /* Composited capture through CDP directly: the clip is in CSS px and the
         returned bitmap is in device px (asserted against sharp's metadata
         below). page.screenshot() validates the clip against layout metrics
         that headless-shell reports as zero-height in this sandbox. */
      /* No clip: a clipped capture on this headless build comes back from
         document space (blank/background, no fixed layer) and applies scale on
         top of the device scale factor. With the device-metrics override above,
         the plain viewport capture IS the composited device-pixel image —
         verified by probe at DPR 1/2/3, and asserted below. */
      const cap = await client.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(cap.data, 'base64');
      if (KEEP) fs.writeFileSync(shotPath, buf);
      const meta = await sharp(buf).metadata();
      const W = meta.width, H = meta.height;
      if (W !== VIEWPORT.width * DPR || H !== VIEWPORT.height * DPR) {
        results.push({ scene: n, error: `unexpected capture size ${W}x${H}` });
        continue;
      }

      /* Reference: the source JPEG for the frame the app says it is showing,
         cover-fitted to the same device box (the ideal rendering of it). */
      const srcScene = srcManifest.scenes[n - 1];
      /* the *tier's* step decides which source frame this delivered frame is:
         build-frames names the Nth kept source frame (n-1)*step+1 */
      const tierStep = tierManifest.step || 1;
      const srcIdx = (st.shown.f - 1) * tierStep + 1;
      // the source reel's own naming is not ours to assume: index the sorted list
      const srcFiles = fs.readdirSync(path.join(SRC, srcScene.id)).filter((f) => f.endsWith('.jpg')).sort();
      const srcFile = path.join(SRC, srcScene.id, srcFiles[Math.min(srcFiles.length - 1, Math.max(0, srcIdx - 1))]);
      const refRaw = await sharp(srcFile)
        .resize({ width: W, height: H, fit: 'cover', position: 'center', kernel: 'lanczos3' })
        .toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
      const shotRaw = await sharp(buf).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });

      const a = luma(shotRaw.data, shotRaw.info.channels);
      const b = luma(refRaw.data, refRaw.info.channels);

      /* optional: same-scene capture from another run (the ceiling) */
      let vs = null;
      if (AGAINST) {
        const refShot = path.join(SHOTS, `screen-${AGAINST}-${MODE}-${VIEWPORT.width}x${VIEWPORT.height}-d${DPR}-s${n}.png`);
        if (fs.existsSync(refShot)) {
          const other = await sharp(refShot).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
          if (other.info.width === W && other.info.height === H) {
            const o = luma(other.data, other.info.channels);
            vs = { against: AGAINST, psnr: +psnr(a, o).toFixed(2), ssim: +ssim(a, o, W, H).toFixed(4) };
          } else {
            vs = { against: AGAINST, error: `size ${other.info.width}x${other.info.height} != ${W}x${H}` };
          }
        } else {
          vs = { against: AGAINST, error: 'no reference capture' };
        }
      }
      const delivered = path.join(TIER_DIR, scene.id, `${tierManifest.prefix}${String(st.shown.f).padStart(tierManifest.pad, '0')}${tierManifest.ext}`);
      const deliveredBytes = fs.existsSync(delivered) ? fs.statSync(delivered).size : null;

      const canvasBox = await boxNow();
      const resCapNow = await page.evaluate(() => window.__caha.profile.resCap);
      results.push({
        scene: n, sceneId: scene.id, target: st.target, shown: st.shown, settleMs: Math.round(st.ms),
        device: `${W}x${H}`, backing: `${canvasBox.backingW}x${canvasBox.backingH}`,
        canvasCss: `${canvasBox.cssW}x${canvasBox.cssH}`, resCapNow,
        deliveredBytes, psnr: +psnr(a, b).toFixed(2), ssim: +ssim(a, b, W, H).toFixed(4),
        qs: QS || undefined, vs,
        shot: KEEP ? path.relative(ROOT, shotPath) : undefined,
      });
    }

    const ok = results.filter((r) => !r.error);
    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    const summary = {
      mode: MODE, tier: TIER, dpr: DPR, viewport: `${VIEWPORT.width}x${VIEWPORT.height}@${DPR}`,
      device: ok[0] ? ok[0].device : null, backing: ok[0] ? ok[0].backing : null,
      profileResCap: profile.resCap, samples: results.length,
      qs: QS || undefined,
      vsAgainst: AGAINST || undefined,
      vsCeilingPsnr: ok.filter((r) => r.vs && r.vs.psnr).length
        ? +mean(ok.filter((r) => r.vs && r.vs.psnr).map((r) => r.vs.psnr)).toFixed(2) : null,
      vsCeilingSsim: ok.filter((r) => r.vs && r.vs.ssim).length
        ? +mean(ok.filter((r) => r.vs && r.vs.ssim).map((r) => r.vs.ssim)).toFixed(4) : null,
      psnr: ok.length ? +mean(ok.map((r) => r.psnr)).toFixed(2) : null,
      ssim: ok.length ? +mean(ok.map((r) => r.ssim)).toFixed(4) : null,
      meanFrameBytes: ok.filter((r) => r.deliveredBytes).length
        ? Math.round(mean(ok.filter((r) => r.deliveredBytes).map((r) => r.deliveredBytes))) : null,
      results,
    };

    const report = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { tool: 'screen-quality', sets: [] };
    const key = `${MODE}:${TIER}:dpr${DPR}:${VIEWPORT.width}x${VIEWPORT.height}${QS ? ':' + QS : ''}:${TIER_DIR === path.join(ROOT, TIER) ? '' : path.basename(TIER_DIR)}`;
    report.sets = report.sets.filter((s) => `${s.mode}:${s.tier}:dpr${s.dpr}:${s.viewport.split('@')[0]}${s.qs ? ':' + s.qs : ''}` !== key);
    report.sets.push(summary);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

    console.log(`\ncaha screen-space quality · ${MODE} ${summary.viewport} · tier ${TIER}`);
    console.log(`device ${summary.device} · canvas backing ${summary.backing} · profile resCap ${profile.resCap}`);
    console.log('scene  frame            bytes   PSNR    SSIM   settle');
    for (const r of results) {
      if (r.error) { console.log(`${String(r.scene).padStart(5)}  ${r.error}`); continue; }
      console.log(`${String(r.scene).padStart(5)}  ${r.shown.si + 1}/${String(r.shown.f).padStart(3, '0')}  ` +
        `${String(r.deliveredBytes || '-').padStart(8)}  ${r.psnr.toFixed(2).padStart(6)}  ${r.ssim.toFixed(4)}  ${r.settleMs} ms`);
    }
    if (summary.psnr !== null) {
      console.log(`mean vs lanczos reference: ${summary.psnr} dB / SSIM ${summary.ssim}` +
        (summary.vsCeilingPsnr !== null ? ` · vs ${AGAINST} capture: ${summary.vsCeilingPsnr} dB / SSIM ${summary.vsCeilingSsim}` : '') +
        ` · mean frame ${summary.meanFrameBytes} B · → ${path.relative(ROOT, OUT)}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
