// Mirror of frontend/src/parsePatch.js — kept in sync so the orchestrator can
// detect patch failures on the server and auto-recover with a FULL FILE MODE
// follow-up turn. If you change one, change the other.

export function parsePatchBlocks(text) {
  const editHeader = /<!--\s*EDIT:\s*([^\s>]+)\s*-->/gi;
  const headers = [];
  let m;
  while ((m = editHeader.exec(text)) !== null) {
    headers.push({ filename: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  if (headers.length === 0) return { edits: {}, prose: text.trim() };

  const edits = {};
  const proseParts = [text.slice(0, headers[0].start)];

  for (let i = 0; i < headers.length; i++) {
    const end = i + 1 < headers.length ? headers[i + 1].start : text.length;
    const body = text.slice(headers[i].contentStart, end);
    const pairs = parseSearchReplacePairs(body);
    if (!edits[headers[i].filename]) edits[headers[i].filename] = [];
    edits[headers[i].filename].push(...pairs);
  }
  return { edits, prose: proseParts.join('').trim() };
}

function parseSearchReplacePairs(text) {
  const re = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={3,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;
  const pairs = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    pairs.push({ search: m[1], replace: m[2] });
  }
  return pairs;
}

export function applyPatches(currentPages, edits) {
  const updatedPages = { ...currentPages };
  const applied = {};
  const failed = [];

  for (const [filename, patches] of Object.entries(edits)) {
    const original = currentPages[filename];
    if (original == null) {
      failed.push({ filename, search: '(file does not exist)', reason: 'not_found' });
      continue;
    }
    let working = original;
    let allOk = true;
    for (const { search, replace } of patches) {
      const next = applyOne(working, search, replace);
      if (next == null) {
        failed.push({ filename, search, reason: 'no_match' });
        allOk = false;
        break;
      }
      working = next;
    }
    if (allOk) {
      updatedPages[filename] = working;
      applied[filename] = patches.length;
    }
  }

  return { updatedPages, applied, failed };
}

function applyOne(haystack, search, replace) {
  const idx = haystack.indexOf(search);
  if (idx !== -1) {
    return haystack.slice(0, idx) + replace + haystack.slice(idx + search.length);
  }
  const normSearch = search.replace(/\s+/g, ' ').trim();
  if (!normSearch) return null;
  const map = [];
  let normHaystack = '';
  let inWs = false;
  for (let i = 0; i < haystack.length; i++) {
    const c = haystack[i];
    if (/\s/.test(c)) {
      if (!inWs) {
        if (normHaystack.length > 0) {
          normHaystack += ' ';
          map.push(i);
        }
        inWs = true;
      }
    } else {
      normHaystack += c;
      map.push(i);
      inWs = false;
    }
  }
  const normIdx = normHaystack.indexOf(normSearch);
  if (normIdx !== -1) {
    const startOrig = map[normIdx];
    const endOrig = map[normIdx + normSearch.length - 1] + 1;
    return haystack.slice(0, startOrig) + replace + haystack.slice(endOrig);
  }
  return tryFuzzyLineMatch(haystack, search, replace);
}

function tryFuzzyLineMatch(haystack, search, replace) {
  const searchLines = search.split('\n');
  const haystackLines = haystack.split('\n');
  const searchTrimmed = searchLines.map(l => l.trim());
  const haystackTrimmed = haystackLines.map(l => l.trim());

  const nonEmpty = searchTrimmed.filter(Boolean);
  if (nonEmpty.length < 2) return null;

  const firstAnchor = nonEmpty[0];
  const len = searchTrimmed.length;
  let bestStart = -1;
  let bestScore = 0;

  for (let i = 0; i <= haystackTrimmed.length - len; i++) {
    const anchorOffset = searchTrimmed.indexOf(firstAnchor);
    if (haystackTrimmed[i + anchorOffset] !== firstAnchor) continue;
    let matches = 0;
    let total = 0;
    for (let j = 0; j < len; j++) {
      if (!searchTrimmed[j] && !haystackTrimmed[i + j]) continue;
      total++;
      if (searchTrimmed[j] === haystackTrimmed[i + j]) matches++;
    }
    const score = total > 0 ? matches / total : 0;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  if (bestScore < 0.6 || bestStart === -1) return null;
  const before = haystackLines.slice(0, bestStart);
  const after = haystackLines.slice(bestStart + len);
  return [...before, replace, ...after].join('\n');
}
