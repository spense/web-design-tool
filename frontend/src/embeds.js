// Resolve and splice user-defined embed snippets (third-party scripts,
// widgets, iframes) into page HTML. Source of truth lives on `project.embeds`;
// pages.json never carries embed markup. Used by the preview to render embeds
// live in the iframe and by the backend export to inject them at write time.
//
// Keep this file structurally in sync with backend/embeds.js — same shape,
// same behavior. The duplication is intentional (Vite frontend / Node backend
// can't share the same source without a shared package).

export const EMBED_SCOPE_ALL = 'all';
export const EMBED_SCOPE_PAGE = 'page';
export const EMBED_POSITION_BODY_END = 'body-end';

export function resolveEmbedsForPage(embeds, pageName) {
  if (!Array.isArray(embeds) || !pageName) return [];
  return embeds.filter(e =>
    e && (e.scope === EMBED_SCOPE_ALL || (e.scope === EMBED_SCOPE_PAGE && e.page === pageName))
  );
}

export function injectEmbeds(html, embeds) {
  if (!html || !embeds?.length) return html;

  const bodyEnd = embeds
    .filter(e => (e.position || EMBED_POSITION_BODY_END) === EMBED_POSITION_BODY_END && e.code)
    .map(wrap)
    .join('\n');

  if (!bodyEnd) return html;

  // lastIndexOf — defends against a literal "</body>" appearing inside a
  // <pre>/<code> example block. The real closing tag is always last.
  const idx = html.toLowerCase().lastIndexOf('</body>');
  return idx === -1
    ? html + '\n' + bodyEnd + '\n'
    : html.slice(0, idx) + bodyEnd + '\n' + html.slice(idx);
}

function wrap(e) {
  const name = escapeComment(e.name || 'unnamed');
  return `<!-- embed:${e.id} ${name} -->\n${e.code}\n<!-- /embed:${e.id} -->`;
}

function escapeComment(s) {
  // HTML comments cannot contain "--"; collapse to an en-dash so the marker
  // remains a single valid comment node.
  return String(s).replace(/--/g, '–');
}

export function newEmbedId() {
  return 'em_' + Math.random().toString(36).slice(2, 10);
}
