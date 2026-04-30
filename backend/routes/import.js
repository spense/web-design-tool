import { Router } from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import { createProject, saveProject, getProject } from '../storage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/', upload.single('zip'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'zip file required' });
    const zip = await JSZip.loadAsync(req.file.buffer);

    const pages = {};
    let brief = null, tokens = null, sessionMd = null;

    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const baseName = name.split('/').pop();
      const content = await file.async('string');
      if (baseName.endsWith('.html')) {
        pages[baseName] = content;
      } else if (baseName === 'brief.md') {
        brief = content;
      } else if (baseName === 'tokens.json') {
        tokens = content;
      } else if (baseName === 'design-session.md') {
        sessionMd = content;
      }
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

export default router;
