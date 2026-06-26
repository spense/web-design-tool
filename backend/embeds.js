// Server-side embed helpers. The PREVIEW path (frontend) splices embeds
// inline into HTML so widgets render live in the iframe. The EXPORT path
// (this file's consumer) emits a sidecar `embeds.json` artifact next to
// the HTML/CSS/assets — never inline in HTML — so the design-engine can
// componentize embeds directly into Astro layouts/pages without
// regex-scraping marker blocks back out of page bodies.
//
// Schema mapping (internal → export):
//   scope: 'all'  →  scope: 'site'
//   scope: 'page' →  scope: 'pages', pages: [<filename without .html>]
//
// The export schema is owned by the design-engine team. Keep the shape
// here in lockstep with their zod validator.

export function serializeEmbedsForExport(projectEmbeds) {
  if (!Array.isArray(projectEmbeds) || projectEmbeds.length === 0) return [];
  const out = [];
  for (const e of projectEmbeds) {
    if (!e || !e.code || !e.id) continue;
    const base = {
      id: e.id,
      name: String(e.name || 'Untitled embed'),
      code: String(e.code),
    };
    if (e.scope === 'all') {
      out.push({ ...base, scope: 'site' });
    } else if (e.scope === 'page' && e.page) {
      out.push({ ...base, scope: 'pages', pages: [stripHtmlExt(e.page)] });
    }
  }
  // Stable sort by id so re-exports of unchanged projects produce a
  // byte-identical embeds.json (keeps the engine's git diff quiet).
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function stripHtmlExt(filename) {
  return String(filename).replace(/\.html?$/i, '');
}
