import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getAnthropic, resolveModel, SYSTEM_PROMPT, ITERATION_SYSTEM_PROMPT, MULTI_PAGE_WORKFLOW, INLINE_SYSTEM_PROMPT, pickRandomArchetype, detectArchetypeInPrompt, pickRandomHeroArchetype, detectHeroArchetypeInPrompt, isPromptCachingEnabled } from '../anthropic.js';
import { detectMissingPages, extractPlannedPages, parseFileBlocks } from '../parseFiles.js';
import { parsePatchBlocks, applyPatches, parseRegionBlocks, applyRegions, parseInlineBlocks, applyInlineBlocks } from '../parsePatch.js';
import { extractSearchTerms, evaluateImageIntent, buildImagePool, formatPoolForPrompt, cleanupUnusedImages, listExistingPool } from '../pixabay.js';
import { evaluateSiteImageIntent, resolveTargetUrl, crawlPageImages, buildSiteImagePool } from '../siteImages.js';

const router = Router();

// Extract the first balanced <tag>...</tag> from an HTML string, honoring
// nesting. Returns the element source (including tags) or null. Used to build a
// compact cross-page structural reference so REGION edits to header/footer can
// be done without dumping whole pages into context.
function extractElement(html, tag) {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  const open = openRe.exec(html);
  if (!open) return null;
  const start = open.index;
  let depth = 1;
  let pos = open.index + open[0].length;
  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return null;
    if (o && o.index < c.index) { depth++; pos = o.index + o[0].length; }
    else { depth--; pos = c.index + c[0].length; if (depth === 0) return html.slice(start, pos); }
  }
  return null;
}

// Build a small reference block of a page's themeable/structural elements
// (header, footer, :root tokens) so the model can REGION-edit them on pages
// whose full body isn't in context. Returns '' when nothing notable is found.
function buildStructureReference(name, html) {
  const parts = [];
  const header = extractElement(html, 'header');
  if (header) parts.push(header);
  const footer = extractElement(html, 'footer');
  if (footer) parts.push(footer);
  const rootMatch = html.match(/:root\s*\{[^}]*\}/i);
  if (rootMatch) parts.push(`<style>\n${rootMatch[0]}\n</style>`);
  if (parts.length === 0) return '';
  return `\n<!-- STRUCTURE REFERENCE: ${name} (header / footer / :root only — full body omitted) -->\n${parts.join('\n')}\n`;
}

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
    console.log(`[chat] POST received — model=${model} messages=${messages?.length} hasContext=${!!context} hasCrawledData=${!!context?.crawledData} currentPages=${currentPageCount} inlineScope=${!!inlineScope} scope=${context?.scope || 'none'}`);
    const client = getAnthropic();
    const resolvedModel = resolveModel(model);
    const jobId = randomUUID();

    const isFirstGeneration = !context?.currentPages || Object.keys(context.currentPages).length === 0;
    const isInlineEdit = !!inlineScope && typeof inlineScope.path === 'string' && typeof inlineScope.page === 'string';

    // Chat scope: which conversation thread this turn belongs to.
    //   '__site' — project-wide / cross-page conversation (theme, header, footer, :root, nav)
    //   '<page.html>' — scoped to a specific page
    // The scope drives a dynamic system-prompt block telling the model the
    // expected blast radius of this turn. Defaults to '__site' for back-compat
    // with older clients that don't send a scope.
    const rawScope = typeof context?.scope === 'string' ? context.scope : null;
    const chatScope = isInlineEdit
      ? null
      : (rawScope === '__site' || (rawScope && context?.currentPages && context.currentPages[rawScope]))
        ? rawScope
        : '__site';

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

    // Three tiers of system prompt to keep iteration turns cheap:
    //   - INLINE_SYSTEM_PROMPT: inline-edit turns (single scoped element).
    //   - SYSTEM_PROMPT + MULTI_PAGE_WORKFLOW: first generation only — when
    //     the model is making the foundational design decisions (archetypes,
    //     IA, multi-page plan, nav style, contact form scaffolding).
    //   - ITERATION_SYSTEM_PROMPT: every other turn. Drops the first-gen
    //     guidance (~2.5-3k tokens saved per turn) since the existing pages
    //     already encode those decisions and are in context as reference.
    let cachedSystem;
    if (isInlineEdit) {
      cachedSystem = INLINE_SYSTEM_PROMPT;
    } else if (isFirstGeneration) {
      cachedSystem = SYSTEM_PROMPT + MULTI_PAGE_WORKFLOW;
    } else {
      cachedSystem = ITERATION_SYSTEM_PROMPT;
    }
    // Crawled intake data is large (often 50k+ tokens). It's the source
    // material the first generation rewrites copy from — after that, its
    // content lives in the rendered HTML already in context. Re-sending it
    // on every iteration was the dominant token cost (87k+ for a "replace
    // the logo" turn). Include it on first generation (no pages exist yet,
    // the model needs the source) or when the user explicitly ticks the
    // "Include crawled site data" checkbox for a turn that genuinely needs
    // it (e.g. "build an interior About page from the crawl").
    const includeCrawl = !!context?.crawledData && (isFirstGeneration || context?.includeCrawlData);
    if (includeCrawl) {
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
      dynamicSystem += `\n\n--- INLINE EDIT SCOPE ---\nThe user is editing a single <${tag || 'element'}> element.\n  page: ${page}\n  selectorPath: ${path}\n  breadcrumb: ${breadcrumb || '(unknown)'}\n\nCurrent element outerHTML:\n${outerHTML || '(missing)'}\n\nEmit exactly one INLINE block with header \`<!-- INLINE: ${path} in ${page} -->\` and a single replacement element. Keep the same <${tag}> root tag by default, but if the user explicitly asks to swap this element for a different element type (e.g. replace a link with an <iframe> map/video embed), emit that new root tag instead. No FILE/EDIT/REGION/PATCH blocks this turn.`;
    }

    // Inject random layout + hero archetypes for first generations when the
    // user prompt doesn't already specify them. This gives the model concrete
    // structural starting points instead of defaulting to the same patterns.
    if (isFirstGeneration && !isInlineEdit) {
      const userText = (messages || [])
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : '')
        .join(' ');
      let injectedLayout = null;
      if (!detectArchetypeInPrompt(userText)) {
        const archetype = pickRandomArchetype();
        injectedLayout = archetype;
        dynamicSystem += `\n\n--- LAYOUT ARCHETYPE ---\nNo archetype was specified in the prompt. If the prompt contains enough design direction for you to choose a better-fit archetype from the catalog, do so and name it in your commentary. Otherwise, use: **${archetype}**. Adapt it to the business — it's a structural starting point, not a rigid spec.\n\nReminder: before generating HTML, state your IA decisions in the commentary — page structure (single/multi), what pages or sections you're building, and any changes from the existing site's structure. Then state which archetype you're using.`;
        console.log(`[chat] injected random archetype: ${archetype}`);
      }
      if (!detectHeroArchetypeInPrompt(userText)) {
        const hero = pickRandomHeroArchetype(injectedLayout);
        dynamicSystem += `\n\n--- HERO ARCHETYPE ---\nNo hero archetype was specified. Use: **${hero}**. Adapt it to the business and content. Name the hero archetype in your commentary alongside the layout archetype.`;
        console.log(`[chat] injected random hero archetype: ${hero}`);
      }
    }

    if (context?.activePage) {
      dynamicSystem += `\n\n--- ACTIVE CONTEXT ---\nThe user is currently viewing "${context.activePage}" in the design preview. If they ask for changes without specifying a page, assume they mean this page.`;
    }
    if (chatScope === '__site') {
      dynamicSystem += `\n\n--- CHAT SCOPE: PROJECT-WIDE ---\nThis turn is in the project's Main Chat — a dedicated thread for cross-page work. Prefer changes that span pages (theme/\`:root\` token swaps, REGION edits to header / footer / nav, site-wide copy voice). When the user asks for a global change (e.g. "make the header larger", "swap the primary color", "add a logo to every page"), use REGION blocks targeting \`*.html\` or per-file REGION blocks rather than touching one page at a time. Single-page edits ARE still allowed when the user explicitly asks for them ("only on the contact page"), but the default for ambiguous requests in Main Chat is project-wide.`;
    } else if (chatScope) {
      dynamicSystem += `\n\n--- CHAT SCOPE: ${chatScope} ---\nThis turn is in the chat thread for **${chatScope}**. Default to changes scoped to this single page. Cross-page changes are allowed when the user explicitly asks for them or when a single-page edit would break shared chrome (e.g. adding a new nav link requires updating every page's header) — in that case, briefly note in your commentary that you're also touching other pages and why.`;
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
        // Compact cross-page structural reference: for omitted pages (main chat,
        // pageContext !== 'all'), include just their header/footer/:root. This
        // is a few hundred tokens per page instead of the full body, and lets
        // the model do correct REGION edits to shared chrome (e.g. "add this
        // logo to the header on both pages") without re-emitting whole pages —
        // the #1 cause of slow, token-heavy turns for tiny header changes.
        if (!isInlineEdit && pageContext !== 'all' && otherNames.length > 0) {
          let structureRef = '';
          for (const name of otherNames) {
            const html = allPages[name];
            if (typeof html === 'string') structureRef += buildStructureReference(name, html);
          }
          if (structureRef) {
            dynamicSystem += `\n--- OTHER PAGES: STRUCTURE REFERENCE ---\nThe full body of ${otherNames.join(', ')} is omitted to save tokens, but their shared chrome is below so you can sync it. For a change to the header/footer/:root that spans pages, emit REGION blocks (one per file when the elements differ between pages, copying each page's own element from here) — do NOT rewrite these pages in FULL FILE MODE just to sync a header/footer/logo/token change.\n${structureRef}`;
          }
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

    // Prompt caching is opt-out via PROMPT_CACHING=off (env is the master
    // kill-switch). When enabled at the env level, we still gate per-request:
    // caching only earns its keep when the cached prefix gets read multiple
    // times. Cache writes cost ~1.25x normal input; reads cost ~0.1x —
    // break-even is 2-3 reads of the same prefix.
    //
    // Skip caching for:
    //   - first generation: one-shot write that's never re-read at this prefix
    //   - inline edits: different prompt (INLINE_SYSTEM_PROMPT) + short turns
    //   - the index.html page thread: the "first-page paint + tools" workspace
    //     where iteration usually happens via direct-edit tools, not chat
    //
    // Cache ON for: Main Chat (cross-page work, repeated visits) and non-index
    // page threads (same cached prefix shared across page generations + edits).
    const envCachingOn = isPromptCachingEnabled();
    const cachingOn = envCachingOn
      && !isFirstGeneration
      && !isInlineEdit
      && chatScope !== 'index.html';
    const systemBlocks = [
      cachingOn
        ? { type: 'text', text: cachedSystem, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: cachedSystem },
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
        let pagesAfterPatches = pagesAfterRegions;
        if (Object.keys(edits).length > 0) {
          const r = applyPatches(pagesAfterRegions, edits);
          r.failed.forEach(f => failedFiles.add(f.filename));
          pagesAfterPatches = r.updatedPages;
        }
        // Corruption check: a patch's REPLACE side occasionally contains leftover
        // `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` markers, dumping them
        // into the saved file and silently breaking the page. Detect and force
        // a clean FULL FILE rewrite of the affected file(s).
        const CORRUPTION_RE = /^[ \t]*(<{5,}\s*SEARCH|>{5,}\s*REPLACE|={7,}\s*$)/m;
        for (const [filename, content] of Object.entries(pagesAfterPatches)) {
          const original = currentPages[filename] || '';
          if (CORRUPTION_RE.test(content) && !CORRUPTION_RE.test(original)) {
            failedFiles.add(filename);
          }
        }
        console.log(`[chat] recovery-check edits=${Object.keys(edits).length} regions=${regions.length} pages=${Object.keys(currentPages).length} failed=${[...failedFiles].join(',') || 'none'}`);
        if (failedFiles.size > 0) {
          const list = [...failedFiles];
          const followUpMessages = [
            ...messages,
            { role: 'assistant', content: assistantSoFar },
            {
              role: 'user',
              content: `Your patch block(s) for ${list.join(', ')} couldn't be applied cleanly (either the SEARCH text didn't byte-match the current file, the REGION target element wasn't found, or the resulting file contains leftover \`<<<<<<< SEARCH\` / \`=======\` / \`>>>>>>> REPLACE\` markers from a malformed REPLACE block). Re-emit the affected file(s) in FULL FILE MODE — complete \`<!-- FILE: filename -->\` block(s) with the full \`<!DOCTYPE html>\`…\`</html>\` document, with all of your intended changes already applied. The emitted HTML must contain NO patch-marker text whatsoever. Only emit the file(s) listed; do NOT touch any others.`,
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
      console.log(`[chat] model=${resolvedModel} caching=${cachingOn ? 'on' : 'off'} parts=${partsCount} stop=${stats.stopReason} in=${stats.usage.input_tokens} out=${stats.usage.output_tokens} cache_write=${stats.usage.cache_creation_input_tokens} cache_read=${stats.usage.cache_read_input_tokens}`);
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
