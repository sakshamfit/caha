/* ============================================================
   cahā — scroll canvas
   ------------------------------------------------------------
   The scroll system from alagappan567/cafe-3d-scroll
   (src/components/ScrollCanvas.tsx and its Third/Fifth siblings),
   ported to caha's no-build vanilla stack and scaled from "one
   300-frame clip per section" to caha's 14-scene reel.

   Same system, per chapter (<section data-chapter>):
     • a tall container with a sticky, viewport-high stage holding
       a <canvas>  (reference: 500vh + `sticky top-0 h-screen`)
     • a GSAP ScrollTrigger — start "top top", end "bottom bottom",
       scrub 0.5 — that maps the chapter's scroll progress onto its
       frames, drawn cover-fit into the canvas
     • story beats shown for a frame range, alternating sides, with
       progress dots  (reference: STORY_SCENES + dots)
     • overlays that fade out as the scroll starts  (reference: the
       hero overlay, `end: "8% top"`)

   What changes because caha is 14× bigger (4,200 frames, 239 MB):
     • one chapter spans several scenes; its container is
       `scenes × --scene-height + 100vh` tall
     • frames are not all preloaded at mount. Each chapter streams
       coarse → fine (every 32nd frame first, then 16th, then a moving
       window around the playhead), nearest chapter first
     • until the exact frame lands, the nearest loaded frame is drawn
     • loading is two-stage: bytes stream in cheaply, and only frames
       in a window around the playhead are decoded ahead of time (a
       1080p decode is the expensive part; decoding everything on
       arrival starves the main thread on 2-core phones)
     • the scrub drives a real tween, so `scrub: 0.5` actually smooths
       (a bare ScrollTrigger with no animation ignores scrub)
     • the canvas backing store never exceeds the frames' real detail

   Authoring lives in index.html, not here: a chapter lists its scenes
   (`data-scenes`), and each beat names a scene and a source-frame range
   (`data-scene="scene-02" data-from="40" data-to="270"`), so copy can
   be retimed without touching this file.
   ============================================================ */
(() => {
  'use strict';

  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const film = (window.cahaFilm = window.cahaFilm || {});

  /* ---------- readiness surface for the preloader (site.js) ---------- */
  const listeners = new Set();
  let resolveReady;
  film.ready = new Promise((r) => { resolveReady = r; });
  film.progress = 0;
  film.onProgress = (fn) => { listeners.add(fn); fn(film.progress); return () => listeners.delete(fn); };

  if (!gsap || !ScrollTrigger) {
    console.error('[caha] GSAP / ScrollTrigger did not load — vendor/gsap/ is missing?');
    film.error = 'gsap';
    resolveReady();
    return;
  }
  gsap.registerPlugin(ScrollTrigger);
  // Mobile URL-bar show/hide changes innerHeight; re-laying out the scroll
  // map there would move the film under the user's finger.
  ScrollTrigger.config({ ignoreMobileResize: true });

  /* ---------- configuration ---------- */
  const mq = (q) => window.matchMedia(q).matches;
  const qs = new URLSearchParams(location.search);
  const coarse = mq('(pointer: coarse)');
  const phone = coarse || window.innerWidth < 760;
  const reducedMotion = mq('(prefers-reduced-motion: reduce)');
  const conn = navigator.connection || {};
  const saveData = !!conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '');

  const FRAMES = {
    dir: 'assets/frames',       // the source reel, committed with the repo
    prefix: 'ezgif-frame-',
    pad: 3,
    ext: '.jpg',
    maxW: 1920,                 // largest frame in the reel — the detail cap
    maxH: 1080,
  };
  /* Every Nth source frame. At 2 (desktop) a scene is 150 frames over
     --scene-height (180vh): the same frames-per-viewport density as the
     reference's 300 frames over 400vh. ?step=1 plays every frame. */
  const STEP = Math.max(1, +qs.get('step') || (saveData ? 4 : phone ? 3 : 2));
  const CONCURRENCY = phone ? 4 : 6;                  // parallel downloads
  const DECODE_CONCURRENCY = 2;                       // parallel decodes
  const DECODE_AHEAD = 40, DECODE_BEHIND = 16;        // decode window around the playhead, frames
  const DECODED_REACH = 6;                            // prefer a decoded frame this close over a sync decode
  const SCRUB = reducedMotion ? true : 0.5;           // reference: scrub 0.5
  const EVICT_RANK = phone ? 2 : 3;                   // chapters this far away drop fine frames
  const EVICT_LEVEL = phone ? 2 : 3;
  const WARM_LEVEL = 0;                               // preloader waits for the focus chapter's level-0 frames

  // network state; decoding is tracked separately (f.decoded / f.decoding)
  const IDLE = 0, LOADING = 1, LOADED = 2, FAILED = 3;
  const LEVEL_PENALTY = [0, 0, 24, 48, 72, 96];       // frames of distance a finer level "costs"

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  // level 0: every 32nd frame · 1: 16th · 2: 8th · 3: 4th · 4: 2nd · 5: the rest
  const levelOf = (i) => { for (let L = 0; L < 5; L++) if (i % (32 >> L) === 0) return L; return 5; };

  const chapters = [];
  const stats = { requested: 0, loaded: 0, failed: 0 };
  let inflight = 0;
  let decoding = 0;
  let queue = [];
  let qPos = 0;
  let focus = null;
  let scrollDir = 1;
  let lastScrollY = window.scrollY;
  let lastRebuildT = -1e9;
  let rebuildTimer = 0;
  let drawQueued = false;

  /* ============================================================
     Build — read each chapter's DOM and lay out its frame list
     ============================================================ */
  async function loadManifest() {
    try {
      const res = await fetch('assets/manifest.json');
      if (res.ok) return await res.json();
    } catch (e) { /* file:// or offline: fall back to 300 frames per scene */ }
    return null;
  }

  function buildChapter(el, index, sceneFrames) {
    const ids = (el.dataset.scenes || '').trim().split(/\s+/).filter(Boolean);
    const frames = [];
    const sceneStart = {};
    const sceneCount = {};
    for (const id of ids) {
      const total = sceneFrames[id] || 300;
      sceneStart[id] = frames.length;
      for (let n = 1; n <= total; n += STEP) {
        frames.push({
          scene: id,
          n,                                   // source frame number, 1-based
          url: `${FRAMES.dir}/${id}/${FRAMES.prefix}${String(n).padStart(FRAMES.pad, '0')}${FRAMES.ext}`,
          img: null,
          state: IDLE,
          decoded: false,
          decoding: false,
          level: 0,
          i: 0,
        });
      }
      sceneCount[id] = frames.length - sceneStart[id];
    }
    frames.forEach((f, i) => { f.i = i; f.level = levelOf(i); });

    /* source frame n of a scene → this chapter's delivered-frame index */
    const indexOf = (id, n, edge) => {
      if (!(id in sceneStart)) return edge === 'end' ? -1 : frames.length;
      const k = edge === 'end' ? Math.floor((n - 1) / STEP) : Math.ceil((n - 1) / STEP);
      return sceneStart[id] + clamp(k, 0, sceneCount[id] - 1);
    };

    const stage = el.querySelector('.chapter__stage');
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    const beats = [...el.querySelectorAll('[data-beat]')].map((b) => {
      const scene = b.dataset.scene || ids[0];
      return {
        el: b,
        align: b.dataset.align === 'right' ? 'right' : 'left',
        start: indexOf(scene, +b.dataset.from || 1, 'start'),
        end: indexOf(scene, +b.dataset.to || 300, 'end'),
        active: false,
      };
    });

    // progress dots — one per beat, as in the reference
    const dotsEl = el.querySelector('.chapter__dots');
    const dots = beats.map(() => {
      const d = document.createElement('span');
      d.className = 'chapter__dot';
      dotsEl && dotsEl.appendChild(d);
      return d;
    });

    el.style.setProperty('--scenes', String(ids.length));

    return {
      el, index, stage, canvas, ctx, frames, beats, dots, dotsEl,
      id: el.id || `chapter-${index + 1}`,
      play: { frame: 0 },   // the tweened playhead (fractional frame)
      target: 0,            // integer frame under the playhead
      drawn: -1,            // frame index currently on the canvas
      stale: true,          // canvas needs a repaint regardless of `drawn`
      dot: -1,
      dotsOn: null,
      align: '',
      st: null,
    };
  }

  /* ============================================================
     Canvas — sized to real detail, drawn cover-fit
     ============================================================ */
  function sizeCanvas(ch) {
    const cssW = ch.stage.clientWidth || window.innerWidth;
    const cssH = ch.stage.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* Beyond 1 source pixel per backing pixel there is no detail left to
       show, only fill-rate to pay: a 1440×900 retina laptop gets a
       1728×1080 surface (not 2880×1800), a phone gets ~500×1080, and in
       both the frame is drawn at exactly 1:1 in its constrained axis. */
    const cover = Math.max(cssW / FRAMES.maxW, cssH / FRAMES.maxH);
    const scale = Math.min(dpr, 1 / cover);
    const w = Math.max(2, Math.round(cssW * scale));
    const h = Math.max(2, Math.round(cssH * scale));
    if (ch.canvas.width !== w || ch.canvas.height !== h) {
      ch.canvas.width = w;
      ch.canvas.height = h;
      ch.ctx.imageSmoothingEnabled = true;
      ch.ctx.imageSmoothingQuality = 'high';
      ch.stale = true;
    }
  }

  function drawCover(ch, img) {
    const cw = ch.canvas.width, chh = ch.canvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return false;
    const s = Math.max(cw / iw, chh / ih);
    const w = Math.ceil(iw * s), h = Math.ceil(ih * s);
    ch.ctx.drawImage(img, Math.floor((cw - w) / 2), Math.floor((chh - h) / 2), w, h);
    return true;
  }

  /* The frame to show for playhead `t`: a decoded frame at or right next to
     it (drawn with no main-thread work), else the nearest loaded frame (the
     browser decodes it during the draw — what the reference does for every
     frame), preferring the one behind at equal distance. */
  function pickFrame(ch, t) {
    const F = ch.frames, N = F.length;
    if (!N) return -1;
    for (let d = 0; d <= DECODED_REACH; d++) {
      const b = t - d, a = t + d;
      if (b >= 0 && F[b].decoded) return b;
      if (a < N && F[a].decoded) return a;
    }
    for (let d = 0; d < N; d++) {
      const b = t - d, a = t + d;
      if (b >= 0 && F[b].state === LOADED) return b;
      if (a < N && F[a].state === LOADED) return a;
      if (b < 0 && a >= N) break;
    }
    return -1;
  }

  function paint(ch) {
    const idx = pickFrame(ch, ch.target);
    if (idx < 0) return;
    if (idx === ch.drawn && !ch.stale) return;
    if (drawCover(ch, ch.frames[idx].img)) {
      ch.drawn = idx;
      ch.stale = false;
      ch.canvas.classList.add('is-painted');
    }
  }

  function requestPaint() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      for (const ch of chapters) if (ch.needsPaint) { ch.needsPaint = false; paint(ch); }
    });
  }

  /* ============================================================
     Story beats + dots — the reference's STORY_SCENES logic
     ============================================================ */
  function updateBeats(ch, pos) {
    let current = -1, dot = 0;
    for (let k = 0; k < ch.beats.length; k++) {
      const b = ch.beats[k];
      if (pos >= b.start) dot = k;
      const on = pos >= b.start && pos <= b.end;
      if (on) current = k;
      if (on !== b.active) {
        b.active = on;
        b.el.classList.toggle('is-active', on);
      }
    }
    if (dot !== ch.dot) {
      if (ch.dots[ch.dot]) ch.dots[ch.dot].classList.remove('is-active');
      if (ch.dots[dot]) ch.dots[dot].classList.add('is-active');
      ch.dot = dot;
    }
    // the dots arrive with the first beat (after the title card / hero overlay)
    const dotsOn = ch.beats.length > 0 && pos >= ch.beats[0].start - 6;
    if (dotsOn !== ch.dotsOn && ch.dotsEl) {
      ch.dotsEl.classList.toggle('is-visible', dotsOn);
      ch.dotsOn = dotsOn;
    }
    // legibility shade follows the side the active beat sits on
    const align = current >= 0 ? ch.beats[current].align : ch.align || 'left';
    if (align !== ch.align) {
      ch.stage.dataset.align = align;
      ch.align = align;
    }
  }

  function render(ch) {
    const N = ch.frames.length;
    if (!N) return;
    const pos = ch.play.frame;
    const t = clamp(Math.round(pos), 0, N - 1);
    const moved = t !== ch.target;
    ch.target = t;
    updateBeats(ch, pos);
    paint(ch);
    if (moved && ch === focus) pumpDecode();
    if (ch === focus && Math.abs(ch.target - lastRebuildT) > 24) scheduleRebuild(0);
  }

  /* ============================================================
     Loader — coarse → fine, nearest chapter first
     ============================================================ */
  function load(ch, f, high) {
    f.state = LOADING;
    inflight++;
    stats.requested++;
    const img = new Image();
    img.decoding = 'async';
    if ('fetchPriority' in img) img.fetchPriority = high ? 'high' : 'low';
    img.onload = () => {
      inflight--;
      if (f.state === LOADING) {
        f.state = LOADED;
        f.img = img;
        stats.loaded++;
        // a chapter's very first pixels don't wait for the decode window
        if (ch.drawn < 0 || ch.stale) { ch.needsPaint = true; requestPaint(); }
        pumpDecode();
      }
      noteWarm();
      pump();
    };
    img.onerror = () => {
      inflight--;
      f.state = FAILED;
      stats.failed++;
      noteWarm();
      pump();
    };
    img.src = f.url;
  }

  /* ---------- decode window ----------
     decode() runs off the main thread where the browser can, and the draw
     that follows is then just a blit. Only frames the playhead is about to
     reach are worth that: the focus chapter's window (weighted toward the
     scroll direction) and every chapter's entry frames. */
  const wantsDecode = (f) => f && f.state === LOADED && !f.decoded && !f.decoding;

  function pumpDecode() {
    if (decoding >= DECODE_CONCURRENCY) return;
    const picks = [];
    const room = () => decoding + picks.length < DECODE_CONCURRENCY;
    if (focus) {
      const F = focus.frames, N = F.length, t = focus.target;
      for (let d = 0; d <= DECODE_AHEAD && room(); d++) {
        const a = t + d * scrollDir;
        if (a >= 0 && a < N && wantsDecode(F[a])) picks.push([focus, F[a]]);
        if (d > 0 && d <= DECODE_BEHIND && room()) {
          const b = t - d * scrollDir;
          if (b >= 0 && b < N && wantsDecode(F[b])) picks.push([focus, F[b]]);
        }
      }
    }
    for (const ch of chapters) {
      if (!room()) break;
      if (ch === focus) continue;
      const first = ch.frames[0], last = ch.frames[ch.frames.length - 1];
      if (wantsDecode(first)) picks.push([ch, first]);
      if (room() && wantsDecode(last)) picks.push([ch, last]);
    }
    for (const [ch, f] of picks) decodeFrame(ch, f);
  }

  function decodeFrame(ch, f) {
    const img = f.img;
    f.decoding = true;
    decoding++;
    const done = () => {
      decoding--;
      f.decoding = false;
      if (f.img === img && f.state === LOADED) {
        f.decoded = true;
        // repaint if this frame is closer to the playhead than what is showing
        if (ch.drawn < 0 || ch.stale || Math.abs(f.i - ch.target) < Math.abs(ch.drawn - ch.target)) {
          ch.needsPaint = true;
          requestPaint();
        }
      }
      pumpDecode();
    };
    (img.decode ? img.decode() : Promise.resolve()).then(done, done);
  }

  function pump() {
    while (inflight < CONCURRENCY && qPos < queue.length) {
      const item = queue[qPos++];
      if (item.f.state === IDLE) load(item.ch, item.f, item.high);
    }
  }

  /* where the viewport is relative to a chapter's scrub range, in px */
  function distanceTo(ch, y) {
    if (!ch.st) return Infinity;
    if (y < ch.st.start) return ch.st.start - y;
    if (y > ch.st.end) return y - ch.st.end;
    return 0;
  }

  function pickFocus(y) {
    let inside = null, ahead = null, aheadD = Infinity, near = null, nearD = Infinity;
    for (const ch of chapters) {
      const d = distanceTo(ch, y);
      if (d === 0) { inside = ch; break; }
      const isAhead = scrollDir > 0 ? ch.st.start > y : ch.st.end < y;
      if (isAhead && d < aheadD) { ahead = ch; aheadD = d; }
      if (d < nearD) { near = ch; nearD = d; }
    }
    return inside || ahead || near;
  }

  function rebuildQueue() {
    rebuildTimer = 0;
    if (!chapters.length) return;
    const y = window.scrollY;
    const vh = window.innerHeight || 800;
    focus = pickFocus(y) || chapters[0];
    const t = focus.target;
    lastRebuildT = t;

    const ranked = chapters
      .filter((ch) => ch !== focus)
      .map((ch) => ({ ch, d: distanceTo(ch, y) }))
      .sort((a, b) => a.d - b.d);

    const out = [];
    const add = (ch, frames, key, high) => {
      frames.sort((a, b) => key(a) - key(b));
      for (const f of frames) if (f.state === IDLE) out.push({ ch, f, high });
    };
    // ahead of the playhead costs 1 per frame, behind it costs 2
    const eff = (i) => ((i - t) * scrollDir >= 0 ? Math.abs(i - t) : Math.abs(i - t) * 2);
    const entry = (ch, i) => (ch.st && ch.st.start > y ? i : ch.frames.length - 1 - i);

    // 1 · focus chapter, coarse: every 32nd frame, then every 16th
    add(focus, focus.frames.filter((f) => f.level === 0), (f) => eff(f.i), true);
    add(focus, focus.frames.filter((f) => f.level === 1), (f) => eff(f.i), true);
    // 2 · the next-nearest chapter's entry frame + level 0, so it never scrolls in black
    if (ranked[0]) {
      const ch = ranked[0].ch;
      add(ch, ch.frames.filter((f) => f.level === 0), (f) => entry(ch, f.i), false);
    }
    // 3 · posters for every other chapter
    for (const { ch } of ranked.slice(1)) {
      const i = ch.st && ch.st.start > y ? 0 : ch.frames.length - 1;
      add(ch, [ch.frames[i]], () => 0, false);
    }
    // 4 · focus chapter, fine: a coarse-to-fine window around the playhead
    add(focus, focus.frames.filter((f) => f.level >= 2), (f) => LEVEL_PENALTY[f.level] + eff(f.i), false);
    // 5 · the next-nearest chapter fills in as the viewport approaches it
    if (ranked[0] && ranked[0].d < vh * 2.5) {
      const ch = ranked[0].ch;
      const maxLevel = ranked[0].d < vh * 1.2 ? 5 : 3;
      add(ch, ch.frames.filter((f) => f.level >= 1 && f.level <= maxLevel),
        (f) => f.level * 1000 + entry(ch, f.i), false);
    }

    queue = out;
    qPos = 0;

    // memory: far chapters give back their fine frames (coarse ones stay for a fast return).
    // Posters (first/last frame) are kept, or step 3 would re-request them on every rebuild.
    ranked.forEach(({ ch, d }, r) => {
      if (r + 1 < EVICT_RANK || d < vh * 3) return;
      const lastI = ch.frames.length - 1;
      for (const f of ch.frames) {
        if (f.state === LOADED && !f.decoding && f.level >= EVICT_LEVEL &&
            f.i !== ch.drawn && f.i !== 0 && f.i !== lastI) {
          f.state = IDLE;
          f.img = null;
          f.decoded = false;
        }
      }
    });

    pump();
    pumpDecode();
    noteWarm();   // the focus may have moved onto frames that are already here
  }

  function scheduleRebuild(delay) {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(rebuildQueue, delay);
  }

  /* ---------- preloader progress ----------
     The first pass (level-0 frames) of whichever chapter the page opened on —
     the hero normally, but a reload mid-page or a deep link (#visit) opens
     somewhere else, and waiting on hero frames nobody is loading would hold
     the preloader until its timeout. */
  function noteWarm() {
    if (film.progress >= 1 || !chapters.length) return;
    const frames = (focus || chapters[0]).frames;
    let total = 0, settled = 0;
    for (const f of frames) {
      if (f.level > WARM_LEVEL) continue;
      total++;
      if (f.state === LOADED || f.state === FAILED) settled++;
    }
    const p = total ? settled / total : 1;
    film.progress = Math.max(film.progress, p);  // the bar never runs backwards
    film.failed = stats.failed;
    listeners.forEach((fn) => fn(film.progress));
    if (p >= 1) {
      film.progress = 1;
      film.readyAt = Math.round(performance.now());
      resolveReady();
    }
  }

  /* ============================================================
     Scroll wiring — the reference's ScrollTrigger setup
     ============================================================ */
  function wire(ch) {
    const last = ch.frames.length - 1;
    const tween = gsap.to(ch.play, {
      frame: last,
      ease: 'none',
      onUpdate: () => render(ch),
      scrollTrigger: {
        trigger: ch.el,
        start: 'top top',
        end: 'bottom bottom',
        scrub: SCRUB,
        onToggle: (self) => {
          ch.el.classList.toggle('is-active', self.isActive);
          if (self.isActive) scheduleRebuild(0);
        },
      },
    });
    ch.st = tween.scrollTrigger;

    // overlays that fade out as the chapter starts to scroll
    // (reference: the hero overlay → opacity 0, y -40, power2.in, scrubbed).
    // autoAlpha also sets visibility:hidden at 0, so faded buttons can't be clicked.
    ch.el.querySelectorAll('[data-fade-out]').forEach((node) => {
      gsap.to(node, {
        autoAlpha: 0,
        y: -40,
        ease: 'power2.in',
        scrollTrigger: {
          trigger: ch.el,
          start: 'top top',
          end: () => '+=' + Math.round(window.innerHeight * (+node.dataset.fadeOut || 0.45)),
          scrub: true,
          invalidateOnRefresh: true,
        },
      });
    });
  }

  function repaintAll() {
    for (const ch of chapters) { sizeCanvas(ch); render(ch); }
  }

  /* ============================================================
     Boot
     ============================================================ */
  async function init() {
    const els = [...document.querySelectorAll('[data-chapter]')];
    if (!els.length) { resolveReady(); return; }

    const manifest = await loadManifest();
    const sceneFrames = {};
    if (manifest && Array.isArray(manifest.scenes)) {
      for (const s of manifest.scenes) sceneFrames[s.id] = s.frames;
    }
    els.forEach((el, i) => chapters.push(buildChapter(el, i, sceneFrames)));

    for (const ch of chapters) { sizeCanvas(ch); wire(ch); }
    ScrollTrigger.refresh();

    rebuildQueue();
    repaintAll();

    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (y !== lastScrollY) {
        const dir = y > lastScrollY ? 1 : -1;
        if (dir !== scrollDir) { scrollDir = dir; scheduleRebuild(0); }
        lastScrollY = y;
      }
      scheduleRebuild(150);
    }, { passive: true });

    // layout can move after fonts/images settle — re-measure the scroll map
    ScrollTrigger.addEventListener('refresh', () => { repaintAll(); scheduleRebuild(0); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });

    // canvases follow real width changes (rotation, window resize), not URL-bar height jitter
    let lastW = window.innerWidth, lastH = window.innerHeight, resizeTO = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTO);
      resizeTO = setTimeout(() => {
        const w = window.innerWidth, h = window.innerHeight;
        if (w !== lastW || !coarse || Math.abs(h - lastH) > lastH * 0.25) {
          lastW = w; lastH = h;
          repaintAll();
        }
      }, 120);
    }, { passive: true });

    // debugging handle: cahaFilm.stats() in the console
    film.chapters = chapters;
    film.stats = () => ({
      step: STEP,
      concurrency: CONCURRENCY,
      inflight,
      decoding,
      focus: focus && focus.id,
      ...stats,
      chapters: chapters.map((ch) => ({
        id: ch.id,
        frames: ch.frames.length,
        loaded: ch.frames.filter((f) => f.state === LOADED).length,
        decoded: ch.frames.filter((f) => f.decoded).length,
        target: ch.target,
        drawn: ch.drawn,
        beat: ch.beats.findIndex((b) => b.active),
      })),
    });
  }

  init().catch((err) => {
    console.error('[caha] scroll canvas failed to start', err);
    film.error = String(err && err.message || err);
    resolveReady();
  });
})();
