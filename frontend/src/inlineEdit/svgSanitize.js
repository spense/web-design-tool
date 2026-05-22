// Safely parse and sanitize SVG markup before inserting into the iframe.
// Strips <script>, <foreignObject>, and any on* event-handler attributes.
// Validates the parse and ensures there's exactly one root <svg>.
//
// Returns { ok: true, svg: HTMLElement } on success
//      or { ok: false, error: string } on failure.

const DROP_TAGS = new Set(['SCRIPT', 'FOREIGNOBJECT']);

export function sanitizeSvg(input) {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: 'No SVG provided' };
  }
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Empty input' };

  // Parse as XML so we can detect parserror cleanly.
  const doc = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) {
    return { ok: false, error: 'Invalid SVG markup' };
  }

  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    return { ok: false, error: 'Top-level element must be <svg>' };
  }

  // Walk the tree, dropping disallowed elements and on* attributes.
  const walk = (node) => {
    // Iterate over a snapshot since we mutate children mid-loop.
    const kids = Array.from(node.children || []);
    for (const child of kids) {
      if (DROP_TAGS.has(child.tagName.toUpperCase())) {
        child.remove();
        continue;
      }
      // Strip event handlers and javascript: in href/xlink:href.
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          child.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'xlink:href') &&
            /^\s*javascript:/i.test(attr.value)) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(root);

  return { ok: true, svg: root };
}
