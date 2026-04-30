// Extract <!-- FILE: name --> labeled blocks; mirror of backend parser.
export function parseFileBlocks(text) {
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

export function detectUrl(text) {
  const m = text.match(/https?:\/\/[^\s)]+/);
  return m ? m[0] : null;
}
