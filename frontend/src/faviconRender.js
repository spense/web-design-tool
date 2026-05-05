// Favicon generation + rasterization utilities (client-side, no deps).
// All sizes are produced via Canvas so the backend stays image-library free.

import { hexToHsl, hslToHex } from './colorUtils.js';

export const FAVICON_SIZES = [16, 32, 180, 192, 512];

// Font styles that the regenerate cycle picks from. Each entry must
// rasterize reliably across browsers (only widely-shipped system fonts).
export const FONT_STYLES = [
  { id: 'sans-bold',   family: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', weight: 700 },
  { id: 'sans-black',  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', weight: 900 },
  { id: 'serif-bold',  family: 'Georgia, "Times New Roman", serif', weight: 700 },
  { id: 'mono-bold',   family: '"SF Mono", ui-monospace, Menlo, Consolas, monospace', weight: 700 },
];

// First-letter monogram. "Acme Corp" → "A", "openai" → "O".
export function shortInitials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const first = s.split(/[\s_\-]+/).filter(Boolean)[0] || s;
  return first[0].toUpperCase();
}

// Two-letter monogram. Prefers first-letter-of-first-two-words; falls back
// to camelCase splits or the first two characters of a single word.
export function longInitials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const words = s.split(/[\s_\-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0];
  const camel = w.match(/^([A-Z][a-z]*)([A-Z])/);
  if (camel) return (camel[1][0] + camel[2]).toUpperCase();
  return w.slice(0, 2).toUpperCase();
}

// Back-compat alias used by older callers.
export const pickInitials = longInitials;

// Pick an ordered list of candidate background colors that match the site's
// tonality. Brand tokens (primary/accent/etc) are used as-is, then padded
// with hue-shifted variants that inherit the primary's saturation +
// lightness — so every choice in the cycle "feels like" the same site.
export function pickColorChoices(tokens, name) {
  const candidates = [];
  const keys = ['--color-primary', '--color-accent', '--accent', '--primary', '--color-secondary', '--brand'];
  for (const k of keys) {
    const v = tokens?.[k];
    const hex = normalizeToHex(v);
    if (hex && !candidates.includes(hex)) candidates.push(hex);
  }
  if (candidates.length === 0) {
    candidates.push(hashHex(name || 'untitled'));
  }
  // Anchor s/l on the primary brand color so hue-shifted variants stay in
  // the same tonal family. If the primary is too washed-out to make a
  // legible favicon, nudge saturation up a bit while keeping lightness.
  const seed = candidates[0];
  const hsl = hexToHsl(seed);
  if (hsl) {
    const s = Math.max(hsl.s, 45);
    const l = clamp(hsl.l, 28, 72);
    for (const shift of [60, 180, 240, 120, 300]) {
      const shifted = hslToHex({ h: (hsl.h + shift) % 360, s, l });
      if (!candidates.includes(shifted)) candidates.push(shifted);
    }
  }
  return candidates;
}

// Build the parameter set for a given attempt number. Each attempt advances
// the color, letter mode, and font on independent periods so successive
// regenerates produce visibly different combinations — not just a recolor.
export function chooseParams({ name, tokens, attempt = 0 }) {
  const colors = pickColorChoices(tokens || {}, name);
  const bg = colors[attempt % colors.length];
  const fg = readableForeground(bg);
  // Even attempts → 2-letter monogram, odd → 1-letter.
  const useLong = attempt % 2 === 0;
  const letters = useLong ? longInitials(name) : shortInitials(name);
  const font = FONT_STYLES[attempt % FONT_STYLES.length].id;
  return { letters, bg, fg, shape: 'rounded', font };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Build an SVG string for the monogram. viewBox is a 100×100 unit square so
// the same source rasterizes cleanly to any pixel size. The shape always
// bleeds to the edge — at 16×16 there's no room to spare.
export function buildMonogramSvg({ letters, bg, fg, font }) {
  const lt = String(letters || '?').slice(0, 2);
  const fontStyle = FONT_STYLES.find(f => f.id === font) || FONT_STYLES[0];
  // Mono is naturally wider — shrink it more for two letters. Serif
  // benefits from a hair more breathing room than sans.
  const isMono = fontStyle.id === 'mono-bold';
  const isSerif = fontStyle.id === 'serif-bold';
  const fontSize = lt.length === 1
    ? (isSerif ? 78 : 82)
    : (isMono ? 56 : isSerif ? 60 : 66);
  const letterSpacing = lt.length === 1 ? 0 : (isMono ? -4 : -3);
  // Vertical centering: compute the baseline offset as an absolute number
  // in viewBox units. Using `dy=".35em"` is the textbook trick but `em`
  // resolves against the element's computed font-size, which not all SVG
  // renderers honor when the file is consumed as a static asset (favicon,
  // file preview). The baked-in offset has no unit ambiguity.
  const baselineY = 50 + fontSize * 0.35;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" ry="22" fill="${bg}"/>
  <text x="50" y="${baselineY}" text-anchor="middle"
        font-family='${fontStyle.family}' font-size="${fontSize}" font-weight="${fontStyle.weight}"
        fill="${fg}" letter-spacing="${letterSpacing}">${escapeXml(lt)}</text>
</svg>`;
}

// Rasterize an SVG string to a PNG Blob at the given pixel size.
export async function rasterizeSvg(svg, size) {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);
  return canvasToBlob(canvas);
}

// Rasterize a user-uploaded image to a square PNG, cover-fit (centered crop).
export async function rasterizeImage(file, size) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    // cover-fit: crop the longer axis so the square is fully filled.
    const ratio = Math.max(size / img.width, size / img.height);
    const drawW = img.width * ratio;
    const drawH = img.height * ratio;
    const dx = (size - drawW) / 2;
    const dy = (size - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    return canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Render a full set of PNG blobs (one per size) from an SVG string.
export async function renderAllFromSvg(svg) {
  const out = {};
  for (const size of FAVICON_SIZES) {
    out[size] = await rasterizeSvg(svg, size);
  }
  return out;
}

// Render a full set of PNG blobs from an uploaded image File/Blob.
export async function renderAllFromImage(file) {
  const out = {};
  for (const size of FAVICON_SIZES) {
    out[size] = await rasterizeImage(file, size);
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('image load failed'));
    img.src = src;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
  });
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// Best-effort conversion of a CSS color value to a 6-char hex. Accepts
// `#abc`, `#aabbcc`, `#aabbccff`, `rgb(...)`, `hsl(...)`. Returns null otherwise.
function normalizeToHex(v) {
  if (!v) return null;
  const s = String(v).trim();
  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length >= 6) return '#' + h.slice(0, 6).toLowerCase();
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]].map(n => {
      const v = Math.max(0, Math.min(255, Math.round(parseFloat(n))));
      return v.toString(16).padStart(2, '0');
    }).join('');
  }
  const hsl = s.match(/^hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i);
  if (hsl) {
    return hslToHex({ h: parseFloat(hsl[1]), s: parseFloat(hsl[2]), l: parseFloat(hsl[3]) });
  }
  return null;
}

// Pick black or white text based on the background's perceived brightness.
function readableForeground(bg) {
  const hsl = hexToHsl(bg);
  if (!hsl) return '#ffffff';
  return hsl.l < 60 ? '#ffffff' : '#111111';
}

// Deterministic hex from a string — used when the design has no color tokens.
function hashHex(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return hslToHex({ h: hue, s: 55, l: 45 });
}
