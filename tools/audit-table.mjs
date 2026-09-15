/* ============================================================
   Caha — turn browser-audit reports into a markdown table

     node tools/audit-table.mjs v1 v2.1 v2            # compare labels
     node tools/audit-table.mjs --scenario desktop/wheel v1 v2.1 v2

   Each label is reports/browser-audit-<label>.json, written by
   tools/browser-audit.mjs. Missing labels / scenarios print as "–"
   so a half-finished matrix is still readable.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const only = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1] : '';
const labels = argv.filter((a) => !a.startsWith('--') && a !== only);

const read = (label) => {
  const f = path.join(ROOT, 'reports', `browser-audit-${label}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const reports = labels.map(read);
const scenarios = [...new Set(reports.filter(Boolean).flatMap((r) => r.results.map((x) => x.name)))]
  .filter((n) => !only || n === only);

const get = (rep, sc) => (rep ? rep.results.find((r) => r.name === sc) : null);
const num = (v, d = 2) => (v === null || v === undefined ? '–' : (typeof v === 'number' ? +v.toFixed(d) : v));

const METRICS = [
  ['ticks sampled', (r) => r.ticks, 0],
  ['forced layouts / frame', (r) => r.blink.layoutPerTick, 4],
  ['style recalcs / frame', (r) => r.blink.recalcPerTick, 3],
  ['script ms / frame', (r) => r.blink.scriptMsPerTick, 3],
  ['long tasks (worst ms)', (r) => `${r.longTasks.count} (${r.longTasks.worstMs})`, 0],
  ['rAF loops', (r) => r.rafLoops, 0],
  ['non-passive listeners', (r) => r.nonPassive, 0],
  ['draws with nothing to show', (r) => (r.engineStats ? r.engineStats.missed : null), 0],
  ['substitute frames drawn', (r) => (r.engineStats ? r.engineStats.approx : null), 0],
  ['frames advanced / moving tick', (r) => (r.motion ? r.motion.framesPerMovingTick : null), 2],
  ['starvation p95 (frames)', (r) => r.lag.playheadToShown.p95, 2],
  ['damping lag p95 (frames)', (r) => r.lag.dampLag.p95, 2],
  ['stutter (jitter mean)', (r) => (r.jitter ? r.jitter.mean : null), 2],
  ['seek convergence (ms)', (r) => (r.seeks && r.seeks.length ? r.seeks.map((s) => s.convergenceMs).join('/') : null), 0],
  ['bitmap cache MB (budget)', (r) => (r.engineStats ? r.engineStats.cacheMB : null), 1],
  ['payload MB in run', (r) => (r.engineStats ? r.engineStats.netMB : null), 2],
  ['cache evictions', (r) => (r.engineStats ? r.engineStats.evicted : null), 0],
];

for (const sc of scenarios) {
  console.log(`\n### ${sc}\n`);
  console.log(`| metric | ${labels.join(' | ')} |`);
  console.log(`|---|${labels.map(() => '---').join('|')}|`);
  for (const [name, fn, d] of METRICS) {
    const cells = labels.map((l, i) => num(fn(get(reports[i], sc) || {}), d));
    if (cells.every((c) => c === '–')) continue;
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  }
  const checks = labels.map((l, i) => {
    const r = get(reports[i], sc);
    if (!r || !r.checks) return '–';
    const failed = r.checks.filter((c) => !c.pass);
    return failed.length ? `${failed.length} ✗` : 'all ✓';
  });
  console.log(`| checklist | ${checks.join(' | ')} |`);
}

const extras = ['mobile/urlbar-4x', 'desktop/autoplay'].filter((s) => scenarios.includes(s) || !only);
console.log('');
for (const sc of extras) {
  let printed = false;
  for (const [i, l] of labels.entries()) {
    const r = get(reports[i], sc);
    if (!r || !r.log) continue;
    const ub = (r.log.find((x) => x.urlBar) || {}).urlBar;
    const ap = (r.log.find((x) => x.autoplay) || {}).autoplay;
    if (ub) {
      if (!printed) { console.log(`\n**${sc}**`); printed = true; }
      console.log(`- ${l}: Δscroll ${ub.dScroll}px, ΔmaxScroll ${ub.dMaxScroll}px, Δdisplayed frame ${ub.dShown}`);
    }
    if (ap) {
      if (!printed) { console.log(`\n**${sc}**`); printed = true; }
      console.log(`- ${l}: wheel stops autoplay=${ap.wheelStopped}, scrollbar drag yields=${ap.dragYielded}, position respected=${ap.dragRespected}`);
    }
  }
}
console.log('');
