/* ============================================================
   Caha — frame payload build
   Turns the source reel (assets/frames, ~239 MB of ezgif JPEGs) into
   the set the site actually serves (assets/web):

     • denoise   median(3) — the render's high-frequency noise is what
                 eats codec bits; removing it is nearly free visually
                 and cuts bytes a lot (measured: see AUDIT.md)
     • resize    to --width (never upscaled): 1920 sources → 1600
     • decimate  keep every Nth frame (--step 2): a scroll playhead is
                 damped, so 12 fps of source motion is indistinguishable
     • re-encode webp q60 (or avif q45 for ~40% less, slower)

   Incremental: existing outputs are skipped, so re-runs are cheap.

     node tools/build-frames.mjs                     # web set, defaults
     node tools/build-frames.mjs --format avif --quality 45
     node tools/build-frames.mjs --scenes 1,2 --force

   Env overrides: CAHA_SRC_FRAMES, CAHA_OUT_WEB
   ============================================================ */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes('--' + name);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.resolve(opt('src', process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames')));
const OUT = path.resolve(opt('out', process.env.CAHA_OUT_WEB || path.join(ROOT, 'assets/web')));
const FORMAT = opt('format', 'webp');
const QUALITY = +opt('quality', FORMAT === 'avif' ? 45 : 60);
const WIDTH = +opt('width', 1600);
const STEP = +opt('step', 2);
const DENOISE = !flag('no-denoise');
const FORCE = flag('force');
const CONC = +opt('concurrency', Math.max(2, os.cpus().length));
const ONLY = opt('scenes', '') ? opt('scenes', '').split(',').map((n) => +n) : null;

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'manifest.json'), 'utf8'));
const pad = (n, w) => String(n).padStart(w, '0');

const enc = (pipe) =>
  FORMAT === 'avif' ? pipe.avif({ quality: QUALITY, effort: 3, chromaSubsampling: '4:2:0' })
  : FORMAT === 'jpeg' ? pipe.jpeg({ quality: QUALITY, mozjpeg: true })
  : pipe.webp({ quality: QUALITY, effort: 4, smartSubsample: true });

async function work(items, fn) {
  let i = 0, done = 0;
  const workers = Array.from({ length: Math.min(CONC, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      done++;
      if (done % 100 === 0) process.stdout.write(`\r  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
  process.stdout.write(`\r  ${done}/${items.length}\n`);
}

function manifest_dir_label() {
  const rel = path.relative(ROOT, OUT);
  return rel.startsWith('assets') ? rel.split(path.sep).join('/') : 'assets/web';
}

const t0 = Date.now();
const summary = { format: FORMAT, quality: QUALITY, width: WIDTH, step: STEP, denoise: DENOISE, scenes: [] };
let totalBytes = 0, totalFiles = 0, skipped = 0;

for (let si = 0; si < manifest.scenes.length; si++) {
  const sc = manifest.scenes[si];
  if (ONLY && !ONLY.includes(si + 1)) continue;
  const srcDir = path.join(SRC, sc.id);
  const outDir = path.join(OUT, sc.id);
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.jpg')).sort();
  const picked = files.filter((_, idx) => idx % STEP === 0);
  console.log(`${sc.id}: ${files.length} src → ${picked.length} out`);

  await work(picked, async (f) => {
    const outN = Math.round(files.indexOf(f) / STEP) + 1;
    const outFile = path.join(outDir, `frame-${pad(outN, 4)}.${FORMAT}`);
    if (!FORCE && fs.existsSync(outFile)) { skipped++; totalBytes += fs.statSync(outFile).size; totalFiles++; return; }
    let pipe = sharp(path.join(srcDir, f)).resize({ width: WIDTH, withoutEnlargement: true });
    if (DENOISE) pipe = pipe.median(3);
    const buf = await enc(pipe).toBuffer();
    fs.writeFileSync(outFile, buf);
    totalBytes += buf.length;
    totalFiles++;
  });

  summary.scenes.push({ id: sc.id, title: sc.title, frames: picked.length });
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  brand: manifest.brand,
  fps: manifest.fps,
  dir: manifest_dir_label(),
  ext: '.' + FORMAT,
  prefix: 'frame-',
  pad: 4,
  step: STEP,
  width: WIDTH,
  scenes: summary.scenes.length ? summary.scenes : manifest.scenes.map((s) => ({ id: s.id, title: s.title, frames: Math.ceil(s.frames / STEP) })),
}, null, 2));

console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${totalFiles} files, ` +
  `${(totalBytes / 1048576).toFixed(1)} MB total, avg ${(totalBytes / totalFiles / 1024).toFixed(0)} KB, skipped ${skipped}`);
console.log('source reel was 239.4 MB / 4200 files');
