#!/usr/bin/env node
/* ============================================================
   Caha — what a delivered frame actually costs to decode

   screen-quality.mjs says how good a tier looks; this says what
   it costs. Starvation (the film drawing an approximated frame
   because the exact one has not arrived) is decided by
   milliseconds-per-frame, not by bytes, so the tier's resolution
   and codec have to be chosen against a measured decode budget:

     decodes needed per second of scrolling  =  scroll px/s ÷ px per frame
     decode time per second                  =  that × ms/frame
     ...the surplus is what keeps the screen on the frame the
     scrollbar is pointing at.

   Measures the real thing in the real browser: fetch (warm server)
   + createImageBitmap over N frames per tier, reporting medians and
   p95s. Run it on the same box the audit runs on — software
   rasterization makes absolute numbers pessimistic, but the RANKING
   between tiers is what the decision needs.

   Usage: node tools/decode-cost.mjs --tiers assets/web,assets/web-avif,assets/web-m --frames 24
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const TIERS = (opt('tiers', 'assets/web-avif,assets/web,assets/web-m') || '').split(',').filter(Boolean);
const FRAMES = +opt('frames', 24);
const SCENES = (opt('scenes', '6,10') || '').split(',').map(Number);

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
    const libBr = path.join(ROOT, 'node_modules/@sparticuz/chromium/bin/al2023.tar.bz2');
    const libBr2 = path.join(ROOT, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br');
    const src = fs.existsSync(libBr) ? libBr : libBr2;
    if (!fs.existsSync(libDir) && fs.existsSync(src)) {
      const zlib = await import('node:zlib');
      const tarFile = path.join(os.tmpdir(), 'al2023', 'al2023.tar');
      fs.mkdirSync(path.dirname(tarFile), { recursive: true });
      fs.writeFileSync(tarFile, zlib.brotliDecompressSync(fs.readFileSync(src)));
      const { execFileSync } = await import('node:child_process');
      execFileSync('tar', ['-xf', tarFile, '-C', path.dirname(tarFile)]);
    }
    env = { ...process.env, LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  }
  return puppeteer.launch({ executablePath, args, headless: 'shell', env, protocolTimeout: 180000 });
}

const main = async () => {
  const { server, port } = await startServer({ port: 0 });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/film.html`, { waitUntil: 'domcontentloaded' });
    console.log(`\ncaha decode cost · chromium ${await browser.version()} · ${os.cpus().length} cpus\n`);
    console.log('tier                 frames  MPix    kB/f  fetch ms  decode ms (med/p95)  bytes/frame');
    for (const tier of TIERS) {
      const mf = path.join(ROOT, tier, 'manifest.json');
      if (!fs.existsSync(mf)) { console.log(`${tier.padEnd(20)} (no manifest)`); continue; }
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const urls = [];
      for (const n of SCENES) {
        const sc = m.scenes[n - 1];
        if (!sc) continue;
        const per = Math.ceil(FRAMES / SCENES.length);
        for (let i = 0; i < per; i++) {
          const f = Math.min(sc.frames, 10 + i * Math.floor(sc.frames / per));
          urls.push(`/${tier}/${sc.id}/${m.prefix}${String(f).padStart(m.pad, '0')}${m.ext}`);
        }
      }
      const res = await page.evaluate(async (urls) => {
        const out = [];
        for (const u of urls) {
          const t0 = performance.now();
          const r = await fetch(u);
          const blob = await r.blob();
          const t1 = performance.now();
          const bmp = await createImageBitmap(blob);
          const t2 = performance.now();
          out.push({ fetch: t1 - t0, decode: t2 - t1, bytes: blob.size, w: bmp.width, h: bmp.height });
          bmp.close();
        }
        return out;
      }, urls);
      const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
      const dec = res.map((r) => r.decode), fet = res.map((r) => r.fetch);
      const { w, h, bytes } = res[0];
      console.log(`${tier.padEnd(20)} ${String(res.length).padStart(6)}  ` +
        `${((w * h) / 1e6).toFixed(2)}  ${(bytes / 1024).toFixed(0).padStart(6)}  ` +
        `${med(fet).toFixed(1).padStart(8)}  ${med(dec).toFixed(1).padStart(9)}/${p95(dec).toFixed(1).padEnd(6)}  ` +
        `${w}x${h}`);
    }
    console.log('');
  } finally {
    await browser.close();
    server.close();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
