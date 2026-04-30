import { Router } from 'express';
import { crawlSite } from '../crawler.js';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const data = await crawlSite(url);
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
