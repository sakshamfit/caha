/* ============================================================
   Caha — scroll audit harness
   Enable with ?audit=1  (or Ctrl+Shift+A).

   This is the Step-1 checklist from the brief, automated. It
   instruments the page *from the outside* so it can be dropped into
   ANY scroll-driven site (it has no dependency on app.js):

     #3/#12  how many requestAnimationFrame loops are alive
     #4      is the render work inside the scroll tick (blits/frame)
     #5      forced-layout: layout reads & scroll writes per frame
     #6      compositing hints / full-screen effect layers
     #8      html/body overflow + double-scroll detection
     #11     non-passive wheel/touch/scroll listeners (compositor blockers)
     plus    fps / frame-time percentiles, payload bytes, decoded-bitmap bytes

   It reports into window.__cahaAudit and renders a small overlay.
   ============================================================ */
(() => {
  'use strict';
  const enabled = () =>
    new URLSearchParams(location.search).has('audit') || sessionStorage.getItem('caha-audit') === '1';
  if (!enabled()) {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        sessionStorage.setItem('caha-audit', '1');
        location.reload();
      }
    });
    return;
  }

  const report = {
    startedAt: Date.now(),
    raf: { loops: 0, loopStacks: [], calls: 0 },
    layout: { scrollHeightReads: 0, scrollWrites: 0, rectReads: 0, offsetReads: 0 },
    listeners: { nonPassive: [] },
    dom: {},
    frames: { count: 0, times: [], long: 0, worst: 0 },
  };

  /* ---- #12 / #3: count live rAF loops (self-rescheduling chains) ---- */
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const loops = new Set();
  let running = null;
  window.requestAnimationFrame = (cb) => {
    report.raf.calls++;
    // a callback that re-arms itself while it is running == one live loop
    if (running === cb && !cb.__cahaDiag) loops.add(cb);
    return nativeRAF((t) => {
      const prev = running;
      running = cb;
      try { cb(t); } finally { running = prev; }
    });
  };

  /* ---- #5: forced synchronous layout detectors ---- */
  const bump = (k) => { report.layout[k]++; };
  for (const proto of [Element.prototype, Document.prototype]) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    if (d && d.get) {
      Object.defineProperty(proto, 'scrollHeight', { ...d, get() { bump('scrollHeightReads'); return d.get.call(this); } });
    }
  }
  const g = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...a) { bump('rectReads'); return g.apply(this, a); };
  for (const prop of ['offsetTop', 'offsetHeight', 'offsetWidth', 'clientHeight']) {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (d && d.get) Object.defineProperty(HTMLElement.prototype, prop, { ...d, get() { bump('offsetReads'); return d.get.call(this); } });
  }
  const st = window.scrollTo;
  window.scrollTo = function (...a) { bump('scrollWrites'); return st.apply(window, a); };

  /* ---- #11: non-passive compositor-blocking listeners ---- */
  const AEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (['wheel', 'touchstart', 'touchmove', 'scroll'].includes(type)) {
      const passive = opts === true ? false : (opts && typeof opts === 'object') ? !!opts.passive : false;
      if (!passive) {
        report.listeners.nonPassive.push({ type, stack: (new Error().stack || '').split('\n').slice(2, 4).join(' ') });
      }
    }
    return AEL.call(this, type, fn, opts);
  };

  /* ---- #8 / #6: static DOM/CSS checks ---- */
  function domChecks() {
    const cs = (el) => getComputedStyle(el);
    const html = cs(document.documentElement), body = cs(document.body);
    const stage = document.getElementById('stage');
    report.dom = {
      htmlOverflow: html.overflowX + '/' + html.overflowY,
      bodyOverflow: body.overflowX + '/' + body.overflowY,
      doubleScroll: document.body.scrollHeight > document.documentElement.clientHeight + 4 &&
        (body.overflowY === 'auto' || body.overflowY === 'scroll'),
      backdropFilters: [...document.querySelectorAll('*')].filter((el) => {
        const bf = cs(el).backdropFilter || cs(el).webkitBackdropFilter;
        return bf && bf !== 'none';
      }).map((el) => '#' + (el.id || el.className)),
      canvasBacking: (() => { const c = document.getElementById('frame'); return c ? c.width + 'x' + c.height : null; })(),
      stagePosition: stage ? cs(stage).position : null,
      scrollLengthVH: Math.round(document.documentElement.scrollHeight / window.innerHeight * 100) / 100,
    };
  }

  /* ---- frame timing ---- */
  let last = performance.now();
  const diag = () => {
    const now = performance.now();
    const dt = now - last; last = now;
    report.frames.count++;
    report.frames.times.push(dt);
    if (report.frames.times.length > 600) report.frames.times.shift();
    if (dt > 33.4) { report.frames.long++; report.frames.worst = Math.max(report.frames.worst, dt); }
    requestAnimationFrame(diag);
  };
  diag.__cahaDiag = true;
  requestAnimationFrame(diag);

  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  };

  window.__cahaAudit = {
    report,
    snapshot() {
      const app = window.__caha ? window.__caha.stats : null;
      const t = report.frames.times;
      return {
        fps: +(1000 / (t.slice(-120).reduce((a, b) => a + b, 0) / Math.max(1, t.slice(-120).length))).toFixed(1),
        frameMs: { p50: pct(t, 0.5), p95: pct(t, 0.95), p99: pct(t, 0.99), worst: +report.frames.worst.toFixed(1), long: report.frames.long },
        rafLoops: loops.size,
        layout: report.layout,
        nonPassiveListeners: report.listeners.nonPassive,
        dom: report.dom,
        engine: app,
      };
    },
  };

  /* ---- overlay ---- */
  const el = document.createElement('div');
  el.id = 'caha-audit';
  el.innerHTML = `
    <style>
      #caha-audit{position:fixed;top:52px;right:12px;z-index:60;width:272px;background:rgba(10,7,5,.88);
        color:#f4ead9;font:10px/1.5 ui-monospace,Menlo,monospace;border:1px solid rgba(246,234,210,.18);
        border-radius:8px;padding:8px 10px;backdrop-filter:none;letter-spacing:.02em}
      #caha-audit h4{font:600 10px/1.4 ui-monospace,monospace;margin:0 0 4px;letter-spacing:.14em;text-transform:uppercase;opacity:.8}
      #caha-audit .row{display:flex;justify-content:space-between;gap:8px}
      #caha-audit .row b{font-weight:600}
      #caha-audit .ok{color:#9fd68f}#caha-audit .bad{color:#e8896b}#caha-audit .warn{color:#e5c07b}
      #caha-audit canvas{display:block;width:100%;height:34px;margin:4px 0}
      #caha-audit button{font:inherit;background:rgba(246,234,210,.1);color:inherit;border:1px solid rgba(246,234,210,.2);
        border-radius:4px;padding:2px 6px;margin:4px 4px 0 0;cursor:pointer}
    </style>
    <h4>scroll audit</h4>
    <canvas id="caha-audit-graph" width="252" height="34"></canvas>
    <div id="caha-audit-body"></div>
    <button id="caha-audit-copy">copy json</button><button id="caha-audit-hide">hide</button>`;
  document.body.appendChild(el);
  const body = el.querySelector('#caha-audit-body');
  const graph = el.querySelector('#caha-audit-graph');
  const gctx = graph.getContext('2d');
  el.querySelector('#caha-audit-hide').onclick = () => { el.style.display = 'none'; };
  el.querySelector('#caha-audit-copy').onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(window.__cahaAudit.snapshot(), null, 2));
  };

  const row = (k, v, cls) => `<div class="row"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`;
  let once = false;
  setInterval(() => {
    const s = window.__cahaAudit.snapshot();
    const eng = s.engine || {};
    const drawn = eng.frames ? eng.frames.drawn : 0;
    const blitsPerDraw = drawn ? (eng.frames.blits / drawn).toFixed(2) : '–';
    const measuresPerFrame = s.engine ? (s.engine.layout.measures / Math.max(1, s.engine.loop.frames)).toFixed(3) : '–';
    const cacheMB = eng.cache ? (eng.cache.bytes / 1048576).toFixed(0) : '–';
    const netMB = eng.net ? (eng.net.bytes / 1048576).toFixed(1) : '–';
    const cls = (ok, warnOk) => (ok ? 'ok' : warnOk ? 'warn' : 'bad');
    body.innerHTML =
      row('fps', s.fps, s.fps > 50 ? 'ok' : s.fps > 30 ? 'warn' : 'bad') +
      row('frame ms p50/p95', `${s.frameMs.p50}/${s.frameMs.p95}`, s.frameMs.p95 < 20 ? 'ok' : s.frameMs.p95 < 33 ? 'warn' : 'bad') +
      row('long frames', s.frameMs.long, s.frameMs.long < 20 ? 'ok' : 'warn') +
      row('rAF loops', s.rafLoops, s.rafLoops <= 2 ? 'ok' : 'bad') +
      row('layout reads/frame', measuresPerFrame, +measuresPerFrame < 0.02 ? 'ok' : 'bad') +
      row('scroll writes', s.layout.scrollWrites, s.layout.scrollWrites < 500 ? 'ok' : 'warn') +
      row('non-passive LSN', s.nonPassiveListeners.length, s.nonPassiveListeners.length === 0 ? 'ok' : 'bad') +
      row('blits / drawn frame', blitsPerDraw, +blitsPerDraw <= 1.15 ? 'ok' : 'warn') +
      row('missed draws', eng.frames ? eng.frames.missed : '–', eng.frames && eng.frames.missed < 30 ? 'ok' : 'warn') +
      row('bitmap cache MB', cacheMB, eng.profile !== 'mobile' || +cacheMB < 96 ? 'ok' : 'warn') +
      row('payload MB', netMB, '') +
      row('overflow html', s.dom.htmlOverflow, /hidden/.test(s.dom.htmlOverflow || '') ? 'warn' : 'ok') +
      row('backdrop-filter', (s.dom.backdropFilters || []).length, (s.dom.backdropFilters || []).length ? 'bad' : 'ok') +
      row('profile', eng.profile || '–', '');
    const t = report.frames.times.slice(-126);
    gctx.clearRect(0, 0, 252, 34);
    t.forEach((dt, i) => {
      const h = Math.min(34, dt * 1.6);
      gctx.fillStyle = dt > 33.4 ? '#e8896b' : dt > 20 ? '#e5c07b' : '#9fd68f';
      gctx.fillRect(i * 2, 34 - h, 1.5, h);
    });
    if (!once) { domChecks(); once = true; }
  }, 500);
  setTimeout(domChecks, 1500);
})();
