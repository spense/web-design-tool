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
    label: 'Modern',
    heading: "'Inter', sans-serif",
    body: "'Inter', sans-serif",
    googleFonts: 'Inter:wght@400;500;600;700;800',
  },
  {
    id: 'editorial',
    label: 'Editorial',
    heading: "'Playfair Display', serif",
    body: "'Lora', serif",
    googleFonts: 'Playfair+Display:wght@400;600;700&family=Lora:wght@400;500;600',
  },
  {
    id: 'friendly',
    label: 'Friendly',
    heading: "'Poppins', sans-serif",
    body: "'Open Sans', sans-serif",
    googleFonts: 'Poppins:wght@500;600;700;800&family=Open+Sans:wght@400;500;600',
  },
  {
    id: 'bold',
    label: 'Bold',
    heading: "'Oswald', sans-serif",
    body: "'Roboto', sans-serif",
    googleFonts: 'Oswald:wght@500;600;700&family=Roboto:wght@400;500;700',
  },
  {
    id: 'classic',
    label: 'Classic',
    heading: "'Merriweather', serif",
    body: "'Source Sans 3', sans-serif",
    googleFonts: 'Merriweather:wght@400;700;900&family=Source+Sans+3:wght@400;500;600',
  },
  {
    id: 'tech',
    label: 'Tech',
    heading: "'Space Grotesk', sans-serif",
    body: "'IBM Plex Sans', sans-serif",
    googleFonts: 'Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600',
  },
  {
    id: 'premium',
    label: 'Premium',
    heading: "'Cormorant Garamond', serif",
    body: "'Inter', sans-serif",
    googleFonts: 'Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600',
  },
  {
    id: 'casual',
    label: 'Casual',
    heading: "'DM Serif Display', serif",
    body: "'DM Sans', sans-serif",
    googleFonts: 'DM+Serif+Display&family=DM+Sans:wght@400;500;700',
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
