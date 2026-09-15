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
     FIX L  URL-bar-class viewport changes remapping the whole film
     FIX M  autoplay that ignored scrollbar drags / non-wheel scrolls
     FIX N  silent black screen when no frame ever decodes
     FIX O  damping that trailed a fast scrub by ~1 s of film
     FIX P  profile chosen from RAM/network hints, not pointer + width
     FIX Q  two paths into the bitmap cache (double-decode, bytes, close)
     FIX R  ±8-frame fallback search → nearest resident frame in the scene
     FIX S  warm-up that ignored the cache budget it was filling
     FIX O2 damping speed-up disabled while the frame pipeline is starving

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


  /* FIX P — two independent questions: what *shape* of delivery does this
     device want (pointer + width), and what *budget* can it afford (memory /
     network hints)? v2.0/2.1 conflated them, so a 4 GB desktop was served the
     960 px phone tier and a tablet with a coarse pointer but plenty of RAM got
     the phone budget. deviceMemory is a rounded hint (and 4 is a very common
     value on desktop), so it may lower budgets but must not pick the tier. */
  /* FIX X diagnosis switches (A/B on one machine, like ?damping=flat):
     the concurrency the frame pump is allowed to run at. The audit found that
     p95 starvation does not scale with tier size the way throughput alone would
     predict — it falls off a cliff once per-frame latency exceeds the playhead's
     patience, and 10 concurrent decodes on a low-core CPU is exactly how that
     happens. */
  const CONC_OVERRIDE = +(qs.get('conc') || 0);
  const BURST_OVERRIDE = +(qs.get('burst') || 0);

  const PROFILE = (() => {
    const phoneTier = coarse || window.innerWidth < 700;
    const tight = saveData || tinyNet || lowMem;
    if (phoneTier) {
      return {
        id: 'mobile',
        cacheBudgetMB: lowMem ? 64 : tight ? 96 : 128,  // FIX D: budget in BYTES, not frame count
        maxConcurrent: CONC_OVERRIDE || 2,   // FIX C: base slots; rises when starving
        maxConcurrentBurst: BURST_OVERRIDE || 4,
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
      id: tight ? 'desktop-lite' : 'desktop',
      cacheBudgetMB: tight ? 192 : 384,
      maxConcurrent: CONC_OVERRIDE || Math.min(tight ? 4 : 6, Math.max(3, cores - 2)),
      maxConcurrentBurst: BURST_OVERRIDE || 10,
      warmFrames: 36,
      warmTimeoutMs: 2500,
      preloadAhead: 36,
      preloadBehind: 10,
      crossfade: !(saveData || tinyNet),   // crossfade doubles full-screen blits
      autoplay: qs.get('autoplay') === '1',     // opt-in everywhere now
      smoothing: 10,
      resCap: 1920,
    };
  })();

  /* ---------- Tuning ---------- */
  const ADAPTIVE_DAMPING = qs.get('damping') !== 'flat';  // FIX O (A/B switch)
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
  const requested = new Set(); // keys queued, in flight or resident
  const inFlight = new Set();  // FIX Q: keys with a fetch/decode in progress
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
    version: 2.2,
    profile: PROFILE.id,
    frames: { drawn: 0, missed: 0, approx: 0, blits: 0 },
    net: { requests: 0, bytes: 0, failed: 0 },
    cache: { hits: 0, misses: 0, bytes: 0, entries: 0, evicted: 0 },
    layout: { scrollReads: 0, layoutWrites: 0, measures: 0, deferredMeasures: 0 },
    loop: { frames: 0, longFrames: 0, worst: 0 },
    autoplay: { enabled: false, active: false, scrolls: 0, loops: 0, yields: 0 },
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
  let metrics = null;                 // { w, h, maxScroll } of the last real measure

  /* FIX L — metrics are re-measured on invalidation, but *height-only* changes
     smaller than a third of the viewport are ignored. That is exactly what a
     mobile URL bar collapsing (or a soft keyboard animating) looks like, and
     re-measuring there moves `maxScroll` under the user's finger, which remaps
     the whole film: measured in Chromium, a 96 px URL-bar collapse moved the
     displayed frame by 4 frames on the 1,400-frame delivery set — and the source
     reel runs at 4.3 px/frame, so the same 96 px collapse is ~22 frames there.
     Width changes, rotations and large resizes still re-measure. */
  function measure(force) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const prev = metrics;
    if (!force && prev && w === prev.w && Math.abs(h - prev.h) <= prev.h * 0.3) {
      stats.layout.deferredMeasures++;
      metricsDirty = false;
      return false;                   // keep the mapping the user is scrolling against
    }
    stats.layout.measures++;
    metrics = { w, h, maxScroll: Math.max(1, document.documentElement.scrollHeight - h) };
    maxScroll = metrics.maxScroll;
    metricsDirty = false;
    return true;
  }
  const invalidateMetrics = () => { metricsDirty = true; };

  // Passive scroll listener: caches the compositor's scroll offset.
  // Reading window.scrollY here is free (it is not a layout query).
  let autoWroteY = -1;               // where autoplay last put the scroll
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    scrollY = y;
    stats.layout.scrollReads++;
    /* FIX M — a scroll we did not write is user input, whoever caused it. The
       v2.1 one-shot `suppressScrollEvent` flag had two holes: (1) dragging the
       scrollbar dispatches no DOM event at all, so autoplay never yielded and
       fought the user for the whole drag; (2) if our own scrollTo produced no
       scroll event (position unchanged) the flag stayed armed and swallowed
       the *next* real scroll. Comparing against where we last wrote closes
       both without any extra state to get out of sync. */
    if (autoActive && autoWroteY >= 0 && Math.abs(y - autoWroteY) > 4) {
      stats.autoplay.yields++;
      markInput();                   // pauses autoplay and hands the scroll back
      return;
    }
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
  let resCapH = 0;                  // height of the widest frame seen (FIX Y)
  let resCapPinned = false;         // has the delivery width been applied yet?
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
  /* FIX X — per-frame delivery cost, measured where it happens (fetch + decode).
     Median/percentile timing lives in stats.frames.decode for the reports; the
     EWMA is what the pump's governor reads. */
  let decodeEwmaMs = 0;          // 0 = nothing measured yet
  let decodeSamples = 0;
  const decodeHist = [];         // last 64, for the p95 in stats
  function noteDecode(ms) {
    decodeSamples++;
    decodeEwmaMs = decodeEwmaMs ? decodeEwmaMs * 0.8 + ms * 0.2 : ms;
    decodeHist.push(ms);
    if (decodeHist.length > 64) decodeHist.shift();
    if (decodeSamples === 1 || decodeSamples % 8 === 0) {
      const sorted = [...decodeHist].sort((a, b) => a - b);
      stats.frames.decode = {
        ms: +decodeEwmaMs.toFixed(1),
        median: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
        p95: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1),
        n: decodeSamples,
      };
    }
  }

  async function loadFrame(si, f, priority) {
    const t0 = performance.now();
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
    noteDecode(performance.now() - t0);
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
    /* FIX W — rebuilding the queue dropped the keys of frames that had been
       queued but not yet picked up by pump(), while `requested` (which enqueue()
       trusts: "queued, in flight or resident") kept them forever. Every scrub
       tick leaked a few more, so a frame could become permanently unrequestable
       and the renderer would approximate around it — measured at a settled
       playhead: the film resting 6-9 frames off, indefinitely. Rebuild `requested`
       down to what is actually live: resident, in flight, or in the new queue. */
    for (const k of requested) if (!cache.has(k) && !inFlight.has(k)) requested.delete(k);
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
  /* One place that turns a decoded bitmap into a resident cache entry, so the
     warm-up path and the pump path cannot drift apart. Two races used to be
     possible: the same key decoded twice (warm-up finishing while the pump
     re-queued it), which double-counted `cacheBytes` and made the budget
     evict frames it did not need to evict, and a replaced entry leaking its
     bitmap because nobody called close(). */
  function storeFrame(si, f, bmp) {
    const k = keyOf(si, f);
    const bw = bmp.width || bmp.naturalWidth || 0;
    const bh = bmp.height || bmp.naturalHeight || 0;
    if (!bw || !bh) return;
    const bytes = bw * bh * 4;
    adoptSourceRes(bw, bh);
    const prev = cache.get(k);
    if (prev) {
      cacheBytes -= prev.bytes;
      if (prev.bmp !== bmp && prev.bmp.close) prev.bmp.close();
    }
    cache.set(k, { bmp, bytes });
    cacheBytes += bytes;
    requested.add(k);
    stats.cache.bytes = cacheBytes;
    stats.cache.entries = cache.size;
    evict();
  }

  /* FIX X — the burst cap was a constant (10), and on a 2-core box ten
     concurrent AVIF decodes pushed each frame's *latency* past the playhead's
     patience: measured on this machine, 1920-wide frames at burst 10 starved
     the film by p95 40.6 frames, the same tier at burst 4 by 3.5. Ten requests
     in flight do not make ten times the progress when there are two cores —
     they only make every frame late. So the pump now bounds *latency* instead
     of count: in-flight work is capped so that the newest request should still
     land inside LATENCY_BUDGET_MS, using the measured cost of recent frames
     (fetch + decode, EWMA). Machines that decode in 4 ms keep the old burst
     behaviour; slow ones automatically settle to 2-4 in flight. `?latency=`
     overrides the budget for A/B runs. */
  const LATENCY_BUDGET_MS = +(qs.get('latency') || 45);
  function pumpCap() {
    const base = performance.now() < starvingUntil ? PROFILE.maxConcurrentBurst : PROFILE.maxConcurrent;
    if (!decodeSamples || !LATENCY_BUDGET_MS) return base;
    const byLatency = Math.round(LATENCY_BUDGET_MS / Math.max(1, decodeEwmaMs));
    return clamp(byLatency, 2, base);
  }

  function pump() {
    const cap = pumpCap();
    while (activeLoads < cap && queue.length) {
      const item = queue.shift();
      if (cache.has(item.k) || inFlight.has(item.k)) continue;
      inFlight.add(item.k);
      activeLoads++;
      loadFrame(item.si, item.f, item.dist < 3 ? 'high' : 'low')
        .then((bmp) => { storeFrame(item.si, item.f, bmp); })
        .catch(() => {
          requested.delete(item.k);    // allow a retry later
          stats.net.failed++;
        })
        .finally(() => { inFlight.delete(item.k); activeLoads--; pump(); });
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
    /* Reels can mix resolutions (this one does: three 720p scenes + eleven
       1080p), so size the surface from the LARGEST frame seen rather than from
       whichever frame happens to arrive.
       FIX Y — the "which frame happens to arrive" version oscillated: the cap
       was min(profile, max(seen, w), h*16/9), so a 720p scene's frame dropped
       the cap back to 1280 while the next 1080p frame raised it to 1920 again.
       Every flip called resizeCanvas(), i.e. assigned canvas.width/height —
       which invalidates layout and forces a full repaint plus a surface
       reallocation. Measured in Chromium: Blink layout per frame on the
       teleport scenario went 0.021 (uniform 1280 tier) → 0.059-0.069 (mixed
       1920/1280 tier) purely from that oscillation, and the stalls showed up
       as extra starvation on the way *into* a scene boundary.
       Monotonic now: pin once to the tier's real width, then only ever grow. */
    if (w > resCapSeen) { resCapSeen = w; resCapH = h; }
    const want = Math.min(PROFILE.resCap, resCapSeen, resCapH ? Math.round(resCapH * 16 / 9) : resCapSeen);
    const cap = resCapPinned ? Math.max(resCap, want) : want;
    resCapPinned = true;
    if (cap !== resCap) { resCap = cap; resizeCanvas(); }
    const frameBytes = w * h * 4;
    if (frameBytes <= maxFrameBytes) return;
    maxFrameBytes = frameBytes;
    /* FIX D2, corrected: the resident window (the frames eviction is not allowed
       to touch) must fit *inside* the byte budget, or the budget is advisory and
       the peak resident set is whatever the window happens to be. v2.1 computed
       ahead/behind independently with hard floors (≥8 ahead, ≥4 behind) and then
       added the whole crossfade margin on top in evict(), which on the mobile
       profile was 8+4+14 = 26 frames ≈ 96 MB against a 64 MB budget — measured
       73.8–102 MB resident. Derive the window from the budget instead, keep ~20 %
       headroom for the crossfade/prefetch outside it, and let the crossfade
       margin count toward the budget only when crossfade is actually enabled. */
    const budget = PROFILE.cacheBudgetMB * 1024 * 1024;
    const resident = clamp(Math.floor((budget * 0.8) / frameBytes), 6,
      PROFILE.preloadAhead + PROFILE.preloadBehind);
    win.ahead = clamp(Math.round(resident * 0.72), 3, PROFILE.preloadAhead);
    win.behind = clamp(resident - win.ahead, 2, PROFILE.preloadBehind);
    stats.cache.window = [win.behind, win.ahead];
  }

  /* FIX D — evict by decoded BYTES (a 1920×1080 bitmap is 8.3 MB; v1's
     100-frame cap was ~830 MB of bitmaps and got mobile tabs killed),
     and close() bitmaps so the memory actually returns. */
  function evict() {
    const budget = PROFILE.cacheBudgetMB * 1024 * 1024;
    if (cacheBytes <= budget) return;
    const lo = currentGlobal - win.behind;
    const hi = currentGlobal + win.ahead + (PROFILE.crossfade ? CROSSFADE : 0);
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
  const NEAREST_MAX = 30;      // frames; ~1.2 s of film at 24 fps

  function pushMiss(m) {
    missWindow.push(m);
    if (missWindow.length > 60) missWindow.shift();
    stats.frames.starving = missWindow.reduce((a, b) => a + b, 0) / missWindow.length;
  }

  function nearestCachedFrame(si, frameNo) {
    const base = si * 1000;
    const last = base + scenes[si].frames;
    let behind = -1, ahead = -1;
    for (const k of cache.keys()) {
      if (k <= base || k > last) continue;        // same scene only
      const f = k - base;
      if (f === frameNo) return f;
      if (f < frameNo) { if (behind < 0 || f > behind) behind = f; }
      else if (ahead < 0 || f < ahead) ahead = f;
    }
    const bd = behind < 0 ? Infinity : frameNo - behind;
    const ad = ahead < 0 ? Infinity : ahead - frameNo;
    if (bd <= 8 && bd <= ad + 2) return behind;   // continuity first, when close
    if (ad <= 8) return ahead;
    const pick = bd <= ad ? behind : ahead;
    if (pick < 0 || Math.abs(pick - frameNo) > NEAREST_MAX) return -1;
    return pick;
  }

  /* Rolling starvation flag: how many of the last 60 draws found no frame at all.
     Used by the playhead damping below (FIX O2). */
  let missWindow = [];
  let approxWant = null;        // FIX V: {si, f} we had to approximate around
  let approxRetryAt = 0;        // throttle re-scheduling while it is missing

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
      /* FIX R — v2.1 probed at most ±8 frames for something already decoded, so
         a deliberate jump (End/Home, an anchor, a scrollbar drag, or simply
         re-scrubbing an area that was evicted) showed *nothing* new until the
         right frame finished decoding. Ask the cache instead: one pass over
         ≤ ~100 keys finds the closest resident frame in this scene, preferring
         the one behind the playhead for continuity — and never further than
         NEAREST_MAX, because a frame from a different moment is worse than a
         brief hold. */
      const near = nearestCachedFrame(si, frameNo);
      if (near > 0) { img = cacheGet(keyOf(si, near)); usedFrame = near; }
    }
    if (!img) {
      stats.frames.missed++;
      starvingUntil = performance.now() + 500;   // open extra decode slots
      pushMiss(1);
      pump();
      return;
    }
    pushMiss(0);
    drawCover(img, 1);
    stats.frames.drawn++;
    stats.frames.shown = { si, f: usedFrame, global: offsets[si] + usedFrame - 1 };
    if (usedFrame !== frameNo) stats.frames.approx++;

    if (fade > 0) {
      const nextFrame = clamp(Math.round(fade * (CROSSFADE - 1)) + 1, 1, scenes[si + 1].frames);
      const nimg = cacheGet(keyOf(si + 1, nextFrame));
      if (nimg) drawCover(nimg, fade);
    }
    /* FIX V — an approximated frame must not be final. `drawKey === g` makes the
       render path a no-op for the rest of the stop, so when FIX R's
       nearest-resident fallback drew a neighbour and the exact frame landed a
       moment later, the canvas kept the neighbour: measured at a settled
       playhead the film rested 8.9 frames (≈0.4 s of film) off, indefinitely,
       which is what the screen-quality tool refuses to settle on. Remember what
       was approximated around; the tick repaints once, when the exact bitmap is
       resident. (While moving, the next tick's g differs anyway — this only
       matters at rest, which is exactly where a viewer stops to look.) */
    approxWant = usedFrame === frameNo ? null : { si, f: frameNo };
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
        autoWroteY = 0;               // our own write must not read as user input
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
    autoWroteY = y;
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
        /* FIX O — the damping rate rises with the distance still to cover, so a
           fast scrub does not trail the scrollbar by a second of film while a
           settled playhead still eases (that easing is what hides the wheel's
           quantisation). `?damping=flat` restores v2.1 behaviour so the two can
           be A/B'd on the same machine (see AUDIT.md for the measured trace).
           FIX O2 — but a *faster* playhead is the wrong answer when the frames
           are not arriving: on a slow link or a weak device the playhead would
           run ahead of anything it can show and the picture would sit still
           while the scrollbar moves. When the last 60 draws starved, drop the
           speed-up so the film eases at the rate the pipeline can hold. */
        const gap = Math.abs(target - playhead);
        const starving = (stats.frames.starving || 0) > 0.10;
        const rate = SMOOTHING * (ADAPTIVE_DAMPING && !starving ? 1 + Math.min(1.5, gap / 40) : 1);
        const ease = 1 - Math.exp(-rate * (dt / 1000));
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
    /* FIX V: the exact frame we had to approximate around may arrive after the
       playhead stopped. If it is resident, force the one repaint that swaps the
       approximation out; if it is still missing, ask for it again (throttled, so
       a genuinely unavailable frame cannot turn into a per-tick queue rebuild). */
    if (approxWant) {
      if (cacheGet(keyOf(approxWant.si, approxWant.f))) {
        approxWant = null;
        drawKey = -2; drawFade = -2;
      } else if (now - approxRetryAt > 200) {
        approxRetryAt = now;
        scheduleAround(g);
      }
    }
    drawAt(playhead);
    if (fadePhase) {
      const a = fadePhase === 1 ? Math.min(1, fadeT / FADE_MS) : 1 - Math.min(1, fadeT / FADE_MS);
      ctx.fillStyle = `rgba(11, 8, 6, ${a.toFixed(3)})`;
      ctx.fillRect(0, 0, cw, ch);
      stats.frames.blits++;
    }
    requestAnimationFrame(tick);
  }

  /* ---------- FIX J: resize is debounced and re-measures everything ----------
     FIX L: except URL-bar-class, height-only changes — those must not move the
     scroll mapping mid-gesture. The canvas backing store is re-synced once the
     gesture has settled instead (a realloc + full repaint per URL-bar frame
     would be worse than the slight CSS scale in between). */
  let resizeTO = 0;
  let settleTO = 0;
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const prev = metrics;
    const urlBarLike = prev && w === prev.w && Math.abs(h - prev.h) <= prev.h * 0.3;
    if (!urlBarLike) {
      resizeCanvas();
      invalidateMetrics();
      measure(true);
      if (currentGlobal >= 0) scheduleAround(currentGlobal);
      drawKey = -2;
      return;
    }
    invalidateMetrics();             // the tick's measure() will defer and clear it
    clearTimeout(settleTO);
    settleTO = setTimeout(() => { resizeCanvas(); drawKey = -2; }, 500);
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

    /* Warm-up with a hard timeout (FIX J): the page always reveals.
       FIX S — the warm-up has to respect the same byte budget as the running
       cache. It used to decode `warmFrames` frames unconditionally, and eviction
       can never touch frames inside the resident window, so on the mobile
       profile it loaded ~25 frames (~95 MB) into a 64 MB budget before the loop
       even started (measured in Chromium: 94.9 MB peak resident vs a 64 MB
       budget, i.e. the budget was advisory, not real). Size the warm-up from
       the budget, and evict once before the loop takes over. */
    const expectedFrameBytes = Math.max(1, Math.round(PROFILE.resCap * PROFILE.resCap * 9 / 16) * 4);
    const warmByBudget = Math.floor((PROFILE.cacheBudgetMB * 1048576 * 0.5) / expectedFrameBytes);
    const WARM = Math.max(6, Math.min(PROFILE.warmFrames, warmByBudget, totalFrames));
    let done = 0;
    const warmKeys = [];
    for (let i = 0; i < WARM; i++) {
      const si = sceneOf(i);
      warmKeys.push([si, i - offsets[si] + 1]);
    }
    await Promise.race([
      Promise.all(warmKeys.map(([si, f]) =>
        loadFrame(si, f, 'high')
          .then((bmp) => { storeFrame(si, f, bmp); })
          .catch(() => { stats.net.failed++; })
          .then(() => {
            done++;
            const pct = Math.round((done / WARM) * 100);
            loaderFill.style.transform = `scaleX(${pct / 100})`;
            loaderPct.textContent = pct + '%';
          }))),
      new Promise((r) => setTimeout(r, PROFILE.warmTimeoutMs)),
    ]);
    evict();
    stats.cache.bytes = cacheBytes;
    stats.cache.entries = cache.size;

    /* FIX N — v2.1 always revealed the page, so a missing/blocked frame set
       (or a manifest pointing at files that are not there) produced a silent
       black screen: the loader faded out, nothing ever drew, and nothing said
       why. Reveal only when there is something to show; otherwise say what
       happened and keep watching, so a slow/blocked set still recovers. */
    const reveal = () => { loaderEl.classList.add('done'); setTimeout(() => loaderEl.remove(), 1000); };
    if (cache.size === 0) {
      stats.loader = { revealed: false, failed: stats.net.failed };
      loaderPct.textContent = stats.net.failed
        ? `No frames loaded — ${stats.net.failed} requests failed. Run \`npm run build:frames\`, or check assets/manifest.json`
        : 'No frames loaded';
      const watch = setInterval(() => {
        if (cache.size > 0) { clearInterval(watch); stats.loader.revealed = true; reveal(); }
      }, 600);
    } else {
      stats.loader = { revealed: true, failed: stats.net.failed };
      reveal();
    }

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

  /* diagnostics / perf-test hook (read-only surface).
     `debug()` is what tools/browser-audit.mjs polls once per animation frame
     to trace scroll → playhead → displayed frame; it must stay side-effect
     free (no layout reads, no writes). */
  window.__caha = {
    stats, profile: PROFILE,
    // live: baseDir is only known once the manifest probe has picked a tier,
    // and `setDir: baseDir` here would capture the default forever (the
    // screen-quality tool asserts this to prove it measured the right reel).
    get setDir() { return baseDir; },
    get playhead() { return playhead; },
    get maxScroll() { return maxScroll; },
    debug: () => ({
      scrollY, maxScroll, totalFrames, innerHeight: window.innerHeight,
      target: targetFromScroll(), playhead,
      shown: stats.frames.shown ? { ...stats.frames.shown } : null,
      metricsDirty, window: { ahead: win.ahead, behind: win.behind },
    }),
  };

  boot();
})();
