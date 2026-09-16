/* ============================================================
   Caha — fetch the source reel
     node tools/fetch-frames.mjs [--ref <branch>] [--remote <name>] [--force]

   The 4,200 source JPEGs (239 MB) are deliberately not in this branch's
   history (assets/frames/ is gitignored), but tools/build-frames.mjs needs
   them as input — so on a clean clone `npm run build:frames` fails with
   ENOENT and the site reports "No frames loaded". This pulls the reel out
   of the branch that carries it, into assets/frames/ (or CAHA_SRC_FRAMES),
   without touching the checked-out branch: a depth-1 fetch to FETCH_HEAD,
   then `git archive` → tar, which is exactly the manual recipe in README.md.

   Env: CAHA_SRC_FRAMES  where to put the reel (default assets/frames)
        CAHA_FRAMES_REF  branch that carries it (default arena/01a09a10-caha)
   ============================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes('--' + name);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.resolve(process.env.CAHA_SRC_FRAMES || path.join(ROOT, 'assets/frames'));
const REF = opt('ref', process.env.CAHA_FRAMES_REF || 'arena/01a09a10-caha');
const REMOTE = opt('remote', 'origin');
const FORCE = flag('force');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
const countJpgs = (dir) => {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const scene of fs.readdirSync(dir)) {
    const p = path.join(dir, scene);
    if (scene.startsWith('scene-') && fs.statSync(p).isDirectory()) {
      n += fs.readdirSync(p).filter((f) => f.endsWith('.jpg')).length;
    }
  }
  return n;
};

const have = countJpgs(DEST);
if (have > 0 && !FORCE) {
  console.log(`source reel already present: ${have} frames in ${DEST} (pass --force to re-extract)`);
  process.exit(0);
}

const t0 = Date.now();
console.log(`fetching ${REMOTE}/${REF} (depth 1) — the reel is ~240 MB, this can take a minute`);
try {
  // FETCH_HEAD only: no local branch is created and the checkout is untouched.
  execFileSync('git', ['fetch', '--depth=1', REMOTE, REF], { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  console.error(`\nfetch-frames: could not fetch ${REMOTE}/${REF} (${err.message})`);
  console.error('  If the frames live somewhere else, point the tooling at them instead:');
  console.error('    CAHA_SRC_FRAMES=/path/to/frames npm run build:frames');
  process.exit(1);
}

const tarFile = path.join(os.tmpdir(), `caha-frames-${process.pid}.tar`);
try {
  console.log(`extracting assets/frames → ${DEST}`);
  execFileSync('git', ['archive', '-o', tarFile, 'FETCH_HEAD', 'assets/frames'], { cwd: ROOT, stdio: 'inherit' });
  fs.mkdirSync(DEST, { recursive: true });
  // the archive is rooted at assets/frames/<scene>/…; drop those two components
  execFileSync('tar', ['-xf', tarFile, '--strip-components=2', '-C', DEST], { stdio: 'inherit' });
} finally {
  fs.rmSync(tarFile, { force: true });
}

// build-frames reads the reel's manifest from next to the frames directory;
// the repo already has it at assets/manifest.json, an out-of-repo copy needs one.
const manifestOut = path.join(DEST, '..', 'manifest.json');
if (!fs.existsSync(manifestOut)) {
  fs.writeFileSync(manifestOut, git('show', 'FETCH_HEAD:assets/manifest.json'));
  console.log(`wrote ${manifestOut}`);
}

const got = countJpgs(DEST);
if (got === 0) {
  console.error(`\nfetch-frames: ${REMOTE}/${REF} has no assets/frames/scene-*/… JPEGs`);
  process.exit(1);
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${got} frames in ${DEST}`);
console.log('next: npm run build:tiers   (the two measured tiers the site ships)');
