// Canonical CSS + JS for the design tool's animation effects. Used at export
// time to inject the runtime into every page; mirrored in
// frontend/src/animationAssets.js for preview-time iframe injection.
//
// If you change anything here, mirror it to the frontend file too.

// Effect catalog — also the source of truth for per-effect override CSS used
// to disable individual effects when a toggle is off.
export const EFFECT_KEYS = ['fadeIn', 'reveal', 'parallax', 'sticky', 'countUp', 'marquee'];

// Default state. Matches frontend/src/animations.js — every effect on by
// default. Pages without specialty markup are no-ops, so "on" only manifests
// when the model actually emits the matching classes.
export const DEFAULT_ANIMATIONS = {
  fadeIn:   true,
  reveal:   true,
  parallax: true,
  sticky:   true,
  countUp:  true,
  marquee:  true,
};

// Read animation settings off a project. Tolerates both the new
// `project.animations` shape and the legacy `scrollAnimations` boolean.
export function normalizeAnimations(project) {
  const out = { ...DEFAULT_ANIMATIONS };
  if (project && typeof project === 'object') {
    if (project.animations && typeof project.animations === 'object') {
      for (const k of EFFECT_KEYS) {
        if (typeof project.animations[k] === 'boolean') out[k] = project.animations[k];
      }
    } else if (project.scrollAnimations === false) {
      out.fadeIn = false;
    }
  }
  return out;
}

// Full payload that powers every effect.  Idempotent: safe to inject twice
// (the script self-guards via window.__cinderAnim).
export const ANIMATIONS_CSS = `/* cinder-anim */
.animate-in,
.animate-in-up,
.animate-in-left,
.animate-in-right,
.animate-in-scale,
.animate-in-blur {
  opacity: 0;
  transition: opacity .6s ease .15s, transform .6s ease .15s, filter .6s ease .15s;
  will-change: opacity, transform;
}
.animate-in,
.animate-in-up { transform: translate3d(0, 24px, 0); }
.animate-in-left  { transform: translate3d(-32px, 0, 0); }
.animate-in-right { transform: translate3d(32px, 0, 0); }
.animate-in-scale { transform: scale(.92); }
.animate-in-blur  { filter: blur(8px); }
.animate-in.visible,
.animate-in-up.visible,
.animate-in-left.visible,
.animate-in-right.visible,
.animate-in-scale.visible { opacity: 1; transform: none; }
.animate-in-blur.visible { opacity: 1; filter: none; }
@media (max-width: 640px) {
  .animate-in-left  { transform: translate3d(-16px, 0, 0); }
  .animate-in-right { transform: translate3d(16px, 0, 0); }
}
.animate-in-stagger > *:nth-child(1) { transition-delay: .10s; }
.animate-in-stagger > *:nth-child(2) { transition-delay: .20s; }
.animate-in-stagger > *:nth-child(3) { transition-delay: .30s; }
.animate-in-stagger > *:nth-child(4) { transition-delay: .40s; }
.animate-in-stagger > *:nth-child(5) { transition-delay: .50s; }
.animate-in-stagger > *:nth-child(6) { transition-delay: .60s; }
.animate-in-stagger > *:nth-child(7) { transition-delay: .70s; }
.animate-in-stagger > *:nth-child(8) { transition-delay: .80s; }

/* Parallax: section bg shortcut + per-element data attribute. JS writes
   --cinder-y; CSS applies the transform. The bg shortcut paints into a
   pseudo-element so the section's text content scrolls normally.
   Use :where() so page CSS that already positions the element (e.g. an
   absolute-positioned empty bg wrapper) isn't stomped by our defaults. */
:where(.parallax-bg) {
  position: relative;
  isolation: isolate;
  overflow: hidden;
}
.parallax-bg::before {
  content: "";
  position: absolute;
  inset: -15% 0;
  background-image: var(--cinder-pbg, none);
  background-size: cover;
  background-position: center;
  transform: translate3d(0, var(--cinder-y, 0px), 0);
  will-change: transform;
  pointer-events: none;
  z-index: -1;
}
[data-parallax] {
  transform: translate3d(0, var(--cinder-y, 0px), 0);
  will-change: transform;
}

/* Sticky eyebrow: small label that pins to the top of its containing
   section while the section's content scrolls past. */
.sticky-eyebrow {
  position: sticky;
  top: 0;
  z-index: 5;
}

/* Marquee strip: continuous horizontal scroll. Content gets duplicated by
   the runtime if it's not already wrapped in a .marquee-track. */
.marquee-strip {
  overflow: hidden;
  position: relative;
  width: 100%;
}
.marquee-strip .marquee-track {
  display: flex;
  flex-wrap: nowrap;
  width: max-content;
  animation: cinder-marquee 30s linear infinite;
  gap: var(--marquee-gap, 2rem);
}
.marquee-strip:hover .marquee-track { animation-play-state: paused; }
@keyframes cinder-marquee {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
@media (max-width: 640px) {
  .marquee-strip .marquee-track { animation-duration: 45s; }
}

/* Reduced motion: turn every effect into a static no-op. */
@media (prefers-reduced-motion: reduce) {
  .animate-in, .animate-in-up, .animate-in-left, .animate-in-right,
  .animate-in-scale, .animate-in-blur {
    opacity: 1 !important;
    transform: none !important;
    filter: none !important;
    transition: none !important;
  }
  .parallax-bg::before, [data-parallax] {
    transform: none !important;
  }
  .marquee-strip .marquee-track { animation: none !important; }
}

/* Per-section opt-out (data-anim-off ancestor). Mirrors the prefers-reduced-
   motion neutralization so the section behaves as if no effects are present. */
[data-anim-off] .animate-in,
[data-anim-off] .animate-in-up,
[data-anim-off] .animate-in-left,
[data-anim-off] .animate-in-right,
[data-anim-off] .animate-in-scale,
[data-anim-off] .animate-in-blur,
[data-anim-off].animate-in,
[data-anim-off].animate-in-up,
[data-anim-off].animate-in-left,
[data-anim-off].animate-in-right,
[data-anim-off].animate-in-scale,
[data-anim-off].animate-in-blur {
  opacity: 1 !important;
  transform: none !important;
  filter: none !important;
  transition: none !important;
}
[data-anim-off] .parallax-bg::before,
[data-anim-off].parallax-bg::before,
[data-anim-off] [data-parallax],
[data-anim-off][data-parallax] {
  transform: none !important;
}
[data-anim-off] .sticky-eyebrow,
[data-anim-off].sticky-eyebrow {
  position: static !important;
}
[data-anim-off] .marquee-strip .marquee-track,
[data-anim-off].marquee-strip .marquee-track {
  animation: none !important;
}
`;

export const ANIMATIONS_JS = `(function(){
  if (window.__cinderAnim) { window.__cinderAnim.refresh(); return; }
  var prefersReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var narrow = (window.innerWidth || 0) < 768;
  var parallaxDisabled = prefersReduce || coarse || narrow;

  function offBy(el){ return !!(el.closest && el.closest('[data-anim-off]')); }

  // Reveal observer — handles .animate-in and all .animate-in-* variants,
  // plus count-up tweens.
  var observer = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (!e.isIntersecting) return;
      var el = e.target;
      if (!offBy(el)) {
        if (el.hasAttribute('data-countup')) runCountUp(el);
        el.classList.add('visible');
      } else {
        el.classList.add('visible');
      }
      observer.unobserve(el);
    });
  }, { threshold: 0, rootMargin: '0px 0px -10% 0px' });

  function observeReveals(){
    var sel = '.animate-in:not(.visible), .animate-in-up:not(.visible), .animate-in-left:not(.visible), .animate-in-right:not(.visible), .animate-in-scale:not(.visible), .animate-in-blur:not(.visible), [data-countup]:not(.visible)';
    document.querySelectorAll(sel).forEach(function(el){ observer.observe(el); });
  }

  function runCountUp(el){
    if (el.__countupRan) return;
    el.__countupRan = true;
    var target = parseFloat(el.getAttribute('data-countup'));
    if (!isFinite(target)) return;
    var suffix = el.getAttribute('data-countup-suffix') || '';
    var dur = parseInt(el.getAttribute('data-countup-duration') || '1400', 10);
    var decimals = (String(target).split('.')[1] || '').length;
    var start = performance.now();
    function step(now){
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      var v = target * eased;
      el.textContent = v.toFixed(decimals) + suffix;
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = target.toFixed(decimals) + suffix;
    }
    requestAnimationFrame(step);
  }

  // Parallax: collects .parallax-bg sections + [data-parallax] elements.
  var parallaxItems = [];
  function setupParallax(){
    parallaxItems = [];
    if (parallaxDisabled) return;
    document.querySelectorAll('.parallax-bg').forEach(function(sec){
      if (offBy(sec)) return;
      // Lift the section's background-image into a CSS var the ::before reads.
      var bg = sec.style.backgroundImage || getComputedStyle(sec).backgroundImage;
      if (bg && bg !== 'none') {
        sec.style.setProperty('--cinder-pbg', bg);
        // Hide the original so the pseudo-element shows alone.
        sec.style.backgroundImage = 'none';
      }
      parallaxItems.push({ el: sec, speed: 0.4, isBg: true });
    });
    document.querySelectorAll('[data-parallax]').forEach(function(el){
      if (offBy(el)) return;
      var s = parseFloat(el.getAttribute('data-parallax'));
      if (!isFinite(s)) s = 0.7;
      parallaxItems.push({ el: el, speed: 1 - s, isBg: false });
    });
  }

  var ticking = false;
  function updateParallax(){
    ticking = false;
    var vh = window.innerHeight || 0;
    for (var i = 0; i < parallaxItems.length; i++) {
      var it = parallaxItems[i];
      var r = it.el.getBoundingClientRect();
      var center = r.top + r.height / 2;
      var delta = (center - vh / 2) * it.speed;
      it.el.style.setProperty('--cinder-y', (-delta).toFixed(1) + 'px');
    }
  }
  function onScroll(){
    if (parallaxDisabled || parallaxItems.length === 0) return;
    if (!ticking) { ticking = true; requestAnimationFrame(updateParallax); }
  }

  // Marquee: duplicate strip children into a .marquee-track for seamless loop.
  function setupMarquees(){
    document.querySelectorAll('.marquee-strip').forEach(function(strip){
      if (strip.__marqueeInit) return;
      strip.__marqueeInit = true;
      if (strip.querySelector(':scope > .marquee-track')) return;
      var track = document.createElement('div');
      track.className = 'marquee-track';
      while (strip.firstChild) track.appendChild(strip.firstChild);
      var clone = track.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      var wrap = document.createDocumentFragment();
      // Wrap original + clone inside the single track for a -50% loop.
      var allItems = Array.prototype.slice.call(track.children);
      allItems.forEach(function(n){ wrap.appendChild(n); });
      clone = wrap.cloneNode(true);
      track.appendChild(wrap);
      track.appendChild(clone.cloneNode(true));
      strip.appendChild(track);
    });
  }

  function refresh(){
    setupMarquees();
    observeReveals();
    setupParallax();
    updateParallax();
  }

  window.__cinderAnim = { refresh: refresh, observer: observer };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function(){ updateParallax(); }, { passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
})();`;

// Compact override CSS used at preview + export time to gate individual
// effects without rewriting the markup. Each key returns a CSS snippet that
// neutralizes the matching effect; concatenate the ones whose toggle is off.
export const EFFECT_OFF_CSS = {
  fadeIn: `.animate-in:not([class*="animate-in-"]){opacity:1!important;transform:none!important;transition:none!important;}`,
  reveal: `.animate-in-up,.animate-in-left,.animate-in-right,.animate-in-scale,.animate-in-blur{opacity:1!important;transform:none!important;filter:none!important;transition:none!important;}`,
  parallax: `.parallax-bg::before,[data-parallax]{transform:none!important;}`,
  sticky: `.sticky-eyebrow{position:static!important;}`,
  countUp: `/* count-up gated at runtime */`,
  marquee: `.marquee-strip .marquee-track{animation:none!important;}`,
};

// Build a single override <style> body from the animations object (keys with
// false get their off-CSS appended). Returns empty string when every effect
// is on.
export function buildEffectOverrideCss(animations) {
  if (!animations) return '';
  let out = '';
  for (const key of EFFECT_KEYS) {
    if (animations[key] === false) out += EFFECT_OFF_CSS[key] || '';
  }
  return out;
}

// Build a tiny script that disables count-up at runtime (since the override
// CSS alone can't stop the JS tween). Idempotent. Returns empty string when
// countUp is enabled (or animations is null).
export function buildCountUpOffScript(animations) {
  if (!animations || animations.countUp !== false) return '';
  return `document.querySelectorAll('[data-countup]').forEach(function(el){var t=parseFloat(el.getAttribute('data-countup'));if(isFinite(t))el.textContent=t.toFixed((String(t).split('.')[1]||'').length)+(el.getAttribute('data-countup-suffix')||'');el.__countupRan=true;});`;
}
