# caha

A cafe in motion: a scroll-scrubbed film (14 scenes × 300 rendered frames) that you
play with the scrollbar. Vanilla JS, one `requestAnimationFrame` loop, no framework.

**Read [`AUDIT.md`](AUDIT.md) first** — it is the measured diagnosis of why the scroll
felt janky and what each fix changed (before/after numbers included).

## Run it

```bash
npm i                       # sharp, for the frame pipeline
npm run build:frames        # assets/frames (239 MB JPEGs) → assets/web (≈113 MB WebP)
npm run dev                 # http://localhost:5173
```

`build:frames` is incremental and skippable: with no `assets/web/` the engine falls back
to the source reel, so `npm run dev` works immediately on a fresh clone that has the
frames. Useful flags:

```bash
npm run build:frames -- --format avif --quality 45 --out assets/web-avif  # desktop, ~40 % smaller
npm run build:frames -- --width 960 --quality 55 --out assets/web-m       # phone tier
```

The engine probes lightest-suitable-first and falls back to the source reel:
phones (`pointer: coarse`) try `assets/web-m/` → `assets/web-avif/` → `assets/web/` →
`assets/frames/`; desktop tries `assets/web-avif/` → `assets/web/` → `assets/frames/`.
AVIF wins on bytes for desktop; phones get WebP because cheap SoCs decode it much faster.

Large sets can live outside the repo:

```bash
CAHA_SRC_FRAMES=/path/to/frames CAHA_WEB_DIR=/path/to/web npm run dev
```

## See the numbers on your own machine

Open the site with `?audit=1` (or press Ctrl+Shift+A): a live overlay reports fps and
frame-time percentiles, live rAF-loop count, forced-layout reads per frame, non-passive
listener detection, decoded-bitmap megabytes, payload bytes, and displayed-frame lag —
the Step-1 checklist from the audit, running against whatever code is loaded.
`copy json` puts a full snapshot on your clipboard.

Headless regression comparison of the old vs new engine (same synthetic scroll trace,
real asset bytes):

```bash
CAHA_SRC_FRAMES=/path/to/frames node tools/simulate.mjs --engine v1 --net local --device desktop
node tools/simulate.mjs --engine v2 --net local --device desktop --set web
```

## How it works (v2)

- **One rAF loop.** Order per tick: input → autoplay ramp → damped playhead →
  preload schedule → UI writes → draw. Nothing else schedules frames.
- **Scroll is read once per frame** from a passive-listener cache; page metrics
  (`scrollHeight`) are measured only on resize/orientation/font/manifest invalidation.
- **Frames decode off the main thread** (`fetch` → `createImageBitmap`) and live in a
  byte-budgeted LRU whose resident window is derived from budget ÷ decoded-frame bytes.
- **The canvas backing store never exceeds the delivery resolution**; identical frames
  are not re-blitted; crossfade alpha is quantised and mobile skips it.
- **Autoplay is opt-in**: the ▶ control (bottom centre) starts the film, any input
  pauses it and hands the scroll back, and the end of the reel loops with a
  fade-to-black cut. `?autoplay=1` pre-enables it (kiosks); `prefers-reduced-motion`
  hides the control entirely. Teleports are cuts, not rewind sweeps.
- `prefers-reduced-motion` disables autoplay, damping and crossfade.
