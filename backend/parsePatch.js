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

export function parseRegionBlocks(text) {
  const re = /<!--\s*REGION:\s*(header|footer|nav|root)\s+in\s+([^>]+?)\s*-->\s*([\s\S]*?)\s*<!--\s*\/REGION\s*-->/gi;
  const regions = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    regions.push({
      target: m[1].toLowerCase(),
      files: m[2].split(',').map(s => s.trim()).filter(Boolean),
      content: m[3],
    });
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
      // Truncation guard: if the model emitted a region body that's much shorter
      // than what it's replacing, it almost certainly abbreviated mid-element
      // (placeholder comments, dropped nav items, etc.). Reject and let the
      // backend's auto-recovery loop force a FULL FILE rewrite instead.
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

// ─── INLINE blocks: scoped single-element edits from inline-edit toolbar ───
//
// Format emitted by the model:
//   <!-- INLINE: <selectorPath> in <page> -->
//   <element ...>...</element>
//
// `selectorPath` is dot-joined nth-child indices from <body> down (e.g. "1.0.3").
// Block ends at the next HTML comment marker (or end of text). Only ONE root
// element is allowed inside the block.

import { load as loadCheerio } from 'cheerio';

const INLINE_HEADER_RE = /<!--\s*INLINE:\s*([0-9.]+)\s+in\s+([^\s>]+)\s*-->/gi;
// Only OUR marker comments terminate an INLINE block. Arbitrary HTML comments
// inside the element body (e.g. inside an SVG) must not terminate it early.
const MARKER_RE = /<!--\s*(?:INLINE|FILE|EDIT|REGION|PAGES):/gi;

export function parseInlineBlocks(text) {
  const headers = [];
  let m;
  INLINE_HEADER_RE.lastIndex = 0;
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

// Apply a single INLINE block to a page's HTML string. Returns null if the
// path doesn't resolve, if the markup parses to zero/multiple roots, or if
// the root tag doesn't match the existing element's tag.
export function applyInlineToPage(pageHtml, path, newMarkup) {
  if (!pageHtml || !path) return null;
  const $ = loadCheerio(pageHtml, { decodeEntities: false });

  // Resolve the selector path against <body>.
  const indices = path.split('.').map(Number);
  if (indices.some(n => Number.isNaN(n))) return null;
  let node = $('body')[0];
  if (!node) return null;
  for (const idx of indices) {
    const children = node.children.filter(c => c.type === 'tag');
    if (!children[idx]) return null;
    node = children[idx];
  }
  // Parse the new markup; insist on a single root element with matching tag.
  const $new = loadCheerio(newMarkup, { decodeEntities: false });
  const newRoots = $new('body').children().filter((_, el) => el.type === 'tag').toArray();
  if (newRoots.length !== 1) return null;
  const newRoot = newRoots[0];
  if (newRoot.tagName !== node.tagName) return null;

  $(node).replaceWith($(newRoot));
  // Cheerio's $.html() preserves doctype if present.
  return $.html();
}

// Apply all INLINE blocks. Returns { updatedPages, applied, failed }.
export function applyInlineBlocks(currentPages, blocks) {
  const updatedPages = { ...currentPages };
  const applied = [];
  const failed = [];
  for (const b of blocks) {
    const src = updatedPages[b.filename];
    if (!src) { failed.push({ ...b, reason: 'not_found' }); continue; }
    const next = applyInlineToPage(src, b.path, b.markup);
    if (next == null) { failed.push({ ...b, reason: 'no_match_or_tag' }); continue; }
    updatedPages[b.filename] = next;
    applied.push({ filename: b.filename, path: b.path });
  }
  return { updatedPages, applied, failed };
}
