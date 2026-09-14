/* ============================================================
   Caha — scroll-scrubbed frame animation engine  (v2)
   14 scenes × 300 frames, paced like 24fps film.

   v2 is a hot-path rewrite of v1. The architecture is unchanged
   (native scroll + ONE requestAnimationFrame loop + damped playhead,
   which was already correct) — what changed is everything that made
   the *feel* broken. Each fix is tagged with the audit item it closes;
   see AUDIT.md for the measured evidence.

     FIX A  per-frame forced layout (scrollHeight) + scrollTo writes
     FIX B  oversized canvas backing store (DPR² fill rate)
     FIX C  main-thread JPEG decode bursts during scroll
     FIX D  unbounded decoded-bitmap memory (count-based LRU)
     FIX E  autoplay hijacking the user's scroll + hard jump to top
     FIX F  per-frame layout writes (progress bar `width` + transition)
     FIX G  backdrop-filter re-compositing over a per-frame canvas
     FIX H  O(n) cache eviction / queue churn on every decode & frame
     FIX I  mobile: payload, memory budget, DPR, autoplay, touch
     FIX J  loader that could block forever; no resize re-measure

   Still true from v1, deliberately kept:
     - exactly ONE rAF loop (no GSAP/Lenis/ScrollTrigger to fight it)
     - passive-only event listeners
     - frame-rate-independent damping (lerp/damp in the rAF, not snaps)
   ============================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('frame');
  const ctx = canvas.getContext('2d', { alpha: false });
  const spacer = $('spacer');
  const loaderEl = $('loader');
  const loaderFill = $('loader-fill');
  const loaderPct = $('loader-pct');
  const progressFill = $('progress-fill');
  const progressLabel = $('progress-label');
  const sceneIndexEl = $('scene-index');
  const sceneTitleEl = $('scene-title');
  const hintEl = $('hint');

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const pad2 = (n) => String(n).padStart(2, '0');
  let padWidth = 3;
  const padN = (n) => String(n).padStart(padWidth, '0');
  const easeInOut = (t) => t * t * (3 - 2 * t);

  /* ---------- Device profiles (FIX I) ---------- */
  const mq = (q) => window.matchMedia(q).matches;
  const coarse = mq('(pointer: coarse)');
  const reducedMotion = mq('(prefers-reduced-motion: reduce)');
  const conn = navigator.connection || null;
  const saveData = !!(conn && conn.saveData);
  const tinyNet = !!(conn && /(^|-)2g$/.test(conn.effectiveType || ''));
  const lowMem = (navigator.deviceMemory || 8) <= 4;
  const cores = navigator.hardwareConcurrency || 4;
  const qs = new URLSearchParams(location.search);

  const PROFILE = (() => {
    const mobile = coarse || saveData || tinyNet || lowMem || window.innerWidth < 700;
    if (mobile) {
      return {
        id: 'mobile',
        cacheBudgetMB: lowMem ? 64 : 128,  // FIX D: budget in BYTES, not frame count
        maxConcurrent: 2,                  // FIX C: base slots; rises to 4 when starving
        maxConcurrentBurst: 4,
        warmFrames: 20,
        warmTimeoutMs: 2200,               // FIX J: loader can never block forever
        preloadAhead: 20,
        preloadBehind: 6,
        crossfade: false,                  // FIX B: halves full-screen blits on weak GPUs
        autoplay: qs.get('autoplay') === '1',   // opt-in; the button can still enable it
        smoothing: 8,
        resCap: 1280,                      // FIX B: never render above source/detail need
      };
    }
    return {
      id: 'desktop',
      cacheBudgetMB: 384,
      maxConcurrent: Math.min(6, Math.max(3, cores - 2)),
      maxConcurrentBurst: 10,
      warmFrames: 36,
      warmTimeoutMs: 2500,
      preloadAhead: 36,
      preloadBehind: 10,
      crossfade: true,
      autoplay: qs.get('autoplay') === '1',     // opt-in everywhere now
      smoothing: 10,
      resCap: 1920,
    };
  })();

  /* ---------- Tuning ---------- */
  const SCENE_VH = 150;        // scroll height per scene, in viewport heights
  const SMOOTHING = reducedMotion ? Infinity : PROFILE.smoothing;
  const CROSSFADE = 14;        // frames of crossfade at scene boundaries
  const FADE_STEPS = 12;       // FIX B: quantise alpha → ≤12 double-blits per boundary
  const AUTO_RAMP = 1200;      // FIX E: ease autoplay velocity in, never lurch
  const END_HOLD = 1400;       // ms to hold the last frame before looping
  const FADE_MS = 600;         // loop-with-fade: dip to black, cut, come back

  /* ---------- State ---------- */
  let scenes = [];
  let offsets = [];
  let totalFrames = 0;
  let fps = 24;
  let ext = '.jpg';
  let baseDir = 'assets/frames';

  let playhead = -1;           // smoothed, fractional frame position
  let currentGlobal = -1;      // integer frame currently targeted
  let drawKey = -2;            // FIX B: what is actually on the canvas right now
  let drawFade = -1;

  /* FIX D: byte-budgeted LRU of decoded ImageBitmaps */
  const cache = new Map();     // key -> { bmp, bytes }
  let cacheBytes = 0;
  const requested = new Set(); // keys queued or in flight
  let queue = [];
  let activeLoads = 0;

  /* FIX A: scroll position is a cached value, never read in the hot path */
  let scrollY = window.scrollY;
  let maxScroll = 1;
  let metricsDirty = true;

  let lastInput = performance.now();
  let autoEnabled = false;     // v2.1: autoplay is OPT-IN via the play control
  let autoActive = false;
  let autoStart = 0;
  let autoScrollY = 0;
  let endHoldUntil = 0;
  let fadePhase = 0;           // 0 none · 1 fading out · 2 fading in
  let fadeT = 0;

  /* Stats surface for diagnostics.js / performance tests */
  const stats = {
    version: 2,
    profile: PROFILE.id,
    frames: { drawn: 0, missed: 0, approx: 0, blits: 0 },
    net: { requests: 0, bytes: 0, failed: 0 },
    cache: { hits: 0, misses: 0, bytes: 0, entries: 0, evicted: 0 },
    layout: { scrollReads: 0, layoutWrites: 0, measures: 0 },
    loop: { frames: 0, longFrames: 0, worst: 0 },
    autoplay: { enabled: false, active: false, scrolls: 0, loops: 0 },
  };

  const keyOf = (si, f) => si * 1000 + f;           // f = 1-based frame number
  const urlOf = (si, f) =>
    `${baseDir}/${scenes[si].id}/${scenes[si].prefix}${padN(f)}${ext}`;

  function sceneOf(g) {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= g) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const globalOfKey = (k) => offsets[Math.floor(k / 1000)] + (k % 1000) - 1;

  /* ============================================================
     FIX A — scroll metrics are measured on invalidation events,
     never inside the animation frame.
     ============================================================ */
  function measure() {
    stats.layout.measures++;
    maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    metricsDirty = false;
  }
  const invalidateMetrics = () => { metricsDirty = true; };

  // Passive scroll listener: caches the compositor's scroll offset.
  // Reading window.scrollY here is free (it is not a layout query).
  let suppressScrollEvent = false;   // our own writes must not read as user input
  window.addEventListener('scroll', () => {
    scrollY = window.scrollY;
    stats.layout.scrollReads++;
    if (suppressScrollEvent) { suppressScrollEvent = false; return; }
    if (!autoActive) markInput();
  }, { passive: true });

  /* ---------- Canvas (FIX B) ----------
     The backing store is capped at the source frame resolution.
     v1 sized it to CSS×DPR, so on a retina laptop every frame was an
     upscaling blit into a 3840×2160 surface. The compositor scales the
     finished canvas for free; we must not pay for it per frame. */
  let cw = 0, ch = 0;
  let resCap = PROFILE.resCap;      // tightened to the delivery frame's own width
  let resCapSeen = 0;
  function resizeCanvas() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const w = window.innerWidth * dpr;
    const h = window.innerHeight * dpr;
    const s = Math.min(1, resCap / Math.max(w, h));
    const nw = Math.max(2, Math.round(w * s));
    const nh = Math.max(2, Math.round(h * s));
    if (canvas.width !== nw || canvas.height !== nh) {
      canvas.width = nw;
      canvas.height = nh;
      drawKey = -2;                 // force a repaint of the new surface
    }
    cw = nw; ch = nh;
  }

  function drawCover(img, alpha) {
    const iw = img.width || img.naturalWidth;
    const ih = img.height || img.naturalHeight;
    if (!iw || !ih) return false;
    const s = Math.max(cw / iw, ch / ih);
    const w = iw * s, h = ih * s;
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    if (alpha < 1) ctx.globalAlpha = 1;
    stats.frames.blits++;
    return true;
  }

  function cacheGet(k) {
    const e = cache.get(k);
    if (!e) { stats.cache.misses++; return null; }
    stats.cache.hits++;
    cache.delete(k); cache.set(k, e);   // LRU touch
    return e.bmp;
  }

  /* ============================================================
     FIX C — decode off the main thread with createImageBitmap(),
     so a finished scroll frame never arrives half-decoded and never
     stalls drawImage with a first-use upload.
     ============================================================ */
  async function loadFrame(si, f, priority) {
    const res = await fetch(urlOf(si, f), {
      priority: priority === 'high' ? 'high' : 'low',
    });
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    stats.net.requests++;
    stats.net.bytes += blob.size;
    let bmp;
    if (typeof createImageBitmap === 'function') {
      bmp = await createImageBitmap(blob);
    } else {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      bmp = img;
    }
    return bmp;
  }

  function enqueue(si, f, dist) {
    if (si < 0 || si >= scenes.length) return;
    if (f < 1 || f > scenes[si].frames) return;
    const k = keyOf(si, f);
    if (cache.has(k) || requested.has(k)) return;
    requested.add(k);
    queue.push({ k, si, f, dist });
  }

  /* FIX H — the queue is rebuilt (not accumulated) around the playhead,
     so priorities are always fresh and the array stays tiny. */
  function scheduleAround(g) {
    queue = [];
    const si = sceneOf(g);
    const local = g - offsets[si];
    enqueue(si, local + 1, 0);
    for (let i = 1; i <= win.ahead; i++) {
      const gg = g + i;
      if (gg >= totalFrames) break;
      const s2 = sceneOf(gg);
      enqueue(s2, gg - offsets[s2] + 1, i);
    }
    for (let i = 1; i <= win.behind; i++) {
      const gg = g - i;
      if (gg < 0) break;
      const s2 = sceneOf(gg);
      enqueue(s2, gg - offsets[s2] + 1, i + 0.5);
    }
    if (PROFILE.crossfade && si + 1 < scenes.length &&
        local >= scenes[si].frames - CROSSFADE - 12) {
      for (let f = 1; f <= CROSSFADE; f++) {
        enqueue(si + 1, f, scenes[si].frames - local + f);
      }
    }
    queue.sort((a, b) => a.dist - b.dist);
    pump();
  }

  let starvingUntil = 0;
  function pump() {
    const cap = performance.now() < starvingUntil ? PROFILE.maxConcurrentBurst : PROFILE.maxConcurrent;
    while (activeLoads < cap && queue.length) {
      const item = queue.shift();
      if (cache.has(item.k)) continue;
      activeLoads++;
      loadFrame(item.si, item.f, item.dist < 3 ? 'high' : 'low')
        .then((bmp) => {
          const bw = bmp.width || bmp.naturalWidth;
          const bh = bmp.height || bmp.naturalHeight;
          const bytes = bw * bh * 4;
          adoptSourceRes(bw, bh);
          cache.set(item.k, { bmp, bytes });
          cacheBytes += bytes;
          stats.cache.bytes = cacheBytes;
          stats.cache.entries = cache.size;
          evict();
        })
        .catch(() => {
          requested.delete(item.k);    // allow a retry later
          stats.net.failed++;
        })
        .finally(() => { activeLoads--; pump(); });
    }
  }

  /* FIX B: once the first frame is decoded we know the delivery
     resolution; never render a backing store wider than that.
     FIX D2: the same knowledge sizes the RESIDENT window — how many
     decoded frames the byte budget can actually hold. Preloading more
     than we can keep resident is wasted bandwidth and eviction churn
     (measured: 1105 pointless evictions before this fix). */
  const win = { ahead: PROFILE.preloadAhead, behind: PROFILE.preloadBehind };
  let maxFrameBytes = 0;
  function adoptSourceRes(w, h) {
    if (!w) return;
    // reels can mix resolutions (this one does: 720p + 1080p scenes), so
    // track the LARGEST frame seen and size everything from that.
    const cap = Math.min(PROFILE.resCap, Math.max(resCapSeen, w), Math.round(h * 16 / 9));
    resCapSeen = Math.max(resCapSeen, w);
    if (cap !== resCap) { resCap = cap; resizeCanvas(); }
    const frameBytes = w * h * 4;
    if (frameBytes <= maxFrameBytes) return;
    maxFrameBytes = frameBytes;
    const budget = PROFILE.cacheBudgetMB * 1024 * 1024;
    win.ahead = clamp(Math.floor((budget * 0.65) / frameBytes), 8, PROFILE.preloadAhead);
    win.behind = clamp(Math.floor((budget * 0.20) / frameBytes), 4, PROFILE.preloadBehind);
    stats.cache.window = [win.behind, win.ahead];
  }

  /* FIX D — evict by decoded BYTES (a 1920×1080 bitmap is 8.3 MB; v1's
     100-frame cap was ~830 MB of bitmaps and got mobile tabs killed),
     and close() bitmaps so the memory actually returns. */
  function evict() {
    const budget = PROFILE.cacheBudgetMB * 1024 * 1024;
    if (cacheBytes <= budget) return;
    const lo = currentGlobal - win.behind;
    const hi = currentGlobal + win.ahead + CROSSFADE;
    for (const [k, e] of cache) {
      if (cacheBytes <= budget) break;
      const gk = globalOfKey(k);
      if (gk >= lo && gk <= hi) continue;
      cache.delete(k);
      requested.delete(k);
      cacheBytes -= e.bytes;
      stats.cache.evicted++;
      if (e.bmp.close) e.bmp.close();
    }
    stats.cache.bytes = cacheBytes;
    stats.cache.entries = cache.size;
  }

  /* ---------- Scroll ↔ frame mapping (FIX A: no layout reads here) ---------- */
  const targetFromScroll = () =>
    clamp((scrollY / maxScroll) * (totalFrames - 1), 0, totalFrames - 1);
  const pxPerFrame = () => maxScroll / (totalFrames - 1);

  /* ---------- Rendering ---------- */
  function drawAt(ph) {
    if (!totalFrames || ph < 0) return;
    const g = Math.round(ph);
    const si = sceneOf(g);
    const localF = clamp(ph - offsets[si], 0, scenes[si].frames - 1);
    const frameNo = Math.floor(localF) + 1;

    let fade = -1;
    const framesHere = scenes[si].frames;
    if (PROFILE.crossfade && localF >= framesHere - CROSSFADE && si + 1 < scenes.length) {
      const t = clamp((localF - (framesHere - CROSSFADE)) / (CROSSFADE - 1), 0, 1);
      fade = Math.round(easeInOut(t) * FADE_STEPS) / FADE_STEPS;
    }
    if (drawKey === g && drawFade === fade) return;   // FIX B: nothing changed → no blit

    let img = cacheGet(keyOf(si, frameNo));
    let usedFrame = frameNo;
    if (!img) {
      // nearest already-decoded frame around the playhead beats a stale
      // hold: behind first (continuity), then a few ahead (closeness)
      for (let d = 1; d <= 8 && !img; d++) {
        if (frameNo - d >= 1) {
          img = cacheGet(keyOf(si, frameNo - d));
          usedFrame = frameNo - d;
        }
        if (!img && frameNo + d <= scenes[si].frames) {
          img = cacheGet(keyOf(si, frameNo + d));
          usedFrame = frameNo + d;
        }
      }
    }
    if (!img) {
      stats.frames.missed++;
      starvingUntil = performance.now() + 500;   // open extra decode slots
      pump();
      return;
    }
    drawCover(img, 1);
    stats.frames.drawn++;
    if (usedFrame !== frameNo) stats.frames.approx++;

    if (fade > 0) {
      const nextFrame = clamp(Math.round(fade * (CROSSFADE - 1)) + 1, 1, scenes[si + 1].frames);
      const nimg = cacheGet(keyOf(si + 1, nextFrame));
      if (nimg) drawCover(nimg, fade);
    }
    drawKey = g;
    drawFade = fade;
  }

  /* ---------- UI (FIX F: transform-only writes, batched, no transitions) ---------- */
  let lastPct = -1;
  function updateProgress(g) {
    const pct = Math.round((g / (totalFrames - 1)) * 1000) / 10;
    if (pct === lastPct) return;
    lastPct = pct;
    progressFill.style.transform = `scaleX(${pct / 100})`;
    stats.layout.layoutWrites++;
  }
  let lastScene = -1;
  function updateSceneUI(g) {
    const si = sceneOf(g);
    if (si === lastScene) return;
    lastScene = si;
    progressLabel.textContent = `${pad2(si + 1)} / ${pad2(scenes.length)}`;
    sceneIndexEl.textContent = pad2(si + 1);
    sceneTitleEl.textContent = scenes[si].title || scenes[si].id;
    if (g > 2) hintEl.classList.add('hide');
    stats.layout.layoutWrites++;
  }

  /* ---------- Play control (v2.1): the film plays when YOU press play ---------- */
  const playctl = $('playctl');
  function setAuto(on) {
    if (reducedMotion) on = false;
    autoEnabled = on;
    stats.autoplay.enabled = on;
    stopAutoplay();
    fadePhase = 0;
    if (playctl) {
      playctl.classList.toggle('on', on);
      playctl.setAttribute('aria-pressed', String(on));
      playctl.setAttribute('aria-label', on ? 'Pause the scroll film' : 'Play the scroll film');
      playctl.textContent = on ? '❚❚' : '▶';
    }
    if (on) { lastInput = performance.now(); endHoldUntil = 0; }
  }
  if (playctl) {
    playctl.addEventListener('click', () => { setAuto(!autoEnabled); lastInput = performance.now(); });
  }

  /* ---------- Input tracking ---------- */
  function markInput() {
    lastInput = performance.now();
    if (autoEnabled) setAuto(false);   // grabbing the scroll always wins
  }
  ['wheel', 'touchstart', 'mousedown', 'keydown', 'pointerdown']
    .forEach((ev) => window.addEventListener(ev, markInput, { passive: true }));

  function stopAutoplay() {
    autoActive = false;
    endHoldUntil = 0;
    stats.autoplay.active = false;
  }

  /* ============================================================
     FIX E — autoplay glides in with a velocity ramp, is cancelled by
     any real input, and RESTS at the end of the reel instead of
     teleporting the user's scroll position back to 0.
     ============================================================ */
  function autoplayStep(now, dt) {
    if (reducedMotion || !autoEnabled || document.hidden) return;

    // loop-with-fade: dip to black, cut to the top, come back up
    if (fadePhase === 1) {
      fadeT += dt;
      if (fadeT >= FADE_MS) {
        suppressScrollEvent = true;
        window.scrollTo(0, 0);
        scrollY = 0;
        playhead = 0;
        currentGlobal = -1;
        drawKey = -2;
        fadePhase = 2;
        fadeT = 0;
        stats.autoplay.loops++;
        autoScrollY = 0;
        autoStart = now;          // ramp back in gently
      }
      return;
    }
    if (fadePhase === 2) {
      fadeT += dt;
      if (fadeT >= FADE_MS) { fadePhase = 0; drawKey = -2; }
      return;
    }

    const t = targetFromScroll();
    if (t >= totalFrames - 1.01) {
      if (!endHoldUntil) endHoldUntil = now + END_HOLD;
      else if (now >= endHoldUntil) { fadePhase = 1; fadeT = 0; drawKey = -2; }
      return;
    }
    endHoldUntil = 0;
    if (!autoActive) {
      autoActive = true;
      autoStart = now;
      autoScrollY = scrollY;
      stats.autoplay.active = true;
    }
    const ramp = clamp((now - autoStart) / AUTO_RAMP, 0, 1);
    autoScrollY += (dt / 1000) * fps * pxPerFrame() * easeInOut(ramp);
    const y = Math.min(autoScrollY, maxScroll);
    // autoActive is true here, so the scroll listener already ignores this
    window.scrollTo(0, y);       // one write per frame, batched with the reads below
    scrollY = y;
    stats.autoplay.scrolls++;
  }

  /* ============================================================
     The ONE rAF loop. Order matters: input → damp → schedule → draw.
     Scroll is read exactly once per frame (from the cached value),
     and the playhead is damped toward it, never snapped.
     ============================================================ */
  let lastT = performance.now();
  function tick(now) {
    const dt = Math.min(50, now - lastT);
    lastT = now;
    stats.loop.frames++;
    if (dt > 33.4) { stats.loop.longFrames++; stats.loop.worst = Math.max(stats.loop.worst, dt); }

    if (metricsDirty) measure();              // FIX A: layout read only when invalidated
    autoplayStep(now, dt);

    const target = targetFromScroll();
    if (playhead < 0) playhead = target;
    if (SMOOTHING === Infinity) playhead = target;
    else {
      // FIX K: a teleport (End/Home key, anchor link, restore) is a CUT,
      // not a 1.5 s rewind sweep — v1 played the whole reel backwards here.
      if (Math.abs(target - playhead) > 400) playhead = target;
      else {
        const ease = 1 - Math.exp(-SMOOTHING * (dt / 1000));
        playhead += (target - playhead) * ease;
        if (Math.abs(target - playhead) < 0.02) playhead = target;
      }
    }

    const g = Math.round(playhead);
    if (g !== currentGlobal) {
      currentGlobal = g;
      scheduleAround(g);
      updateSceneUI(g);
    }
    updateProgress(g);
    if (fadePhase) drawKey = -2;                 // fade needs a fresh base each tick
    drawAt(playhead);
    if (fadePhase) {
      const a = fadePhase === 1 ? Math.min(1, fadeT / FADE_MS) : 1 - Math.min(1, fadeT / FADE_MS);
      ctx.fillStyle = `rgba(11, 8, 6, ${a.toFixed(3)})`;
      ctx.fillRect(0, 0, cw, ch);
      stats.frames.blits++;
    }
    requestAnimationFrame(tick);
  }

  /* ---------- FIX J: resize is debounced and re-measures everything ---------- */
  let resizeTO = 0;
  function onResize() {
    resizeCanvas();
    invalidateMetrics();
    measure();
    if (currentGlobal >= 0) scheduleAround(currentGlobal);
    drawKey = -2;
  }
  window.addEventListener('resize', () => {
    clearTimeout(resizeTO);
    resizeTO = setTimeout(onResize, 150);
  }, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(invalidateMetrics);

  /* ---------- Boot ---------- */
  async function boot() {
    let manifest;
    // lightest suitable delivery set wins; manifest.dir/ext describe it
    const sources = coarse
      ? ['assets/web-m/manifest.json', 'assets/web-avif/manifest.json',
         'assets/web/manifest.json', 'assets/manifest.json']
      : ['assets/web-avif/manifest.json', 'assets/web/manifest.json',
         'assets/manifest.json'];
    for (const src of sources) {
      try {
        const res = await fetch(src);
        if (!res.ok) continue;
        const m = await res.json();
        if (m && m.scenes && m.scenes.length) { manifest = m; break; }
      } catch { /* try the next source */ }
    }
    if (!manifest) {
      loaderPct.textContent = 'Could not load a manifest — run `npm run build:frames`, or serve over http';
      return;
    }

    scenes = manifest.scenes;
    fps = manifest.fps || 24;
    if (manifest.dir) baseDir = manifest.dir;
    if (manifest.ext) ext = manifest.ext;
    if (manifest.prefix !== undefined) scenes.forEach((s) => { s.prefix = manifest.prefix; });
    scenes.forEach((s) => { if (s.prefix === undefined) s.prefix = 'ezgif-frame-'; });
    // pad width can differ between sets
    if (manifest.pad) padWidth = manifest.pad;

    offsets = [];
    let acc = 0;
    for (const s of scenes) { offsets.push(acc); acc += s.frames; }
    totalFrames = acc;

    spacer.style.height = (SCENE_VH * scenes.length) + 'vh';
    resizeCanvas();
    measure();

    // Warm-up with a hard timeout (FIX J): the page always reveals.
    const WARM = Math.min(PROFILE.warmFrames, totalFrames);
    let done = 0;
    const warmKeys = [];
    for (let i = 0; i < WARM; i++) {
      const si = sceneOf(i);
      warmKeys.push([si, i - offsets[si] + 1]);
    }
    await Promise.race([
      Promise.all(warmKeys.map(([si, f]) =>
        loadFrame(si, f, 'high')
          .then((bmp) => {
            const bytes = bmp.width * bmp.height * 4;
            adoptSourceRes(bmp.width, bmp.height);
            cache.set(keyOf(si, f), { bmp, bytes });
            cacheBytes += bytes;
            requested.add(keyOf(si, f));
          })
          .catch(() => { stats.net.failed++; })
          .then(() => {
            done++;
            const pct = Math.round((done / WARM) * 100);
            loaderFill.style.transform = `scaleX(${pct / 100})`;
            loaderPct.textContent = pct + '%';
          }))),
      new Promise((r) => setTimeout(r, PROFILE.warmTimeoutMs)),
    ]);
    stats.cache.bytes = cacheBytes;
    stats.cache.entries = cache.size;

    loaderEl.classList.add('done');
    setTimeout(() => loaderEl.remove(), 1000);

    playhead = targetFromScroll();
    currentGlobal = Math.round(playhead);
    scheduleAround(currentGlobal);
    updateSceneUI(currentGlobal);
    updateProgress(currentGlobal);
    lastInput = performance.now();
    if (PROFILE.autoplay) setAuto(true);
    if (playctl) playctl.hidden = reducedMotion;
    requestAnimationFrame(tick);
  }

  /* diagnostics / perf-test hook (read-only surface) */
  window.__caha = {
    stats, profile: PROFILE, setDir: baseDir,
    get playhead() { return playhead; },
    get maxScroll() { return maxScroll; },
  };

  boot();
})();
