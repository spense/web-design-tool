// Animation effects: shared catalog, defaults, and helpers used by both
// ToolsMenu (UI) and PreviewPanel (iframe override injection).

export const EFFECT_KEYS = ['fadeIn', 'reveal', 'parallax', 'sticky', 'countUp', 'marquee'];

export const EFFECT_LABELS = {
  fadeIn:   'Fade in elements',
  reveal:   'Scroll reveal',
  parallax: 'Parallax',
  sticky:   'Sticky elements',
  countUp:  'Count-up stats',
  marquee:  'Marquee',
};

// Defaults: every effect on. Pages without specialty markup are no-ops, so
// "on" only manifests when the model actually emits the markup — which is the
// signal that the user asked for / the model judged the effect appropriate.
export const DEFAULT_ANIMATIONS = {
  fadeIn:   true,
  reveal:   true,
  parallax: true,
  sticky:   true,
  countUp:  true,
  marquee:  true,
};

// Read a project's animation settings as a normalized object. Tolerates both
// the new `project.animations` shape and the legacy `project.scrollAnimations`
// boolean (which maps to fadeIn). Missing keys fall back to defaults.
export function normalizeAnimations(project) {
  const out = { ...DEFAULT_ANIMATIONS };
  if (project && typeof project === 'object') {
    if (project.animations && typeof project.animations === 'object') {
      for (const k of EFFECT_KEYS) {
        if (typeof project.animations[k] === 'boolean') out[k] = project.animations[k];
      }
    } else if (project.scrollAnimations === false) {
      // Legacy: scrollAnimations:false meant fade-in off. Everything else
      // stays at its default.
      out.fadeIn = false;
    }
  }
  return out;
}

// Detection: which effects does the active page's markup currently use? Used
// by ToolsMenu to dim rows for effects the model didn't apply to this page.
// Returns an object keyed by EFFECT_KEYS with booleans.
export function detectEffectsInDoc(doc) {
  const present = {};
  for (const k of EFFECT_KEYS) present[k] = false;
  if (!doc) return present;
  try {
    if (doc.querySelector('.animate-in:not([class*="animate-in-"])')) present.fadeIn = true;
    if (doc.querySelector('.animate-in-up, .animate-in-left, .animate-in-right, .animate-in-scale, .animate-in-blur, .animate-in-stagger')) present.reveal = true;
    if (doc.querySelector('.parallax-bg, [data-parallax]')) present.parallax = true;
    if (doc.querySelector('.sticky-eyebrow')) present.sticky = true;
    if (doc.querySelector('[data-countup]')) present.countUp = true;
    if (doc.querySelector('.marquee-strip')) present.marquee = true;
  } catch {}
  return present;
}
