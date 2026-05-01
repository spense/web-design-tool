import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { projectDir, getProject, saveProject } from '../storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// POST /api/projects/:slug/uploads — attach an image to a project
router.post('/:slug/uploads', upload.single('file'), async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const data = await getProject(slug);
    if (!data) return res.status(404).json({ error: 'Project not found' });

    const dir = path.join(projectDir(slug), 'uploads');
    await fs.mkdir(dir, { recursive: true });

    // Sanitize filename, avoid collisions with a small suffix.
    const orig = req.file.originalname || 'image';
    const safe = orig.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'image';
    let filename = safe;
    const ext = path.extname(safe);
    const stem = path.basename(safe, ext);
    let suffix = 0;
    while (await exists(path.join(dir, filename))) {
      suffix++;
      filename = `${stem}-${suffix}${ext}`;
    }
    await fs.writeFile(path.join(dir, filename), req.file.buffer);

    // Track in project.json
    const uploads = Array.isArray(data.project.uploads) ? data.project.uploads : [];
    const meta = {
      filename,
      mediaType: req.file.mimetype || 'application/octet-stream',
      sizeBytes: req.file.size,
      uploadedAt: new Date().toISOString(),
    };
    uploads.push(meta);
    data.project.uploads = uploads;
    await saveProject(slug, { project: data.project });

    res.json(meta);
  } catch (e) { next(e); }
});

// GET /api/projects/:slug/uploads/:filename — serve a raw upload
router.get('/:slug/uploads/:filename', async (req, res, next) => {
  try {
    const { slug, filename } = req.params;
    if (filename.includes('..') || filename.includes('/')) return res.status(400).end();
    const filePath = path.join(projectDir(slug), 'uploads', filename);
    if (!(await exists(filePath))) return res.status(404).end();
    res.sendFile(filePath);
  } catch (e) { next(e); }
});

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

export default router;
