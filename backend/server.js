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
import faviconRouter from './routes/favicon.js';
import ogImageRouter from './routes/ogImage.js';
import pixabayRouter from './routes/pixabay.js';
import inlineRouter from './routes/inline.js';
import { ensureProjectsDir } from './storage.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/config', (req, res) => {
  res.json({
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasPixabayKey: Boolean(process.env.PIXABAY_API_KEY),
  });
});

// Uploads mounted FIRST under /api/projects so its routes (which match
// /:slug/uploads and /:slug/uploads/:filename) take precedence.
app.use('/api/projects', uploadsRouter);
app.use('/api/projects', faviconRouter);
app.use('/api/projects', ogImageRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/crawl', crawlRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
app.use('/api/app-state', appStateRouter);
app.use('/api/pixabay', pixabayRouter);
app.use('/api/inline', inlineRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
ensureProjectsDir().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`[backend] listening on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[backend] WARNING: ANTHROPIC_API_KEY is not set in .env');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[backend] Port ${PORT} is in use. Run: lsof -ti :${PORT} | xargs kill -9`);
      process.exit(1);
    }
    throw err;
  });

  // Release the port immediately on shutdown so `node --watch` restarts and
  // `Ctrl+C` followed by a fresh `npm start` don't race on EADDRINUSE.
  // `closeAllConnections()` (Node 18.2+) is the critical bit — without it,
  // open SSE chat streams keep TCP sockets bound to the port for seconds
  // after the process is told to exit.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    // Hard exit if a connection somehow refuses to drop within 2s.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
