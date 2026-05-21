// Compute a compact spec readout for the selected element.
// Used by the inline-edit toolbar.

function rgbToHex(rgb) {
  if (!rgb) return rgb;
  const m = String(rgb).match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (!m) return rgb;
  const [, r, g, b, a] = m;
  if (a !== undefined && parseFloat(a) < 1) return rgb; // keep alpha
  return '#' + [r, g, b].map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

// "24px 24px 24px 24px" → "24px"; "24px 0px" → "24px 0"
function collapseShorthand(s) {
  if (!s) return s;
  const parts = s.split(/\s+/);
  if (parts.length === 4 && parts.every(p => p === parts[0])) return parts[0];
  // strip "px" from pure-zero like "0px"
  return parts.map(p => p === '0px' ? '0' : p).join(' ');
}

// "Inter, system-ui, sans-serif" → "Inter"
function firstFamily(s) {
  if (!s) return s;
  return s.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

// "8px 16px solid rgb(52,54,60)" style border → collapsed
function formatBorder(cs) {
  const w = cs.borderTopWidth;
  // Treat as no border if width is 0px on all sides.
  if (['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth']
      .every(k => parseFloat(cs[k]) === 0)) return null;
  // Uniform border?
  const allEqual = ['Top','Right','Bottom','Left'].every(side =>
    cs[`border${side}Width`] === cs.borderTopWidth &&
    cs[`border${side}Style`] === cs.borderTopStyle &&
    cs[`border${side}Color`] === cs.borderTopColor);
  if (allEqual) {
    return `${cs.borderTopWidth} ${cs.borderTopStyle} ${rgbToHex(cs.borderTopColor)}`;
  }
  return 'mixed';
}

function formatBackground(cs) {
  const bgImage = cs.backgroundImage;
  if (bgImage && bgImage !== 'none') {
    // truncate long gradient/url
    if (bgImage.length > 38) return bgImage.slice(0, 35) + '…';
    return bgImage;
  }
  const bgColor = cs.backgroundColor;
  if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') return null;
  return rgbToHex(bgColor);
}

function truncate(s, n = 30) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Returns { textSpecs: [...] | null, boxSpecs: [...] }
// Each spec is { k, v }.
export function computeElementSpecs(el, hasTextNode) {
  if (!el) return { textSpecs: null, boxSpecs: [] };
  const win = el.ownerDocument?.defaultView;
  if (!win) return { textSpecs: null, boxSpecs: [] };
  const cs = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  let textSpecs = null;
  if (hasTextNode) {
    textSpecs = [
      { k: 'font',   v: truncate(firstFamily(cs.fontFamily), 28) },
      { k: 'size',   v: `${cs.fontSize} / ${cs.lineHeight === 'normal' ? '–' : cs.lineHeight}` },
      { k: 'weight', v: cs.fontWeight },
      { k: 'color',  v: rgbToHex(cs.color) },
    ];
  }

  const boxSpecs = [
    { k: 'w × h',   v: `${Math.round(rect.width)} × ${Math.round(rect.height)}` },
    { k: 'padding', v: collapseShorthand(cs.padding) },
    { k: 'margin',  v: collapseShorthand(cs.margin) },
  ];
  const bg = formatBackground(cs);
  if (bg) boxSpecs.push({ k: 'background', v: bg });
  const border = formatBorder(cs);
  if (border) boxSpecs.push({ k: 'border', v: border });
  const radius = collapseShorthand(cs.borderRadius);
  if (radius && radius !== '0') boxSpecs.push({ k: 'radius', v: radius });

  return { textSpecs, boxSpecs };
}
