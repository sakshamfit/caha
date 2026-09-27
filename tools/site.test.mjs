/* ============================================================
   cahā — static checks for the scroll site (index.html)
   Runs with `npm test` (node --test tools/*.test.mjs) next to the
   legacy film's audit.test.mjs. No browser needed; for the real-browser
   scrub check see tools/site-check.mjs (`npm run check:site`).
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('index.html');
const css = read('site/site.css');
const engine = read('site/scroll-canvas.js');
const manifest = JSON.parse(read('assets/manifest.json'));
const frameCount = Object.fromEntries(manifest.scenes.map((s) => [s.id, s.frames]));

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};

/* chapters = <section … data-chapter …> … </section> (chapters never nest sections) */
const chapters = [...html.matchAll(/<section\b[^>]*\bdata-chapter\b[^>]*>[\s\S]*?<\/section>/g)].map((m) => {
  const block = m[0];
  const open = block.match(/^<section\b[^>]*>/)[0];
  const beats = [...block.matchAll(/<article\b[^>]*\bdata-beat\b[^>]*>/g)].map((b) => ({
    tag: b[0],
    scene: attr(b[0], 'data-scene'),
    from: +attr(b[0], 'data-from'),
    to: +attr(b[0], 'data-to'),
    align: attr(b[0], 'data-align'),
  }));
  return {
    block,
    id: attr(open, 'id'),
    scenes: (attr(open, 'data-scenes') || '').trim().split(/\s+/).filter(Boolean),
    style: attr(open, 'style') || '',
    beats,
  };
});

test('the chapters play the whole reel, in order, each scene once', () => {
  assert.ok(chapters.length >= 2, 'expected several chapters');
  const played = chapters.flatMap((c) => c.scenes);
  assert.deepEqual(played, manifest.scenes.map((s) => s.id));
});

test('each chapter is a sticky stage with a canvas, dots and a matching --scenes', () => {
  const ids = new Set();
  for (const c of chapters) {
    assert.ok(c.id && !ids.has(c.id), `chapter needs a unique id (${c.id})`);
    ids.add(c.id);
    assert.match(c.block, /class="chapter__stage"/, `${c.id}: no .chapter__stage`);
    assert.match(c.block, /<canvas\b[^>]*class="chapter__canvas"/, `${c.id}: no canvas`);
    assert.match(c.block, /class="chapter__dots"/, `${c.id}: no dots container`);
    const n = c.style.match(/--scenes:\s*(\d+)/);
    assert.ok(n, `${c.id}: inline --scenes missing (sizes the section before JS runs)`);
    assert.equal(+n[1], c.scenes.length, `${c.id}: --scenes does not match data-scenes`);
  }
});

test('story beats are valid, in order and non-overlapping within a chapter', () => {
  for (const c of chapters) {
    assert.ok(c.beats.length > 0, `${c.id}: no beats`);
    let last = null;
    for (const b of c.beats) {
      const where = `${c.id} beat ${b.scene} ${b.from}-${b.to}`;
      assert.ok(c.scenes.includes(b.scene), `${where}: scene not in this chapter`);
      assert.ok(Number.isInteger(b.from) && Number.isInteger(b.to), `${where}: from/to must be frame numbers`);
      assert.ok(b.from >= 1 && b.to <= frameCount[b.scene] && b.from < b.to, `${where}: range outside 1–${frameCount[b.scene]}`);
      assert.ok(b.align === 'left' || b.align === 'right', `${where}: data-align must be left|right`);
      const pos = c.scenes.indexOf(b.scene) * 1e4;
      if (last) assert.ok(pos + b.from > last, `${where}: overlaps or precedes the previous beat`);
      last = pos + b.to;
    }
  }
});

test('every local file index.html and site.css reference exists', () => {
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href)="([^"#][^"]*)"/g)) refs.add(m[1]);
  for (const m of css.matchAll(/url\('\.\.\/([^']+)'\)/g)) refs.add(m[1]);
  const local = [...refs].filter((r) => !/^(https?:|data:|mailto:|tel:)/.test(r));
  assert.ok(local.length > 20, 'expected the page to reference its assets');
  const missing = local.filter((r) => !fs.existsSync(path.join(ROOT, decodeURI(r.split(/[?#]/)[0]))));
  assert.deepEqual(missing, []);
});

test('no third-party requests: fonts and GSAP are served from the repo', () => {
  assert.doesNotMatch(html, /<(?:link|script)\b[^>]*(?:href|src)="https?:/, 'index.html loads a remote stylesheet or script');
  assert.doesNotMatch(css, /url\(['"]?https?:/, 'site.css loads a remote resource');
  for (const f of ['gsap.min.js', 'ScrollTrigger.min.js']) {
    const head = read(`vendor/gsap/${f}`).slice(0, 200);
    assert.match(head, /3\.15\.0/, `vendor/gsap/${f} should be GSAP 3.15.0 (the reference's version)`);
  }
  assert.match(read('tools/serve.mjs'), /'\.woff2': 'font\/woff2'/, 'serve.mjs must send fonts with a font MIME type');
});

test('scroll system: GSAP ScrollTrigger scrub over a sticky stage, as in the reference', () => {
  assert.match(engine, /start:\s*'top top'/);
  assert.match(engine, /end:\s*'bottom bottom'/);
  assert.match(engine, /scrub:\s*SCRUB/);
  assert.match(engine, /const SCRUB = reducedMotion \? true : 0\.5/);
  assert.match(css, /\.chapter__stage\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/);
  assert.match(css, /\.chapter\s*\{[^}]*height:\s*calc\(var\(--scenes[^)]*\)\s*\*\s*var\(--scene-height\)\s*\+\s*100vh\)/);
});

/* the full argument list of every addEventListener('<type>', …) call, by paren matching */
function listenerCalls(src, types) {
  const out = [];
  const re = new RegExp(`addEventListener\\('(${types.join('|')})'`, 'g');
  for (const m of src.matchAll(re)) {
    let i = m.index + 'addEventListener'.length, depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push({ type: m[1], args: src.slice(start, i + 1) });
  }
  return out;
}

test('input listeners are passive, and frames are drawn cover-fit', () => {
  const types = ['scroll', 'resize', 'wheel', 'touchstart', 'touchmove'];
  const engineCalls = listenerCalls(engine, types);
  assert.ok(engineCalls.length >= 2, 'expected the engine to listen to scroll + resize');
  for (const c of [...engineCalls, ...listenerCalls(read('site/site.js'), types)]) {
    assert.match(c.args, /\{\s*passive:\s*true\s*\}\s*\)$/, `a '${c.type}' listener is not passive`);
  }
  assert.match(engine, /Math\.max\(cw \/ iw, chh \/ ih\)/, 'drawCover should scale to cover');
});

test('the legacy single-canvas film is preserved at film.html, and its tools follow it', () => {
  const film = read('film.html');
  assert.match(film, /<script src="app\.js"/);
  assert.match(read('tools/browser-audit.mjs'), /url = '\/film\.html'/);
  assert.match(read('tools/screen-quality.mjs'), /\/film\.html\?audit=1/);
  assert.match(read('tools/decode-cost.mjs'), /\/film\.html/);
});
