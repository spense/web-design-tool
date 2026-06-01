import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getAnthropic, resolveModel, SYSTEM_PROMPT, MULTI_PAGE_WORKFLOW, INLINE_MODE, pickRandomArchetype, detectArchetypeInPrompt } from '../anthropic.js';
import { detectMissingPages, extractPlannedPages, parseFileBlocks } from '../parseFiles.js';
import { parsePatchBlocks, applyPatches, parseRegionBlocks, applyRegions, parseInlineBlocks, applyInlineBlocks } from '../parsePatch.js';
import { extractSearchTerms, evaluateImageIntent, buildImagePool, formatPoolForPrompt, cleanupUnusedImages, listExistingPool } from '../pixabay.js';
import { evaluateSiteImageIntent, resolveTargetUrl, crawlPageImages, buildSiteImagePool } from '../siteImages.js';

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
    const { model, messages, context, inlineScope } = req.body || {};
    const currentPageCount = context?.currentPages ? Object.keys(context.currentPages).length : 0;
    console.log(`[chat] POST received — model=${model} messages=${messages?.length} hasContext=${!!context} hasCrawledData=${!!context?.crawledData} currentPages=${currentPageCount} inlineScope=${!!inlineScope}`);
    const client = getAnthropic();
    const resolvedModel = resolveModel(model);
    const jobId = randomUUID();

    const isFirstGeneration = !context?.currentPages || Object.keys(context.currentPages).length === 0;
    const isInlineEdit = !!inlineScope && typeof inlineScope.path === 'string' && typeof inlineScope.page === 'string';

    // Page-context tier — how much of the project's HTML to include in the
    // system prompt this turn. The frontend picks this based on mode and a
    // per-prompt "Include … context" checkbox:
    //   'none'    — no page dump (default for inline edits — element scope is enough)
    //   'current' — only the active/scoped page (default for main chat)
    //   'all'     — every page (opt-in; needed for cross-page work)
    // Falls back to legacy 'all' if an old client doesn't send the field.
    const pageContext = (context?.pageContext === 'none' || context?.pageContext === 'current' || context?.pageContext === 'all')
      ? context.pageContext
      : 'all';

    let cachedSystem = SYSTEM_PROMPT;
    if (isFirstGeneration) cachedSystem += MULTI_PAGE_WORKFLOW;
    if (isInlineEdit) cachedSystem += INLINE_MODE;
    if (context?.crawledData) {
      cachedSystem += `\n\n--- INTAKE DATA (crawled from ${context.crawledData.startUrl}) ---\n${JSON.stringify(context.crawledData, null, 2)}`;
    }
    // Design brief: the project's original ask. Stays in the cached system
    // block so it survives Clear context (which only slices the user/assistant
    // message history) and so subsequent turns hit cache. The frontend derives
    // this from the first user message in the session, regardless of clear markers.
    if (context?.designBrief && typeof context.designBrief === 'string' && context.designBrief.trim()) {
      cachedSystem += `\n\n--- DESIGN BRIEF (original project ask) ---\n${context.designBrief.trim()}`;
    }

    let dynamicSystem = '';

    // Inline-edit scope: tell the model exactly which element to modify.
    if (isInlineEdit) {
      const { path, page, outerHTML, tag, breadcrumb } = inlineScope;
      dynamicSystem += `\n\n--- INLINE EDIT SCOPE ---\nThe user is editing a single <${tag || 'element'}> element.\n  page: ${page}\n  selectorPath: ${path}\n  breadcrumb: ${breadcrumb || '(unknown)'}\n\nCurrent element outerHTML:\n${outerHTML || '(missing)'}\n\nEmit exactly one INLINE block with header \`<!-- INLINE: ${path} in ${page} -->\` and a single replacement element whose root tag is <${tag}>. No FILE/EDIT/REGION/PATCH blocks this turn.`;
    }

    // Inject a random layout archetype for first generations when the user
    // prompt doesn't already specify one. This gives the model a concrete
    // structural starting point instead of defaulting to the same pattern.
    if (isFirstGeneration && !isInlineEdit) {
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
    if (context?.currentPages && Object.keys(context.currentPages).length > 0 && pageContext !== 'none') {
      const allPages = context.currentPages;
      const allFilenames = Object.keys(allPages);
      let pagesToDump = {};
      if (pageContext === 'all') {
        pagesToDump = allPages;
      } else {
        // 'current' — pick the scoped page (inline) or the active page (main).
        // Fall back to the first file if neither resolves, so the model still
        // has some grounding rather than nothing.
        const target = (isInlineEdit && inlineScope?.page) || context?.activePage || allFilenames[0];
        if (target && allPages[target]) pagesToDump[target] = allPages[target];
      }
      const dumpedNames = Object.keys(pagesToDump);
      if (dumpedNames.length > 0) {
        const otherNames = allFilenames.filter(n => !dumpedNames.includes(n));
        const trimmedNote = pageContext === 'all'
          ? ''
          : (otherNames.length > 0
              ? ` Only the ${isInlineEdit ? 'scoped' : 'active'} page is shown below to save tokens; other files (${otherNames.join(', ')}) are omitted. If the user references those pages and you don't have what you need, ask them to enable "Include all page contexts" and resend.`
              : '');
        if (isInlineEdit) {
          dynamicSystem += `\n\n--- DESIGN REFERENCE (read-only) ---\nThe project contains these files: ${allFilenames.join(', ')}.${trimmedNote}\nThe content below is shown for reference ONLY — to help you match the surrounding design tokens, fonts, and content style. Do NOT emit EDIT/PATCH/REGION/FILE blocks against these files this turn; the runtime will drop them.\n`;
        } else {
          dynamicSystem += `\n\n--- CURRENT DESIGN ---\nThe project contains these files: ${allFilenames.join(', ')}.${trimmedNote}\nWhen iterating with PATCH MODE, your SEARCH blocks must be byte-exact matches against the file contents below.\n`;
        }
        for (const [name, content] of Object.entries(pagesToDump)) {
          dynamicSystem += `\n<!-- CURRENT FILE: ${name} -->\n${content}\n`;
        }
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

    // Image pool: prepare images before generation starts. Two independent
    // sources, both downloaded into uploads/ so assets stay local (they survive
    // export and downstream R2 upload — never reference a remote URL):
    //   1. On-demand SITE-image reuse — pull existing images from a specific
    //      page of the crawled site when the user explicitly asks (e.g. "use
    //      the gallery images from /portfolio"). No Pixabay key required.
    //   2. PIXABAY stock search — first generation always; later turns gated by
    //      a cheap regex pre-filter + Haiku intent check.
    // `searchedThisTurn` tracks whether this turn added images — used below to
    // decide whether to report imageStats. Skipped for inline edits (scoped to
    // one element — not a pool-populating moment).
    let searchedThisTurn = false;
    if (context?.slug && !isInlineEdit) {
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

        const existing = isFirstGeneration ? [] : await listExistingPool(context.slug);
        const maybeAboutImages = !hasAttachments && /\b(image|photo|picture|background|gallery|hero|illustration|video|imagery|photos|images|logo|logos|avatar|avatars|unsplash|pixabay)\b/i.test(lastUserText);
        let poolInjected = false;

        // 1) On-demand site-image reuse. Gate behind the cheap regex, then ask
        // Haiku whether the user wants EXISTING site images and from which page.
        if (maybeAboutImages && context?.crawledData?.startUrl) {
          const siteIntent = await evaluateSiteImageIntent(context.crawledData, lastUserText);
          if (siteIntent.needsSiteImages) {
            const targetUrl = resolveTargetUrl(siteIntent.targetUrl, context.crawledData.startUrl);
            safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'searching' })}\n\n`);
            const found = await crawlPageImages(targetUrl);
            console.log(`[chat] site-image crawl ${targetUrl}: ${found.length} images`);
            const pool = await buildSiteImagePool(context.slug, found);
            if (pool.length > 0) {
              const combined = [...existing, ...pool.filter(p => !existing.some(e => e.path === p.path))];
              const note = siteIntent.placementHint
                ? `The user asked to use existing site images ${siteIntent.placementHint}. The "site-" prefixed entries below are those images.`
                : `The "site-" prefixed entries below are existing images pulled from the user's site at the user's request.`;
              dynamicSystem += formatPoolForPrompt(combined, note);
              searchedThisTurn = true;
              poolInjected = true;
              safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'ready', poolSize: combined.length })}\n\n`);
            }
          }
        }

        // 2) Pixabay stock search (requires API key). Skip if the site-image
        // path already built and injected a pool this turn.
        let needsNewImages = false;
        if (!poolInjected && process.env.PIXABAY_API_KEY) {
          if (isFirstGeneration) {
            needsNewImages = true;
            searchedThisTurn = true;
            safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'searching' })}\n\n`);
            const searchTerms = await extractSearchTerms(context.crawledData, lastUserText);
            console.log(`[chat] pixabay search terms: ${searchTerms.join(', ')}`);
            const pool = await buildImagePool(context.slug, searchTerms);
            if (pool.length > 0) {
              dynamicSystem += formatPoolForPrompt(pool);
              poolInjected = true;
              safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'ready', poolSize: pool.length })}\n\n`);
            }
          } else if (maybeAboutImages) {
            // Regex matched — ask Haiku whether this is actually a request for
            // NEW images or just a layout change involving existing ones.
            const intent = await evaluateImageIntent(context.crawledData, lastUserText);
            needsNewImages = intent.needsImages;
            if (needsNewImages && intent.terms.length > 0) {
              searchedThisTurn = true;
              safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'searching' })}\n\n`);
              console.log(`[chat] pixabay search terms (intent): ${intent.terms.join(', ')}`);
              const pool = await buildImagePool(context.slug, intent.terms);
              const combined = [...existing, ...pool.filter(p => !existing.some(e => e.path === p.path))];
              if (combined.length > 0) {
                dynamicSystem += formatPoolForPrompt(combined);
                poolInjected = true;
                safeWriteEarly(`event: preparingImages\ndata: ${JSON.stringify({ status: 'ready', poolSize: combined.length })}\n\n`);
              }
            }
          }
        }

        // Always surface the existing pool when we didn't inject a fresh one,
        // so the model knows which images are already available.
        if (!poolInjected && existing.length > 0) {
          dynamicSystem += formatPoolForPrompt(existing);
        }
      } catch (err) {
        console.error('[chat] image pool prep failed, continuing without:', err.message);
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
      if (lastStopReason === 'end_turn' && clientConnected && !isInlineEdit) {
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
      // Only run cleanup and report stats when the model actually emitted code
      // changes (FILE/PATCH/REGION blocks). Prose-only responses shouldn't
      // trigger cleanup or show misleading "Used X images" stats.
      //
      // Report imageStats ONLY when this turn actually did image work:
      //   - searchedThisTurn: we ran a Pixabay search and the pool grew, OR
      //   - deleted.length > 0: cleanup actually orphaned + removed images.
      // Otherwise the line "Used N images. Discarded 0" is just noise on
      // every chat turn (notably misleading for inline edits that don't
      // touch images at all).
      //
      // Skip entirely for inline edits: they're scoped to one element and
      // aren't an image-pool moment. Running cleanup here is both irrelevant
      // (it sweeps pre-existing orphans unrelated to the user's request, then
      // reports them as "Discarded N") and risky (an accidental dropped image
      // ref in a re-emitted element would permanently delete the file).
      // Orphans get swept on the next full chat turn instead.
      let imageStats = null;
      if (context?.slug && !isInlineEdit) {
        try {
          const currentPages = context?.currentPages || {};
          const { files: newFiles } = parseFileBlocks(job.fullText);
          const regions = parseRegionBlocks(job.fullText);
          const { edits } = parsePatchBlocks(job.fullText);
          const inlines = parseInlineBlocks(job.fullText);
          const hasCodeChanges = Object.keys(newFiles).length > 0 || regions.length > 0 || Object.keys(edits).length > 0 || inlines.length > 0;

          if (hasCodeChanges) {
            let mergedPages = { ...currentPages, ...newFiles };
            if (regions.length > 0) {
              mergedPages = applyRegions(mergedPages, regions).updatedPages;
            }
            if (Object.keys(edits).length > 0) {
              mergedPages = applyPatches(mergedPages, edits).updatedPages;
            }
            if (inlines.length > 0) {
              mergedPages = applyInlineBlocks(mergedPages, inlines).updatedPages;
            }
            const deleted = await cleanupUnusedImages(context.slug, mergedPages);
            if (searchedThisTurn || deleted.length > 0) {
              const remaining = await listExistingPool(context.slug);
              imageStats = { used: remaining.length, discarded: deleted.length };
            }
          }
        } catch (err) {
          console.error('[chat] pixabay cleanup failed:', err.message);
        }
      }

      const stats = {
        text: job.fullText,
        stopReason: lastStopReason,
        usage: aggregateUsage,
        partsCount,
        imageStats,
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
