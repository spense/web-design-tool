// Parse and rewrite the `:root { --token: value; }` block in an HTML string.

const ROOT_BLOCK_RE = /(:root\s*\{)([\s\S]*?)(\})/i;

// Extract the current tokens from the first :root block in the HTML.
// Returns null if no :root block is found.
export function extractTokens(html) {
  if (!html) return null;
  const m = html.match(ROOT_BLOCK_RE);
  if (!m) return null;
  const body = m[2];
  const tokens = {};
  // Match `--name: value;` allowing values that contain semicolons inside ()
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    tokens[`--${match[1]}`] = match[2].trim();
  }
  return tokens;
}

// Returns true if the HTML has a usable :root token block (>= 4 vars).
export function hasTokenContract(html) {
  const t = extractTokens(html);
  return t && Object.keys(t).length >= 4;
}

// Replace the :root block with one built from the new token map.
// Tokens not in `nextTokens` are preserved from the existing block.
export function applyTokens(html, nextTokens) {
  if (!html || !nextTokens) return html;
  const m = html.match(ROOT_BLOCK_RE);
  if (!m) return html;
  const existing = extractTokens(html) || {};
  const merged = { ...existing, ...nextTokens };
  const body = '\n' + Object.entries(merged)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n') + '\n';
  return html.replace(ROOT_BLOCK_RE, `$1${body}$3`);
}

// Update or insert the Google Fonts <link> tag in <head>.
// `googleFontsQuery` is the part after `family=` (e.g. "Inter:wght@400;700").
// Pass null to leave the existing link alone.
export function updateGoogleFontsLink(html, googleFontsQuery) {
  if (!html || googleFontsQuery == null) return html;
  const newHref = `https://fonts.googleapis.com/css2?family=${googleFontsQuery}&display=swap`;
  const newLink = `<link rel="stylesheet" href="${newHref}">`;

  // Replace existing google fonts link(s)
  if (/<link[^>]*fonts\.googleapis\.com[^>]*>/i.test(html)) {
    return html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/gi, '');
    // Re-run with insertion below — we just stripped any existing.
  }
  return insertIntoHead(html, newLink);
}

// Two-step: strip existing google fonts then insert fresh.
export function setGoogleFonts(html, googleFontsQuery) {
  if (!html || googleFontsQuery == null) return html;
  const stripped = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/gi, '')
                       .replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/gi, '');
  const newHref = `https://fonts.googleapis.com/css2?family=${googleFontsQuery}&display=swap`;
  const preconnect = `<link rel="preconnect" href="https://fonts.googleapis.com">`;
  const preconnect2 = `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`;
  const newLink = `<link rel="stylesheet" href="${newHref}">`;
  return insertIntoHead(stripped, `${preconnect}\n  ${preconnect2}\n  ${newLink}`);
}

function insertIntoHead(html, snippet) {
  // Insert just before </head>
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `  ${snippet}\n</head>`);
  }
  // Fallback: prepend
  return snippet + '\n' + html;
}

// Apply a token+font transformation across all pages of a project.
//   pages: { filename: html }
//   patch: { tokens?: {...}, googleFonts?: 'Inter:wght@...' }
export function applyToAllPages(pages, patch) {
  const out = {};
  for (const [name, html] of Object.entries(pages)) {
    let next = html;
    if (patch.tokens) next = applyTokens(next, patch.tokens);
    if (patch.googleFonts) next = setGoogleFonts(next, patch.googleFonts);
    out[name] = next;
  }
  return out;
}
