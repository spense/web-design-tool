// Theme presets for the Tools menu. Pure data + transform functions; no React.

import { hexToHsl, hslToHex } from './colorUtils.js';

// ─── Color themes ───────────────────────────────────────────────────────────
// Each theme returns a map of CSS var -> value to apply on top of the current
// tokens. `null` value means "leave unchanged" (i.e. preserve the brand color).

export const colorThemes = [
  {
    id: 'default',
    label: 'Original',
    description: "Restore the design's original colors",
    swatch: null, // filled in at runtime from snapshot
    // Only restore COLOR tokens from the snapshot — leave fonts/spacing alone.
    build: (current, snapshot) => {
      if (!snapshot) return current;
      const out = { ...current };
      for (const [k, v] of Object.entries(snapshot)) {
        if (k.startsWith('--color-')) out[k] = v;
      }
      return out;
    },
  },
  {
    id: 'rich',
    label: 'Rich',
    description: 'Deep, jewel-toned dark surfaces with high contrast',
    swatch: null,
    build: (current) => {
      const primary = current['--color-primary'] || '#5b6ee1';
      const hsl = hexToHsl(primary);
      if (!hsl) return current;
      const { h, s, l } = hsl;
      // Boost saturation for the dark bg; ensure primary is readable against it
      const rs = Math.min(s * 1.1, 90);
      const adjustedPrimary = hslToHex({ h, s: rs, l: Math.max(l, 52) });
      return {
        ...current,
        '--color-bg':               hslToHex({ h, s: Math.max(rs * 0.4, 15), l: 7  }),
        '--color-surface':          hslToHex({ h, s: Math.max(rs * 0.45, 18), l: 13 }),
        '--color-text':             hslToHex({ h, s: Math.max(s * 0.08, 3),   l: 94 }),
        '--color-text-muted':       hslToHex({ h, s: Math.max(s * 0.2, 8),    l: 60 }),
        '--color-border':           hslToHex({ h, s: Math.max(rs * 0.45, 18), l: 22 }),
        '--color-primary':          adjustedPrimary,
        '--color-primary-contrast': hslToHex({ h, s: Math.max(s * 0.08, 3),   l: 96 }),
        '--color-accent':           hslToHex({ h, s: Math.min(rs * 1.1, 92),   l: 65 }),
      };
    },
  },
  {
    id: 'vivid',
    label: 'Vivid',
    description: 'Crisp white base with a bold, saturated brand color',
    swatch: null,
    build: (current) => {
      const primary = current['--color-primary'] || '#5b6ee1';
      const hsl = hexToHsl(primary);
      if (!hsl) return current;
      const { h, s, l } = hsl;
      // Push saturation high and pin lightness so primary pops on white
      const vs = Math.min(s * 1.2, 95);
      const adjustedPrimary = hslToHex({ h, s: vs, l: Math.min(Math.max(l, 38), 55) });
      return {
        ...current,
        '--color-bg':               '#ffffff',
        '--color-surface':          hslToHex({ h, s: Math.max(s * 0.12, 5),  l: 96 }),
        '--color-text':             hslToHex({ h, s: Math.max(s * 0.2, 8),   l: 8  }),
        '--color-text-muted':       hslToHex({ h, s: Math.max(s * 0.3, 10),  l: 38 }),
        '--color-border':           hslToHex({ h, s: Math.max(s * 0.15, 6),  l: 88 }),
        '--color-primary':          adjustedPrimary,
        '--color-primary-contrast': '#ffffff',
        '--color-accent':           hslToHex({ h, s: Math.min(vs * 1.05, 95), l: 30 }),
      };
    },
  },
  {
    id: 'monochrome',
    label: 'Mono',
    description: 'Shades of the brand color',
    swatch: null,
    build: (current) => {
      const primary = current['--color-primary'] || '#5b6ee1';
      const hsl = hexToHsl(primary);
      if (!hsl) return current;
      const { h, s } = hsl;
      return {
        ...current,
        '--color-bg':               hslToHex({ h, s: Math.max(s * 0.15, 6), l: 96 }),
        '--color-surface':          hslToHex({ h, s: Math.max(s * 0.2, 8),  l: 92 }),
        '--color-text':             hslToHex({ h, s: Math.max(s * 0.4, 15), l: 18 }),
        '--color-text-muted':       hslToHex({ h, s: Math.max(s * 0.3, 10), l: 40 }),
        '--color-border':           hslToHex({ h, s: Math.max(s * 0.2, 8),  l: 82 }),
        '--color-primary':          primary,
        '--color-primary-contrast': hslToHex({ h, s: Math.max(s * 0.15, 6), l: 96 }),
        '--color-accent':           hslToHex({ h, s, l: 35 }),
      };
    },
  },
];

// ─── Font pairings ──────────────────────────────────────────────────────────
// `googleFonts` is the @import URL family-string — what comes after
// `family=` in a Google Fonts URL (joined with `&family=` for multiple fonts).

export const fontPairings = [
  {
    id: 'original',
    label: 'Original',
    description: "Keep the design's original fonts",
    heading: null, body: null, googleFonts: null,
  },
  {
    id: 'modern',
    label: 'Modern (Inter)',
    heading: "'Inter', sans-serif",
    body: "'Inter', sans-serif",
    googleFonts: 'Inter:wght@400;500;600;700;800',
  },
  {
    id: 'editorial',
    label: 'Editorial (Playfair Display, Lora)',
    heading: "'Playfair Display', serif",
    body: "'Lora', serif",
    googleFonts: 'Playfair+Display:wght@400;600;700&family=Lora:wght@400;500;600',
  },
  {
    id: 'friendly',
    label: 'Friendly (Nunito, Quicksand)',
    heading: "'Nunito', sans-serif",
    body: "'Quicksand', sans-serif",
    googleFonts: 'Nunito:wght@600;700;800&family=Quicksand:wght@400;500;600',
  },
  {
    id: 'bold',
    label: 'Bold (Bebas Neue, Roboto)',
    heading: "'Bebas Neue', sans-serif",
    body: "'Roboto', sans-serif",
    googleFonts: 'Bebas+Neue&family=Roboto:wght@400;500;700',
  },
  {
    id: 'classic',
    label: 'Classic (Libre Baskerville, Source Sans 3)',
    heading: "'Libre Baskerville', serif",
    body: "'Source Sans 3', sans-serif",
    googleFonts: 'Libre+Baskerville:wght@400;700&family=Source+Sans+3:wght@400;500;600',
  },
  {
    id: 'tech',
    label: 'Tech (JetBrains Mono, Space Grotesk)',
    heading: "'JetBrains Mono', monospace",
    body: "'Space Grotesk', sans-serif",
    googleFonts: 'JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;600',
  },
  {
    id: 'premium',
    label: 'Premium (Cormorant Garamond, Raleway)',
    heading: "'Cormorant Garamond', serif",
    body: "'Raleway', sans-serif",
    googleFonts: 'Cormorant+Garamond:wght@400;500;600;700&family=Raleway:wght@400;500;600',
  },
  {
    id: 'casual',
    label: 'Casual (Archivo Black, DM Sans)',
    heading: "'Archivo Black', sans-serif",
    body: "'DM Sans', sans-serif",
    googleFonts: 'Archivo+Black&family=DM+Sans:wght@400;500;700',
  },
  {
    id: 'refined',
    label: 'Refined (Fraunces, Mulish)',
    heading: "'Fraunces', serif",
    body: "'Mulish', sans-serif",
    googleFonts: 'Fraunces:wght@400;500;600;700&family=Mulish:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'corporate',
    label: 'Corporate (Sora, Work Sans)',
    heading: "'Sora', sans-serif",
    body: "'Work Sans', sans-serif",
    googleFonts: 'Sora:wght@500;600;700;800&family=Work+Sans:ital,wght@0,400;0,500;0,600;1,400;1,600',
  },
  {
    id: 'magazine',
    label: 'Magazine (Spectral, Karla)',
    heading: "'Spectral', serif",
    body: "'Karla', sans-serif",
    googleFonts: 'Spectral:wght@400;500;600;700&family=Karla:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'statement',
    label: 'Statement (Oswald, Merriweather)',
    heading: "'Oswald', sans-serif",
    body: "'Merriweather', serif",
    googleFonts: 'Oswald:wght@400;500;600;700&family=Merriweather:ital,wght@0,400;0,700;0,900;1,400;1,700',
  },
  {
    id: 'warm',
    label: 'Warm (Epilogue, Figtree)',
    heading: "'Epilogue', sans-serif",
    body: "'Figtree', sans-serif",
    googleFonts: 'Epilogue:wght@500;600;700;800&family=Figtree:ital,wght@0,400;0,500;0,600;1,400;1,600',
  },
  {
    id: 'elegant',
    label: 'Elegant (Marcellus, Jost)',
    heading: "'Marcellus', serif",
    body: "'Jost', sans-serif",
    googleFonts: 'Marcellus&family=Jost:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'geometric',
    label: 'Geometric (Poppins, Rubik)',
    heading: "'Poppins', sans-serif",
    body: "'Rubik', sans-serif",
    googleFonts: 'Poppins:wght@500;600;700&family=Rubik:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'humanist',
    label: 'Humanist (Outfit, Hanken Grotesk)',
    heading: "'Outfit', sans-serif",
    body: "'Hanken Grotesk', sans-serif",
    googleFonts: 'Outfit:wght@500;600;700;800&family=Hanken+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'literary',
    label: 'Literary (Bitter, Open Sans)',
    heading: "'Bitter', serif",
    body: "'Open Sans', sans-serif",
    googleFonts: 'Bitter:ital,wght@0,500;0,600;0,700;1,500&family=Open+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'expressive',
    label: 'Expressive (Unbounded, Plus Jakarta Sans)',
    heading: "'Unbounded', sans-serif",
    body: "'Plus Jakarta Sans', sans-serif",
    googleFonts: 'Unbounded:wght@500;600;700;800&family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'kinetic',
    label: 'Kinetic (Syne, Be Vietnam Pro)',
    heading: "'Syne', sans-serif",
    body: "'Be Vietnam Pro', sans-serif",
    googleFonts: 'Syne:wght@500;600;700;800&family=Be+Vietnam+Pro:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'gazette',
    label: 'Gazette (DM Serif Display, Nunito Sans)',
    heading: "'DM Serif Display', serif",
    body: "'Nunito Sans', sans-serif",
    googleFonts: 'DM+Serif+Display&family=Nunito+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'slab',
    label: 'Slab (Zilla Slab, Libre Franklin)',
    heading: "'Zilla Slab', serif",
    body: "'Libre Franklin', sans-serif",
    googleFonts: 'Zilla+Slab:wght@500;600;700&family=Libre+Franklin:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'gallery',
    label: 'Gallery (Gloock, Albert Sans)',
    heading: "'Gloock', serif",
    body: "'Albert Sans', sans-serif",
    googleFonts: 'Gloock&family=Albert+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'studio',
    label: 'Studio (Bricolage Grotesque, Cabin)',
    heading: "'Bricolage Grotesque', sans-serif",
    body: "'Cabin', sans-serif",
    googleFonts: 'Bricolage+Grotesque:wght@600;700;800&family=Cabin:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'couture',
    label: 'Couture (Yeseva One, Red Hat Text)',
    heading: "'Yeseva One', serif",
    body: "'Red Hat Text', sans-serif",
    googleFonts: 'Yeseva+One&family=Red+Hat+Text:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'gridiron',
    label: 'Gridiron (Fjalla One, PT Sans)',
    heading: "'Fjalla One', sans-serif",
    body: "'PT Sans', sans-serif",
    googleFonts: 'Fjalla+One&family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700',
  },
  {
    id: 'nordic',
    label: 'Nordic (Familjen Grotesk, Instrument Sans)',
    heading: "'Familjen Grotesk', sans-serif",
    body: "'Instrument Sans', sans-serif",
    googleFonts: 'Familjen+Grotesk:wght@500;600;700&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'journal',
    label: 'Journal (Newsreader, Overpass)',
    heading: "'Newsreader', serif",
    body: "'Overpass', sans-serif",
    googleFonts: 'Newsreader:wght@400;500;600;700&family=Overpass:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
  {
    id: 'impact',
    label: 'Impact (Anton, Schibsted Grotesk)',
    heading: "'Anton', sans-serif",
    body: "'Schibsted Grotesk', sans-serif",
    googleFonts: 'Anton&family=Schibsted+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600',
  },
];

// ─── Sizing scales (font-size) ──────────────────────────────────────────────

export const sizingScales = [
  { id: 'default', label: 'Default', multiplier: null  },
  { id: 'small',   label: 'Small',   multiplier: 0.85  },
  { id: 'large',   label: 'Large',   multiplier: 1.25  },
];

const SIZING_KEYS = ['--font-size-base', '--font-size-h1', '--font-size-h2', '--font-size-h3'];

export function buildSizingTokens(currentTokens, snapshotTokens, multiplier) {
  const next = { ...currentTokens };
  const base = snapshotTokens || currentTokens;
  for (const key of SIZING_KEYS) {
    const v = base[key];
    if (v) next[key] = scaleCssLength(v, multiplier);
  }
  return next;
}

// ─── Spacing scales (multipliers on current --space-* values) ───────────────

export const spacingScales = [
  { id: 'compact',     label: 'Compact',     multiplier: 0.6 },
  { id: 'comfortable', label: 'Comfortable', multiplier: 1.0 },
  { id: 'roomy',       label: 'Roomy',       multiplier: 1.5 },
];

// ─── Border radius scales ───────────────────────────────────────────────────

export const radiusScales = [
  { id: 'square', label: 'Square', vars: { '--radius-sm': '0',   '--radius-md': '0',    '--radius-lg': '0',    '--radius-button': '0'     } },
  { id: 'small',  label: 'Small',  vars: { '--radius-sm': '4px', '--radius-md': '8px',  '--radius-lg': '12px', '--radius-button': '4px'   } },
  { id: 'large',  label: 'Large',  vars: { '--radius-sm': '8px', '--radius-md': '16px', '--radius-lg': '24px', '--radius-button': '8px'   } },
  { id: 'pill',   label: 'Pill',   vars: { '--radius-sm': '8px', '--radius-md': '16px', '--radius-lg': '24px', '--radius-button': '999px' } },
];

// Category → token-name predicate. Used to scope "Original" restores so
// resetting one category doesn't wipe a user's choice in another.
export const tokenCategories = {
  color:   k => k.startsWith('--color-'),
  font:    k => k === '--font-heading' || k === '--font-body',
  sizing:  k => k.startsWith('--font-size-') || k === '--line-height-base',
  spacing: k => k.startsWith('--space-'),
  radius:  k => k.startsWith('--radius-'),
};

// Pick only the tokens in `tokens` that belong to `category` from the snapshot.
export function pickCategory(tokens, category) {
  const test = tokenCategories[category];
  if (!test || !tokens) return {};
  const out = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (test(k)) out[k] = v;
  }
  return out;
}

// Apply spacing multiplier to a current token map.
export function buildSpacingTokens(currentTokens, snapshotTokens, multiplier) {
  const next = { ...currentTokens };
  // Use the snapshot as the baseline so multipliers compound from the original.
  const baseSource = snapshotTokens || currentTokens;
  for (const key of ['--space-xs', '--space-sm', '--space-md', '--space-lg', '--space-xl']) {
    const v = baseSource[key];
    if (!v) continue;
    next[key] = scaleCssLength(v, multiplier);
  }
  return next;
}

function scaleCssLength(value, mult) {
  // Match a number followed by a unit (px, rem, em).
  const m = String(value).match(/^([\d.]+)\s*(px|rem|em|%)$/);
  if (!m) return value;
  const n = parseFloat(m[1]) * mult;
  // Round to 3 decimals then trim trailing zeros
  const rounded = Math.round(n * 1000) / 1000;
  return `${rounded}${m[2]}`;
}
