import { Router } from 'express';
import { getAnthropic, resolveModel, SYSTEM_PROMPT } from '../anthropic.js';

const router = Router();

// Streaming chat: forwards Anthropic SSE to the client.
// Body: { model: 'sonnet'|'opus'|'haiku', messages: [{role,content}], context: {...} }
router.post('/', async (req, res, next) => {
  try {
    const { model, messages, context } = req.body || {};
    const client = getAnthropic();

    let systemPrompt = SYSTEM_PROMPT;
    if (context?.crawledData) {
      systemPrompt += `\n\n--- INTAKE DATA (crawled from ${context.crawledData.startUrl}) ---\n${JSON.stringify(context.crawledData, null, 2)}`;
    }
    if (context?.activePage) {
      systemPrompt += `\n\n--- ACTIVE CONTEXT ---\nThe user is currently viewing "${context.activePage}" in the design preview. If they ask for changes without specifying a page, assume they mean this page.`;
    }
    if (context?.currentPages && Object.keys(context.currentPages).length > 0) {
      systemPrompt += `\n\n--- CURRENT DESIGN ---\nThe project currently contains these files: ${Object.keys(context.currentPages).join(', ')}.\nWhen iterating, output the COMPLETE updated HTML for any file you change. You may include the full current HTML below for reference:\n`;
      for (const [name, content] of Object.entries(context.currentPages)) {
        systemPrompt += `\n<!-- CURRENT FILE: ${name} -->\n${content}\n`;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const stream = await client.messages.stream({
      model: resolveModel(model),
      max_tokens: 16000,
      system: systemPrompt,
      messages,
    });

    let fullText = '';
    stream.on('text', (delta) => {
      fullText += delta;
      res.write(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
    });
    stream.on('error', (err) => {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
    stream.on('end', () => {
      res.write(`event: done\ndata: ${JSON.stringify({ text: fullText })}\n\n`);
      res.end();
    });

    req.on('close', () => {
      try { stream.controller?.abort(); } catch {}
    });
  } catch (e) {
    if (!res.headersSent) return next(e);
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

export default router;
