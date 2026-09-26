/* ============================================================
   Caha — zero-dependency static server for local dev & preview
     node tools/serve.mjs [port]

   Serves the repo root, with two conveniences:
     • CAHA_SRC_FRAMES / CAHA_WEB_DIR env vars let the (large) frame
       sets live OUTSIDE the repo while the site runs normally.
     • Frames are served with immutable cache headers (they never
       change), documents/manifest with no-cache (they do).

   The server can also be imported (tools/browser-audit.mjs does) —
   `startServer()` returns the http server; the CLI path only runs
   when this file is executed directly.
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_TIERS = () => ({
  'assets/web-m': process.env.CAHA_WEBM_DIR || path.join(ROOT, 'assets/web-m'),
  'assets/web-avif': process.env.CAHA_WEBAVIF_DIR || path.join(ROOT, 'assets/web-avif'),
  'assets/web': process.env.CAHA_WEB_DIR || path.join(ROOT, 'assets/web'),
  'assets/frames': process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames'),
  'assets/web-960': process.env.CAHA_WEB960_DIR || path.join(ROOT, 'assets/web-960'),
  'assets/web-1600': process.env.CAHA_WEB1600_DIR || path.join(ROOT, 'assets/web-1600'),
});

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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const safeJoin = (base, rel) => {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
};

export function createHandler(tiers = DEFAULT_TIERS(), root = ROOT) {
  const TIERS = Object.entries(tiers);
  return (req, res) => {
    /* A preview proxy or a fuzzing client can send anything, including paths
       that are not valid URLs on their own ('//' resolves to a schemeless
       absolute URL and throws). An exception here used to take the whole
       process down — which is how the live preview died — so parse defensively
       and treat anything unparseable as a 400. */
    let pathname;
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('400 bad request');
      return;
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    pathname = pathname.replace(/\/+/g, '/');

    // tier roots first (they may live outside the repo)
    let file = null;
    for (const [prefix, dir] of TIERS) {
      if (pathname.startsWith('/' + prefix + '/')) {
        file = safeJoin(dir, pathname.slice(prefix.length + 2));
        break;
      }
    }
    if (!file) file = safeJoin(root, pathname);

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
  };
}

export function startServer({ port = 0, host = '0.0.0.0', tiers, root } = {}) {
  const handler = createHandler(tiers, root);
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      console.error('serve error:', err && err.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('500 ' + (err && err.message));
    }
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port }));
  });
}

/* CLI: node tools/serve.mjs [port] */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const PORT = +(process.argv[2] || process.env.PORT || 5173);
  const TIERS = DEFAULT_TIERS();
  startServer({ port: PORT }).then(() => {
    console.log(`caha serving on http://0.0.0.0:${PORT}`);
    console.log(`  frames : ${TIERS['assets/frames']}`);
    for (const [prefix, dir] of Object.entries(TIERS)) {
      const ok = prefix === 'assets/frames' ? true : fs.existsSync(path.join(dir, 'manifest.json'));
      console.log(`  ${prefix.padEnd(15)}: ${ok ? dir : '(not built)'}`);
    }
  });
}
