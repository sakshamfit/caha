# Caha

A cafe in motion — a scroll-driven website where every scroll moves you
through 14 synchronized animated scenes (300 frames each).

## Run locally

The site is fully static. From the repo root:

```bash
python3 -m http.server 8080
# or: npx serve .
```

Then open http://localhost:8080

## Structure

```
index.html          page shell
style.css           styling
app.js              scroll-scrub animation engine
assets/
  manifest.json     scene list, titles, frame counts, fps — edit me
  frames/
    scene-01/       ezgif-frame-001.jpg … ezgif-frame-300.jpg
    scene-02/       …
    scene-14/
```

## Customizing

- **Scene titles** — edit `assets/manifest.json` (`title` per scene);
  the site reads it on every load.
- **Pacing** — `fps` in the manifest sets the autoplay speed;
  `SCENE_VH` in `app.js` sets how much scrolling one scene takes.
- **Adding a scene** — create `assets/frames/scene-15/` with numbered
  frames and append it to `manifest.json`.

## Behavior

- Scrolling scrubs through all 4,200 frames in sync.
- Scenes crossfade at their boundaries.
- Stop scrolling for ~4s and the film plays itself at 24 fps
  (disabled automatically if the visitor prefers reduced motion).
- Frames are preloaded ahead of the playhead and evicted behind it,
  so memory stays bounded.
