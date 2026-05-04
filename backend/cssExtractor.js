// Lifts inline <style> CSS out of generated HTML pages and dedupes across them.
//
// Categorization:
//   - `:root { ... }` blocks → tokens.css (emitted once)
//   - Rules that appear identically on ≥2 pages → styles.css
//   - Rules unique to a single page → pages/<name>.css
//
// Rule order within each output file follows first-seen order across pages,
// preserving cascade. At-rules (@media, @keyframes, @supports, @font-face)
// are treated as a single rule with a brace-balanced body.

export function extractAndDedupCss(pages) {
  // Parse every page's <style> block into structured rules.
  const perPage = {};
  for (const [name, html] of Object.entries(pages)) {
    perPage[name] = parsePageStyles(html);
  }

  // Build first-seen order + page-presence map across all rules.
  const order = [];
  const seen = new Map(); // key -> { prelude, body, isRoot, pages: Set }
  for (const [name, info] of Object.entries(perPage)) {
    for (const rule of info.rules) {
      const existing = seen.get(rule.key);
      if (!existing) {
        seen.set(rule.key, { prelude: rule.prelude, body: rule.body, isRoot: rule.isRoot, pages: new Set([name]) });
        order.push(rule.key);
      } else {
        existing.pages.add(name);
      }
    }
  }

  // Categorize.
  const tokensRules = [];
  const sharedRules = [];
  const pageRules = {}; // pageName -> rule[]
  let rootEmitted = false;
  for (const key of order) {
    const r = seen.get(key);
    if (r.isRoot) {
      // Emit :root once. If different pages happen to have different :root
      // contents (shouldn't, per system prompt), the first one wins.
      if (rootEmitted) continue;
      tokensRules.push(formatRule(r));
      rootEmitted = true;
      continue;
    }
    if (r.pages.size > 1) {
      sharedRules.push(formatRule(r));
    } else {
      const [only] = r.pages;
      (pageRules[only] ||= []).push(formatRule(r));
    }
  }

  const css = {};
  if (tokensRules.length) css['tokens.css'] = joinRules(tokensRules);
  if (sharedRules.length) css['styles.css'] = joinRules(sharedRules);
  for (const [name, rules] of Object.entries(pageRules)) {
    if (rules.length === 0) continue;
    const cssName = name.replace(/\.html$/i, '.css');
    css[`pages/${cssName}`] = joinRules(rules);
  }

  // Rewrite each page's HTML: strip <style> block(s), inject <link> tags.
  const rewrittenPages = {};
  for (const [name, html] of Object.entries(pages)) {
    const links = [];
    if (css['tokens.css']) links.push(`<link rel="stylesheet" href="tokens.css">`);
    if (css['styles.css']) links.push(`<link rel="stylesheet" href="styles.css">`);
    const cssName = name.replace(/\.html$/i, '.css');
    if (css[`pages/${cssName}`]) links.push(`<link rel="stylesheet" href="pages/${cssName}">`);
    rewrittenPages[name] = stripStyleBlocks(html, links);
  }

  return { pages: rewrittenPages, css };
}

// --- helpers ---

function parsePageStyles(html) {
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let combined = '';
  let m;
  while ((m = styleRe.exec(html)) !== null) {
    combined += '\n' + m[1];
  }
  if (!combined.trim()) return { rules: [] };
  return { rules: tokenizeCss(combined) };
}

function tokenizeCss(input) {
  // Strip /* ... */ comments — they're not load-bearing in production CSS
  // and trip up dedup hashing.
  const css = input.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  const n = css.length;

  while (i < n) {
    // Skip whitespace.
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;

    // Read prelude up to the next '{' at depth 0. (Selectors and at-rules
    // never contain a literal '{' outside of strings; this is a safe
    // approximation for AI-generated stylesheets.)
    const preludeStart = i;
    while (i < n && css[i] !== '{') i++;
    if (i >= n) break; // dangling text, ignore
    const prelude = css.slice(preludeStart, i).trim();
    i++; // past '{'

    // Read brace-balanced body.
    const bodyStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth === 0) break;
      i++;
    }
    const body = css.slice(bodyStart, i);
    i++; // past closing '}'

    if (!prelude) continue;

    const isRoot = /^:root\b/.test(prelude);
    const key = `${prelude.replace(/\s+/g, ' ')}{${normalizeBody(body)}}`;
    rules.push({ prelude, body, isRoot, key });
  }

  return rules;
}

// Normalize body whitespace so functionally identical rules dedupe.
function normalizeBody(body) {
  return body
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .trim();
}

function formatRule(r) {
  // Pretty-print: prelude on its own line, body indented 2 spaces per declaration.
  const decls = r.body
    .split(';')
    .map(d => d.trim())
    .filter(Boolean);
  // For at-rules with nested rule blocks (@media, @keyframes), the body holds
  // entire nested rules — splitting by ';' would mangle it. Detect by
  // presence of a '{' in the body and emit the body verbatim instead.
  if (r.body.includes('{')) {
    const indented = r.body.trim().replace(/^/gm, '  ');
    return `${r.prelude} {\n${indented}\n}`;
  }
  return `${r.prelude} {\n${decls.map(d => `  ${d};`).join('\n')}\n}`;
}

function joinRules(rules) {
  return rules.join('\n\n') + '\n';
}

function stripStyleBlocks(html, linkTags) {
  // Replace the FIRST <style> block with the link tags, drop any others.
  const styleRe = /[ \t]*<style[^>]*>[\s\S]*?<\/style>\s*/i;
  const linkBlock = linkTags.map(t => `  ${t}`).join('\n') + '\n';

  let replaced = false;
  let result = html.replace(styleRe, () => {
    replaced = true;
    return linkBlock;
  });
  // Drop any remaining <style> blocks (multi-style pages collapse to one link block).
  result = result.replace(/[ \t]*<style[^>]*>[\s\S]*?<\/style>\s*/gi, '');

  if (!replaced) {
    // No <style> existed — inject links before </head>.
    result = result.replace(/<\/head>/i, `${linkBlock}</head>`);
  }
  return result;
}
