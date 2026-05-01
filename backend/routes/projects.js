import { Router } from 'express';
import { listProjects, getProject, createProject, saveProject, renameProject, deleteProject } from '../storage.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await listProjects());
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    res.json(await createProject({ name }));
  } catch (e) { next(e); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const data = await getProject(req.params.slug);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { next(e); }
});

router.put('/:slug', async (req, res, next) => {
  try {
    const { project, pages, session } = req.body || {};
    await saveProject(req.params.slug, { project, pages, session });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/:slug/name', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    const updated = await renameProject(req.params.slug, name);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.delete('/:slug', async (req, res, next) => {
  try {
    await deleteProject(req.params.slug);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
