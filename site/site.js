/* ============================================================
   cahā — page behaviour around the scroll canvas
   preloader · nav · feature cards · tilt card · reveals
   (reference: Preloader.tsx, FeatureCards.tsx, AboutStats.tsx,
   SiteAnimations.tsx). The film itself lives in scroll-canvas.js.
   ============================================================ */
(() => {
  'use strict';

  window.__cahaSite = true;
  const root = document.documentElement;
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const film = window.cahaFilm || null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- Preloader ----------
     The reference runs a fixed 2.6 s timer. Here the bar tracks the hero's
     first pass of frames (every 32nd), so a warm cache opens fast and a slow
     connection doesn't open onto a black canvas. */
  (function preloader() {
    const el = document.getElementById('preloader');
    if (!el) return;
    const fill = document.getElementById('preloader-fill');
    const t0 = performance.now();
    const MIN_MS = 1400;     // long enough for the wordmark to land
    const MAX_MS = 7000;     // never hold the page hostage
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (fill) fill.style.transform = 'scaleX(1)';
      const wait = Math.max(0, MIN_MS - (performance.now() - t0));
      setTimeout(() => {
        el.classList.add('is-done');
        setTimeout(() => el.remove(), 1000);
        checkFilm();
      }, wait);
    };

    if (film && film.onProgress && film.ready) {
      film.onProgress((p) => { if (fill) fill.style.transform = `scaleX(${Math.max(0.04, p)})`; });
      film.ready.then(finish);
    } else {
      finish();
    }
    setTimeout(finish, MAX_MS);
  })();

  /* If nothing could be loaded at all, say why instead of showing black. */
  function checkFilm() {
    if (!film) return;
    const s = typeof film.stats === 'function' ? film.stats() : null;
    const noFrames = s && s.loaded === 0 && s.failed > 0;
    if (!film.error && !noFrames) return;
    const note = document.createElement('div');
    note.className = 'film-notice';
    note.setAttribute('role', 'status');
    note.innerHTML = film.error === 'gsap'
      ? 'The scroll engine didn’t load (<code>vendor/gsap/</code> is missing).'
      : noFrames
        ? `The film frames couldn’t be loaded (${s.failed} requests failed). Serve the site with <code>npm run dev</code>.`
        : 'The film couldn’t start. See the console for details.';
    document.body.appendChild(note);
  }

  /* ---------- Nav ---------- */
  const nav = document.getElementById('nav');
  if (nav) {
    const toggle = nav.querySelector('.nav__toggle');
    const setOpen = (open) => {
      nav.classList.toggle('is-open', open);
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      }
    };
    if (toggle) toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
    nav.querySelectorAll('.nav__links a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

    if (ScrollTrigger) {
      ScrollTrigger.create({
        start: 40,
        end: 'max',
        onToggle: (self) => nav.classList.toggle('is-scrolled', self.isActive),
      });
    }
  }

  /* ---------- Feature cards: hover-expand + 3D tilt + shine ---------- */
  document.querySelectorAll('[data-cards]').forEach((wrap) => {
    const cards = [...wrap.querySelectorAll('.fcard')];
    if (!cards.length) return;
    const resetTilt = (card) => {
      card.style.removeProperty('--rx');
      card.style.removeProperty('--ry');
      card.style.removeProperty('--mx');
      card.style.removeProperty('--my');
    };
    const activate = (card) => {
      cards.forEach((c) => {
        const on = c === card;
        c.classList.toggle('is-active', on);
        if (!on) resetTilt(c);
      });
    };

    cards.forEach((card) => {
      card.addEventListener('mouseenter', () => activate(card));
      card.addEventListener('focusin', () => activate(card));
      card.addEventListener('click', () => activate(card));
      if (!finePointer || reducedMotion) return;

      let raf = 0, px = 0.5, py = 0.5;
      card.addEventListener('pointermove', (e) => {
        if (!card.classList.contains('is-active')) return;
        const r = card.getBoundingClientRect();
        px = (e.clientX - r.left) / r.width;
        py = (e.clientY - r.top) / r.height;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          card.style.setProperty('--rx', `${((py - 0.5) * -12).toFixed(2)}deg`);
          card.style.setProperty('--ry', `${((px - 0.5) * 12).toFixed(2)}deg`);
          card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
          card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
        });
      });
      card.addEventListener('pointerleave', () => resetTilt(card));
    });

    // like the reference, the first card takes over again when the pointer leaves
    wrap.addEventListener('mouseleave', () => activate(cards[0]));
  });

  /* ---------- About card: 3D tilt with a glow that follows the pointer ---------- */
  document.querySelectorAll('[data-tilt]').forEach((card) => {
    if (!finePointer || reducedMotion) return;
    const visual = card.parentElement;
    let raf = 0, px = 0.5, py = 0.5;
    card.addEventListener('pointerenter', () => card.classList.add('is-hover'));
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      px = (e.clientX - r.left) / r.width;
      py = (e.clientY - r.top) / r.height;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        card.style.setProperty('--rx', `${((py - 0.5) * -16).toFixed(2)}deg`);
        card.style.setProperty('--ry', `${((px - 0.5) * 16).toFixed(2)}deg`);
        card.style.setProperty('--cx', `${(px * 100).toFixed(1)}%`);
        card.style.setProperty('--cy', `${(py * 100).toFixed(1)}%`);
        visual.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
        visual.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
      });
    });
    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-hover');
      ['--rx', '--ry', '--cx', '--cy'].forEach((p) => card.style.removeProperty(p));
      visual.style.removeProperty('--mx');
      visual.style.removeProperty('--my');
    });
  });

  /* ---------- Reveal on scroll ---------- */
  if (gsap && ScrollTrigger && !reducedMotion) {
    const reveal = (els) => gsap.fromTo(els, { y: 40 }, {
      opacity: 1,
      y: 0,
      duration: 1,
      ease: 'power3.out',
      stagger: 0.12,
      overwrite: true,
      clearProps: 'transform',
    });
    ScrollTrigger.batch('.reveal', { start: 'top 88%', once: true, onEnter: reveal });
    // loaded mid-page (reload / deep link): anything already scrolled past is simply shown
    const passed = [...document.querySelectorAll('.reveal')].filter((el) => el.getBoundingClientRect().bottom < 0);
    if (passed.length) gsap.set(passed, { opacity: 1 });
  } else {
    root.classList.add('no-reveal');
  }

  /* ---------- Footer year ---------- */
  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });
})();
