# caha

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

## Run it

```bash
npm i                       # sharp (frames) + puppeteer-core/@sparticuz/chromium (audit)
npm run build:frames        # assets/frames (239 MB JPEGs) → assets/web (WebP tier)
npm run dev                 # http://localhost:5173
```

`build:frames` is incremental and skippable: with no `assets/web/` the engine falls back
to the source reel, so `npm run dev` works immediately on a checkout that has the frames.

The frames are large and are **not** in this branch's history. Either fetch them from the
branch that carries them, or point the tooling at a copy:

```bash
git archive origin/arena/01a09a10-caha assets/frames assets/manifest.json | tar -x -C /tmp/caha
CAHA_SRC_FRAMES=/tmp/caha/assets/frames npm run dev
```

Useful flags:

```bash
# the two tiers this branch ships (settings measured in AUDIT.md, not guessed)
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

## Test it

```bash
npm test        # source invariants + a gate on the committed audit reports (~0.2 s)
```

Thirteen checks: `app.js` has exactly one animation loop (every `requestAnimationFrame`
re-arms the same callback), one passive scroll listener and no non-passive compositor input
listeners, no layout-triggering style writes in the frame path, scroll metrics measured on
invalidation rather than per frame, one accounting path into the bitmap cache, the preload
queue rebuild keeps `requested` honest and an approximated frame is re-drawn when the exact
one lands (FIX W/V), the screen-quality tool still hides the UI chrome and refuses to measure
a fallback tier, each tier records how it was built, and — the useful one — the committed
real-browser report must be green while the v2.1 baseline must still record the failures this
pass fixed. If someone regenerates a report where a check fails, or the baseline stops
reproducing, `npm test` fails and `AUDIT.md` is flagged as stale.

## Measure the picture

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

## Audit it in a real browser

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

## See it on your machine

Open the site with `?audit=1` (or press Ctrl+Shift+A): a live overlay reports fps and
frame-time percentiles, live rAF-loop count, forced-layout reads per frame, non-passive
listener detection, decoded-bitmap megabytes, payload bytes, and displayed-frame lag —
the Step-1 checklist from the brief, running against whatever code is loaded.
`copy json` puts a full snapshot on your clipboard.

## How it works (v2.3)

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
