// Validate + sanitize an HTML fragment returned by the model for the
// inline "Prompt change" action.
//
// Returns:
//   { ok: true, element: HTMLElement, markup: string } on success
//   { ok: false, error: string }                        on failure
//
// Failure modes:
//   - parse error
//   - zero or multiple root elements
//   - root tag doesn't match `expectedTag` (case-insensitive)
// Sanitization (silent — does not fail):
//   - drop <script>, <iframe>, <object>, <embed>, <foreignObject>
//   - strip on* event handlers from all elements
//   - strip javascript: from href / src / xlink:href

const DROP_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FOREIGNOBJECT',
]);

export function validateAndSanitizeHtml(input, expectedTag) {
  if (!input || typeof input !== 'string') {
    return { ok: false, error: 'No HTML provided' };
  }
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Empty input' };

  const doc = new DOMParser().parseFromString(trimmed, 'text/html');
  if (!doc?.body) return { ok: false, error: 'Parse failed' };

  // The fragment lives in body. Count actual element children (ignore
  // whitespace text nodes — they're noise, not extra roots).
  const rootChildren = Array.from(doc.body.children);
  if (rootChildren.length === 0) {
    return { ok: false, error: 'No element found in response' };
  }
  if (rootChildren.length > 1) {
    return { ok: false, error: `Expected one root element, got ${rootChildren.length}` };
  }

  const root = rootChildren[0];
  if (expectedTag && root.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
    return {
      ok: false,
      error: `Expected <${expectedTag.toLowerCase()}>, got <${root.tagName.toLowerCase()}>`,
    };
  }

  // Walk and clean.
  const cleanAttrs = (el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  };
  const walk = (node) => {
    cleanAttrs(node);
    const kids = Array.from(node.children);
    for (const child of kids) {
      if (DROP_TAGS.has(child.tagName.toUpperCase())) {
        child.remove();
        continue;
      }
      walk(child);
    }
  };
  walk(root);

  return { ok: true, element: root, markup: root.outerHTML };
}
