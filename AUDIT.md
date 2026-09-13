# Caha — scroll audit & fix report

Audit date: 2026-09-13 · branch `arena/01a09a57-caha` · audited code: the scroll engine as
committed on `arena/01a09a10-caha` (`app.js` v1, 348 lines) — the only copy of the real
project that exists in this repository.

Everything below was measured, not guessed. Where a browser was unavailable (this sandbox
has no Chrome and no package mirror for one), the numbers come from
`tools/simulate.mjs` — a headless harness that runs the **actual v1 and v2 engine source**
in a virtual 60 Hz browser: real asset bytes read from disk, a network/latency model,
modelled per-megapixel blit cost from each engine's *own* canvas size, and instrumented
`scrollHeight` / `scrollTo` / style-write counters. Reproduce with:

```bash
npm i
CAHA_SRC_FRAMES=<path to assets/frames> node tools/simulate.mjs --engine v1 --net local --device desktop
node tools/simulate.mjs --engine v2 --net local --device desktop --set web
```

---

## Step 1 — Diagnosis (the 12 questions, answered for this codebase)

**1. Scroll library?** None. Native browser scroll + one `requestAnimationFrame` loop that
reads `window.scrollY` (v1 `app.js:236-272`). No GSAP ScrollTrigger, no Locomotive, no Lenis,
no IntersectionObserver.

**2. 3D library?** None at runtime. The "3D" is a **pre-rendered film**: 14 scenes × 300
JPEG frames (4,200 files, **239.4 MB**, mixed 1920×1080 and 1280×720) drawn with
`drawImage` onto a 2D canvas and scrubbed by scroll. This is the single most important
fact in the audit: every recommendation below follows from it.

**3. More than one scroll-controlling system?** No library fight — but a *self* fight:
idle autoplay writes `window.scrollTo()` every frame (v1 `app.js:246-262`) inside the same
loop that reads `window.scrollY`, and at the end of the reel it teleports with
`window.scrollTo(0, 0)` (v1 `app.js:252`). Any input during autoplay, or the end-of-reel
teleport, reads as "the scroll is broken".

**4. Render loop synced to a scroll ticker?** There is exactly one rAF loop (good), but a
second animator fought it: `#progress-fill { transition: width 80ms linear }` (v1
`style.css`) while JS rewrote `style.width` on every frame change — a CSS transition
restarted ~60×/s on a layout property.

**5. Raw `scrollY` per event, or damped in rAF?** Damping was already correct
(frame-rate-independent exponential smoothing, v1 `app.js:265-268`) — but the scroll
*metrics* were read raw and expensively: `maxScroll()` reads
`document.documentElement.scrollHeight` (a forced layout) and was called up to **3× per
frame** (v1 `app.js:203-213`, via `targetFromScroll()` twice + `pxPerFrame()`), interleaved
with `scrollTo` writes and `style.width` writes. Measured: **2.13 forced-layout reads per
animation frame**, continuously. Textbook layout thrashing.

**6. Compositing / GPU hints?** The stage is `position: fixed` (good), but: the canvas
backing store was sized `CSS × devicePixelRatio` (v1 `app.js:96-99`) — up to 3840×2160 —
while the source frames are ≤1920×1080, so every frame paid for a full-screen **upscaling
blit** into a surface with no extra detail; and `#wordmark` used `backdrop-filter: blur(6px)`
(v1 `style.css`) over the animating canvas, forcing a blurred backdrop read-back on every
repaint.

**7. `ScrollTrigger.refresh()` after assets load?** N/A (no ScrollTrigger) — but the
equivalent bug existed: page height is set from JS after `fetch(manifest)` (v1
`app.js:296`), the resize handler only resized the canvas (v1 `app.js:276`) and never
re-measured anything, and the live per-frame `scrollHeight` read was the (very expensive)
way v1 "noticed" layout changes.

**8. `overflow` on html/body?** `body { overflow-x: hidden }` (v1 `style.css`) — the classic
scroll-container trap (phantom scrollbars / broken `position: fixed` descendants on some
engines). Nothing in the layout overflows horizontally, so it was pure risk.

**9. Pinning / snap?** No ScrollTrigger pins and no snap — the fixed-stage + `#spacer`
pattern is the right choice and was kept. Two notes: the spacer is set in `vh` (mobile
URL-bar collapse changes scroll length mid-gesture), and 14 × 150vh = **2100vh** of scroll
is an extreme reel length (a design decision, flagged not changed).

**10. Mobile?** No mobile profile at all: same 1920×1080 JPEGs, same DPR-2 canvas, autoplay
on touch, and a **count-based** LRU capped at 100 decoded frames (v1 `app.js:44`) = up to
**~830 MB of decoded bitmaps** (100 × 1920×1080×4 B). That is a tab-kill on iOS and
GC-storm territory on Android. Simulated 4G + phone: v1 ran **459 frames of lag on average**
behind the scroll position.

**11. Passive listeners?** Clean in v1 — all five input listeners are `{ passive: true }`
(v1 `app.js:275`). The audit harness (`diagnostics.js`) now asserts this continuously:
0 non-passive wheel/touch/scroll listeners.

**12. Multiple rAF loops?** Exactly one in v1 (kept in v2). The harness counts live
self-rearming rAF chains and reports them in the overlay.

### Root causes, ranked by measured impact

| # | Root cause | Symptom it produces |
|---|-----------|---------------------|
| 1 | 239.4 MB / 4,200-request payload, main-thread-first decode (`new Image()` + draw-on-load), count-based 830 MB bitmap cache | stalls, "stuck-then-jump", tab kills on mobile, minutes of loading off-localhost |
| 2 | forced layout (`scrollHeight`) 2.13×/frame interleaved with `scrollTo` + `style.width` writes | micro-stutter on every scroll tick, worst on slow CPUs |
| 3 | canvas backing store up to 4× the source pixels + redundant same-frame redraws + double-blit crossfade | 11.4 s of modelled blit time per 50 s of scroll; dropped frames on weak GPUs |
| 4 | autoplay hijack + end-of-reel teleport + 1.5 s "rewind sweep" after any anchor/End jump | "the page scrolls by itself / jumps" — the #1 *feels broken* report |
| 5 | `backdrop-filter` over an animating canvas; `overflow-x: hidden` on body | per-frame composite work; latent fixed-positioning/scrollbar bugs |

---

## Step 2 — Fixes (smallest change per root cause; architecture kept)

The architecture was **not** rewritten: native scroll + one rAF + damped playhead was
already the right design, and no scroll/3D library was added (adding Lenis or GSAP here
would insert a second opinion about scroll position into a system whose problem was
already too many opinions).

1. **Payload pipeline** (`tools/build-frames.mjs`): denoise `median(3)` → resize to 1600
   (never upscale) → keep every 2nd frame → WebP q60. Measured on the real reel:
   **4,200 files / 239.4 MB → 2,100 files / 112.6 MB** (avg 55 KB), i.e. ~8 MB streamed per
   scene viewed instead of ~20 MB, half the requests, and 1600×900 decoded bitmaps
   (5.8 MB vs 8.3 MB). `--format avif --quality 45` measures ~40% smaller still
   (48 KB vs 93 KB per identical frame) at a slower encode; the engine picks
   `assets/web/` (or a `assets/web-m/` mobile tier) automatically and falls back to the
   source reel if no build exists.
2. **Decode off the hot path**: frames are fetched as blobs and decoded with
   `createImageBitmap()` (off-main-thread, upload-ready), instead of `new Image()` whose
   first `drawImage` stalls.
3. **One scroll read, zero layout reads per frame** (FIX A): `scrollY` is cached by a
   passive listener; `scrollHeight` is measured only on invalidation (resize debounced
   150 ms, orientationchange, `fonts.ready`, manifest load). 2.13 → **0** reads/frame.
4. **Transform-only UI writes** (FIX F): progress bar is `scaleX()` with `will-change`,
   scene labels update only on scene change, the CSS transition is gone. 1,143 → **1**
   layout-triggering writes per 50 s run.
5. **Canvas sized to the content** (FIX B): backing store capped to the delivery
   resolution (and DPR), redundant same-frame blits skipped (`drawKey`), crossfade alpha
   quantised to 12 steps and disabled on mobile. Modelled blit cost 11,355 ms → **1,179 ms**
   per 50 s.
6. **Byte-budgeted cache** (FIX D/D2): eviction by decoded bytes with `bitmap.close()`,
   and — the subtle one — the *resident window* is derived from budget ÷ decoded-frame
   bytes, because preloading more than the budget can hold is pure eviction churn
   (measured 1,105 pointless evictions before this). Peak bitmaps 799 MB → 417 MB desktop
   (bounded), → **78 MB** on mobile.
7. **Autoplay that behaves** (FIX E/K): velocity ramp-in, instant cancel on any input,
   rests at the end instead of teleporting, opt-out via `?autoplay=0`, and teleports
   (End/Home/anchors/scroll-restore) are **cuts**, not rewind sweeps.
8. **Compositing hygiene** (FIX G, #8): `backdrop-filter` removed (solid tint reads the
   same), `body{overflow-x:hidden}` → `html{overflow-x:clip}`, `overscroll-behavior-y:none`,
   `touch-action: pan-y pinch-zoom` on the stage, `contain: layout paint` on the stage.
9. **Nearest-frame fallback**: on a cache miss the engine draws the closest decoded frame
   ±8 instead of holding a stale one — motion stays continuous during flicks (324 uses in
   the desktop trace, 282 on 4G).
10. **Loader with an escape hatch** (FIX J): warm-up races a 2.2–2.5 s timeout so the page
    always reveals; resize re-measures scroll metrics and re-schedules preloads.

### What to test by hand

- **Desktop, wheel notches:** the film should glide between notches (damping), the top
  progress bar should move without stepping; open `?audit=1` — fps graph green,
  `rAF loops = 2` (engine + diagnostics), `layout reads/frame = 0`, `non-passive LSN = 0`.
- **Idle 4 s:** autoplay eases in (no lurch); touch the wheel → instant hand-back, no jump.
- **End key / Home key / reload mid-page:** a cut to the right frame, never a rewind sweep.
- **DevTools → Network, 4G throttle:** frames arrive progressively; during a fast flick you
  may see the nearest-available frame (slightly soft continuity) but never a blank canvas.
- **Phone (real device):** scroll the whole reel once — the tab must not be killed by
  memory (v1's cache alone could hold ~830 MB); Safari/Chrome memory readout should stay
  under ~150 MB for the canvas cache.

---

## Step 3 — Verify loop (re-ran the Step-1 checklist against v2)

Same 50 s synthetic trace (wheel bursts, a fling, two idle windows, End + Home teleports),
identical for both engines; `local` = localhost-class network, `4g` = 1.5 Mbps + 60 ms.

| metric (desktop / local) | v1 | v2 | |
|---|---|---|---|
| forced-layout reads / rAF | 2.13 | **0** | item 5 |
| layout-triggering style writes | 1,143 | **1** | items 4/6 |
| scroll writes (autoplay) | 1,687 | 1,687 (ramped, cancellable, rests at end) | item 3 |
| modelled full-screen blit ms / 50 s | 11,355 | **1,179** | item 6 |
| peak decoded bitmaps | 799 MB | **417 MB** (budget-bounded) | item 10 |
| payload transferred in trace | 259.8 MB / 4,727 req | **67.9 MB / 1,233 req** | item 1 |
| displayed-frame lag: mean / p95 | 209 / 2,723 frames | **6.8 / 13.2 frames** | feel |
| ticks >12 frames behind scroll | 18.3 % | **6.3 %** | feel |

| metric (phone / 4G) | v1 | v2 |
|---|---|---|
| lag mean / p95 (frames) | 458.7 / 3,745 | **49.9 / 131.9** |
| peak decoded bitmaps | 799 MB (tab-kill) | **78 MB** |
| payload in trace | 43.2 MB / 800 req | **9.3 MB / 171 req** |

Checklist re-run on v2: one rAF loop ✔ · passive-only listeners ✔ · damped playhead,
scroll read once per frame ✔ · refresh-equivalent on resize/fonts/manifest ✔ ·
`overflow-x: clip`, no double scroll container ✔ · no pin/snap regressions (none existed) ✔ ·
mobile profile (payload tier, memory budget, DPR cap, no crossfade, no autoplay by default) ✔.

**Honest limits:** on 1.5 Mbps the reel is bandwidth-bound — 41 % of active ticks still run
>12 frames behind during hard flicks (v1: 71 %, and it held *stale* frames while doing it).
The fix for that is the lighter mobile tier, not more client cleverness:
`node tools/build-frames.mjs --width 960 --quality 55 --out assets/web-m`
(the engine already probes `assets/web-m/` first on coarse pointers). Final confirmation on
real GPUs/phones is still required — the harness models blit cost, it cannot replace a
device; the `?audit=1` overlay exists precisely so you can capture real-device numbers.

### Measured, then rejected: switching to video

An obvious recommendation for a 239 MB frame reel is "use a video". Measured with ffmpeg on
scene-06 (the heaviest scene, 23 MB): all-keyframe H.264 crf23 = **20.6 MB**, crf27 =
15.1 MB, long-GOP crf23 = 13.6 MB; denoising first did not change the ranking. Smooth
scrubbing needs (near-)all-keyframe encoding, which lands at ≈ the JPEG frames' own size,
and long-GOP buys only ~40 % in exchange for seek-decode latency exactly where scrubbing
can't afford it. The render's high-frequency detail (rattan, foliage) plus the source
JPEGs' existing quantisation noise leave little temporal redundancy to exploit.
**Verdict: keep the frame sequence; fix its weight and its engine.** Revisit only if the
source animation can be re-rendered cleaner/darker-grained.

---

## Repo map

```
app.js               v2 engine (hot-path rewrite of v1; same architecture)
diagnostics.js       ?audit=1 overlay — the 12-point checklist, live, on any site
index.html           + diagnostics script, noscript, color-scheme
style.css            compositing/overflow/progress-bar fixes
tools/build-frames.mjs   source reel → web set (denoise/resize/decimate/encode)
tools/serve.mjs          static server; frames may live outside the repo
tools/simulate.mjs       headless v1-vs-v2 harness (this report's numbers)
tools/fixtures/app.v1.js the audited v1 engine, kept for regression comparison
AUDIT.md             this report
```

Porting onto the branch that holds your frames (`arena/01a09a10-caha`):

```bash
git fetch origin arena/01a09a57-caha
git checkout FETCH_HEAD -- app.js style.css index.html diagnostics.js tools package.json AUDIT.md README.md
npm i && npm run build:frames && npm run dev
```

The source frames stay exactly where they are; `assets/web/` is generated and git-ignored.
