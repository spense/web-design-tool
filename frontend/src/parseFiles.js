// Extract <!-- FILE: name --> labeled blocks; mirror of backend parser.
// Falls back to detecting raw <!DOCTYPE html>...</html> documents when the
// model skips the FILE: marker, so HTML never leaks into chat prose.
export function parseFileBlocks(text) {
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
  const re = /<!--\s*FILE:\s*([^\s>-]+)\s*-->/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ filename: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  if (matches.length === 0) return { files: {}, prose: text.trim() };
  const prose = text.slice(0, matches[0].start).trim();
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let content = text.slice(matches[i].contentStart, end).trim();
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
    files[matches[i].filename] = content;
  }
  return { files, prose };
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

export function detectUrl(text) {
  const m = text.match(/https?:\/\/[^\s)]+/);
  return m ? m[0] : null;
}
