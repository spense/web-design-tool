import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import JSZip from 'jszip';
import { createProject, saveProject, getProject, projectDir } from '../storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/', upload.single('zip'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'zip file required' });
    const zip = await JSZip.loadAsync(req.file.buffer);

    const pages = {};
    const assets = []; // [{ name, buf }]
    const cssFiles = {}; // relativePath -> string  (e.g. 'tokens.css', 'styles.css', 'pages/contact.css')
    let brief = null, tokens = null, sessionMd = null;

    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const parts = name.split('/');
      const baseName = parts.pop();
      const folder = parts[0] || '';

      // Image/binary files inside an assets/ or uploads/ folder go back into
      // the new project's uploads/ on disk. (Exports use assets/; older or
      // hand-built zips may use uploads/.)
      if (folder === 'assets' || folder === 'uploads') {
        assets.push({ name: baseName, buf: await file.async('nodebuffer') });
        continue;
      }

      const content = await file.async('string');
      if (baseName.endsWith('.html')) {
        pages[baseName] = content;
      } else if (baseName.endsWith('.css')) {
        // Preserve full relative path so pages/contact.css doesn't collide
        // with a top-level contact.css.
        cssFiles[name] = content;
      } else if (baseName === 'brief.md') {
        brief = content;
      } else if (baseName === 'tokens.json') {
        tokens = content;
      } else if (baseName === 'design-session.md') {
        sessionMd = content;
      }
    }

    // Inline external CSS back into each HTML page. The working format keeps
    // CSS inside one <style> block per page; the export splits it out. On
    // re-import we reverse that so PATCH mode and the iframe preview keep
    // working without external-asset plumbing.
    for (const [name, html] of Object.entries(pages)) {
      pages[name] = inlineCssIntoHtml(html, cssFiles, name);
    }

    // Rewrite HTML refs back to uploads/ so the working preview resolves them.
    for (const [name, html] of Object.entries(pages)) {
      pages[name] = html.replace(/(["'(=\s])assets\//g, '$1uploads/');
    }

    if (Object.keys(pages).length === 0) {
      return res.status(400).json({ error: 'No HTML files found in zip' });
    }

    const baseName = (req.body.name || req.file.originalname.replace(/\.zip$/i, '')) || 'imported';
    const created = await createProject({ name: baseName });
    const { project } = created;

    const importMessages = [];
    if (sessionMd) importMessages.push({ role: 'assistant', content: `Imported design session:\n\n${sessionMd}`, timestamp: new Date().toISOString() });
    if (brief) importMessages.push({ role: 'assistant', content: `Imported design brief:\n\n${brief}`, timestamp: new Date().toISOString() });

    project.importedFrom = req.file.originalname;
    project.tokens = tokens ? safeJson(tokens) : null;

    if (assets.length > 0) {
      const uploadsDir = path.join(projectDir(project.slug), 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true });
      const now = new Date().toISOString();
      project.uploads = [];
      for (const asset of assets) {
        await fs.writeFile(path.join(uploadsDir, asset.name), asset.buf);
        project.uploads.push({
          filename: asset.name,
          mediaType: guessMediaType(asset.name),
          sizeBytes: asset.buf.length,
          uploadedAt: now,
        });
      }
    }

    await saveProject(project.slug, {
      project,
      pages,
      session: { messages: importMessages },
    });

    const full = await getProject(project.slug);
    res.json(full);
  } catch (e) { next(e); }
});

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

// Replace each <link rel="stylesheet" href="..."> in <head> with the CSS
// content from the zip, collapsed into a single <style> block. Drops links
// to stylesheets we don't have content for (external CDNs etc. stay as
// <link> tags untouched).
function inlineCssIntoHtml(html, cssFiles, htmlName) {
  const linkRe = /[ \t]*<link\b[^>]*rel=["']?stylesheet["']?[^>]*>\s*/gi;
  const collected = [];
  const remaining = [];

  let result = html.replace(linkRe, (tag) => {
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) { remaining.push(tag); return ''; }
    const href = hrefMatch[1];

    // Only inline relative refs we have content for. Absolute URLs (Google
    // Fonts etc.) stay as <link> tags.
    if (/^(https?:)?\/\//i.test(href)) { remaining.push(tag); return ''; }

    // Resolve relative to the HTML's directory (HTML files always live at
    // export root, so this is just the href itself).
    const key = href.replace(/^\.\//, '');
    if (cssFiles[key] != null) {
      collected.push({ key, css: cssFiles[key] });
      return '';
    }
    // Unknown stylesheet href — keep the tag in case the consumer can resolve it.
    remaining.push(tag);
    return '';
  });

  if (collected.length === 0 && remaining.length === 0) return html;

  // Rebuild <head> insertion: kept <link> tags first, then a single combined
  // <style> block with the inlined CSS in load order.
  const linkBlock = remaining.length ? '  ' + remaining.join('\n  ').trim() + '\n' : '';
  const styleBlock = collected.length
    ? `  <style>\n${collected.map(c => `/* from ${c.key} */\n${c.css}`).join('\n\n').replace(/^/gm, '    ')}\n  </style>\n`
    : '';

  return result.replace(/<\/head>/i, `${linkBlock}${styleBlock}</head>`);
}

function guessMediaType(name) {
  const ext = name.toLowerCase().split('.').pop();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  }[ext] || 'application/octet-stream';
}

export default router;
