/* ============================================================
   Caha — scroll-scrubbed frame animation engine
   14 scenes × 300 frames, paced like 24fps film.
   ============================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('frame');
  const ctx = canvas.getContext('2d');
  const spacer = $('spacer');
  const loaderEl = $('loader');
  const loaderFill = $('loader-fill');
  const loaderPct = $('loader-pct');
  const progressFill = $('progress-fill');
  const progressLabel = $('progress-label');
  const sceneIndexEl = $('scene-index');
  const sceneTitleEl = $('scene-title');
  const hintEl = $('hint');

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  const easeInOut = (t) => t * t * (3 - 2 * t);

  const prefersReducedMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----- Tuning ----- */
  const SCENE_VH = 150;        // scroll height per scene, in viewport heights
  const SMOOTHING = 10;        // playhead damping (higher = snappier)
  const PRELOAD_AHEAD = 60;    // frames to preload ahead of the playhead
  const PRELOAD_BEHIND = 15;   // frames to keep behind the playhead
  const MAX_CONCURRENT = 6;    // parallel image downloads
  const CACHE_CAP = 100;       // decoded frames kept in memory
  const CROSSFADE = 18;        // frames of crossfade at scene boundaries
  const IDLE_DELAY = 4000;     // ms of no input before autoplay kicks in
  const END_HOLD = 2200;       // ms to hold the last frame before looping

  /* ----- State ----- */
  let scenes = [];
  let offsets = [];
  let totalFrames = 0;
  let fps = 24;

  let playhead = -1;            // smoothed, fractional frame position
  let currentGlobal = -1;       // integer frame currently on screen
  const cache = new Map();      // key -> HTMLImageElement (LRU order)
  const requested = new Set();  // keys queued or loaded
  let queue = [];               // pending loads, sorted by priority
  let activeLoads = 0;

  let lastInput = performance.now();
  let autoActive = false;
  let autoScrollY = 0;
  let endHoldUntil = 0;

  const keyOf = (si, f) => si * 1000 + f;           // f = 1-based frame number
  const urlOf = (si, f) =>
    `assets/frames/${scenes[si].id}/ezgif-frame-${pad3(f)}.jpg`;

  /* Which scene owns global frame g (binary search over offsets) */
  function sceneOf(g) {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= g) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  const globalOfKey = (k) => {
    const si = Math.floor(k / 1000);
    return offsets[si] + (k % 1000) - 1;
  };

  /* ----- Canvas ----- */
  function resize() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  /* Draw an image with "cover" fit (fills canvas, crops overflow) */
  function drawCover(img, alpha) {
    const cw = canvas.width, ch = canvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    const s = Math.max(cw / iw, ch / ih);
    const w = iw * s, h = ih * s;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    ctx.globalAlpha = 1;
  }

  function getImage(si, f) {
    const k = keyOf(si, f);
    const img = cache.get(k);
    if (img) {                       // touch for LRU
      cache.delete(k);
      cache.set(k, img);
      return img;
    }
    return null;
  }

  /* ----- Preloading ----- */
  function enqueue(si, f, dist) {
    if (si < 0 || si >= scenes.length) return;
    if (f < 1 || f > scenes[si].frames) return;
    const k = keyOf(si, f);
    if (cache.has(k) || requested.has(k)) return;
    requested.add(k);
    queue.push({ k, si, f, dist });
  }

  function scheduleAround(g) {
    const si = sceneOf(g);
    const local = g - offsets[si];
    enqueue(si, local + 1, 0);                     // the frame on screen now
    for (let i = 1; i <= PRELOAD_AHEAD; i++) {     // ahead
      const gg = g + i;
      if (gg >= totalFrames) break;
      const s2 = sceneOf(gg);
      enqueue(s2, gg - offsets[s2] + 1, i);
    }
    for (let i = 1; i <= PRELOAD_BEHIND; i++) {    // behind
      const gg = g - i;
      if (gg < 0) break;
      const s2 = sceneOf(gg);
      enqueue(s2, gg - offsets[s2] + 1, i + 0.5);
    }
    // make sure the next scene's opening frames exist for the crossfade
    if (si + 1 < scenes.length && local >= scenes[si].frames - CROSSFADE - 12) {
      for (let f = 1; f <= CROSSFADE; f++) {
        enqueue(si + 1, f, scenes[si].frames - local + f);
      }
    }
    queue.sort((a, b) => a.dist - b.dist);
    pump();
  }

  function pump() {
    while (activeLoads < MAX_CONCURRENT && queue.length) {
      const item = queue.shift();
      if (cache.has(item.k)) continue;
      activeLoads++;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        cache.set(item.k, img);
        activeLoads--;
        evict();
        pump();
      };
      img.onerror = () => {
        requested.delete(item.k);    // allow a retry
        activeLoads--;
        pump();
      };
      img.src = urlOf(item.si, item.f);
    }
  }

  function evict() {
    if (cache.size <= CACHE_CAP) return;
    for (const [k] of cache) {       // oldest first (insertion order)
      if (cache.size <= CACHE_CAP) break;
      const dist = Math.abs(globalOfKey(k) - currentGlobal);
      if (dist > PRELOAD_AHEAD + CROSSFADE) {
        cache.delete(k);
        requested.delete(k);
      }
    }
  }

  /* ----- Scroll <-> frame mapping ----- */
  function maxScroll() {
    return document.documentElement.scrollHeight - window.innerHeight;
  }
  /* Fractional target frame for the current scroll position */
  function targetFromScroll() {
    const m = maxScroll();
    if (m <= 0) return 0;
    return clamp((window.scrollY / m) * (totalFrames - 1), 0, totalFrames - 1);
  }
  function scrollForGlobal(g) {
    const m = maxScroll();
    return (g / (totalFrames - 1)) * m;
  }
  function pxPerFrame() {
    return maxScroll() / (totalFrames - 1);
  }

  /* ----- Rendering (ph = fractional playhead) ----- */
  function drawAt(ph) {
    if (!totalFrames || ph < 0) return;
    const g = Math.round(ph);
    const si = sceneOf(g);
    const localF = clamp(ph - offsets[si], 0, scenes[si].frames - 1);
    const frameNo = Math.floor(localF) + 1;        // 1-based file number

    const img = getImage(si, frameNo);
    if (img && img.complete && img.naturalWidth) drawCover(img, 1);

    // Crossfade into the next scene during the last CROSSFADE frames
    const framesHere = scenes[si].frames;
    if (localF >= framesHere - CROSSFADE && si + 1 < scenes.length) {
      const t = clamp((localF - (framesHere - CROSSFADE)) / (CROSSFADE - 1), 0, 1);
      const nextFrame = clamp(Math.round(t * CROSSFADE) + 1, 1, scenes[si + 1].frames);
      const nimg = getImage(si + 1, nextFrame);
      if (nimg && nimg.complete && nimg.naturalWidth) {
        drawCover(nimg, easeInOut(t));
      }
    }
  }

  /* ----- UI ----- */
  function updateUI(g) {
    const si = sceneOf(g);
    progressFill.style.width = ((g / (totalFrames - 1)) * 100) + '%';
    progressLabel.textContent = `${pad2(si + 1)} / ${pad2(scenes.length)}`;
    sceneIndexEl.textContent = pad2(si + 1);
    sceneTitleEl.textContent = scenes[si].title || scenes[si].id;
    if (g > 2) hintEl.classList.add('hide');
  }

  /* ----- Main loop: smoothed scrub + idle autoplay ----- */
  let lastT = performance.now();
  function tick(now) {
    const dt = Math.min(50, now - lastT);
    lastT = now;

    const idle = now - lastInput > IDLE_DELAY;
    if (!prefersReducedMotion && idle) {
      // Autoplay at the manifest fps by scrolling the page itself,
      // so the scrollbar always reflects the true position.
      const t = targetFromScroll();
      if (t >= totalFrames - 1.01) {
        autoActive = false;
        if (!endHoldUntil) endHoldUntil = now + END_HOLD;
        else if (now >= endHoldUntil) {
          endHoldUntil = 0;
          autoScrollY = 0;
          window.scrollTo(0, 0);           // loop the reel
        }
      } else {
        endHoldUntil = 0;
        if (!autoActive) {
          autoActive = true;
          autoScrollY = window.scrollY;
        }
        autoScrollY += (dt / 1000) * fps * pxPerFrame();
        window.scrollTo(0, autoScrollY);
      }
    } else {
      autoActive = false;
      endHoldUntil = 0;
    }

    // Damped playhead: chunky wheel input becomes a cinematic glide
    const target = targetFromScroll();
    if (playhead < 0) playhead = target;
    const ease = 1 - Math.exp(-SMOOTHING * (dt / 1000));
    playhead += (target - playhead) * ease;
    if (Math.abs(target - playhead) < 0.02) playhead = target;

    const g = Math.round(playhead);
    if (g !== currentGlobal) {
      currentGlobal = g;
      scheduleAround(g);
      updateUI(g);
    }
    drawAt(playhead);
    requestAnimationFrame(tick);
  }

  /* ----- Input tracking (pauses autoplay) ----- */
  function markInput() { lastInput = performance.now(); }
  ['wheel', 'touchstart', 'mousedown', 'keydown', 'pointerdown']
    .forEach((ev) => window.addEventListener(ev, markInput, { passive: true }));
  window.addEventListener('resize', () => { resize(); });

  /* ----- Boot ----- */
  async function boot() {
    let manifest;
    try {
      const res = await fetch('assets/manifest.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      manifest = await res.json();
    } catch (err) {
      loaderPct.textContent =
        'Could not load assets/manifest.json — serve the folder over http';
      return;
    }

    scenes = manifest.scenes;
    fps = manifest.fps || 24;
    offsets = [];
    let acc = 0;
    for (const s of scenes) { offsets.push(acc); acc += s.frames; }
    totalFrames = acc;

    spacer.style.height = (SCENE_VH * scenes.length) + 'vh';
    resize();

    // Warm-up: preload the opening stretch before revealing the page
    const WARM = Math.min(90, totalFrames);
    const CONC = 8;
    let started = 0, done = 0;
    await new Promise((resolve) => {
      function next() {
        if (done >= WARM) return resolve();
        if (started >= WARM) return;
        const idx = started++;
        const si = sceneOf(idx);
        const f = idx - offsets[si] + 1;
        const k = keyOf(si, f);
        const img = new Image();
        img.decoding = 'async';
        const fin = () => {
          if (!cache.has(k)) cache.set(k, img);
          done++;
          const pct = Math.round((done / WARM) * 100);
          loaderFill.style.width = pct + '%';
          loaderPct.textContent = pct + '%';
          if (done >= WARM) resolve(); else next();
        };
        img.onload = fin;
        img.onerror = fin;
        img.src = urlOf(si, f);
      }
      for (let i = 0; i < CONC; i++) next();
    });

    loaderEl.classList.add('done');
    setTimeout(() => loaderEl.remove(), 1000);

    playhead = targetFromScroll();
    currentGlobal = Math.round(playhead);
    scheduleAround(currentGlobal);
    updateUI(currentGlobal);
    lastInput = performance.now();
    requestAnimationFrame(tick);
  }

  boot();
})();
