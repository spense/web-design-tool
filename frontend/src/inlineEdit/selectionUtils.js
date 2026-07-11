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

  // Link = the element is an <a> with an href. Used to surface an Edit Link
  // action that retargets the href without going through chat.
  const isLink = tag === 'A' && el.hasAttribute && el.hasAttribute('href');

  return {
    tag,
    isSvg,
    svgRoot,
    isImg,
    hasBgImage,
    isTextBearing,
    isRemovable,
    isLink,
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

// Heuristic: does this element render anything the user can see right now?
// Used to skip legitimately-hidden surfaces (closed mobile drawers/overlays,
// stashed modals) that the Select tool's global `pointer-events: auto`
// override would otherwise turn into invisible click traps. We deliberately
// look at the element itself AND its ancestors because hidden parents make
// children unselectable too.
export function isVisuallyHidden(el) {
  if (!el || !el.ownerDocument || !el.ownerDocument.defaultView) return false;
  const win = el.ownerDocument.defaultView;
  let node = el;
  while (node && node.nodeType === 1 && node !== node.ownerDocument.documentElement) {
    const cs = win.getComputedStyle(node);
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    // opacity:0 hides the subtree visually — anything inside is also invisible.
    if (parseFloat(cs.opacity) === 0) return true;
    node = node.parentElement;
  }
  // Off-screen check on the element itself: a closed drawer with
  // `transform: translateX(100%); position: fixed; right: 0` sits just past
  // the viewport edge. Bounding rect tells us where it actually paints.
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return true;
  if (r.bottom <= 0 || r.right <= 0) return true;
  if (r.top >= win.innerHeight || r.left >= win.innerWidth) return true;
  return false;
}

// Walk down through every element at (x, y) and return the first one that's
// actually visible + selectable. Used by the Select tool to "see past"
// closed mobile overlays / hidden modals that the global pointer-events
// override would otherwise make the top hit.
export function topSelectableAt(doc, x, y) {
  if (!doc.elementsFromPoint) return null;
  const candidates = doc.elementsFromPoint(x, y);
  for (const el of candidates) {
    if (isSelectable(el, doc) && !isVisuallyHidden(el)) return el;
  }
  return null;
}

// ── Flow root & structural children ──────────────────────────────────────
// The "flow root" is the element whose children are the page's top-level
// structural items (headers, sections, footers). Future-proofs against
// designs that wrap everything in <main> or a top-level container div —
// callers get the right container without hardcoding <body>.
//
// Rules:
//   1. If <body> has exactly one direct <main> child (its usual role), the
//      flow root is that <main>.
//   2. Otherwise flow root is <body>.
export function getFlowRoot(doc) {
  if (!doc?.body) return null;
  const bodyKids = Array.from(doc.body.children).filter(isStructuralChild);
  const structuralMains = bodyKids.filter(el => el.tagName === 'MAIN');
  if (structuralMains.length === 1) return structuralMains[0];
  return doc.body;
}

// Utility / non-rendered tags that shouldn't be treated as structural.
const NON_STRUCTURAL_TAGS = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT', 'BASE', 'TITLE',
]);

// True when `el` is a valid "top-level structural item" — the kind of thing
// the user would drop a new section around. Filters out:
//   - Non-rendered utility tags (see above)
//   - Our own runtime injections (selection overlays, animation runtime,
//     code slots, insert preview) — these are chrome, not content
//   - Hidden mobile toggles / drawers (visually hidden checkboxes with 0×0 rect)
//   - Elements with display:none / visibility:hidden / opacity:0
// Keeps <header>, <section>, <footer>, <article>, <aside>, <nav>, <div>,
// custom elements, and anything else with actual layout.
export function isStructuralChild(el) {
  if (!el || !el.tagName || el.nodeType !== 1) return false;
  if (NON_STRUCTURAL_TAGS.has(el.tagName)) return false;
  if (el.hasAttribute && el.hasAttribute('hidden')) return false;
  // Hidden inputs (mobile menu checkbox pattern) — never structural.
  if (el.tagName === 'INPUT' && el.getAttribute('type') === 'hidden') return false;
  // Our own runtime injections. `__` id prefix covers selection overlays
  // (`__sel-hover`, `__sel-active`) and animation runtime (`__cinder-anim-*`).
  // `data-slot` covers code-slot injections and the insert preview label.
  // Critical because `__sel-hover` moves with the mouse — treating it as
  // structural makes the section-insert affordance chase the cursor.
  if (el.id && el.id.startsWith('__')) return false;
  if (el.hasAttribute && el.hasAttribute('data-slot')) return false;
  // Visibility check: zero rect + off-screen means it's a hidden toggle/drawer.
  // We deliberately do NOT recurse into ancestors here (isVisuallyHidden's
  // job) — the flow root's own visibility is what matters for its children.
  const win = el.ownerDocument?.defaultView;
  if (win) {
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0) return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return true;
}

// Ordered list of structural children of the flow root. Used both for the
// hover-`+` gap positioning and for locating the insertion index in the
// SAVED HTML (via getSelectorPath on the anchor child).
export function getStructuralChildren(doc) {
  const root = getFlowRoot(doc);
  if (!root) return [];
  return Array.from(root.children).filter(isStructuralChild);
}

// True when `el` sits directly under the flow root and passes the structural
// predicate. Toolbar shows Insert Above / Insert Below only for these.
export function isStructuralTopLevel(el, doc) {
  if (!el) return false;
  const root = getFlowRoot(doc);
  return !!root && el.parentElement === root && isStructuralChild(el);
}
