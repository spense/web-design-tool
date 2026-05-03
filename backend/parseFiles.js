// Parse `<!-- FILE: name.ext -->` labeled blocks out of an assistant message.
// Falls back to detecting raw `<!DOCTYPE html>...</html>` documents when the
// model omits the FILE marker.
export function parseFileBlocks(text) {
  const labeled = parseLabeled(text);
  if (Object.keys(labeled.files).length > 0) return labeled;

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
  const prose = text.slice(0, matches[0].start).trim();
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let content = text.slice(matches[i].contentStart, end).trim();
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
    files[matches[i].filename] = content;
  }
  return { files, prose };
}

function extractRawHtmlDocs(text) {
  const docs = [];
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
