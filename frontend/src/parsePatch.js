// Parse `<!-- EDIT: filename -->` blocks containing one or more
// `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` pairs.
//
// Returns { edits: { filename: [{search, replace}, ...] }, prose: "..." }
//
// Prose is whatever text sits outside any EDIT block.
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
  // Match: <<<<<<< SEARCH \n ... \n ======= \n ... \n >>>>>>> REPLACE
  // Allow flexibility on the exact angle-bracket count (5+) so a model that
  // emits 7 instead of 7 won't break us.
  const re = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={3,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;
  const pairs = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    pairs.push({ search: m[1], replace: m[2] });
  }
  return pairs;
}

// Apply edits to a map of pages. Returns:
//   { updatedPages, applied: { filename: count }, failed: [{filename, search}] }
// If any patch fails for a file, that file is left UNCHANGED (atomic per file).
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
  // 1. Try exact literal match.
  const idx = haystack.indexOf(search);
  if (idx !== -1) {
    return haystack.slice(0, idx) + replace + haystack.slice(idx + search.length);
  }
  // 2. Whitespace-normalized fallback: collapse runs of whitespace in both
  //    haystack and search, find a match, then map the indices back.
  const normSearch = search.replace(/\s+/g, ' ').trim();
  if (!normSearch) return null;
  // Build a parallel-index normalized version of haystack so we can map back.
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

  // 3. Line-based fuzzy match: when the model misremembers a few characters
  //    (e.g. a CSS value or attribute), find the best contiguous block of
  //    lines where most lines match after trimming.
  return tryFuzzyLineMatch(haystack, search, replace);
}

function tryFuzzyLineMatch(haystack, search, replace) {
  const searchLines = search.split('\n');
  const haystackLines = haystack.split('\n');
  const searchTrimmed = searchLines.map(l => l.trim());
  const haystackTrimmed = haystackLines.map(l => l.trim());

  // Need at least 2 non-empty search lines to anchor reliably.
  const nonEmpty = searchTrimmed.filter(Boolean);
  if (nonEmpty.length < 2) return null;

  const firstAnchor = nonEmpty[0];
  const len = searchTrimmed.length;
  let bestStart = -1;
  let bestScore = 0;

  for (let i = 0; i <= haystackTrimmed.length - len; i++) {
    // First non-empty search line must appear at the right offset to anchor.
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

// Detect whether a partial stream contains an EDIT block — used for the
// "Applying edits…" status indicator.
export function detectEditStart(text) {
  return /<!--\s*EDIT:|<!--\s*REGION:/i.test(text);
}

export function editStartIndex(text) {
  const m = text.match(/<!--\s*EDIT:|<!--\s*REGION:/i);
  return m ? m.index : -1;
}

// Index of the first design-emitting marker of ANY kind (FILE/EDIT/REGION/INLINE),
// or -1 if none present. Used to tell a real design response apart from an
// answer-only reply (a question/explanation that emits no markers).
export function designStartIndex(text) {
  const m = text.match(/<!--\s*(?:FILE|EDIT|REGION|INLINE):/i);
  return m ? m.index : -1;
}

// Parse `<!-- REGION: <target> in <files> -->\n<content>\n<!-- /REGION -->` blocks.
// Targets: 'header' | 'footer' | 'nav' | 'root'.
// Files: comma-separated bare filenames OR '*.html' / '*' wildcard.
export function parseRegionBlocks(text) {
  const re = /<!--\s*REGION:\s*(header|footer|nav|root)\s+in\s+([^>]+?)\s*-->\s*([\s\S]*?)\s*<!--\s*\/REGION\s*-->/gi;
  const regions = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1].toLowerCase();
    const files = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const content = m[3];
    regions.push({ target, files, content });
  }
  return regions;
}

function expandFileList(patterns, allFiles) {
  const out = new Set();
  for (const p of patterns) {
    if (p === '*' || p === '*.html') {
      for (const f of allFiles) if (f.endsWith('.html')) out.add(f);
    } else {
      out.add(p);
    }
  }
  return [...out];
}

// Apply parsed REGION blocks to a map of pages. Returns:
//   { updatedPages, applied: { filename: count }, failed: [{filename, target, reason}] }
// Failure reasons: 'not_found' (file missing), 'no_region' (target element not in file).
export function applyRegions(currentPages, regions) {
  const updatedPages = { ...currentPages };
  const applied = {};
  const failed = [];

  for (const { target, files, content } of regions) {
    const targetFiles = expandFileList(files, Object.keys(updatedPages));
    for (const filename of targetFiles) {
      const original = updatedPages[filename];
      if (original == null) {
        failed.push({ filename, target, reason: 'not_found' });
        continue;
      }
      const result = replaceRegion(original, target, content);
      if (result == null) {
        failed.push({ filename, target, reason: 'no_region' });
        continue;
      }
      // Truncation guard: a region body dramatically shorter than what it
      // replaces almost certainly means the model abbreviated (placeholder
      // comments, dropped items). Reject so the user gets a clear failure
      // message rather than a silently-mangled page.
      const newLen = content.trim().length;
      const oldLen = result.replacedLength;
      if (oldLen > 200 && newLen < oldLen * 0.5) {
        failed.push({ filename, target, reason: 'truncated', oldLen, newLen });
        continue;
      }
      updatedPages[filename] = result.updated;
      applied[filename] = (applied[filename] || 0) + 1;
    }
  }
  return { updatedPages, applied, failed };
}

function replaceRegion(html, target, newContent) {
  if (target === 'root') {
    const re = /(:root\s*\{)([^}]*)(\})/;
    const m = html.match(re);
    if (!m) return null;
    const updated = html.replace(re, (_, open, _body, close) => `${open}\n${newContent}\n${close}`);
    return { updated, replacedLength: m[2].length };
  }
  return replaceFirstElement(html, target, newContent);
}

// Replace the first balanced occurrence of <tag>...</tag>, honoring nesting.
// Returns { updated, replacedLength } so callers can sanity-check that the new
// content is roughly the same scale as the original.
function replaceFirstElement(html, tag, newContent) {
  const openPattern = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi');
  const closePattern = new RegExp(`</${tag}\\s*>`, 'gi');
  const firstOpen = openPattern.exec(html);
  if (!firstOpen) return null;
  const start = firstOpen.index;
  let depth = 1;
  let pos = firstOpen.index + firstOpen[0].length;
  while (depth > 0) {
    openPattern.lastIndex = pos;
    closePattern.lastIndex = pos;
    const o = openPattern.exec(html);
    const c = closePattern.exec(html);
    if (!c) return null;
    if (o && o.index < c.index) {
      depth++;
      pos = o.index + o[0].length;
    } else {
      depth--;
      pos = c.index + c[0].length;
      if (depth === 0) {
        return {
          updated: html.slice(0, start) + newContent + html.slice(pos),
          replacedLength: pos - start,
        };
      }
    }
  }
  return null;
}

// ─── INLINE blocks (mirror of backend/parsePatch.js INLINE helpers) ────────

const INLINE_HEADER_RE = /<!--\s*INLINE:\s*([0-9.]+)\s+in\s+([^\s>]+)\s*-->/gi;
// Only OUR marker comments terminate an INLINE block. Arbitrary HTML comments
// inside the element body (e.g. inside an SVG) must not terminate it early.
const MARKER_RE = /<!--\s*(?:INLINE|FILE|EDIT|REGION|PAGES):/gi;

export function parseInlineBlocks(text) {
  const headers = [];
  INLINE_HEADER_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_HEADER_RE.exec(text)) !== null) {
    headers.push({
      path: m[1].trim(),
      filename: m[2].trim(),
      contentStart: m.index + m[0].length,
    });
  }
  if (headers.length === 0) return [];

  const blocks = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].contentStart;
    MARKER_RE.lastIndex = start;
    const next = MARKER_RE.exec(text);
    const end = next ? next.index : text.length;
    const markup = text.slice(start, end).trim();
    blocks.push({ path: headers[i].path, filename: headers[i].filename, markup });
  }
  return blocks;
}

// Strip code-execution vectors from an inline replacement element while
// leaving legitimate embeds (iframe maps/video, etc.) intact. Mutates in place.
// Removes <script>/<foreignObject> descendants, on* event-handler attributes,
// and javascript: URLs from href/src/xlink:href.
function sanitizeInlineMarkup(root) {
  const DROP = new Set(['SCRIPT', 'FOREIGNOBJECT']);
  const clean = (el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) {
      if (DROP.has(child.tagName.toUpperCase())) { child.remove(); continue; }
      clean(child);
    }
  };
  clean(root);
}

// Apply a single INLINE block to a page's HTML string. Returns null on any
// of: path doesn't resolve, markup has zero/multiple roots. The replacement
// may change the root tag (e.g. an <a> swapped for an <iframe> embed).
export function applyInlineToPage(pageHtml, path, newMarkup) {
  if (!pageHtml || !path) return null;
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html');
  if (!doc?.body) return null;

  const indices = path.split('.').map(Number);
  if (indices.some(n => Number.isNaN(n))) return null;
  let node = doc.body;
  for (const idx of indices) {
    if (!node?.children?.[idx]) return null;
    node = node.children[idx];
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = newMarkup;
  const roots = Array.from(tmp.children);
  if (roots.length !== 1) return null;
  const fresh = roots[0];
  // The replacement is usually the same tag as the target, but inline edits may
  // intentionally swap the element for a different type — e.g. replacing an
  // <a> "Open in Google Maps" link with an <iframe> map embed. The positional
  // selector path already pins the exact element to replace, so a tag change is
  // safe to honor. Strip only genuinely unsafe nodes/attrs (scripts, inline
  // event handlers, javascript: URLs); iframes/embeds are allowed.
  sanitizeInlineMarkup(fresh);

  node.replaceWith(fresh);
  const m = pageHtml.match(/^\s*(<!doctype[^>]*>)/i);
  const doctype = m ? m[1] : '<!DOCTYPE html>';
  return `${doctype}\n${doc.documentElement.outerHTML}`;
}

export function applyInlineBlocks(currentPages, blocks) {
  const updatedPages = { ...currentPages };
  const applied = [];
  const failed = [];
  for (const b of blocks) {
    const src = updatedPages[b.filename];
    if (!src) { failed.push({ ...b, reason: 'not_found' }); continue; }
    const next = applyInlineToPage(src, b.path, b.markup);
    if (next == null) { failed.push({ ...b, reason: 'no_match' }); continue; }
    updatedPages[b.filename] = next;
    applied.push({ filename: b.filename, path: b.path });
  }
  return { updatedPages, applied, failed };
}
