// Normalize an uploaded/pasted SVG to match the visual properties of the
// SVG it's replacing — size, color, stroke width. Only recolors when the
// source is monochrome (a single paint color used across all fills/strokes),
// so duotone icons aren't flattened.
//
// Mutates `newSvg` in place. `sourceSvg` is a live element in the preview
// iframe — we read from it via both attributes and computed style so that
// CSS-driven styling (a `.icon { stroke: currentColor }` class) is picked up.

const PAINT_NONE = new Set(['', 'none', 'transparent', 'rgba(0, 0, 0, 0)']);

function isPaintValue(v) {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  if (PAINT_NONE.has(s)) return false;
  if (s.startsWith('url(')) return false;
  return true;
}

function getWin(el) {
  return el?.ownerDocument?.defaultView || null;
}

// Resolve a paint/length property from a live element. Attribute wins if set
// (it's the authorial value); otherwise fall back to computed style so
// CSS-set values are still visible.
function resolveProp(el, name) {
  const attr = el.getAttribute?.(name);
  if (attr != null && attr !== '') return attr;
  const win = getWin(el);
  if (win) {
    const cs = win.getComputedStyle(el);
    const v = cs.getPropertyValue(name);
    if (v) return v;
  }
  return null;
}

function collectSourcePaints(sourceSvg) {
  const colors = new Set();
  const strokeWidths = new Set();
  const walk = (el) => {
    for (const name of ['fill', 'stroke']) {
      const v = resolveProp(el, name);
      if (isPaintValue(v)) colors.add(v.trim().toLowerCase().replace(/\s+/g, ''));
    }
    // Only record stroke-width for elements that actually paint a stroke,
    // otherwise every element's default computed stroke-width gets counted.
    const stroke = resolveProp(el, 'stroke');
    if (isPaintValue(stroke)) {
      const sw = resolveProp(el, 'stroke-width');
      if (sw) strokeWidths.add(sw.trim());
    }
    for (const child of el.children) walk(child);
  };
  walk(sourceSvg);
  return { colors, strokeWidths };
}

// Strip per-element fill/stroke on the pasted SVG so root inheritance wins.
// Preserves explicit "none" (used to disable fill on stroked icons).
function stripDescendantPaint(newSvg) {
  const walk = (el) => {
    for (const child of el.children) {
      for (const name of ['fill', 'stroke']) {
        const attr = child.getAttribute(name);
        if (attr != null && attr.trim().toLowerCase() !== 'none') {
          child.removeAttribute(name);
        }
        const inline = child.style?.getPropertyValue(name);
        if (inline && inline.trim().toLowerCase() !== 'none') {
          child.style.removeProperty(name);
        }
      }
      walk(child);
    }
  };
  walk(newSvg);
}

function stripDescendantStrokeWidth(newSvg) {
  const walk = (el) => {
    for (const child of el.children) {
      if (child.hasAttribute('stroke-width')) child.removeAttribute('stroke-width');
      child.style?.removeProperty('stroke-width');
      walk(child);
    }
  };
  walk(newSvg);
}

export function normalizeSvgToSource(newSvg, sourceSvg) {
  if (!newSvg || !sourceSvg) return;

  // Copy the source root's presentation attributes so CSS-class-driven
  // styling (e.g. `.icon { color: var(--fg); width: 24px; }`) carries over
  // to the paste. `class` and `style` do most of the work; the explicit
  // attributes handle SVGs authored with inline attrs instead.
  const ROOT_ATTRS = [
    'class', 'style', 'width', 'height',
    'fill', 'stroke', 'stroke-width',
    'stroke-linecap', 'stroke-linejoin', 'color',
  ];
  for (const name of ROOT_ATTRS) {
    const v = sourceSvg.getAttribute(name);
    if (v != null) newSvg.setAttribute(name, v);
    else newSvg.removeAttribute(name);
  }

  const src = collectSourcePaints(sourceSvg);

  // Monochrome: single distinct paint color across the whole source. Strip
  // hardcoded fill/stroke on the paste so it inherits from the root we just
  // populated. Multi-color source → leave the paste's own colors alone.
  if (src.colors.size <= 1) stripDescendantPaint(newSvg);

  // Consistent stroke-width in the source → apply it and remove overrides
  // on the paste so the weight actually takes effect.
  if (src.strokeWidths.size === 1) {
    const [sw] = src.strokeWidths;
    newSvg.setAttribute('stroke-width', sw);
    stripDescendantStrokeWidth(newSvg);
  }
}
