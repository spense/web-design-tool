import { Router } from 'express';
import { readAppState, writeAppState } from '../storage.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try { res.json(await readAppState()); } catch (e) { next(e); }
});

router.put('/', async (req, res, next) => {
  try {
    await writeAppState(req.body || {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
