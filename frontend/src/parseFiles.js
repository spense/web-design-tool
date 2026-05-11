// Extract <!-- FILE: name --> labeled blocks; mirror of backend parser.
// Falls back to detecting raw <!DOCTYPE html>...</html> documents when the
// model skips the FILE: marker, so HTML never leaks into chat prose.
export function parseFileBlocks(text) {
  // Strip the multi-page `<!-- PAGES: ... -->` directive — it's a hint to the
  // backend orchestrator, not user-facing prose.
  text = text.replace(/<!--\s*PAGES:[^>]*-->\s*/i, '');
  const labeled = parseLabeled(text);
  if (Object.keys(labeled.files).length > 0) return labeled;

  // No labels — fall back to extracting raw HTML documents.
  const raw = extractRawHtmlDocs(text);
  if (raw.docs.length === 0) return { files: {}, prose: text.trim() };

  const files = {};
  raw.docs.forEach((html, i) => {
    const name = i === 0 ? 'index.html' : `page-${i + 1}.html`;
    files[name] = html;
  });
  return { files, prose: raw.prose };
}

function parseLabeled(text) {
  const files = {};
  const re = /<!--\s*FILE:\s*([^\s>]+)\s*-->/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ filename: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  if (matches.length === 0) return { files: {}, prose: text.trim() };
  const proseParts = [text.slice(0, matches[0].start)];
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let content = text.slice(matches[i].contentStart, end).trim();
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
    // If the model wrote commentary after </html>, split it off so it doesn't
    // contaminate the file content (and break completeness checks).
    const closeMatch = content.match(/<\/html\s*>/i);
    if (closeMatch) {
      const cutAt = closeMatch.index + closeMatch[0].length;
      const trailing = content.slice(cutAt).trim();
      content = content.slice(0, cutAt);
      if (trailing) proseParts.push('\n' + trailing);
    }
    files[matches[i].filename] = content;
  }
  return { files, prose: proseParts.join('').trim() };
}

// Extract one or more `<!DOCTYPE html>...</html>` (or `<html>...</html>`) docs.
// Returns docs in order plus the prose with those segments removed.
function extractRawHtmlDocs(text) {
  const docs = [];
  let working = text;
  // Match optional ```html fence wrapping, DOCTYPE/html opening, through </html>
  const re = /(?:```(?:html)?\s*\n)?(<!DOCTYPE\s+html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)\s*(?:```)?/gi;
  let lastIdx = 0;
  const proseParts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    proseParts.push(text.slice(lastIdx, m.index));
    docs.push(m[1].trim());
    lastIdx = m.index + m[0].length;
  }
  proseParts.push(text.slice(lastIdx));
  return { docs, prose: proseParts.join('').trim() };
}

// Detect that an HTML doc has *started* in a partial stream — used to switch
// the streaming UI to the "Generating design" spinner.
export function detectHtmlStart(text) {
  return /<!--\s*FILE:|<!DOCTYPE\s+html|<html[\s>]|```html/i.test(text);
}

// Return the index where HTML output begins, so prose before it can still show.
export function htmlStartIndex(text) {
  const match = text.match(/<!--\s*FILE:|<!DOCTYPE\s+html|<html[\s>]|```html/i);
  return match ? match.index : -1;
}

// Index where ANY generation marker (FULL FILE or PATCH) begins. Used to
// trim the streaming preview so HTML/SEARCH-REPLACE never shows in chat.
export function generationStartIndex(text) {
  const match = text.match(/<!--\s*EDIT:|<!--\s*FILE:|<!DOCTYPE\s+html|<html[\s>]|```html|<{5,}\s*SEARCH/i);
  return match ? match.index : -1;
}

// A FULL FILE emit is only safe to persist if it parses as a complete HTML
// document — has a body and a closing </html>. Truncated streams (max_tokens
// hit mid-output) leave a head-only stub that overwrites a previously good
// file with something the browser renders blank.
export function isCompleteHtmlDoc(html) {
  if (!html || typeof html !== 'string') return false;
  const s = html.trim();
  if (!/<\/html\s*>\s*$/i.test(s)) return false;
  if (!/<body[\s>]/i.test(s)) return false;
  return true;
}

export function detectUrl(text) {
  const m = text.match(/https?:\/\/[^\s)]+/);
  return m ? m[0] : null;
}
