import { Router } from 'express';
import { searchImages, downloadToProject } from '../pixabay.js';

const router = Router();

router.get('/search', async (req, res, next) => {
  try {
    if (!process.env.PIXABAY_API_KEY) {
      return res.status(503).json({ error: 'Pixabay API key not configured' });
    }
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'q parameter required' });
    const hits = await searchImages(q, { type: type || 'photo' });
    res.json({ hits });
  } catch (e) { next(e); }
});

router.post('/download', async (req, res, next) => {
  try {
    if (!process.env.PIXABAY_API_KEY) {
      return res.status(503).json({ error: 'Pixabay API key not configured' });
    }
    const { slug, imageUrl, filename } = req.body || {};
    if (!slug || !imageUrl || !filename) {
      return res.status(400).json({ error: 'slug, imageUrl, and filename required' });
    }
    const result = await downloadToProject(slug, imageUrl, filename);
    if (!result) return res.status(500).json({ error: 'Download failed' });
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
