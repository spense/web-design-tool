// Lenient validators for user-authored HTML, CSS, and JS snippets. Return
// { ok: true } on success or { ok: false, message, line? } on failure.
//
// Philosophy: catch things that would break the page (unclosed tags, invalid
// CSS syntax, JS syntax errors). Do NOT enforce standards-mode HTML rules,
// vendor prefixes, or cross-browser hygiene. Custom elements, data attributes,
// and unknown properties are all valid.

// ─── HTML ───────────────────────────────────────────────────────────────────
// Custom tokenizer + balance checker. We can't use htmlparser2's Parser
// directly for validation — it applies HTML5 error recovery and silently
// "auto-corrects" mismatched closes so typos like `</dv>` never surface.
// Instead, we walk the source ourselves:
//   - Comments, doctypes, and CDATA are skipped.
//   - Script/style/textarea/title contents are treated as raw text; their
//     inner "tags" are ignored until the matching close.
//   - Void tags (<img>, <br>, …) don't need closes.
//   - AUTO_CLOSE_SAME tags close their previous same-name sibling on the
//     next open (`<li>a<li>b</li>` is valid — the first `<li>` implicitly
//     closes before the second opens).
//   - Anything else must be closed by a matching close tag in the correct
//     order — mismatch → error.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
// HTML5 tags where opening a same-name sibling implicitly closes the current one.
// Keeps common list/table markup like `<li>a<li>b</li>` from tripping the checker.
const AUTO_CLOSE_SAME = new Set([
  'li', 'dt', 'dd', 'option', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
  'optgroup', 'colgroup', 'p',
]);

export function validateHtml(input) {
  const src = String(input || '');
  if (!src.trim()) return { ok: true };
  const len = src.length;

  const stack = [];   // { name, line }
  let i = 0;
  let line = 1;

  const bumpTo = (target) => {
    while (i < target) {
      if (src[i] === '\n') line++;
      i++;
    }
  };

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { bumpTo(len); break; }
    bumpTo(lt);

    // Comment.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) return { ok: false, message: 'Unterminated comment', line };
      bumpTo(end + 3);
      continue;
    }
    // Doctype / CDATA / other <! declarations.
    if (src[lt + 1] === '!') {
      const end = src.indexOf('>', lt + 2);
      if (end === -1) return { ok: false, message: 'Unterminated declaration', line };
      bumpTo(end + 1);
      continue;
    }
    // Processing instruction <?xml … ?>
    if (src[lt + 1] === '?') {
      const end = src.indexOf('>', lt + 2);
      if (end === -1) return { ok: false, message: 'Unterminated <? …', line };
      bumpTo(end + 1);
      continue;
    }

    const isClose = src[lt + 1] === '/';
    const nameStart = lt + (isClose ? 2 : 1);
    let ni = nameStart;
    while (ni < len && isTagNameChar(src[ni])) ni++;
    const name = src.slice(nameStart, ni).toLowerCase();

    // '<' not followed by a valid tag name → treat as literal text.
    if (!name) {
      bumpTo(lt + 1);
      continue;
    }

    // Walk to '>' (respecting quoted attr values).
    let ai = ni;
    let selfClose = false;
    while (ai < len) {
      const c = src[ai];
      if (c === '"' || c === "'") {
        const q = c; ai++;
        while (ai < len && src[ai] !== q) ai++;
        if (ai >= len) break;
        ai++;
        continue;
      }
      if (c === '/' && src[ai + 1] === '>') { selfClose = true; ai++; break; }
      if (c === '>') break;
      ai++;
    }
    if (ai >= len) {
      return { ok: false, message: `Unterminated tag <${name}>`, line };
    }
    const tagLine = line;
    bumpTo(ai + 1);

    if (isClose) {
      if (VOID_TAGS.has(name)) continue;
      const top = stack[stack.length - 1];
      if (!top) {
        return { ok: false, message: `Unexpected closing tag </${name}> — nothing to close`, line: tagLine };
      }
      if (top.name !== name) {
        return {
          ok: false,
          message: `Mismatched closing tag: expected </${top.name}>, got </${name}>`,
          line: tagLine,
        };
      }
      stack.pop();
      continue;
    }

    // Opening tag.
    if (VOID_TAGS.has(name) || selfClose) continue;

    // Auto-close a same-name sibling if this tag is in the auto-close set.
    if (AUTO_CLOSE_SAME.has(name) && stack.length > 0 && stack[stack.length - 1].name === name) {
      stack.pop();
    }

    if (RAW_TEXT_TAGS.has(name)) {
      // Scan for </name> (case-insensitive) and skip the entire raw block.
      const rest = src.slice(i);
      const closeRe = new RegExp(`</${name}\\s*>`, 'i');
      const m = rest.match(closeRe);
      if (!m) {
        // No close in the remaining source — flag as unclosed.
        return {
          ok: false,
          message: `Unclosed <${name}> block (opened on line ${tagLine})`,
          line: tagLine,
        };
      }
      bumpTo(i + m.index + m[0].length);
      continue;
    }

    stack.push({ name, line: tagLine });
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      ok: false,
      message: `Unclosed <${unclosed.name}> (opened on line ${unclosed.line})`,
      line: unclosed.line,
    };
  }

  // Structural pass ok — now validate the contents of any embedded <style>
  // and <script> blocks. The main tokenizer above treats those as raw text
  // and doesn't peer inside, so a mistyped CSS property or a JS syntax
  // error inside a section snippet would otherwise slip through.
  const embedded = validateEmbeddedBlocks(src);
  if (embedded) return embedded;

  return { ok: true };
}

// Find each <style>...</style> and <script>...</script> block in the source
// and route its contents through the corresponding validator. Returns a
// failure object on the first bad block (with a line number offset by the
// block's opening tag), or null if everything checks out.
function validateEmbeddedBlocks(src) {
  const blocks = [];
  const re = /<(style|script)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    // Skip external scripts (with src) — nothing inline to validate.
    if (tag === 'script' && /<script\b[^>]*\bsrc=/i.test(m[0])) continue;
    // Line where the inner content starts: line of opening tag + newlines
    // inside the opening tag (rare) + newlines skipped to reach inner.
    const openTagEndAbs = m.index + m[0].indexOf('>') + 1;
    const startLine = 1 + (src.slice(0, openTagEndAbs).match(/\n/g)?.length || 0);
    blocks.push({ tag, inner, startLine });
  }
  for (const b of blocks) {
    const validator = b.tag === 'style' ? validateCss : validateJs;
    const r = validator(b.inner);
    if (!r.ok) {
      return {
        ok: false,
        message: `Inside <${b.tag}>: ${r.message}`,
        line: r.line ? b.startLine + r.line - 1 : b.startLine,
      };
    }
  }
  return null;
}

function isTagNameChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === ':';
}

// ─── CSS ────────────────────────────────────────────────────────────────────
// Two-pass check:
//   1. CSSStyleSheet.replaceSync — catches structural syntax errors
//      (unmatched braces, malformed selectors).
//   2. Per-declaration CSS.supports() — catches typo'd property names.
//      Browsers silently drop unknown properties for forward-compat, so a
//      typo like `bakcground-color: red` parses cleanly. CSS.supports gives
//      us a boolean per property so we can flag it.
// Vendor prefixes (-webkit-, -moz-) and custom properties (--foo) are
// always accepted. @-rules skip the property check.

export function validateCss(input) {
  const src = String(input || '');
  if (!src.trim()) return { ok: true };

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(src);
  } catch (e) {
    return { ok: false, message: e.message || 'Invalid CSS' };
  }

  // Structural pass ok — now check every declared property.
  const unknown = findUnknownCssProperty(src);
  if (unknown) {
    return {
      ok: false,
      message: `Unknown CSS property "${unknown.prop}" — check for typos`,
      line: unknown.line,
    };
  }
  return { ok: true };
}

// Walk the CSS source, tracking bracket depth, and return the first
// declaration whose property name is not accepted by CSS.supports().
// Skips @-rule prelude (only checks declarations inside blocks) so
// @media / @supports / @keyframes don't emit false positives.
function findUnknownCssProperty(src) {
  const len = src.length;
  let depth = 0;
  let line = 1;
  let i = 0;
  // Track whether the current block is an @-rule's prelude — nested rules
  // inside @media / @supports do carry declarations, so we only skip the
  // outermost prelude, not descendants.
  let atRuleStack = []; // { depth, kind: 'skip-decls' | 'has-decls' }

  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

  while (i < len) {
    const c = src[i];

    // Skip comments.
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return null; // unterminated — replaceSync would have caught, but be safe
      const commentText = src.slice(i, end + 2);
      const nls = commentText.match(/\n/g);
      if (nls) line += nls.length;
      i = end + 2;
      continue;
    }

    // Skip strings.
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < len && src[i] !== quote) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }

    if (c === '\n') { line++; i++; continue; }

    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      // Pop any at-rule tracking whose block just closed.
      while (atRuleStack.length && atRuleStack[atRuleStack.length - 1].depth > depth) {
        atRuleStack.pop();
      }
      i++;
      continue;
    }

    // Only look for declarations inside a block (depth > 0). Outside a
    // block we're either whitespace/comments/selectors — walking char by
    // char to advance is enough.
    if (depth === 0) { i++; continue; }

    // At depth > 0. If the current line starts with an @-rule (@keyframes
    // inside a rule is rare; typically we're inside a real rule), we need to
    // skip its prelude but recurse into its block.
    if (c === '@') {
      // Find end of prelude (';' or '{')
      const stopA = src.indexOf(';', i);
      const stopB = src.indexOf('{', i);
      const stop = (stopA !== -1 && (stopB === -1 || stopA < stopB)) ? stopA : stopB;
      if (stop === -1) return null;
      const chunk = src.slice(i, stop);
      const nls = chunk.match(/\n/g);
      if (nls) line += nls.length;
      i = stop;
      continue;
    }

    if (isSpace(c) || c === ';') { i++; continue; }

    // We're at the start of a token — could be a declaration (prop: value)
    // or a nested selector. Look for the next ';' or '{' or '}'.
    // Skip strings and comments so their contents don't fool the delimiter
    // check (e.g. `content: "a;b"` must not terminate on the string's ';').
    let scan = i;
    let sawColon = -1;
    while (scan < len) {
      const s = src[scan];
      if (s === '"' || s === "'") {
        const quote = s; scan++;
        while (scan < len && src[scan] !== quote) {
          if (src[scan] === '\\') { scan += 2; continue; }
          scan++;
        }
        scan++;
        continue;
      }
      if (s === '/' && src[scan + 1] === '*') {
        const end = src.indexOf('*/', scan + 2);
        if (end === -1) { scan = len; break; }
        scan = end + 2;
        continue;
      }
      if (s === '{' || s === '}' || s === ';') break;
      if (s === ':' && sawColon === -1) sawColon = scan;
      scan++;
    }

    // If we hit '{' before ';' → this was a selector, not a declaration.
    if (scan < len && src[scan] === '{') {
      // Advance line count through the selector prelude, then let outer loop
      // handle the '{' on the next iteration.
      const chunk = src.slice(i, scan);
      const nls = chunk.match(/\n/g);
      if (nls) line += nls.length;
      i = scan;
      continue;
    }

    // We hit ';' or '}' or end. If we saw a colon inside this token, extract
    // the property name and validate it.
    if (sawColon > i) {
      const propRaw = src.slice(i, sawColon).trim();
      const declLine = line;
      // Normalize property: lowercase, strip whitespace.
      const prop = propRaw.toLowerCase();
      // Skip: empty, custom properties, vendor-prefixed. Also skip if the
      // property contains characters that aren't valid in a property name —
      // means we're mis-parsing and shouldn't false-positive.
      const looksLikeProp = /^-?[a-z][a-z0-9-]*$/.test(prop);
      if (looksLikeProp && !prop.startsWith('--')) {
        const isVendor = prop.startsWith('-');
        if (!isVendor) {
          let supported = false;
          try {
            supported = CSS.supports(prop, 'initial') || CSS.supports(prop, 'inherit');
          } catch { supported = true; /* environment refused — err on the side of allowing */ }
          if (!supported) {
            return { prop: propRaw, line: declLine };
          }
        }
      }
      // Advance line count through the value chunk.
      const chunk = src.slice(i, scan);
      const nls = chunk.match(/\n/g);
      if (nls) line += nls.length;
    }
    i = scan;
  }
  return null;
}

// ─── JS ─────────────────────────────────────────────────────────────────────
// new Function throws SyntaxError with line/col in most engines. We surface
// the message as-is — modern browsers give reasonable text.

export function validateJs(input) {
  const src = String(input || '');
  if (!src.trim()) return { ok: true };

  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
    return { ok: true };
  } catch (e) {
    const m = e.message || 'Invalid JavaScript';
    // Chromium reports "Unexpected token '<' at line 3" etc.; extract line if present.
    const lineMatch = /(?:at\s+)?line\s+(\d+)/i.exec(m);
    return {
      ok: false,
      message: m,
      line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
    };
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function validateByLang(lang, input) {
  switch (lang) {
    case 'html': return validateHtml(input);
    case 'css':  return validateCss(input);
    case 'js':
    case 'javascript': return validateJs(input);
    default: return { ok: true };
  }
}
