// Backend twin of frontend/src/faviconRender.js → buildMonogramSvg.
// Kept in sync so exports always emit the same monogram the user sees in
// the app, regardless of when the on-disk SVG was originally written.

const FONT_STYLES = [
  { id: 'sans-bold',   family: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', weight: 700 },
  { id: 'sans-black',  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', weight: 900 },
  { id: 'serif-bold',  family: 'Georgia, "Times New Roman", serif', weight: 700 },
  { id: 'mono-bold',   family: '"SF Mono", ui-monospace, Menlo, Consolas, monospace', weight: 700 },
];

export function buildMonogramSvg({ letters, bg, fg, font }) {
  const lt = String(letters || '?').slice(0, 2);
  const fontStyle = FONT_STYLES.find(f => f.id === font) || FONT_STYLES[0];
  const isMono = fontStyle.id === 'mono-bold';
  const isSerif = fontStyle.id === 'serif-bold';
  const fontSize = lt.length === 1
    ? (isSerif ? 78 : 82)
    : (isMono ? 56 : isSerif ? 60 : 66);
  const letterSpacing = lt.length === 1 ? 0 : (isMono ? -4 : -3);
  // Bake the vertical centering into y as an absolute number — see
  // frontend/src/faviconRender.js for the full rationale (em-unit
  // ambiguity in SVG-as-static-asset renderers).
  const baselineY = 50 + fontSize * 0.35;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" ry="22" fill="${bg}"/>
  <text x="50" y="${baselineY}" text-anchor="middle"
        font-family='${fontStyle.family}' font-size="${fontSize}" font-weight="${fontStyle.weight}"
        fill="${fg}" letter-spacing="${letterSpacing}">${escapeXml(lt)}</text>
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// True when the favicon.generated params look like the placeholder set
// import.js writes when reconstructing a project from a zip (no real
// generation params were preserved). In that case we should fall back to
// the on-disk SVG instead of rendering a literal "?".
export function isImportedPlaceholder(g) {
  return !g || (g.letters === '?' && g.bg === '#000' && g.fg === '#fff');
}
