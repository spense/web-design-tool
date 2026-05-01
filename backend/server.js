import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const __dirname_boot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname_boot, '..', '.env') });

import express from 'express';
import cors from 'cors';

import projectsRouter from './routes/projects.js';
import chatRouter from './routes/chat.js';
import crawlRouter from './routes/crawl.js';
import exportRouter from './routes/export.js';
import importRouter from './routes/import.js';
import appStateRouter from './routes/appState.js';
import uploadsRouter from './routes/uploads.js';
import { ensureProjectsDir } from './storage.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/config', (req, res) => {
  res.json({
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

// Uploads mounted FIRST under /api/projects so its routes (which match
// /:slug/uploads and /:slug/uploads/:filename) take precedence.
app.use('/api/projects', uploadsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/crawl', crawlRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
app.use('/api/app-state', appStateRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
ensureProjectsDir().then(() => {
  app.listen(PORT, () => {
    console.log(`[backend] listening on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[backend] WARNING: ANTHROPIC_API_KEY is not set in .env');
    }
  });
});
