// Utilities for selecting and identifying elements inside the preview iframe.
// Used by the inline-edit toolbar/panel.

// Inline-formatting tags. An element whose children are only these (or text
// nodes) is treated as a "text leaf" — Edit / Rewrite are available because
// replacing its textContent only loses inline emphasis, not real structure.
const INLINE_TAGS = new Set([
  'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SMALL', 'MARK', 'CODE',
  'SUB', 'SUP', 'BR', 'ABBR', 'CITE', 'Q', 'VAR', 'KBD', 'TIME', 'LABEL',
  'BDI', 'BDO', 'WBR', 'INS', 'DEL',
]);

// Tags we never want to treat as text-editable even if they happen to have
// only inline children (these have semantics beyond text content).
const NEVER_TEXT_LEAF = new Set([
  'HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'SVG', 'PICTURE', 'VIDEO',
  'AUDIO', 'IFRAME', 'TABLE', 'THEAD', 'TBODY', 'TR', 'FORM', 'UL', 'OL',
  'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
]);

// Tags we never want to treat as selectable.
const SKIP_TAGS = new Set([
  'HTML', 'HEAD', 'LINK', 'META', 'SCRIPT', 'STYLE', 'TITLE', 'BASE', 'NOSCRIPT',
]);

// Structure-based check: does this element behave like a text container?
// True when it has non-empty text AND its children (if any) are all inline.
// Catches text in <div>s, <h2>s, <p>s, <button>s etc. — anywhere text lives
// without nested block layout — without needing a maintained tag list.
function isTextLeaf(el) {
  if (!el || !el.tagName) return false;
  if (NEVER_TEXT_LEAF.has(el.tagName)) return false;
  if (!el.textContent || !el.textContent.trim()) return false;
  for (const child of el.children) {
    if (!INLINE_TAGS.has(child.tagName)) return false;
  }
  return true;
}

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
  // Text-bearing = structurally a text leaf (text content + only inline
  // children). Includes <div>Trusted since 1962</div> and similar — common
  // pattern in these designs — without polluting block containers like
  // <section> or <div class="card"> with edit-text actions that would
  // destroy their nested layout.
  const isTextBearing = isTextLeaf(el);
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

// Capture an identity snapshot of an element at selection time. Used to
// verify that the saved selector path still points to the SAME element
// after the iframe re-renders (chat edit, undo, redo). Without this, a path
// that accidentally lands on a sibling after an ancestor was removed would
// look like a valid re-resolution.
export function fingerprintElement(el) {
  if (!el) return null;
  return {
    tag: el.tagName,
    id: el.id || null,
    textPrefix: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    childCount: el.children ? el.children.length : 0,
  };
}

// Strict identity check. Returns true only if the element looks like the
// one captured by fingerprintElement.
export function matchesFingerprint(snap, el) {
  if (!snap || !el) return false;
  if (snap.tag !== el.tagName) return false;
  if (snap.id !== (el.id || null)) return false;
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (snap.textPrefix !== text) return false;
  if (snap.childCount !== (el.children ? el.children.length : 0)) return false;
  return true;
}

// Whether an element is a valid selection target.
export function isSelectable(el, doc) {
  if (!el || !el.tagName) return false;
  if (el === doc.body || el === doc.documentElement) return false;
  if (SKIP_TAGS.has(el.tagName)) return false;
  // Only the outer <svg> is selectable — never its internal nodes (path, g,
  // circle, etc.). An icon should be selected as a single whole.
  if (el.tagName.toLowerCase() !== 'svg' && el.closest && el.closest('svg')) return false;
  return true;
}
