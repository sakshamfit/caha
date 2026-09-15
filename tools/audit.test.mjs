/* ============================================================
   Caha — fast regression gate for the scroll engine

     npm test

   Two layers, both cheap enough to run on every change:

     1. Source invariants that must not regress, checked by reading
        app.js: one rAF call site, one scroll listener, no layout
        reads in the frame path, no CSS transition on the progress
        fill, all input listeners passive.
     2. The committed real-browser audit (reports/browser-audit-v2.json)
        must exist, cover every scenario, and have every checklist
        assertion green. `reports/browser-audit-v2.1.json` is checked
        the other way round: the failures it records are the ones this
        pass claims to fix, so if they disappear from the *old* engine's
        report the comparison in AUDIT.md has gone stale.

   Run the browser harness itself with `npm run audit:browser`.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const app = read('app.js');
const css = read('style.css');

test('app.js and diagnostics.js parse', () => {
  for (const f of ['app.js', 'diagnostics.js']) {
    assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }));
  }
});

/* Pull the full argument text of every `name(` call, balancing parens so that
   multi-line callbacks (the scroll listener is one) are read whole. */
function callArgs(src, name) {
  const out = [];
  for (let i = src.indexOf(name + '('); i !== -1; i = src.indexOf(name + '(', i + 1)) {
    let depth = 0, j = i + name.length, str = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (str) { if (c === str && src[j - 1] !== '\\') str = null; continue; }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
  }
  return out;
}

test('one animation loop: every rAF call re-arms the same callback', () => {
  const calls = callArgs(app, 'requestAnimationFrame');
  assert.ok(calls.length >= 1, 'no animation loop at all');
  for (const c of calls) {
    assert.match(c, /requestAnimationFrame\(tick\)/,
      `a second animation loop would be started here: ${c.slice(0, 60)}…`);
  }
  // started once in boot(), re-armed once inside tick()
  assert.equal(calls.length, 2, `expected 2 rAF call sites (start + re-arm), found ${calls.length}`);
});

test('one passive scroll listener, and every compositor input listener is passive', () => {
  const registrations = callArgs(app, 'addEventListener');
  const compositorEvents = /'(wheel|touchstart|touchmove|touchend|scroll|pointerdown|mousedown|keydown)'/;
  for (const reg of registrations) {
    if (!compositorEvents.test(reg)) continue;
    assert.match(reg, /passive: true/, `non-passive listener: ${reg.slice(0, 70)}…`);
  }
  const scrolls = registrations.filter((r) => /^addEventListener\('scroll'/.test(r));
  assert.equal(scrolls.length, 1, 'scroll must be read in exactly one place');
});

test('no layout-triggering style writes in the frame path', () => {
  // transform/opacity are compositor-safe; width/height/top/left are not.
  const writes = [...app.matchAll(/\.style\.(width|height|top|left|right|bottom)\s*=/g)];
  for (const w of writes) {
    const line = app.slice(0, w.index).split('\n').pop();
    assert.match(line + w[0], /spacer|loader|progress/,
      `layout-writing style assignment in app.js: ${line.trim()}${w[0]}`);
  }
  assert.doesNotMatch(css, /#progress-fill[^}]*transition/,
    'the progress fill must not animate a layout property');
});

test('scroll metrics are measured on invalidation, not per frame', () => {
  assert.match(app, /function measure\(force\)/);
  assert.match(app, /deferredMeasures/);
  assert.match(app, /settleTO = setTimeout\(\(\) => \{ resizeCanvas\(\); drawKey = -2; \}, 500\)/);
});

test('the decoding cache has a single accounting path and in-flight guard', () => {
  assert.match(app, /function storeFrame\(/);
  const inserts = app.match(/cache\.set\([^)]*\{ bmp/g) || [];
  assert.equal(inserts.length, 1,
    `bitmaps must enter the cache only through storeFrame(); found ${inserts.length} insert sites`);
  assert.match(app, /inFlight/, 'the pump needs an in-flight set to avoid double decoding');
});

test('the live audit report has every scenario green', () => {
  const rep = json('reports/browser-audit-v2.json');
  assert.ok(rep.results.length >= 8, `only ${rep.results.length} scenarios recorded`);
  for (const r of rep.results) {
    assert.equal(r.error, undefined, `${r.name} errored: ${r.error}`);
    const failed = (r.checks || []).filter((c) => !c.pass);
    assert.equal(failed.length, 0,
      `${r.name} failed: ${failed.map((c) => `${c.name}=${c.value}`).join(', ')}`);
  }
});

test('the baseline reports still show the failures this pass fixes', () => {
  const base = json('reports/browser-audit-v2.1.json');
  const failed = base.results.flatMap((r) => (r.checks || []).filter((c) => !c.pass).map((c) => c.name));
  for (const needle of ['bitmap cache within budget', 'URL-bar change', 'autoplay yields to scrollbar']) {
    assert.ok(failed.some((f) => f.includes(needle)),
      `v2.1 baseline no longer records "${needle}" — AUDIT.md's comparison is stale`);
  }
});

test('delivery tier and manifest agree', () => {
  const m = json('assets/manifest.json');
  assert.ok(m.scenes.length > 0);
  for (const s of m.scenes) assert.ok(s.frames > 0 && s.id);
});

/* ---------- quality tier invariants (step "raise the film's quality") ------- */

/* Full source of a named function declaration, braces balanced. */
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `${name}() not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

test('screen-quality measures the film, not the UI chrome', () => {
  const t = read('tools/screen-quality.mjs');
  for (const sel of ['#vignette', '#wordmark', '#progress', '#loader']) {
    assert.ok(t.includes(sel), `screen-quality must hide ${sel} before capturing`);
  }
  assert.match(t, /setDir !== EXPECT_DIR/, 'screen-quality must refuse to measure a fallback tier');
  assert.match(t, /\(st\.shown\.f - 1\) \* tierStep \+ 1/,
    'the reference frame must be derived from the tier step, not assumed 1:1');
});

test('build-frames records how each tier was built', () => {
  /* A quality claim is only traceable if the tier says what produced it. */
  const b = read('tools/build-frames.mjs');
  for (const k of ['format', 'quality', 'width', 'step', 'normalize']) {
    assert.ok(b.includes(`${k}: `) || b.includes(`${k}:`), `manifest.built must record ${k}`);
  }
  assert.match(b, /withoutEnlargement: !NORMALIZE/, 'without --normalize, narrow scenes must not be upscaled');
});

test('a frame that was queued but never fetched can be requested again', () => {
  /* enqueue() trusts `requested` ("queued, in flight or resident"), but
     scheduleAround() rebuilds the queue on every playhead step — so a key that
     was dropped from the queue has to leave `requested` with it, or that frame
     becomes permanently unrequestable and the canvas can only approximate
     around it. Measured before FIX W: a settled playhead resting 6-9 frames
     off, indefinitely. */
  const body = fnBody(app, 'scheduleAround');
  assert.match(body, /for \(const k of requested\) if \(!cache\.has\(k\) && !inFlight\.has\(k\)\) requested\.delete\(k\)/,
    'scheduleAround must prune `requested` down to the live set');
  assert.match(body, /queue = \[\]/, 'the rebuild itself is still expected');
});

test('an approximated frame gets corrected when the exact one lands', () => {
  /* drawKey === g makes drawAt() a no-op for the rest of the stop, so the
     nearest-resident fallback (FIX R) would otherwise be final: the film could
     rest on a neighbour frame even after the real frame arrived. */
  const draw = fnBody(app, 'drawAt');
  assert.match(draw, /approxWant = usedFrame === frameNo \? null : \{ si, f: frameNo \}/,
    'drawAt must record what it had to approximate around');
  const tick = fnBody(app, 'tick');
  assert.match(tick, /if \(approxWant\)/, 'the tick must act on a pending approximation');
  assert.match(tick, /cacheGet\(keyOf\(approxWant\.si, approxWant\.f\)\)/,
    'the exact frame must be checked for residency before repainting');
});
