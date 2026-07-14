import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { exec, execFile } from 'child_process';
import { getProject, projectDir } from '../storage.js';
import { extractAndDedupCss } from '../cssExtractor.js';
import { buildMonogramSvg, isImportedPlaceholder } from '../faviconSvg.js';
import { cleanupUnusedImages } from '../pixabay.js';
import {
  ANIMATIONS_CSS,
  ANIMATIONS_JS,
  buildEffectOverrideCss,
  buildCountUpOffScript,
  normalizeAnimations,
} from '../animationAssets.js';

const router = Router();

// Tracks active and recently-completed export jobs by slug. Survives client
// disconnects/refreshes so the UI can resume showing "Exporting…" state.
// Completed entries auto-evict after CLEANUP_MS to bound memory.
const jobs = new Map();
const CLEANUP_MS = 5 * 60 * 1000;

function scheduleCleanup(slug) {
  setTimeout(() => {
    const j = jobs.get(slug);
    if (j && j.status !== 'running') jobs.delete(slug);
  }, CLEANUP_MS);
}

router.post('/open-folder', async (req, res) => {
  const { dir } = req.body;
  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'Missing dir' });
  }
  try {
    await fs.access(dir);
  } catch {
    return res.status(404).json({ error: 'Directory not found' });
  }
  const platform = process.platform;
  if (platform === 'darwin') {
    const script = `tell application "Finder"\nset f to POSIX file "${dir}" as alias\nmake new Finder window to f\nactivate\nselect every item of f\nend tell`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  } else {
    const cmd = platform === 'win32' ? 'explorer' : 'xdg-open';
    exec(`${cmd} ${JSON.stringify(dir)}`, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  }
});

router.get('/:slug/status', (req, res) => {
  const job = jobs.get(req.params.slug);
  res.json(job || { status: 'idle' });
});

router.delete('/:slug/status', (req, res) => {
  jobs.delete(req.params.slug);
  res.json({ ok: true });
});

router.post('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;

    // If an export is already running for this slug, just return current
    // state — the UI will pick up the running state and start polling.
    const existing = jobs.get(slug);
    if (existing && existing.status === 'running') {
      return res.json(existing);
    }

    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Not found' });
    const { project, pages, session } = data;

    if (!pages || Object.keys(pages).length === 0) {
      return res.status(400).json({ error: 'No design has been generated yet.' });
    }

    // Start tracking the job and respond immediately. The actual work runs
    // in the background and updates the job entry on completion.
    const job = { status: 'running', startedAt: new Date().toISOString() };
    jobs.set(slug, job);
    res.json(job);

    runExport(slug, project, pages, session).then((result) => {
      jobs.set(slug, {
        status: 'done',
        result,
        startedAt: job.startedAt,
        completedAt: new Date().toISOString(),
      });
      scheduleCleanup(slug);
    }).catch((err) => {
      console.error('[export] failed:', err);
      jobs.set(slug, {
        status: 'error',
        error: err.message || String(err),
        startedAt: job.startedAt,
        completedAt: new Date().toISOString(),
      });
      scheduleCleanup(slug);
    });
  } catch (e) { next(e); }
});

async function runExport(slug, project, pages, session) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const exportDir = path.join(projectDir(slug), 'exports', `design-reference-${timestamp}`);
    await fs.mkdir(exportDir, { recursive: true });

    // Lift inline <style> blocks out into shared/page-specific CSS files.
    // After this pass, each HTML page references stylesheets via <link> tags.
    const { pages: rewrittenPages, css: extractedCss } = extractAndDedupCss(pages);

    // In the working project, image paths use `uploads/...` (matches on-disk
    // layout). In the export, rename that folder to `assets/` and rewrite
    // references in HTML/CSS so paths resolve in the unpacked zip.
    const rewriteUploads = (s) => s.replace(/(["'(=\s])uploads\//g, '$1assets/');

    const htmlFiles = Object.fromEntries(
      Object.entries(rewrittenPages).map(([n, c]) => [n, rewriteUploads(c)])
    );
    const cssFiles = Object.fromEntries(
      Object.entries(extractedCss).map(([n, c]) => [n, rewriteUploads(c)])
    );

    // Inject the canonical animations runtime (CSS + JS) into every page so
    // the exported site behaves identically to preview. Per-effect override
    // CSS gates individual toggles without rewriting markup; a tiny inline
    // script disables count-up at runtime when its toggle is off (CSS alone
    // can't stop a JS tween).
    const effects = normalizeAnimations(project);
    const overrideCss = buildEffectOverrideCss(effects);
    const countUpOff = buildCountUpOffScript(effects);
    // Runtime handoff: some effects (parallax's img-fallback) can't be gated
    // by CSS alone, so tell the runtime the current toggle state right after
    // it bootstraps so it can tear those effects down at load time.
    const setEffectsScript = `window.__cinderAnim&&window.__cinderAnim.setEffects(${JSON.stringify(effects)});`;
    for (const [name, html] of Object.entries(htmlFiles)) {
      htmlFiles[name] = injectAnimationsRuntime(html, overrideCss, countUpOff, setEffectsScript);
    }

    // Favicon: figure out which files we'll ship. Inject <link> tags into
    // each HTML page's <head> BEFORE we collect allFiles so the writes pick
    // up the mutated HTML.
    const faviconFiles = await collectFaviconExportFiles(slug, project.favicon);
    if (faviconFiles.length > 0) {
      const linkBlock = buildFaviconLinkBlock(project.favicon);
      for (const [name, html] of Object.entries(htmlFiles)) {
        htmlFiles[name] = injectFaviconLinks(html, linkBlock);
      }
    }

    const ogImageFile = await collectOgImageExportFile(slug, project.ogImage);
    if (ogImageFile) {
      const ogTag = `  <meta property="og:image" content="assets/${ogImageFile.exportName}">\n`;
      for (const [name, html] of Object.entries(htmlFiles)) {
        htmlFiles[name] = injectOgImageTag(html, ogTag);
      }
    }

    // User-authored code slots (global HEAD/FOOTER/CSS + per-page HEAD/FOOTER)
    // are runtime-injected in the preview; bake them into the exported HTML
    // here so the export is self-contained. Global CSS lands last in <head>
    // so it wins the cascade — matches preview slot order.
    for (const [name, html] of Object.entries(htmlFiles)) {
      htmlFiles[name] = injectSiteCode(html, name, project);
    }

    const allFiles = { ...htmlFiles, ...cssFiles };

    for (const [name, content] of Object.entries(allFiles)) {
      const fullPath = path.join(exportDir, name);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
    }

    // Remove Pixabay images that aren't referenced in any page before copying.
    await cleanupUnusedImages(slug, pages);

    const uploadsDir = path.join(projectDir(slug), 'uploads');
    const exportAssetsDir = path.join(exportDir, 'assets');
    let uploadFiles = [];
    try {
      const entries = await fs.readdir(uploadsDir);
      if (entries.length > 0) {
        await fs.mkdir(exportAssetsDir, { recursive: true });
        for (const entry of entries) {
          const src = path.join(uploadsDir, entry);
          const dst = path.join(exportAssetsDir, entry);
          await fs.copyFile(src, dst);
          uploadFiles.push(entry);
        }
      }
    } catch (e) { /* no uploads folder, fine */ }

    if (faviconFiles.length > 0) {
      await fs.mkdir(exportAssetsDir, { recursive: true });
      for (const f of faviconFiles) {
        const dst = path.join(exportAssetsDir, f.exportName);
        if (f.content != null) {
          await fs.writeFile(dst, f.content, 'utf8');
        } else {
          await fs.copyFile(f.src, dst);
        }
      }
    }

    if (ogImageFile) {
      await fs.mkdir(exportAssetsDir, { recursive: true });
      await fs.copyFile(ogImageFile.src, path.join(exportAssetsDir, ogImageFile.exportName));
    }

    return {
      exportDir,
      files: Object.keys(allFiles),
      timestamp,
      slug,
    };
}

// Standard names used in exports (assets/...). Independent from the
// internal generated-{size}.png / uploaded-{size}.png storage layout.
const FAVICON_EXPORT_NAMES = {
  16: 'favicon-16.png',
  32: 'favicon-32.png',
  180: 'apple-touch-icon.png',
  192: 'icon-192.png',
  512: 'icon-512.png',
};

async function collectFaviconExportFiles(slug, favicon) {
  if (!favicon?.selected) return [];
  const dir = path.join(projectDir(slug), 'favicon');
  const variant = favicon.selected; // 'generated' | 'uploaded'
  const out = [];
  for (const [size, exportName] of Object.entries(FAVICON_EXPORT_NAMES)) {
    const src = path.join(dir, `${variant}-${size}.png`);
    try {
      await fs.access(src);
      out.push({ src, exportName });
    } catch { /* missing, skip */ }
  }
  // The SVG only exists for generated favicons; ship it alongside as a
  // higher-resolution option for supporting browsers. Render it fresh from
  // the persisted params so older projects (whose on-disk SVG predates
  // the centering fix) don't ship a stale version. Fall back to disk only
  // when params are unavailable (e.g. zip-imported projects).
  if (variant === 'generated') {
    if (!isImportedPlaceholder(favicon.generated)) {
      out.push({
        exportName: 'favicon.svg',
        content: buildMonogramSvg(favicon.generated),
      });
    } else {
      const svg = path.join(dir, 'generated.svg');
      try {
        await fs.access(svg);
        out.push({ src: svg, exportName: 'favicon.svg' });
      } catch {}
    }
  }
  return out;
}

function buildFaviconLinkBlock(favicon) {
  const lines = [];
  if (favicon?.selected === 'generated') {
    lines.push('  <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">');
  }
  lines.push('  <link rel="icon" type="image/png" sizes="32x32" href="assets/favicon-32.png">');
  lines.push('  <link rel="icon" type="image/png" sizes="16x16" href="assets/favicon-16.png">');
  lines.push('  <link rel="apple-touch-icon" sizes="180x180" href="assets/apple-touch-icon.png">');
  return lines.join('\n') + '\n';
}

// Inject the canonical animations payload + any per-effect overrides into
// an HTML page. Idempotent — looks for known ids before injecting again.
function injectAnimationsRuntime(html, overrideCss, countUpOff, setEffectsScript) {
  let out = html;
  const baseStyle = `  <style id="cinder-anim-css">${ANIMATIONS_CSS}</style>\n`;
  const baseScript = `  <script id="cinder-anim-js">${ANIMATIONS_JS}</script>\n`;
  const overrideStyle = overrideCss
    ? `  <style id="cinder-anim-override">${overrideCss}</style>\n`
    : '';
  const countUpScript = countUpOff
    ? `  <script id="cinder-anim-countup-off">${countUpOff}</script>\n`
    : '';
  const effectsScript = setEffectsScript
    ? `  <script id="cinder-anim-set-effects">${setEffectsScript}</script>\n`
    : '';
  if (/<\/head>/i.test(out) && !/id=["']cinder-anim-css["']/.test(out)) {
    out = out.replace(/<\/head>/i, `${baseStyle}${overrideStyle}</head>`);
  } else if (overrideStyle && !/id=["']cinder-anim-override["']/.test(out)) {
    out = out.replace(/<\/head>/i, `${overrideStyle}</head>`);
  }
  if (/<\/body>/i.test(out) && !/id=["']cinder-anim-js["']/.test(out)) {
    out = out.replace(/<\/body>/i, `${baseScript}${effectsScript}${countUpScript}</body>`);
  } else if (countUpScript && !/id=["']cinder-anim-countup-off["']/.test(out)) {
    out = out.replace(/<\/body>/i, `${effectsScript}${countUpScript}</body>`);
  }
  return out;
}

function injectFaviconLinks(html, linkBlock) {
  // Drop any existing favicon links so we don't double up after re-export.
  const stripped = html.replace(
    /[ \t]*<link\b[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>\s*/gi,
    ''
  );
  if (/<\/head>/i.test(stripped)) {
    return stripped.replace(/<\/head>/i, `${linkBlock}</head>`);
  }
  // No <head> tag — nothing useful we can do. Return as-is.
  return stripped;
}

async function collectOgImageExportFile(slug, ogImage) {
  if (!ogImage?.filename) return null;
  const src = path.join(projectDir(slug), 'og-image', ogImage.filename);
  try {
    await fs.access(src);
    const ext = path.extname(ogImage.filename) || '.png';
    return { src, exportName: `og-image${ext}` };
  } catch { return null; }
}

function injectOgImageTag(html, ogTag) {
  const stripped = html.replace(
    /[ \t]*<meta\b[^>]*property=["']og:image["'][^>]*>\s*/gi,
    ''
  );
  if (/<\/head>/i.test(stripped)) {
    return stripped.replace(/<\/head>/i, `${ogTag}</head>`);
  }
  return stripped;
}

// Bake user-authored code slots into a page's HTML at export time. Mirrors
// the preview's runtime injection so the export is self-contained and
// behaves identically to what the user sees in the tool.
//
// Slot order (matches PreviewPanel.applyCodeSlots):
//   <head>: globalHead → pageHead → globalCss (last = wins cascade)
//   <body> tail: globalBodyEnd → pageBodyEnd
//
// Wrapped in HTML comment markers so downstream consumers (like the design
// engine's Astro build) can identify user-authored regions and preserve
// them during AI-driven regenerations.
function injectSiteCode(html, pageName, project) {
  const globalHead = String(project?.globalHead || '').trim();
  const globalBodyEnd = String(project?.globalBodyEnd || '').trim();
  const globalCss = String(project?.globalCss || '').trim();
  const pageEntry = project?.pageCode?.[pageName] || {};
  const pageHead = String(pageEntry.head || '').trim();
  const pageBodyEnd = String(pageEntry.bodyEnd || '').trim();

  const headParts = [];
  if (globalHead) headParts.push(`<!-- site-code:global-head -->\n${globalHead}\n<!-- /site-code:global-head -->`);
  if (pageHead) headParts.push(`<!-- site-code:page-head -->\n${pageHead}\n<!-- /site-code:page-head -->`);
  if (globalCss) headParts.push(`<!-- site-code:global-css -->\n<style>\n${globalCss}\n</style>\n<!-- /site-code:global-css -->`);

  const bodyParts = [];
  if (globalBodyEnd) bodyParts.push(`<!-- site-code:global-body-end -->\n${globalBodyEnd}\n<!-- /site-code:global-body-end -->`);
  if (pageBodyEnd) bodyParts.push(`<!-- site-code:page-body-end -->\n${pageBodyEnd}\n<!-- /site-code:page-body-end -->`);

  let result = html;
  if (headParts.length) {
    const block = '\n' + headParts.join('\n') + '\n';
    if (/<\/head>/i.test(result)) {
      result = result.replace(/<\/head>/i, `${block}</head>`);
    } else {
      result = block + result;
    }
  }
  if (bodyParts.length) {
    const block = '\n' + bodyParts.join('\n') + '\n';
    if (/<\/body>/i.test(result)) {
      result = result.replace(/<\/body>/i, `${block}</body>`);
    } else {
      result = result + block;
    }
  }
  return result;
}

export default router;
