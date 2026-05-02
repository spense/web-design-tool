import { Router } from 'express';
import { getAnthropic, resolveModel, SYSTEM_PROMPT } from '../anthropic.js';

const router = Router();

// Streaming chat: forwards Anthropic SSE to the client.
// Body: { model: 'sonnet'|'opus'|'haiku', messages: [{role,content}], context: {...} }
router.post('/', async (req, res, next) => {
  try {
    const { model, messages, context } = req.body || {};
    const client = getAnthropic();

    // Split system into a CACHED prefix (system prompt + crawl data — stable
    // within a project) and an UNCACHED suffix (active page + current pages —
    // changes every turn).
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
    if (dynamicSystem) {
      systemBlocks.push({ type: 'text', text: dynamicSystem });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const stream = client.messages.stream({
      model: resolveModel(model),
      max_tokens: 32000,
      system: systemBlocks,
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

    try {
      const finalMessage = await stream.finalMessage();
      const usage = finalMessage.usage || {};
      const stats = {
        text: fullText,
        stopReason: finalMessage.stop_reason || null,
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        },
      };
      console.log(`[chat] model=${resolveModel(model)} stop=${stats.stopReason} in=${stats.usage.input_tokens} out=${stats.usage.output_tokens} cache_write=${stats.usage.cache_creation_input_tokens} cache_read=${stats.usage.cache_read_input_tokens}`);
      res.write(`event: done\ndata: ${JSON.stringify(stats)}\n\n`);
      res.end();
    } catch (err) {
      // error already sent via stream.on('error') above; ensure response closes
      if (!res.writableEnded) res.end();
    }

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
