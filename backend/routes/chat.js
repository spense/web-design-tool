import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getAnthropic, resolveModel, SYSTEM_PROMPT, MULTI_PAGE_WORKFLOW, pickRandomArchetype, detectArchetypeInPrompt } from '../anthropic.js';
import { detectMissingPages, extractPlannedPages, parseFileBlocks } from '../parseFiles.js';
import { parsePatchBlocks, applyPatches, parseRegionBlocks, applyRegions } from '../parsePatch.js';
import { extractSearchTerms, buildImagePool, formatPoolForPrompt, cleanupUnusedImages, listExistingPool } from '../pixabay.js';

const router = Router();

// In-memory job store: survives client disconnects and tab switches.
const jobs = new Map();

const MAX_PAGES_PER_GENERATION = 10;

router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json({ status: job.status, result: job.result || null, error: job.error || null });
});

router.post('/', async (req, res, next) => {
  try {
    const { model, messages, context } = req.body || {};
    console.log(`[chat] POST received — model=${model} messages=${messages?.length} hasContext=${!!context} hasCrawledData=${!!context?.crawledData} hasCurrentPages=${!!context?.currentPages}`);
    const client = getAnthropic();
    const resolvedModel = resolveModel(model);
    const jobId = randomUUID();

    const isFirstGeneration = !context?.currentPages || Object.keys(context.currentPages).length === 0;
    let cachedSystem = SYSTEM_PROMPT;
    if (isFirstGeneration) cachedSystem += MULTI_PAGE_WORKFLOW;
    if (context?.crawledData) {
      cachedSystem += `\n\n--- INTAKE DATA (crawled from ${context.crawledData.startUrl}) ---\n${JSON.stringify(context.crawledData, null, 2)}`;
    }

    let dynamicSystem = '';

    // Inject a random layout archetype for first generations when the user
    // prompt doesn't already specify one. This gives the model a concrete
    // structural starting point instead of defaulting to the same pattern.
    if (isFirstGeneration) {
      const userText = (messages || [])
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join(' ');
      if (!detectArchetypeInPrompt(userText)) {
        const archetype = pickRandomArchetype();
        dynamicSystem += `\n\n--- LAYOUT ARCHETYPE ---\nNo archetype was specified in the prompt. If the prompt contains enough design direction for you to choose a better-fit archetype from the catalog, do so and name it in your commentary. Otherwise, use: **${archetype}**. Adapt it to the business — it's a structural starting point, not a rigid spec.\n\nReminder: before generating HTML, state your IA decisions in the commentary — page structure (single/multi), what pages or sections you're building, and any changes from the existing site's structure. Then state which archetype you're using.`;
        console.log(`[chat] injected random archetype: ${archetype}`);
      }
    }

    if (context?.activePage) {
      dynamicSystem += `\n\n--- ACTIVE CONTEXT ---\nThe user is currently viewing "${context.activePage}" in the design preview. If they ask for changes without specifying a page, assume they mean this page.`;
    }
    if (context?.currentPages && Object.keys(context.currentPages).length > 0) {
      dynamicSystem += `\n\n--- CURRENT DESIGN ---\nThe project currently contains these files: ${Object.keys(context.currentPages).join(', ')}.\nWhen iterating with PATCH MODE, your SEARCH blocks must be byte-exact matches against the file contents below.\n`;
      for (const [name, content] of Object.entries(context.currentPages)) {
        dynamicSystem += `\n<!-- CURRENT FILE: ${name} -->\n${content}\n`;
      }
    }

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

    const safeWriteEarly = (chunk) => {
      if (!res.writableEnded) { try { res.write(chunk); } catch {} }
    };

    // Pixabay image pool: search and download before generation starts.
    if (process.env.PIXABAY_API_KEY && context?.slug) {
      try {
        const lastUserMsg = [...(messages || [])].reverse().find(m => m.role === 'user');
        let lastUserText = '';
        let hasAttachments = false;
        if (typeof lastUserMsg?.content === 'string') {
          lastUserText = lastUserMsg.content;
        } else if (Array.isArray(lastUserMsg?.content)) {
          lastUserText = lastUserMsg.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
          hasAttachments = lastUserText.includes('user has attached');
        }
        const imageKeywords = !hasAttachments && /\b(image|photo|picture|background|gallery|hero|illustration|video|imagery|photos|images|unsplash|pixabay)\b/i.test(lastUserText);

        const existing = isFirstGeneration ? [] : await listExistingPool(context.slug);
        const needsNewImages = isFirstGeneration || imageKeywords;

        if (needsNewImages) {
          safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'searching' })}\n\n`);
          const searchTerms = await extractSearchTerms(context.crawledData, userText);
          console.log(`[chat] pixabay search terms: ${searchTerms.join(', ')}`);
          const pool = await buildImagePool(context.slug, searchTerms);
          const combined = [...existing, ...pool.filter(p => !existing.some(e => e.path === p.path))];
          if (combined.length > 0) {
            dynamicSystem += formatPoolForPrompt(combined);
          }
        } else if (existing.length > 0) {
          dynamicSystem += formatPoolForPrompt(existing);
        }
      } catch (err) {
        console.error('[chat] pixabay image pool failed, continuing without:', err.message);
      }
    }

    const systemBlocks = [
      { type: 'text', text: cachedSystem, cache_control: { type: 'ephemeral' } },
    ];
    if (dynamicSystem) systemBlocks.push({ type: 'text', text: dynamicSystem });

    let clientConnected = true;
    req.on('close', () => { clientConnected = false; });

    const safeWrite = (chunk) => {
      if (clientConnected && !res.writableEnded) {
        try { res.write(chunk); } catch {}
      }
    };

    // Aggregated state across one or more model turns (multi-page generation
    // splits a single user request across follow-up turns to avoid output-token
    // truncation — see SYSTEM_PROMPT). The client sees one continuous stream.
    const aggregateUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    let lastStopReason = null;
    let partsCount = 0;

    // Run one streaming turn; appends deltas to job.fullText and the SSE stream.
    // Returns the assistant text from THIS turn (so we can build follow-up
    // message history) and the stop reason.
    const runTurn = async (turnMessages) => {
      const stream = client.messages.stream({
        model: resolvedModel,
        max_tokens: 64000,
        system: systemBlocks,
        messages: turnMessages,
      });
      let turnText = '';
      stream.on('text', (delta) => {
        turnText += delta;
        job.fullText += delta;
        safeWrite(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
      });
      const finalMessage = await stream.finalMessage();
      const usage = finalMessage.usage || {};
      aggregateUsage.input_tokens += usage.input_tokens ?? 0;
      aggregateUsage.output_tokens += usage.output_tokens ?? 0;
      aggregateUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
      aggregateUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
      lastStopReason = finalMessage.stop_reason || null;
      partsCount += 1;
      return { turnText, stopReason: lastStopReason };
    };

    try {
      // Turn 1: the user's actual request.
      const first = await runTurn(messages);

      // Multi-page follow-ups: only safe to continue if the first turn ended
      // cleanly (end_turn). If it hit max_tokens, the index.html itself is
      // truncated — bail and let the frontend surface the truncation.
      let assistantSoFar = first.turnText;
      if (first.stopReason === 'end_turn') {
        const existing = { ...(context?.currentPages || {}) };
        // Determine which additional pages to generate. Prefer the explicit
        // `<!-- PAGES: ... -->` declaration from the model; fall back to nav
        // link inference for cases where the model omitted the marker.
        const computeMissing = () => {
          const { files: generated } = parseFileBlocks(job.fullText);
          const have = new Set([...Object.keys(existing), ...Object.keys(generated)]);
          const declared = extractPlannedPages(job.fullText).filter(p => !have.has(p));
          const fromNav = detectMissingPages(job.fullText, existing).filter(p => !declared.includes(p));
          return [...declared, ...fromNav];
        };
        let missing = computeMissing();
        let safety = 0;
        while (missing.length > 0 && safety < MAX_PAGES_PER_GENERATION && clientConnected) {
          const nextPage = missing[0];
          const followUpMessages = [
            ...messages,
            { role: 'assistant', content: assistantSoFar },
            { role: 'user', content: `Generate the next page: ${nextPage}. Emit ONLY this one file in FULL FILE MODE, with the same nav/header/footer markup, same :root tokens, and same Google Fonts as the pages already generated. Keep prose minimal.` },
          ];
          const turn = await runTurn(followUpMessages);
          assistantSoFar += turn.turnText;
          // Stop expanding if this turn truncated — the new page is broken.
          if (turn.stopReason !== 'end_turn') break;
          safety += 1;
          missing = computeMissing();
        }
      }

      // PATCH-mode auto-recovery: if the model emitted EDIT blocks whose SEARCH
      // text doesn't match the current file (a known LLM failure mode), ask it
      // for a FULL FILE MODE rewrite of the failing file(s). One retry max — if
      // it still fails, the frontend surfaces the original patch error.
      if (lastStopReason === 'end_turn' && clientConnected) {
        const currentPages = context?.currentPages || {};
        const { edits } = parsePatchBlocks(job.fullText);
        const regions = parseRegionBlocks(job.fullText);
        const failedFiles = new Set();
        let pagesAfterRegions = currentPages;
        if (regions.length > 0) {
          const r = applyRegions(currentPages, regions);
          r.failed.forEach(f => failedFiles.add(f.filename));
          pagesAfterRegions = r.updatedPages;
        }
        if (Object.keys(edits).length > 0) {
          const { failed } = applyPatches(pagesAfterRegions, edits);
          failed.forEach(f => failedFiles.add(f.filename));
        }
        console.log(`[chat] recovery-check edits=${Object.keys(edits).length} regions=${regions.length} pages=${Object.keys(currentPages).length} failed=${[...failedFiles].join(',') || 'none'}`);
        if (failedFiles.size > 0) {
          const list = [...failedFiles];
          const followUpMessages = [
            ...messages,
            { role: 'assistant', content: assistantSoFar },
            {
              role: 'user',
              content: `Your patch block(s) for ${list.join(', ')} couldn't be applied (either the SEARCH text didn't byte-match the current file, or the REGION target element wasn't found). Re-emit the affected file(s) in FULL FILE MODE — complete \`<!-- FILE: filename -->\` block(s) with the full \`<!DOCTYPE html>\`…\`</html>\` document, with all of your intended changes already applied. Only emit the file(s) listed; do NOT touch any others.`,
            },
          ];
          const turn = await runTurn(followUpMessages);
          assistantSoFar += turn.turnText;
        }
      }

      // Clean up unused Pixabay images after generation.
      if (process.env.PIXABAY_API_KEY && context?.slug) {
        try {
          const currentPages = context?.currentPages || {};
          const { files: newFiles } = parseFileBlocks(job.fullText);
          const regions = parseRegionBlocks(job.fullText);
          let mergedPages = { ...currentPages, ...newFiles };
          if (regions.length > 0) {
            mergedPages = applyRegions(mergedPages, regions).updatedPages;
          }
          const { edits } = parsePatchBlocks(job.fullText);
          if (Object.keys(edits).length > 0) {
            mergedPages = applyPatches(mergedPages, edits).updatedPages;
          }
          await cleanupUnusedImages(context.slug, mergedPages);
        } catch (err) {
          console.error('[chat] pixabay cleanup failed:', err.message);
        }
      }

      const stats = {
        text: job.fullText,
        stopReason: lastStopReason,
        usage: aggregateUsage,
        partsCount,
      };
      console.log(`[chat] model=${resolvedModel} parts=${partsCount} stop=${stats.stopReason} in=${stats.usage.input_tokens} out=${stats.usage.output_tokens} cache_write=${stats.usage.cache_creation_input_tokens} cache_read=${stats.usage.cache_read_input_tokens}`);
      job.status = 'done';
      job.result = stats;
      safeWrite(`event: done\ndata: ${JSON.stringify(stats)}\n\n`);
      if (!res.writableEnded) try { res.end(); } catch {}
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      safeWrite(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
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
