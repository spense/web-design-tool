import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import JSZip from 'jszip';
import { getProject, projectDir } from '../storage.js';
import { getAnthropic, resolveModel, EXPORT_SYSTEM_PROMPT } from '../anthropic.js';
import { parseFileBlocks } from '../parseFiles.js';
import { extractAndDedupCss } from '../cssExtractor.js';
import { buildMonogramSvg, isImportedPlaceholder } from '../faviconSvg.js';

const router = Router();

router.post('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { model } = req.body || {};
    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Not found' });
    const { project, pages, session } = data;

    if (!pages || Object.keys(pages).length === 0) {
      return res.status(400).json({ error: 'No design has been generated yet.' });
    }

    const client = getAnthropic();
    const sessionSummary = (session.messages || []).map(m =>
      `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
    ).join('\n\n');

    const userMsg = `Project: ${project.name}\nCrawled URL: ${project.crawledUrl || 'none'}\n\n=== Current HTML files ===\n${Object.entries(pages).map(([n, c]) => `<!-- ${n} -->\n${c}`).join('\n\n')}\n\n=== Chat session ===\n${sessionSummary}`;

    const result = await client.messages.create({
      model: resolveModel(model || 'sonnet'),
      max_tokens: 8000,
      system: EXPORT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });

    const text = result.content.map(b => b.text || '').join('');
    const { files: docFiles } = parseFileBlocks(text);

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

    // The CSS extractor moved `.animate-in` rules into an external stylesheet
    // loaded via async <link>. By the time that CSS applies, the page has
    // already painted with elements at default opacity, causing a flash and
    // the IntersectionObserver may have already marked above-the-fold
    // elements visible (no animation plays). Re-inject the critical animation
    // styles inline in <head> so they apply immediately during HTML parse.
    if (project.scrollAnimations === false) {
      // User disabled animations — inject an override that wins over the
      // extracted styles.
      for (const [name, html] of Object.entries(htmlFiles)) {
        htmlFiles[name] = injectAnimationOverride(html);
      }
    } else {
      for (const [name, html] of Object.entries(htmlFiles)) {
        if (/\banimate-in\b/.test(html)) {
          htmlFiles[name] = injectCriticalAnimationCss(html);
        }
      }
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

    const allFiles = { ...htmlFiles, ...cssFiles, ...docFiles };

    for (const [name, content] of Object.entries(allFiles)) {
      const fullPath = path.join(exportDir, name);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
    }

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

    const zip = new JSZip();
    for (const [name, content] of Object.entries(allFiles)) {
      zip.file(name, content);
    }
    for (const upload of uploadFiles) {
      const buf = await fs.readFile(path.join(uploadsDir, upload));
      zip.file(`assets/${upload}`, buf);
    }
    for (const f of faviconFiles) {
      const buf = f.content != null ? Buffer.from(f.content, 'utf8') : await fs.readFile(f.src);
      zip.file(`assets/${f.exportName}`, buf);
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const zipPath = path.join(exportDir, `${slug}-${timestamp}.zip`);
    await fs.writeFile(zipPath, zipBuffer);

    res.json({
      exportDir,
      zipPath,
      files: Object.keys(allFiles),
      timestamp,
      slug,
    });
  } catch (e) { next(e); }
});

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

const CRITICAL_ANIMATION_CSS = `  <style id="anim-critical">.animate-in{opacity:0;transform:translate3d(0,24px,0);transition:opacity 0.6s ease 0.25s,transform 0.6s ease 0.25s}.animate-in.visible{opacity:1;transform:none}</style>\n`;

function injectCriticalAnimationCss(html) {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${CRITICAL_ANIMATION_CSS}</head>`);
  }
  return html;
}

function injectAnimationOverride(html) {
  const style = `  <style id="anim-override">.animate-in { opacity: 1 !important; transform: none !important; transition: none !important; }</style>\n`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${style}</head>`);
  }
  return html;
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

router.get('/:slug/download/:timestamp', async (req, res, next) => {
  try {
    const { slug, timestamp } = req.params;
    const exportDir = path.join(projectDir(slug), 'exports', `design-reference-${timestamp}`);
    const entries = await fs.readdir(exportDir);
    const zipName = entries.find(f => f.endsWith('.zip'));
    if (!zipName) return res.status(404).json({ error: 'Zip not found' });
    res.download(path.join(exportDir, zipName));
  } catch (e) { next(e); }
});

export default router;
