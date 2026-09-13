/* ============================================================
   Caha — zero-dependency static server for local dev & preview
     node tools/serve.mjs [port]

   Serves the repo root, with two conveniences:
     • CAHA_SRC_FRAMES / CAHA_WEB_DIR env vars let the (large) frame
       sets live OUTSIDE the repo while the site runs normally.
     • Frames are served with immutable cache headers (they never
       change), documents/manifest with no-cache (they do).
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.argv[2] || process.env.PORT || 5173);
const FRAMES_DIR = process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames');
const WEB_DIR = process.env.CAHA_WEB_DIR || path.join(ROOT, 'assets/web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const safeJoin = (base, rel) => {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // external frame roots
  let file = null;
  if (pathname.startsWith('/assets/web/')) file = safeJoin(WEB_DIR, pathname.slice('/assets/web/'.length));
  else if (pathname.startsWith('/assets/frames/')) file = safeJoin(FRAMES_DIR, pathname.slice('/assets/frames/'.length));
  else file = safeJoin(ROOT, pathname);

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404 ' + pathname);
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const immutable = ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.avif';
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': fs.statSync(file).size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'access-control-allow-origin': '*',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`caha serving on http://0.0.0.0:${PORT}`);
  console.log(`  frames : ${FRAMES_DIR}`);
  console.log(`  web set: ${fs.existsSync(path.join(WEB_DIR, 'manifest.json')) ? WEB_DIR : '(not built — falling back to source frames)'}${process.env.CAHA_WEB_DIR ? '' : ''}`);
});
