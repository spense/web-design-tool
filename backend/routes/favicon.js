import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { projectDir, getProject, saveProjectFavicon } from '../storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Sizes generated for every favicon variant. Covers modern browser tabs +
// Apple touch icon + Android/PWA manifest icons. No .ico — modern browsers
// accept PNG via <link rel="icon">.
export const FAVICON_SIZES = [16, 32, 180, 192, 512];

const PNG_FIELDS = FAVICON_SIZES.map(s => ({ name: `png_${s}`, maxCount: 1 }));

function faviconDir(slug) {
  return path.join(projectDir(slug), 'favicon');
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function readPngsFromReq(req) {
  const out = {};
  for (const size of FAVICON_SIZES) {
    const f = req.files?.[`png_${size}`]?.[0];
    if (!f) {
      const err = new Error(`Missing png_${size}`);
      err.status = 400;
      throw err;
    }
    out[size] = f.buffer;
  }
  return out;
}

async function writePngs(dir, prefix, pngs) {
  await fs.mkdir(dir, { recursive: true });
  for (const size of FAVICON_SIZES) {
    await fs.writeFile(path.join(dir, `${prefix}-${size}.png`), pngs[size]);
  }
}

async function removeVariant(dir, prefix) {
  for (const size of FAVICON_SIZES) {
    await fs.rm(path.join(dir, `${prefix}-${size}.png`), { force: true });
  }
}

// POST /api/projects/:slug/favicon/generated
// fields: png_16..png_512, svg (text), params (JSON: { letters, bg, fg, shape })
router.post(
  '/:slug/favicon/generated',
  upload.fields([...PNG_FIELDS, { name: 'svg', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const { slug } = req.params;
      const data = await getProject(slug);
      if (!data) return res.status(404).json({ error: 'Project not found' });

      const params = JSON.parse(req.body.params || '{}');
      const svgBuf = req.files?.svg?.[0]?.buffer;
      if (!svgBuf) return res.status(400).json({ error: 'svg required' });
      const pngs = await readPngsFromReq(req);

      const dir = faviconDir(slug);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'generated.svg'), svgBuf);
      await writePngs(dir, 'generated', pngs);

      const favicon = data.project.favicon || {};
      favicon.generated = {
        letters: params.letters || '?',
        bg: params.bg || '#000',
        fg: params.fg || '#fff',
        shape: params.shape || 'rounded',
        font: params.font || 'sans-bold',
        // Persist attempt so each regenerate advances through the cycle
        // (color × letter-mode × font) instead of repeating identical results.
        attempt: Number.isFinite(params.attempt) ? params.attempt : 0,
      };
      favicon.selected = 'generated';
      favicon.version = (favicon.version || 0) + 1;
      await saveProjectFavicon(slug, favicon);

      res.json({ favicon });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  }
);

// POST /api/projects/:slug/favicon/uploaded
// fields: original (file), png_16..png_512
router.post(
  '/:slug/favicon/uploaded',
  upload.fields([...PNG_FIELDS, { name: 'original', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const { slug } = req.params;
      const data = await getProject(slug);
      if (!data) return res.status(404).json({ error: 'Project not found' });

      const original = req.files?.original?.[0];
      if (!original) return res.status(400).json({ error: 'original required' });
      const pngs = await readPngsFromReq(req);

      const dir = faviconDir(slug);
      await fs.mkdir(dir, { recursive: true });

      // Drop any prior uploaded files (incl. older extension variants).
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif']) {
        await fs.rm(path.join(dir, `uploaded.${ext}`), { force: true });
      }
      const ext = (path.extname(original.originalname || '').slice(1).toLowerCase() || 'png').replace(/[^a-z0-9]/g, '');
      const safeExt = ext || 'png';
      await fs.writeFile(path.join(dir, `uploaded.${safeExt}`), original.buffer);
      await writePngs(dir, 'uploaded', pngs);

      const favicon = data.project.favicon || {};
      favicon.uploaded = {
        filename: `uploaded.${safeExt}`,
        mediaType: original.mimetype || 'application/octet-stream',
        sizeBytes: original.size,
        uploadedAt: new Date().toISOString(),
      };
      favicon.selected = 'uploaded';
      favicon.version = (favicon.version || 0) + 1;
      await saveProjectFavicon(slug, favicon);

      res.json({ favicon });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  }
);

// PATCH /api/projects/:slug/favicon/select  body: { selected: 'generated'|'uploaded' }
router.patch('/:slug/favicon/select', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { selected } = req.body || {};
    if (!['generated', 'uploaded'].includes(selected)) {
      return res.status(400).json({ error: 'selected must be "generated" or "uploaded"' });
    }
    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    const favicon = data.project.favicon || {};
    if (selected === 'uploaded' && !favicon.uploaded) {
      return res.status(400).json({ error: 'No uploaded favicon to select' });
    }
    if (selected === 'generated' && !favicon.generated) {
      return res.status(400).json({ error: 'No generated favicon to select' });
    }
    favicon.selected = selected;
    favicon.version = (favicon.version || 0) + 1;
    await saveProjectFavicon(slug, favicon);
    res.json({ favicon });
  } catch (e) { next(e); }
});

// DELETE /api/projects/:slug/favicon/uploaded — drop uploaded variant
router.delete('/:slug/favicon/uploaded', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    const dir = faviconDir(slug);
    const favicon = data.project.favicon || {};
    if (favicon.uploaded?.filename) {
      await fs.rm(path.join(dir, favicon.uploaded.filename), { force: true });
    }
    await removeVariant(dir, 'uploaded');
    delete favicon.uploaded;
    if (favicon.selected === 'uploaded') {
      favicon.selected = favicon.generated ? 'generated' : null;
    }
    favicon.version = (favicon.version || 0) + 1;
    await saveProjectFavicon(slug, favicon);
    res.json({ favicon });
  } catch (e) { next(e); }
});

// GET /api/projects/:slug/favicon/file/:name — serve a favicon file
// :name is e.g. "generated-16.png", "generated.svg", "uploaded-32.png", "uploaded.png"
router.get('/:slug/favicon/file/:name', async (req, res, next) => {
  try {
    const { slug, name } = req.params;
    if (name.includes('..') || name.includes('/')) return res.status(400).end();
    const filePath = path.join(faviconDir(slug), name);
    if (!(await exists(filePath))) return res.status(404).end();
    // No-store so regenerated favicons show up immediately even without a
    // cache-busting query string.
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } catch (e) { next(e); }
});

export default router;
