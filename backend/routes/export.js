import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import JSZip from 'jszip';
import { getProject, projectDir } from '../storage.js';
import { getAnthropic, resolveModel, EXPORT_SYSTEM_PROMPT } from '../anthropic.js';
import { parseFileBlocks } from '../parseFiles.js';

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
    const exportDir = path.join(projectDir(slug), 'exports', timestamp);
    await fs.mkdir(exportDir, { recursive: true });

    const allFiles = { ...pages, ...docFiles };
    for (const [name, content] of Object.entries(allFiles)) {
      await fs.writeFile(path.join(exportDir, name), content, 'utf8');
    }

    // Copy uploads/ folder into the export so `<img src="uploads/...">` paths
    // resolve in the unpacked zip.
    const uploadsDir = path.join(projectDir(slug), 'uploads');
    const exportUploadsDir = path.join(exportDir, 'uploads');
    let uploadFiles = [];
    try {
      const entries = await fs.readdir(uploadsDir);
      if (entries.length > 0) {
        await fs.mkdir(exportUploadsDir, { recursive: true });
        for (const entry of entries) {
          const src = path.join(uploadsDir, entry);
          const dst = path.join(exportUploadsDir, entry);
          await fs.copyFile(src, dst);
          uploadFiles.push(entry);
        }
      }
    } catch (e) { /* no uploads folder, fine */ }

    const zip = new JSZip();
    for (const [name, content] of Object.entries(allFiles)) {
      zip.file(name, content);
    }
    for (const upload of uploadFiles) {
      const buf = await fs.readFile(path.join(uploadsDir, upload));
      zip.file(`uploads/${upload}`, buf);
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

router.get('/:slug/download/:timestamp', async (req, res, next) => {
  try {
    const { slug, timestamp } = req.params;
    const exportDir = path.join(projectDir(slug), 'exports', timestamp);
    const entries = await fs.readdir(exportDir);
    const zipName = entries.find(f => f.endsWith('.zip'));
    if (!zipName) return res.status(404).json({ error: 'Zip not found' });
    res.download(path.join(exportDir, zipName));
  } catch (e) { next(e); }
});

export default router;
