# cahā — The Coffee Club

A café website you walk through by scrolling. Five pinned **chapters** scrub caha's
14-scene film (14 × 300 frames in `assets/frames/`) on a full-screen canvas, with story
beats timed to the footage, and the café's sections in between: menu cards, a counter
marquee, the space, the story, and plan-your-visit.

The scroll system is the one from
[alagappan567/cafe-3d-scroll](https://github.com/alagappan567/cafe-3d-scroll)
(`ScrollCanvas.tsx` and its siblings), ported to this repo's no-build vanilla stack with
the same library and version (GSAP 3.15 ScrollTrigger, vendored), and scaled from one
300-frame clip per section to caha's 4,200-frame reel.

## Run it

```bash
npm run dev          # http://localhost:5173
```

There's no build step and nothing to install for the site itself. The frames are committed,
and GSAP and the fonts are vendored (`vendor/gsap/`, `assets/fonts/`), so the page makes no
third-party requests. To deploy, serve the repo root from any static host.
`npm i` is only needed for the browser check below and the legacy film's tooling.

## The scroll system

| Reference (Next.js) | caha (`index.html`, `site/scroll-canvas.js`) |
| --- | --- |
| `relative h-[500vh]` container | `.chapter`, `scenes × --scene-height + 100vh` tall |
| `sticky top-0 h-screen` stage + `<canvas>` | `.chapter__stage` + `canvas.chapter__canvas` |
| `ScrollTrigger.create({ start: "top top", end: "bottom bottom", scrub: 0.5 })` → frame | the same trigger, driving a `gsap.to(playhead)` tween, so `scrub: 0.5` really smooths (a bare trigger ignores scrub) |
| cover-fit `drawImage` | the same |
| `STORY_SCENES` `{ from, to, label, heading, text, align }` | `<article data-beat data-scene data-from data-to data-align>` in the HTML |
| progress dots (24×7 active pill) | the same, one per beat |
| hero overlay fading out (`end: "8% top"`) | `[data-fade-out]`: the hero and each chapter's title card |
| preloader, fixed ticker, grain, expanding tilt cards, gallery, marquee, stats, CTA | the same pieces, in cahā's palette, with stills taken from the reel |

What had to change because caha's reel is 14× longer (239 MB):

- **Chapters span scenes.** One sticky stage plays 2–4 consecutive scenes as one clip.
- **Frames stream coarse → fine** instead of all preloading at mount. The chapter under the
  viewport loads every 32nd frame, then every 16th, then fills a moving window around the
  playhead. The next chapter gets its entry frames early, and far chapters give back their
  fine frames.
- **Two-stage loading.** Bytes download cheaply (6 at a time on desktop, 4 on phones). Only
  frames near the playhead, weighted towards the scroll direction, are `decode()`d ahead of
  time (2 at a time). A 1080p decode is the expensive part, and decoding everything on
  arrival starves a phone's main thread.
- **The nearest frame is always drawn** until the exact one lands, so scrubbing never shows
  black.
- **The canvas never exceeds the frames' real detail.** A retina laptop gets a 1728×1080
  surface instead of 2880×1800, and a phone ~500×1080. In both, the frame is drawn at exactly 1:1.
- **Density follows the device**: every 2nd frame on desktop (150 per scene, the reference's
  frames-per-viewport density), every 3rd on phones, every 4th with Save-Data.
- `prefers-reduced-motion`: no scrub smoothing, and no ticker, marquee, grain or tilt motion.

## The chapters

| | Chapter | Scenes | Beats |
| --- | --- | --- | --- |
| I | Arrival (hero) | 01–04 | The Corner · The Steps · The Sign · The Threshold · Step Inside |
| II | The Bar | 05–07 | The Room · The Counter · The Case · The Pour |
| III | The Table | 08–10 | Morning · Brunch · Stay a While |
| IV | Upstairs | 11–12 | The Stair · The Lounge |
| V | After Dark | 13–14 | The Terrace · Nightfall |

Between them: *Everything you came for* (expanding cards), *From the counter* (marquee),
*The Space* (gallery), *A coffee club, open to everyone* (story + stats), and *Plan your
visit* + *Reserve your table*.

## Edit it

All copy and timing is in `index.html`, so you don't need to touch the engine to change it.

```html
<section class="chapter" id="bar" data-chapter data-scenes="scene-05 scene-06 scene-07" style="--scenes: 3">
  …
  <article class="beat" data-beat data-scene="scene-06" data-from="196" data-to="294" data-align="left">
    <p class="beat__label">The Counter</p> …
```

- `data-from` / `data-to` are **source frame numbers (1–300) of that scene**. To retime a
  beat, open `assets/frames/scene-06/ezgif-frame-196.jpg` and its neighbours to see what's
  on screen. Beats alternate `left` / `right`, like the reference's.
- Chapters must play the reel in order, each scene once (`npm test` checks this).
- **Pace**: `--scene-height` in `site/site.css` is the scroll length per scene: 180vh on
  desktop, 150vh on phones. The reference gives one clip 400vh.
- **Density**: `?step=1` plays every source frame (`?step=` overrides the device default).
- **Stills**: the content sections use reel frames directly as images, with numbers
  6k+1 so the canvas cache shares them on desktop and phones.
- **Placeholders to replace**: the *Plan your visit* details, the stats, and the
  **Book Now** link (`#reserve`, marked `TODO` in the HTML).

## Files

| Path | What |
| --- | --- |
| `index.html` | the site: chapters, beats, content sections |
| `site/scroll-canvas.js` | the scroll system (chapters → ScrollTrigger → canvas, beats, dots, loader) |
| `site/site.js` | preloader (tracks real frame loading), nav, expanding cards, tilt, reveals |
| `site/site.css` | styles |
| `vendor/gsap/` | GSAP + ScrollTrigger 3.15.0, unmodified |
| `assets/fonts/` | Inter, Playfair Display, Poppins (SIL OFL), self-hosted |
| `assets/frames/`, `assets/manifest.json` | the reel |
| `film.html` | the original single-canvas film (below) |

## Test it

```bash
npm test             # static checks: the site's (tools/site.test.mjs) + the film's
npm run check:site   # real Chromium, desktop + phone: scrubs every chapter (≈3 min)
```

`check:site` scrolls to the middle of every beat and waits until the drawn frame *is* the
frame under the playhead. It then checks the canvas holds a real picture, the right beat
and dot are active, the gaps at scene cuts show only film, the hero overlay fades, every
visible still loads, and nothing errors. It writes `reports/site-check.json`, with
screenshots in `reports/shots/site/`. In the browser console, `cahaFilm.stats()` shows
the loader's state (focus chapter, loaded and decoded frames, in-flight requests).

## The single-canvas film (`film.html`)

The site's first engine is kept at [`film.html`](film.html), and the footer links to it as
*Watch the full film*. It plays all 14 scenes as one continuous, crossfaded film on a fixed
canvas, with its own vanilla rAF engine (`app.js`, `style.css`, `diagnostics.js`). Everything
below documents it, and the audit tools (`browser-audit`, `screen-quality`, `decode-cost`)
measure it.

A cafe in motion: a scroll-scrubbed film (14 scenes × 300 rendered frames) that you
play with the scrollbar. Vanilla JS, one `requestAnimationFrame` loop, no framework.

**Read [`AUDIT.md`](AUDIT.md) first.** It has three measured passes: the modelled one
(`tools/simulate.mjs`) that rewrote the engine's hot path; the **real-browser** one
(Chromium via CDP, `tools/browser-audit.mjs`) that found and verified the second round of
fixes; and — at the top of pass 3 — the **screen-space quality** work
(`tools/frame-quality.mjs` + `tools/screen-quality.mjs`) that rebuilt the delivered film and
fixed the two defects that measurement exposed. What the rebuild bought, measured on the glass:
**+0.12 dB / +0.024 SSIM** for the desktop tier at DPR 1 (+0.08 dB / +0.023 at DPR 2) for ~8 %
more bytes per second of film, and phone fidelity held at **10.8 % fewer bytes** with a much
tighter decode tail. Two better-looking tiers (1440 and 1920 AVIF) were built, measured and
**rejected** on the starvation bar rather than shipped. On the shipping pair 6 of the 8 audit
scenarios pass; the two that do not — a 4×-CPU-throttled fling and teleport's layout counter —
are named with their cause in AUDIT.md.

### Run it

```bash
npm i                       # sharp (frames) + puppeteer-core/@sparticuz/chromium (audit)
npm run setup               # = fetch:frames + build:tiers (≈12 min on 2 cores, once)
npm run dev                 # http://localhost:5173/film.html
```

The source reel (`assets/frames/`, 239 MB) is committed on `main`; only the built
`assets/web*/` tiers are gitignored, and the film falls back to the reel without them. On a
checkout that lacks the reel (some older branches), **"No frames loaded — 24 requests
failed"** means the engine fell through every tier probe to the source reel and found nothing
there either (24 is the desktop warm-up on a 2-core box). Recover in two steps:

```bash
npm run fetch:frames        # git archive of the branch that carries the reel → assets/frames
npm run build:tiers         # the two measured tiers the site ships (web-avif + web-m)
```

`fetch:frames` does a depth-1 fetch of `origin/arena/01a09a10-caha` to `FETCH_HEAD` and
extracts from it — it never switches or creates a branch. `build:frames` is incremental and
skippable: with no built tier the engine falls back to the source reel, so `npm run dev` works
as soon as the frames are present. If the reel already lives somewhere else, point the tooling
at it instead:

```bash
CAHA_SRC_FRAMES=/path/to/frames npm run build:tiers
CAHA_SRC_FRAMES=/path/to/frames npm run dev
```

Useful flags:

```bash
# the two tiers this branch ships (settings measured in AUDIT.md, not guessed) — this is
# exactly what `npm run build:tiers` runs
npm run build:frames -- --width 1280 --format webp --quality 68 --step 4 --out assets/web-avif
npm run build:frames -- --width 1280 --format avif --quality 45 --step 3 --out assets/web-m

# anything else is one command away; --normalize upscales the 3 sub-1080p scenes to one width,
# --denoise re-enables median(3) (measured harmful at these settings, hence opt-in)
npm run build:frames -- --width 1920 --quality 80 --out assets/web --force
```

The engine probes lightest-suitable-first and falls back to the source reel: phones
(`pointer: coarse` or a <700 px viewport) try `assets/web-m/` → `assets/web-avif/` →
`assets/web/` → `assets/frames/`; desktop tries `assets/web-avif/` → `assets/web/` →
`assets/frames/`. Both shipped tiers are measured, and they take opposite sides of the same
trade. At 1280 the reel's two codecs trade places per byte, so the desktop tier keeps WebP and
spends its budget on *quality* instead (`q68` where the fallback uses `q52`); the phone tier uses
AVIF `q45`, which matches the WebP tier's screen fidelity for 10.8 % fewer bytes with a much
tighter decode tail (p95 13.2 ms vs 25.7 ms, `tools/decode-cost.mjs`) — what a phone profile
needs. Both deliver every 4th/3rd source frame rather than every 3rd because pass 3 measured that
starvation is a *decode-latency* problem: decode cost tracks pixels, so at a fixed 1280 width the
way to pay for heavier frames is to send fewer of them (25 % fewer frames per second of fast
scrolling, ~42 % → ~26 % of a two-core budget at wheel speed). Bigger frames do not fit: 1440 and
1920 AVIF tiers were built and rejected on the 4×-throttled starvation bar. The `web-avif`
directory name is historical — it is WebP inside; the dev server re-checks a tier's file
extension when its contents change. RAM/network hints (`deviceMemory`, `saveData`) only lower budgets and
concurrency — they no longer pick the delivery tier (see `FIX P`).

Large sets can live anywhere:

```bash
CAHA_SRC_FRAMES=/path/to/frames CAHA_WEB_DIR=/path/to/web npm run dev
```

### Test it

```bash
npm test        # source invariants + a gate on the committed audit reports (~0.2 s)
```

The film's checks live in `tools/audit.test.mjs`: `app.js` has exactly one animation loop (every `requestAnimationFrame`
re-arms the same callback), one passive scroll listener and no non-passive compositor input
listeners, no layout-triggering style writes in the frame path, scroll metrics measured on
invalidation rather than per frame, one accounting path into the bitmap cache, the preload
queue rebuild keeps `requested` honest and an approximated frame is re-drawn when the exact
one lands (FIX W/V), the screen-quality tool still hides the UI chrome and refuses to measure
a fallback tier, each tier records how it was built, and — the useful one — the committed
real-browser report must be green while the v2.1 baseline must still record the failures this
pass fixed. If someone regenerates a report where a check fails, or the baseline stops
reproducing, `npm test` fails and `AUDIT.md` is flagged as stale.

### Measure the picture

```bash
# per frame: bytes, PSNR, SSIM for any setting, plus a full-reel size projection
CAHA_SRC_FRAMES=/path/to/frames node tools/frame-quality.mjs --grid \
    --settings 1920:avif:45,1600:avif:60,1280:webp:52 --scenes 2,6,7,13 --samples 1 --step 3

# end to end: what lands on the glass (composited device pixels vs the source frame,
# through the same cover-fit + canvas + compositor path the site uses)
CAHA_SRC_FRAMES=/path/to/frames node tools/screen-quality.mjs \
    --tier assets/web-avif --mode desktop --dpr 1 --scenes 2,6,7,10,13 --label ship

# per tier: fetch + decode milliseconds per frame — the number the perf bar depends on
node tools/decode-cost.mjs --tiers assets/web,assets/web-avif,assets/web-m --frames 24
```

`screen-quality.mjs` refuses to sample until the drawn frame *is* the frame under the
playhead, which is how FIX V and FIX W were found (`--loose` measures the starved case
instead). `--tier-dir` + `--overrides` let you serve the *source reel* as a tier, which is the
zero-compression ceiling every quality claim in AUDIT.md is quoted against.

### Audit it in a real browser

```bash
npm run audit:browser                                   # working tree, all 8 scenarios (≈4 min)
npm run audit:browser -- --only desktop/wheel           # one scenario (or a,b,c)
npm run audit:browser -- --engine v2.1 --label before   # the committed v2.1 engine
npm run audit:browser -- --engine v1   --label v1       # the old engine fixture
npm run audit:browser -- --extra 'damping=flat'         # A/B the damping curve
```

It drives Chromium over CDP with real wheel notches, real touch drags/flings and End/Home
keys, and records Blink's own counters (`LayoutCount`, `RecalcStyleCount`, `ScriptDuration`,
`TaskDuration`), a per-frame trace of scroll → damped playhead → displayed frame, decoded
bitmap memory, payload, rAF-loop and non-passive-listener censuses, long tasks, and a
pixel check that compares the canvas against the frame files for the current position
(±3 frames) to prove the scrub shows the right frame. Each run writes
`reports/browser-audit-<label>.json` plus screenshots in `reports/shots/`, and fails loudly
on the brief's checklist (one rAF loop, zero non-passive listeners, no per-frame layout,
cache inside budget, no film jump on a viewport-height change, autoplay yields to input).

If the browser cannot be downloaded (no CDN), the harness falls back to
`@sparticuz/chromium`, unpacking the Amazon Linux libs it needs next to the binary — that is
how it runs in a bare container. Point it at your own browser with `CAHA_CHROME=<path>`.

Prefer the modelled harness for payload/memory curves it can compute without a browser:

```bash
CAHA_SRC_FRAMES=/path/to/frames npm run simulate -- --engine v1 --net 4g --device mobile
```

### See it on your machine

Open `film.html?audit=1` (or press Ctrl+Shift+A on `film.html`): a live overlay reports fps and
frame-time percentiles, live rAF-loop count, forced-layout reads per frame, non-passive
listener detection, decoded-bitmap megabytes, payload bytes, and displayed-frame lag —
the Step-1 checklist from the brief, running against whatever code is loaded.
`copy json` puts a full snapshot on your clipboard.

### How it works (v2.3)

- **One rAF loop.** Order per tick: input → autoplay ramp → damped playhead → preload
  schedule → UI writes → draw. Nothing else schedules frames.
- **Scroll is read once per frame** from a passive-listener cache; page metrics
  (`scrollHeight`) are measured only on invalidation — and *not* on mobile URL-bar-class
  viewport changes, which would remap the film under your finger (`FIX L`).
- **The playhead damps toward the scroll position** with a frame-rate-independent rate that
  rises with the distance still to cover, so a fast scrub does not trail the scrollbar by
  seconds of film while a settled playhead still eases (`?damping=flat` restores the old
  curve).
- **Frames decode off the main thread** (`fetch` → `createImageBitmap`) into a
  byte-budgeted LRU with one accounting path (`FIX Q`); the warm-up respects the same
  budget (`FIX S`). When the exact frame is missing, the closest *resident* frame in the
  scene is drawn — preferring behind — rather than holding a stale one (`FIX R`).
- **The canvas backing store never exceeds the delivery resolution, and never shrinks once
  sized** (`FIX B`/`FIX Y`); identical frames are not re-blitted; crossfade alpha is quantised
  and mobile skips it. (The one candidate filter
  change here — `imageSmoothingQuality: 'high'` — was measured and reverted: 0.01 dB at a
  0.83× downscale, −0.07 dB at 0.53×, so smoothing stays exactly as pass 2 left it.)
- **The pump governs its own concurrency by measured decode cost** (`FIX X`): an EWMA of
  fetch+decode time caps how many frames may be in flight so the newest request still lands
  inside ~45 ms. A constant burst of 10 cost p95 40.6 frames of starvation on a 2-core box;
  the same tier at cap 4 cost 3.5. On hardware that decodes in a few ms the cap is a no-op.
  (`?latency=`, `?conc=`, `?burst=` expose the knobs for A/B runs.)
- **The canvas backing store is sized once, monotonically** (`FIX Y`): a mixed-resolution reel
  (720p + 1080p scenes) used to raise and lower the cap as frames of different widths arrived,
  resizing the surface at every scene boundary — Blink layout per frame 0.021 → 0.069. It is
  pinned to the widest frame of the tier and only ever grows.
- **A frame is never *approximated* at rest** (`FIX V`/`FIX W`): when the nearest-resident
  fallback draws a neighbour, the tick repaints as soon as the exact frame is resident, and
  the preload queue no longer leaks `requested` keys that made a frame permanently
  unrequestable. Measured before the fix: the film resting 6–9 frames (≈340 px of scroll)
  from where the page said it was, indefinitely.
- **Autoplay is opt-in** (`▶`, `?autoplay=1` for kiosks, hidden under
  `prefers-reduced-motion`) and yields to *any* scroll it did not write — including
  scrollbar drags, which fire no DOM event (`FIX M`). The end of the reel loops with a
  fade-to-black cut; teleports are cuts, not rewind sweeps.
- **It never shows a silent black screen**: with no frames decoded the loader stays up and
  says what failed (`FIX N`).
- `prefers-reduced-motion` disables autoplay and damping.
