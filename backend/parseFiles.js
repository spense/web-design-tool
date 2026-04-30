// Parse `<!-- FILE: name.ext -->` labeled blocks out of an assistant message.
// Returns { files: { name: content }, prose: "text outside file blocks" }.
export function parseFileBlocks(text) {
  const files = {};
  const re = /<!--\s*FILE:\s*([^\s>-]+)\s*-->/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ filename: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  if (matches.length === 0) {
    return { files: {}, prose: text.trim() };
  }
  const proseParts = [text.slice(0, matches[0].start)];
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    let content = text.slice(matches[i].contentStart, end).trim();
    // strip leading/trailing ``` fences if model wrapped output
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '');
    files[matches[i].filename] = content;
  }
  return { files, prose: proseParts.join('').trim() };
}
