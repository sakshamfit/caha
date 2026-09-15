/* ============================================================
   Caha — frame quality measurement

   Answers "is the delivered film good enough, and is a change to the
   pipeline actually an improvement?" with numbers instead of vibes.

     # compare a built tier against the source reel
     node tools/frame-quality.mjs --tier assets/web --samples 3

     # compare several encodings without writing anything (grid mode)
     node tools/frame-quality.mjs --grid --scenes 6,7,13 \
       --settings 1280:webp:52,1600:webp:75,1920:avif:55,1920:webp:82

   Metrics, all against the *source* reel at the delivered resolution:
     • PSNR (dB, luma)      — absolute fidelity; +1 dB ≈ 1.26× less error
     • SSIM (8×8 blocks)     — structural similarity, closer to what the eye sees
     • bytes/frame, MB total — what it costs to ship
     • bits per pixel (bpp)  — the honest cross-resolution comparison

   A 720p source cannot honestly be compared to a 1080p delivery, so when the
   delivery is larger than the source the source is upscaled with lanczos3 and
   the report marks that scene "upscaled" — the PSNR there measures how well the
   resampler behaves, not invented detail.

   Env: CAHA_SRC_FRAMES (default assets/frames)
   ============================================================ */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes('--' + n);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames'));
const TIER = opt('tier', '');
const GRID = flag('grid');
const SAMPLES = +opt('samples', 3);
const ONLY = opt('scenes', '') ? opt('scenes', '').split(',').map(Number) : null;
const DENOISE = flag('denoise');
const SETTINGS = (opt('settings', '') || '1280:webp:52')
  .split(',').map((s) => {
    const [width, format, quality] = s.split(':');
    return { width: +width, format, quality: +quality };
  });

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'manifest.json'), 'utf8'));
const pad = (n, w) => String(n).padStart(w, '0');

/* ---------------- metrics ---------------- */
function luma(raw, channels) {
  // greyscale float in [0,255]; RGBA → Rec.601 luma
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

/* SSIM with non-overlapping 8×8 windows (the classic formula, sample-weighted).
   Non-overlapping blocks make it a "mean windowed SSIM" rather than the
   gaussian-windowed variant — consistent between variants, which is all a
   comparison needs, and it reports local structure loss (blocking, banding,
   smeared foliage) far better than PSNR alone. */
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

/* ---------------- encoding ---------------- */
function encode(pipe, { format, quality }) {
  if (format === 'avif') return pipe.avif({ quality, effort: 4, chromaSubsampling: '4:2:0' });
  if (format === 'jpeg') return pipe.jpeg({ quality, mozjpeg: true });
  return pipe.webp({ quality, effort: 4, smartSubsample: true });
}

async function measureFrame(srcFile, setting, { denoise = false } = {}) {
  const meta = await sharp(srcFile).metadata();
  let pipe = sharp(srcFile).resize({ width: setting.width, withoutEnlargement: true });
  if (denoise) pipe = pipe.median(3);
  const buf = await encode(pipe, setting).toBuffer();

  const decoded = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const targetW = decoded.info.width, targetH = decoded.info.height;

  let ref = sharp(srcFile);
  if (meta.width !== targetW) {
    ref = sharp(srcFile).resize({ width: targetW, withoutEnlargement: false, kernel: 'lanczos3' });
  }
  const rawRef = await ref.raw().toBuffer({ resolveWithObject: true });
  const ch = rawRef.info.channels;
  const A = luma(rawRef.data, ch);
  const B = luma(decoded.data, decoded.info.channels);
  return {
    bytes: buf.length,
    w: targetW, h: targetH,
    upscaled: meta.width < targetW,
    psnr: +psnr(A, B).toFixed(2),
    ssim: +ssim(A, B, targetW, targetH).toFixed(4),
    bpp: +((buf.length * 8) / (targetW * targetH)).toFixed(3),
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const main = async () => {
  const scenes = manifest.scenes
    .map((s, i) => ({ ...s, i }))
    .filter((s) => !ONLY || ONLY.includes(s.i + 1));

  console.log(`\ncaha frame quality · source ${SRC}`);
  console.log(GRID ? `grid mode (nothing written)${DENOISE ? ' + median(3) denoise' : ''}: ${SETTINGS.map((s) => `${s.width}:${s.format}:${s.quality}`).join('  ')}\n`
    : `tier ${TIER} vs source\n`);

  const all = [];
  for (const sc of scenes) {
    const srcDir = path.join(SRC, sc.id);
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.jpg')).sort();
    const picks = Array.from({ length: Math.min(SAMPLES, files.length) }, (_, k) =>
      files[Math.floor((k + 0.5) * files.length / Math.min(SAMPLES, files.length))]);
    const rows = [];
    for (const f of picks) {
      const srcFile = path.join(srcDir, f);
      if (GRID) {
        const cells = [];
        for (const setting of SETTINGS) {
          // denoise is measured as a separate row, not mixed into the grid
          cells.push({ setting, ...(await measureFrame(srcFile, setting, { denoise: DENOISE })) });
        }
        rows.push({ f, cells });
        continue;
      }
      // tier comparison: the tier's own file for this frame index
      const tierDir = path.join(ROOT, TIER, sc.id);
      const cands = fs.existsSync(tierDir)
        ? fs.readdirSync(tierDir).filter((x) => /\.(webp|avif|jpe?g)$/.test(x)).sort() : [];
      if (!cands.length) { rows.push({ f, cells: [] }); continue; }
      const idx = files.indexOf(f);
      const pick = cands[Math.min(cands.length - 1, Math.round((idx / files.length) * cands.length))];
      const buf = fs.readFileSync(path.join(tierDir, pick));
      const decoded = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const meta = await sharp(srcFile).metadata();
      const rawRef = await sharp(srcFile).raw().toBuffer({ resolveWithObject: true });
      const A = luma(rawRef.data, rawRef.info.channels);
      const B = luma(decoded.data, decoded.info.channels);
      rows.push({
        f, cells: [{
          setting: { width: 'tier', format: path.extname(pick).slice(1), quality: '-' },
          bytes: buf.length, w: decoded.info.width, h: decoded.info.height,
          upscaled: meta.width < decoded.info.width,
          psnr: +psnr(A, B).toFixed(2), ssim: +ssim(A, B, decoded.info.width, decoded.info.height).toFixed(4),
          bpp: +((buf.length * 8) / (decoded.info.width * decoded.info.height)).toFixed(3),
        }],
      });
    }
    const flat = rows.flatMap((r) => r.cells);
    const summary = {
      scene: sc.id,
      frames: files.length,
      srcRes: `${(await sharp(path.join(srcDir, files[0])).metadata()).width}px`,
      n: flat.length,
      kB: flat.length ? Math.round(mean(flat.map((c) => c.bytes)) / 1024) : 0,
      psnr: flat.length ? +mean(flat.map((c) => c.psnr)).toFixed(2) : null,
      ssim: flat.length ? +mean(flat.map((c) => c.ssim)).toFixed(4) : null,
      bpp: flat.length ? +mean(flat.map((c) => c.bpp)).toFixed(3) : null,
      upscaled: flat.some((c) => c.upscaled),
    };
    if (GRID) {
      summary.per = {};
      for (let k = 0; k < SETTINGS.length; k++) {
        const cells = rows.map((r) => r.cells[k]).filter(Boolean);
        summary.per[`${SETTINGS[k].width}:${SETTINGS[k].format}:${SETTINGS[k].quality}`] = cells.length ? {
          kB: Math.round(mean(cells.map((c) => c.bytes)) / 1024),
          psnr: +mean(cells.map((c) => c.psnr)).toFixed(2),
          ssim: +mean(cells.map((c) => c.ssim)).toFixed(4),
          bpp: +mean(cells.map((c) => c.bpp)).toFixed(3),
        } : null;
      }
    }
    all.push(summary);
  }

  if (GRID) {
    for (const row of all) {
      console.log(`${row.scene}  (${row.frames} frames, ${row.srcRes}${row.upscaled ? ', upscaled' : ''})`);
      for (const [name, m] of Object.entries(row.per)) {
        console.log(`   ${name.padEnd(18)} ${String(m.kB).padStart(4)} KB  PSNR ${String(m.psnr).padStart(6)} dB  SSIM ${m.ssim.toFixed(4)}  ${m.bpp} bpp`);
      }
    }
    // totals: MB for a full step-N reel at these settings
    const step = +opt('step', 2);
    const measuredFrames = all.reduce((a, row) => a + row.frames, 0);
    const reelFrames = manifest.scenes.reduce((a, s) => a + s.frames, 0);
    console.log(`\nreel at step ${step}: ${Math.round(reelFrames / step)} files ` +
      `(measured ${measuredFrames} source frames = ${(100 * measuredFrames / reelFrames).toFixed(0)} % of the reel)`);
    for (const [name] of SETTINGS.map((s) => [`${s.width}:${s.format}:${s.quality}`])) {
      const bytesMeasured = all.reduce((a, row) => a + (row.frames / step) * row.per[name].kB * 1024, 0);
      // scale the measured share up to the whole reel
      const total = bytesMeasured * (reelFrames / measuredFrames);
      console.log(`   ${name.padEnd(18)} ${(total / 1048576).toFixed(1)} MB`);
    }
    console.log('');
    return;
  }

  console.log(`${'scene'.padEnd(10)} ${'src'.padEnd(7)} ${'kB'.padStart(5)} ${'PSNR'.padStart(7)} ${'SSIM'.padStart(8)} ${'bpp'.padStart(6)}`);
  for (const row of all) {
    console.log(`${row.scene.padEnd(10)} ${row.srcRes.padEnd(7)} ${String(row.kB).padStart(5)} ${String(row.psnr).padStart(7)} ${String(row.ssim).padStart(8)} ${String(row.bpp).padStart(6)}`);
  }
  const flat = all.filter((r) => r.psnr !== null);
  console.log(`${'mean'.padEnd(10)} ${''.padEnd(7)} ${String(Math.round(mean(flat.map((r) => r.kB)))).padStart(5)} ${String(+mean(flat.map((r) => r.psnr)).toFixed(2)).padStart(7)} ${String(+mean(flat.map((r) => r.ssim)).toFixed(4)).padStart(8)}`);
  console.log('');
};

main().catch((e) => { console.error(e); process.exit(1); });
