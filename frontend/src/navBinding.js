// Nav-binding helpers — bridge between human-readable nav labels in the
// rendered design and the page filenames the app manages. Used by the Add
// Page picker (list unwired nav items, wire one up to a new page) and the
// Delete Page flow (restore an unwired item's `href` to `#`).
//
// Why parse, not call the model: linking a nav item to a freshly-created
// page is a deterministic structural change — no judgment required. Doing
// it inline avoids both a model round-trip (tokens, latency) and the
// failure mode where the model mis-wires href targets.

// Convert a human nav label into an HTML filename slug.
// "About Us" → "about-us.html". "Independent Living" → "independent-living.html".
// "FAQ's" → "faq-s.html". Always ends in .html, always lowercase, never empty.
export function slugifyLabel(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'page'}.html`;
}

// Normalize a nav-link's visible text for comparison: strip nested tags,
// collapse whitespace, lowercase. Two labels match iff their normalized
// forms are equal. Tolerant to icon SVGs or <span> wrappers inside links.
function normalizeLabel(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Pull every <a> inside any <nav> whose href is the placeholder "#" out of
// a page's HTML. Returns [{ label, slug }] for each unique label (first
// occurrence wins, so dropdown duplicates collapse cleanly).
//
// Only `<nav>`-scoped — body CTAs like "Learn more" that legitimately
// point to "#" are deliberately excluded so the picker doesn't list them.
export function extractUnwiredNavLinks(html) {
  if (typeof html !== 'string' || !html) return [];
  const results = [];
  const seen = new Set();
  // Walk every <nav>...</nav> block, then every <a ...>...</a> inside it.
  const navRe = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
  let navMatch;
  while ((navMatch = navRe.exec(html)) !== null) {
    const navBody = navMatch[1];
    const linkRe = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRe.exec(navBody)) !== null) {
      const attrs = linkMatch[1];
      const content = linkMatch[2];
      if (!/\bhref\s*=\s*(['"])#\1/.test(attrs)) continue;
      const labelRaw = content.replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' ');
      if (!labelRaw) continue;
      const key = labelRaw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ label: labelRaw, slug: slugifyLabel(labelRaw) });
    }
  }
  return results;
}

// Rewire every `<nav>` `<a href="#">{label}</a>` across the project to
// point to `filename`. Match is case-insensitive on the link's visible
// text (tags stripped, whitespace collapsed). Only touches `<nav>`-scoped
// links — page-body href="#" CTAs are left alone.
//
// Returns a fresh `pages` map. Pages with no matching nav link pass
// through unchanged (same object reference) to keep diffs minimal.
export function bindNavLabelInPages(pages, label, filename) {
  if (!pages || !label || !filename) return pages || {};
  const labelKey = normalizeLabel(label);
  const updated = {};
  for (const [name, html] of Object.entries(pages)) {
    if (typeof html !== 'string') { updated[name] = html; continue; }
    let touched = false;
    const next = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (navFull) => {
      return navFull.replace(/<a\s+([^>]*)>([\s\S]*?)<\/a>/gi, (aFull, attrs, content) => {
        if (!/\bhref\s*=\s*(['"])#\1/.test(attrs)) return aFull;
        const text = normalizeLabel(content);
        if (text !== labelKey) return aFull;
        const newAttrs = attrs.replace(/\bhref\s*=\s*(['"])#\1/, `href="${filename}"`);
        touched = true;
        return `<a ${newAttrs}>${content}</a>`;
      });
    });
    updated[name] = touched ? next : html;
  }
  return updated;
}

// Reverse of bindNavLabelInPages: when a picker-bound page is deleted,
// every nav `<a href="${filename}">` reverts to `<a href="#">` so the menu
// item itself is preserved (just unbound). Matching by filename means we
// don't need to know what label was used at bind time.
export function unbindNavLabelInPages(pages, filename) {
  if (!pages || !filename) return pages || {};
  const escFile = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hrefRe = new RegExp(`\\bhref\\s*=\\s*(['\"])${escFile}\\1`, 'gi');
  const updated = {};
  for (const [name, html] of Object.entries(pages)) {
    if (typeof html !== 'string') { updated[name] = html; continue; }
    let touched = false;
    const next = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (navFull) => {
      return navFull.replace(/<a\s+([^>]*)>/gi, (aFull, attrs) => {
        if (!hrefRe.test(attrs)) return aFull;
        // Reset lastIndex — RegExp with /g state persists across .test() calls.
        hrefRe.lastIndex = 0;
        const newAttrs = attrs.replace(hrefRe, 'href="#"');
        touched = true;
        return `<a ${newAttrs}>`;
      });
    });
    updated[name] = touched ? next : html;
  }
  return updated;
}
