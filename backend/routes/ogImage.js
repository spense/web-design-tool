import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { projectDir, getProject, saveProjectOgImage } from '../storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function ogImageDir(slug) {
  return path.join(projectDir(slug), 'og-image');
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

// POST /api/projects/:slug/og-image
router.post(
  '/:slug/og-image',
  upload.single('image'),
  async (req, res, next) => {
    try {
      const { slug } = req.params;
      const data = await getProject(slug);
      if (!data) return res.status(404).json({ error: 'Project not found' });

      const file = req.file;
      if (!file) return res.status(400).json({ error: 'image required' });

      const dir = ogImageDir(slug);
      await fs.mkdir(dir, { recursive: true });

      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']) {
        await fs.rm(path.join(dir, `og-image.${ext}`), { force: true });
      }
      const ext = (path.extname(file.originalname || '').slice(1).toLowerCase() || 'png').replace(/[^a-z0-9]/g, '');
      const safeExt = ext || 'png';
      await fs.writeFile(path.join(dir, `og-image.${safeExt}`), file.buffer);

      const ogImage = {
        filename: `og-image.${safeExt}`,
        mediaType: file.mimetype || 'application/octet-stream',
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
        version: ((data.project.ogImage?.version) || 0) + 1,
      };
      await saveProjectOgImage(slug, ogImage);

      res.json({ ogImage });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  }
);

// DELETE /api/projects/:slug/og-image
router.delete('/:slug/og-image', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    const dir = ogImageDir(slug);
    const ogImage = data.project.ogImage;
    if (ogImage?.filename) {
      await fs.rm(path.join(dir, ogImage.filename), { force: true });
    }
    await saveProjectOgImage(slug, null);
    res.json({ ogImage: null });
  } catch (e) { next(e); }
});

// GET /api/projects/:slug/og-image/file
router.get('/:slug/og-image/file', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    const ogImage = data.project.ogImage;
    if (!ogImage?.filename) return res.status(404).end();
    const filePath = path.join(ogImageDir(slug), ogImage.filename);
    if (!(await exists(filePath))) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } catch (e) { next(e); }
});

export default router;
