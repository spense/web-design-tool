// Utilities for selecting and identifying elements inside the preview iframe.
// Used by the inline-edit toolbar/panel.

// Tags that can carry a meaningful text node we'd want to edit.
const TEXT_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'SPAN', 'A', 'BUTTON', 'LI', 'LABEL',
  'STRONG', 'EM', 'BLOCKQUOTE', 'FIGCAPTION',
  'SUMMARY', 'TD', 'TH', 'DT', 'DD',
]);

// Tags we never want to treat as selectable.
const SKIP_TAGS = new Set([
  'HTML', 'HEAD', 'LINK', 'META', 'SCRIPT', 'STYLE', 'TITLE', 'BASE', 'NOSCRIPT',
]);

// Build a path of nth-child indices from body down to el.
// Returns array of integers (each is index into parent.children), or null.
export function getSelectorPath(el, doc) {
  if (!el || !doc?.body) return null;
  const path = [];
  let node = el;
  while (node && node !== doc.body) {
    const parent = node.parentElement;
    if (!parent) return null;
    const idx = Array.prototype.indexOf.call(parent.children, node);
    if (idx < 0) return null;
    path.unshift(idx);
    node = parent;
  }
  return path;
}

// Resolve a path back to an element after iframe re-renders.
export function resolveSelectorPath(path, doc) {
  if (!path || !doc?.body) return null;
  let node = doc.body;
  for (const idx of path) {
    if (!node?.children?.[idx]) return null;
    node = node.children[idx];
  }
  return node;
}

// Ancestor chain from outermost (body's direct child) to el.
export function getElementChain(el, doc) {
  const chain = [];
  let node = el;
  while (node && node !== doc.body && node !== doc.documentElement) {
    chain.unshift(node);
    node = node.parentElement;
  }
  return chain;
}

// Categorize an element for action filtering.
export function classifyElement(el) {
  if (!el || !el.tagName) return {};
  const tag = el.tagName;
  const svgRoot = tag === 'svg' ? el : (el.closest ? el.closest('svg') : null);
  const isSvg = !!svgRoot;
  const isImg = tag === 'IMG';
  let hasBgImage = false;
  try {
    const win = el.ownerDocument?.defaultView;
    const cs = win ? win.getComputedStyle(el) : null;
    const bg = cs?.backgroundImage;
    hasBgImage = !!(bg && bg !== 'none' && /url\(/.test(bg));
  } catch {}
  const hasOwnTextNode = Array.from(el.childNodes || []).some(
    n => n.nodeType === 3 && n.textContent.trim()
  );
  const isTextBearing = TEXT_TAGS.has(tag) && hasOwnTextNode;
  const isRemovable = !SKIP_TAGS.has(tag) && tag !== 'BODY';

  return {
    tag,
    isSvg,
    svgRoot,
    isImg,
    hasBgImage,
    isTextBearing,
    isRemovable,
    canReplaceVisual: isImg || hasBgImage || isSvg,
  };
}

// Short human label like `section#hero.dark` for breadcrumbs.
export function shortLabel(el) {
  if (!el || !el.tagName) return '';
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  let cls = '';
  if (typeof el.className === 'string' && el.className.trim()) {
    cls = '.' + el.className.trim().split(/\s+/)[0];
  }
  return `${tag}${id}${cls}`;
}

// Whether an element is a valid selection target.
export function isSelectable(el, doc) {
  if (!el || !el.tagName) return false;
  if (el === doc.body || el === doc.documentElement) return false;
  if (SKIP_TAGS.has(el.tagName)) return false;
  return true;
}
