import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getAnthropic, resolveModel, SYSTEM_PROMPT } from '../anthropic.js';

const router = Router();

// In-memory job store: survives client disconnects and tab switches.
const jobs = new Map();

router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json({ status: job.status, result: job.result || null, error: job.error || null });
});

router.post('/', async (req, res, next) => {
  try {
    const { model, messages, context } = req.body || {};
    const client = getAnthropic();
    const jobId = randomUUID();

    let cachedSystem = SYSTEM_PROMPT;
    if (context?.crawledData) {
      cachedSystem += `\n\n--- INTAKE DATA (crawled from ${context.crawledData.startUrl}) ---\n${JSON.stringify(context.crawledData, null, 2)}`;
    }

    let dynamicSystem = '';
    if (context?.activePage) {
      dynamicSystem += `\n\n--- ACTIVE CONTEXT ---\nThe user is currently viewing "${context.activePage}" in the design preview. If they ask for changes without specifying a page, assume they mean this page.`;
    }
    if (context?.currentPages && Object.keys(context.currentPages).length > 0) {
      dynamicSystem += `\n\n--- CURRENT DESIGN ---\nThe project currently contains these files: ${Object.keys(context.currentPages).join(', ')}.\nWhen iterating with PATCH MODE, your SEARCH blocks must be byte-exact matches against the file contents below.\n`;
      for (const [name, content] of Object.entries(context.currentPages)) {
        dynamicSystem += `\n<!-- CURRENT FILE: ${name} -->\n${content}\n`;
      }
    }

    const systemBlocks = [
      { type: 'text', text: cachedSystem, cache_control: { type: 'ephemeral' } },
    ];
    if (dynamicSystem) systemBlocks.push({ type: 'text', text: dynamicSystem });

    const job = { status: 'running', fullText: '', result: null, error: null };
    jobs.set(jobId, job);
    // Expire job after 10 minutes regardless of outcome.
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Send jobId first so the client can poll if the connection drops.
    res.write(`event: jobId\ndata: ${JSON.stringify({ jobId })}\n\n`);

    let clientConnected = true;
    req.on('close', () => { clientConnected = false; });

    const safeWrite = (chunk) => {
      if (clientConnected && !res.writableEnded) {
        try { res.write(chunk); } catch {}
      }
    };

    const stream = client.messages.stream({
      model: resolveModel(model),
      max_tokens: 32000,
      system: systemBlocks,
      messages,
    });

    stream.on('text', (delta) => {
      job.fullText += delta;
      safeWrite(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
    });

    stream.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
      safeWrite(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      if (!res.writableEnded) try { res.end(); } catch {}
    });

    try {
      const finalMessage = await stream.finalMessage();
      const usage = finalMessage.usage || {};
      const stats = {
        text: job.fullText,
        stopReason: finalMessage.stop_reason || null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        },
      };
      console.log(`[chat] model=${resolveModel(model)} stop=${stats.stopReason} in=${stats.usage.input_tokens} out=${stats.usage.output_tokens} cache_write=${stats.usage.cache_creation_input_tokens} cache_read=${stats.usage.cache_read_input_tokens}`);
      job.status = 'done';
      job.result = stats;
      safeWrite(`event: done\ndata: ${JSON.stringify(stats)}\n\n`);
      if (!res.writableEnded) try { res.end(); } catch {}
    } catch (err) {
      if (!res.writableEnded) try { res.end(); } catch {}
    }
  } catch (e) {
    if (!res.headersSent) return next(e);
    if (!res.writableEnded) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      } catch {}
    }
  }
});

export default router;
