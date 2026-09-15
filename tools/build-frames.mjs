/* ============================================================
   Caha — frame payload build
   Turns the source reel (assets/frames, ~239 MB of ezgif JPEGs) into the
   tier the site serves:

     • resize     to --width with lanczos3. Without --normalize, sources
                  narrower than --width are left alone ("never upscale");
                  with it, every scene is resized to exactly --width so the
                  film has one sharpness instead of a step at every cut
                  (this reel mixes 11× 1920×1080 scenes with 3× 1280×720).
     • decimate   keep every Nth frame (--step). The playhead is damped, so
                 12 fps of source motion (step 2) is hard to distinguish from
                  24 while scrubbing, at half the bytes.
     • encode     WebP or AVIF. Measured on this reel at 1920 wide, AVIF is in
                 a different class from WebP — 70 KB/frame at PSNR 49.1 dB /
                 SSIM 0.9985 versus 120 KB at 40.0 dB / 0.9753 — which is why
                 the desktop tiers are AVIF.
     • denoise    median(3), OFF by default. It was tuned for WebP q60 in
                 pass 1, where it did save bytes; re-measured for the quality
                 tiers it costs bytes AND fidelity (scene-06, 1920 AVIF q60:
                 85 KB / 34.95 dB / SSIM 0.9812 with denoise versus 70 KB /
                 49.11 dB / SSIM 0.9985 without). Pass --denoise to re-enable.
                 Reproduce any of this with tools/frame-quality.mjs.

   Incremental: existing outputs are skipped, so re-runs are cheap. Note that
   changing --quality/--width does NOT invalidate existing files — pass --force
   (or build to a new --out) when changing settings.

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
const FORMAT = opt('format', 'avif');
const QUALITY = +opt('quality', FORMAT === 'avif' ? 60 : 80);
const WIDTH = +opt('width', 1920);
const STEP = +opt('step', 2);
const DENOISE = flag('denoise');
const FORCE = flag('force');
const NORMALIZE = flag('normalize');
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
  if (opt('dir', '')) return opt('dir', '');
  const rel = path.relative(ROOT, OUT);
  if (rel.startsWith('assets')) return rel.split(path.sep).join('/');
  return 'assets/' + path.basename(OUT);   // out-of-repo builds keep their tier name
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
    let pipe = sharp(path.join(srcDir, f)).resize({
      width: WIDTH,
      // --normalize: enlarge narrower scenes so the whole reel is one size
      withoutEnlargement: !NORMALIZE,
      kernel: 'lanczos3',
    });
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
  // how this tier was built (so a quality claim can be traced to settings)
  built: { dir: manifest_dir_label(), format: FORMAT, quality: QUALITY, width: WIDTH, step: STEP,
    denoise: DENOISE, normalize: NORMALIZE, at: new Date().toISOString().slice(0, 10) },
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
