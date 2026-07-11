import React, { useEffect, useRef, useState, useCallback } from 'react';
import { streamChat, pollJobResult, api } from '../api.js';
import { parseFileBlocks, detectUrl, isCompleteHtmlDoc } from '../parseFiles.js';
import { parsePatchBlocks, applyPatches, parseRegionBlocks, applyRegions, editStartIndex, designStartIndex, parseInlineBlocks, applyInlineBlocks } from '../parsePatch.js';
import { calculateCost, totalCost, formatCost } from '../pricing.js';
import Spinner from './Spinner.jsx';
import AddPageDialog from './AddPageDialog.jsx';

const MODELS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'sonnet5', label: 'Sonnet 5' },
  { value: 'opus46', label: 'Opus 4.6' },
  { value: 'opus', label: 'Opus 4.7' },
  { value: 'haiku', label: 'Haiku 4.5' },
];
const MODEL_LABELS = Object.fromEntries(MODELS.map(m => [m.value, m.label]));

function formatDuration(secs) {
  if (secs == null) return '';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Mirror of backend SITE_THREAD constant.
const SITE_THREAD = '__site';

export default function ChatPanel({ project, pages, messages, sessionTotal, activePage, activeScope, onScopeChange, onPagesAction, onUpdate, hasApiKey, onStreamingChange, inlineScope, onClearInlineScope, onProjectPatch, onOpenCodePanel }) {
  const [input, setInput] = useState('');
  const [model, setModel] = useState(project.lastModel || 'sonnet');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [imagePoolStatus, setImagePoolStatus] = useState(null); // null | { status: 'searching' } | { status: 'ready', poolSize }
  const [attachments, setAttachments] = useState([]);
  // Per-prompt opt-in to send more project context than the default. In
  // inline mode, default = element-scope only; checking this adds the scoped
  // page. In main chat, default = current page only; checking this adds all
  // pages. Resets after every send so the cheap default is always re-armed.
  const [includeExtraContext, setIncludeExtraContext] = useState(false);
  // Per-prompt opt-in to inject the original crawled site data into the
  // system prompt. Big (often ~50k tokens) so it's OFF by default for
  // iteration turns and only auto-armed for first generation and freshly-
  // added page threads — see the useEffect below. The crawl is preserved
  // on disk regardless; this only controls whether THIS turn sees it.
  const [includeCrawlData, setIncludeCrawlData] = useState(false);
  const messagesRef = useRef(null);
  // Whether the message list is pinned to the bottom. Drives auto-scroll during
  // streaming: true while the user is at/near the bottom, false once they scroll
  // up to read earlier content.
  const stickToBottomRef = useRef(true);
  const panelRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const preSendMessagesRef = useRef(null);
  const preSendProjectRef = useRef(null);
  const jobIdRef = useRef(null);
  const streamStartRef = useRef(null);
  const applyResultRef = useRef(null);
  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;

  // Extract result processing so both send() and the reconnect effect can call it.
  const applyResult = useCallback((result, baseMessages, baseProject, usedModel, elapsedSecs) => {
    const fullText = result.text;
    const usage = result.usage;
    const truncated = result.stopReason === 'max_tokens';

    let regions = parseRegionBlocks(fullText);
    // Strip REGION blocks before running other parsers so they don't leak into prose.
    const textWithoutRegions = fullText.replace(/<!--\s*REGION:[\s\S]*?<!--\s*\/REGION\s*-->/gi, '');
    const inlines = parseInlineBlocks(textWithoutRegions);
    // Strip INLINE blocks (header + body up to next comment / end) so they
    // don't leak into the prose parsers below.
    const textWithoutInlines = stripInlineBlocks(textWithoutRegions);
    let { edits } = parsePatchBlocks(textWithoutInlines);
    let { files, prose: fileProse } = parseFileBlocks(textWithoutInlines);

    // Inline-mode enforcement: when the user is in an inline-scoped turn
    // (selected one element from the preview), the runtime contract is that
    // ONLY the scoped element changes. If the model emitted FILE/EDIT/REGION
    // blocks anyway — usually trying to patch the page stylesheet for things
    // an inline `style=""` can't express (@media, :root tokens, class rules) —
    // drop them. The smaller models (Haiku) silently aim EDIT blocks at the
    // wrong selector and pretend they succeeded; this surfaces those as a
    // visible "switch to main chat" prompt instead of a silent no-op.
    const lastUserMsg = [...baseMessages].reverse().find(m => m.role === 'user');
    const wasInlineTurn = !!lastUserMsg?.inlineScope;
    let droppedOffScope = false;
    if (wasInlineTurn) {
      const offScopeCount = regions.length + Object.keys(edits).length + Object.keys(files).length;
      if (offScopeCount > 0) {
        droppedOffScope = true;
        regions = [];
        edits = {};
        files = {};
      }
    }
    const editFiles = Object.keys(edits);

    const rejectedFiles = [];
    const safeFiles = {};
    for (const [name, html] of Object.entries(files)) {
      if (isCompleteHtmlDoc(html)) {
        safeFiles[name] = html;
      } else {
        rejectedFiles.push(name);
      }
    }
    const fileNames = Object.keys(safeFiles);

    let updatedPages = { ...pages, ...safeFiles };
    let appliedSummary = [];
    const failureMessages = [];

    if (droppedOffScope) {
      const note = inlines.length > 0
        ? `Some changes were dropped — inline mode only applies edits to the scoped element. Page-wide CSS / stylesheet edits (\`@media\`, \`:root\` tokens, class rules) need the main chat: clear the inline selection (the chip below the chat) and resend.`
        : `This change needs to touch the page stylesheet (\`@media\`, \`:root\` tokens, or class rules), which inline mode can't apply. Clear the inline selection (the chip below the chat) and resend the same prompt to make the change in main chat.`;
      failureMessages.push({
        role: 'system',
        content: note,
        timestamp: new Date().toISOString(),
      });
    }

    if (regions.length > 0) {
      const regionResult = applyRegions(updatedPages, regions);
      updatedPages = regionResult.updatedPages;
      const regionTotals = {};
      for (const [name, count] of Object.entries(regionResult.applied)) {
        regionTotals[name] = (regionTotals[name] || 0) + count;
      }
      for (const [name, count] of Object.entries(regionTotals)) {
        appliedSummary.push(`${name} (${count} region${count === 1 ? '' : 's'})`);
      }
      // Suppress region-failure messages for files also rewritten as FULL FILE
      // blocks in the same response (backend auto-recovery rewrote them).
      const supersededByRewrite = new Set(Object.keys(safeFiles));
      const realRegionFailures = regionResult.failed.filter(f => !supersededByRewrite.has(f.filename));
      if (realRegionFailures.length > 0) {
        const lines = realRegionFailures.map(f => {
          if (f.reason === 'not_found') return `  • ${f.filename}: file not found`;
          if (f.reason === 'truncated') return `  • ${f.filename}: <${f.target}> replacement was suspiciously short (${f.newLen} vs ${f.oldLen} chars) — likely abbreviated`;
          return `  • ${f.filename}: no <${f.target}> element to replace`;
        }).join('\n');
        failureMessages.push({
          role: 'system',
          content: `Region replacement failed for:\n${lines}\n\nAsk me to try again, or request a full rewrite of the affected file(s).`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (rejectedFiles.length > 0) {
      const list = rejectedFiles.map(n => `  • ${n}`).join('\n');
      failureMessages.push({
        role: 'system',
        content: `Skipped writing incomplete file(s) (the response was cut off before the page finished):\n${list}\n\nAsk me to regenerate ${rejectedFiles.length === 1 ? 'that page' : 'those pages'}, or break the request into smaller asks.`,
        timestamp: new Date().toISOString(),
      });
    }
    if (truncated) {
      failureMessages.push({
        role: 'system',
        content: `Response hit the output token limit and was truncated. Any partial files above were discarded. Try again with a smaller change, or split the request across multiple turns.`,
        timestamp: new Date().toISOString(),
      });
    }

    if (editFiles.length > 0) {
      const patchResult = applyPatches(updatedPages, edits);
      updatedPages = patchResult.updatedPages;
      for (const [name, count] of Object.entries(patchResult.applied)) {
        appliedSummary.push(`${name} (${count} edit${count === 1 ? '' : 's'})`);
      }
      // Suppress patch-failure messages for any file that was also rewritten as
      // a full FILE block in the same response — that's the backend's auto-recovery
      // flow (orig EDIT failed → server retried with FULL FILE MODE). The full file
      // supersedes the failed patch, so surfacing the patch error would be misleading.
      const supersededByRewrite = new Set(Object.keys(safeFiles));
      const realFailures = patchResult.failed.filter(f => !supersededByRewrite.has(f.filename));
      if (realFailures.length > 0) {
        const failed = realFailures.map(f => `  • ${f.filename}: ${f.reason === 'not_found' ? 'file not found' : "couldn't find SEARCH block"}`).join('\n');
        failureMessages.push({
          role: 'system',
          content: `Patch failed for:\n${failed}\n\nAsk me to try again, or request a full rewrite of the affected file(s).`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (fileNames.length > 0) {
      const wroteNew = fileNames.filter(n => !pages[n]);
      const wroteUpdated = fileNames.filter(n => pages[n]);
      if (wroteNew.length) appliedSummary.push(`new: ${wroteNew.join(', ')}`);
      if (wroteUpdated.length) appliedSummary.push(`rewrote: ${wroteUpdated.join(', ')}`);
    }

    if (inlines.length > 0) {
      const inlineResult = applyInlineBlocks(updatedPages, inlines);
      updatedPages = inlineResult.updatedPages;
      for (const app of inlineResult.applied) {
        appliedSummary.push(`${app.filename} (inline @ ${app.path})`);
      }
      if (inlineResult.failed.length > 0) {
        const lines = inlineResult.failed.map(f => {
          if (f.reason === 'not_found') return `  • ${f.filename}: file not found`;
          return `  • ${f.filename} @ ${f.path}: selector path didn't resolve, or the reply wasn't a single root element`;
        }).join('\n');
        failureMessages.push({
          role: 'system',
          content: `Inline edit failed for:\n${lines}\n\nThe element may have shifted since you opened the prompt. Try selecting again.`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Strip BOTH FILE and EDIT markup from the commentary. fileProse already has
    // FILE blocks removed (including any trailing prose after </html>); running it
    // back through the patch parser removes EDIT blocks too. This keeps a response
    // that mixes FULL FILE MODE (e.g. a new page) and PATCH MODE (edits to an
    // existing page) from leaking raw HTML/SEARCH-REPLACE markup into the chat —
    // neither single parser's prose is clean when both block types are present.
    let prose = parsePatchBlocks(fileProse).prose;
    let displayContent = prose;
    if (!displayContent) {
      const didSomething = editFiles.length > 0 || fileNames.length > 0 || regions.length > 0 || inlines.length > 0;
      displayContent = didSomething
        ? (Object.keys(pages).length > 0 ? 'Design updated.' : 'Design generated.')
        : (droppedOffScope ? 'No inline change made — see note below.' : '(empty response)');
    }

    const assistantMsg = {
      role: 'assistant',
      content: displayContent,
      model: usedModel,
      timestamp: new Date().toISOString(),
      files: appliedSummary,
      usage,
      duration: elapsedSecs,
      imageStats: result.imageStats || null,
    };
    const finalMessages = [...baseMessages, assistantMsg, ...failureMessages];
    const finalProject = {
      ...baseProject,
      modelHistory: [...(baseProject.modelHistory || []), { model: usedModel, at: new Date().toISOString() }],
    };

    onUpdate(updatedPages, finalMessages, finalProject);
    setStreaming(false);
    setStreamingText('');
    setImagePoolStatus(null);
  }, [pages, onUpdate]);

  // Keep a ref so the reconnect effect always calls the latest version.
  applyResultRef.current = applyResult;

  // On mount: reconnect to any in-progress generation that survived a page refresh.
  useEffect(() => {
    const storageKey = `gen:${project.slug}`;
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;
    let info;
    try { info = JSON.parse(stored); } catch { localStorage.removeItem(storageKey); return; }

    // If the session already has an assistant response, the generation completed before refresh.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant') { localStorage.removeItem(storageKey); return; }

    const { jobId, startedAt, model: savedModel } = info;
    jobIdRef.current = jobId;
    streamStartRef.current = startedAt;
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    pollJobResult(jobId, { signal: ctrl.signal })
      .then(result => {
        localStorage.removeItem(storageKey);
        const elapsedSecs = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null;
        applyResultRef.current(result, messages, project, savedModel, elapsedSecs);
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
        localStorage.removeItem(storageKey);
        const errMsg = { role: 'system', content: `Error: ${e.message}`, timestamp: new Date().toISOString() };
        onUpdate(undefined, [...messages, errMsg], project);
        setStreaming(false);
      })
      .finally(() => {
        if (abortRef.current === ctrl) abortRef.current = null;
        jobIdRef.current = null;
        streamStartRef.current = null;
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopStream = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (project?.slug) localStorage.removeItem(`gen:${project.slug}`);
    const elapsedSecs = streamStartRef.current ? Math.floor((Date.now() - streamStartRef.current) / 1000) : null;
    streamStartRef.current = null;
    jobIdRef.current = null;
    setStreaming(false);
    setStreamingText('');
    const stoppedMsg = {
      role: 'assistant',
      kind: 'stopped',
      content: 'Response stopped by user',
      model,
      timestamp: new Date().toISOString(),
      duration: elapsedSecs,
    };
    onUpdate(undefined, [...messages, stoppedMsg], project);
    preSendMessagesRef.current = null;
    preSendProjectRef.current = null;
  };

  const handleAttach = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const newOnes = [];
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|aac|flac|webm|m4a)$/i.test(file.name);
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv|ogv)$/i.test(file.name);
      const isText = file.type.startsWith('text/') || /\.(txt|html?|md)$/i.test(file.name);
      if (!isImage && !isAudio && !isVideo && !isText) continue;
      try {
        if (isImage || isAudio || isVideo) {
          const meta = await api.uploadAsset(project.slug, file);
          newOnes.push({
            id: Math.random().toString(36).slice(2, 10),
            name: meta.filename,
            displayName: file.name,
            kind: isImage ? 'image-ref' : isAudio ? 'audio-ref' : 'video-ref',
            mediaType: meta.mediaType,
            sizeBytes: meta.sizeBytes,
          });
        } else {
          const data = await readAsText(file);
          newOnes.push({
            id: Math.random().toString(36).slice(2, 10),
            name: file.name,
            kind: 'text',
            mediaType: file.type || 'text/plain',
            data,
          });
        }
      } catch (err) {
        console.error('attach failed', err);
        alert(`Couldn't attach ${file.name}: ${err.message}`);
      }
    }
    if (newOnes.length) setAttachments(a => [...a, ...newOnes]);
  };

  const removeAttachment = (id) => setAttachments(a => a.filter(x => x.id !== id));

  // Insert a "Context Cleared" marker. Conversation history stays visible but
  // the next API call only sends messages after this marker. The model still
  // receives current pages via context.currentPages.
  const clearContext = () => {
    const marker = {
      role: 'assistant',
      kind: 'context-clear',
      content: 'Context cleared.',
      timestamp: new Date().toISOString(),
    };
    onUpdate(undefined, [...messages, marker], project);
  };

  // Auto-scroll to the bottom as content streams in — but only while the user
  // is already pinned to the bottom. If they scroll up to read earlier output
  // mid-generation, stop yanking them back down.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages, streamingText, crawling]);

  // Focus the chat input when the user starts (or retargets) an inline prompt
  // via the preview's Select → Prompt action, so they can type immediately.
  useEffect(() => {
    if (inlineScope) textareaRef.current?.focus();
  }, [inlineScope]);

  // Auto-arm the "include extra context" checkbox based on the active scope.
  // - Inline edit: leave alone (element scope is the cheap default).
  // - Main Chat with 2+ pages: ON by default — cross-page work needs all
  //   pages. With only 1 page, OFF (the single page IS the current page —
  //   checking "all" would just duplicate what 'current' already sends).
  // - Page thread with zero messages (freshly added page): ON for the first
  //   turn so the model can see existing pages as templates. Post-send reset
  //   takes it back to OFF since the thread is now populated.
  // - Page thread with messages: OFF (cheap iteration on this page only).
  //
  // The crawl-data checkbox follows similar logic: ON for first generation
  // (no pages exist yet) and for freshly-added page threads (likely "build
  // this page from the crawl"); OFF for iteration turns. The user can tick
  // it manually per-turn when they need it (e.g. "fill the about page from
  // the crawl").
  useEffect(() => {
    if (inlineScope) return;
    const pageCount = Object.keys(pages || {}).length;
    if (activeScope === SITE_THREAD) {
      setIncludeExtraContext(pageCount > 1);
      setIncludeCrawlData(pageCount === 0);
    } else if (messages.length === 0) {
      // Empty page thread — distinguish a freshly-added STUB page (the user
      // needs the model to build the whole thing from scratch, so arm both
      // toggles) from a DUPLICATED / pre-existing page (it already has the
      // template + content, first turn is likely a small tweak — arm nothing).
      // HTML size cleanly separates: stubs are ~300 chars, real pages 10k+.
      const html = pages?.[activeScope] || '';
      const isStub = html.length < 2000;
      setIncludeExtraContext(isStub);
      setIncludeCrawlData(isStub);
    } else {
      setIncludeExtraContext(false);
      setIncludeCrawlData(false);
    }
    // Only re-evaluate when scope changes — don't fire on every message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope]);

  useEffect(() => {
    onStreamingChangeRef.current?.(streaming || crawling || !!imagePoolStatus);
  }, [streaming, crawling, imagePoolStatus]);

  useEffect(() => {
    return () => { onStreamingChangeRef.current?.(false); };
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    const panel = panelRef.current;
    if (!ta || !panel) return;
    ta.style.height = 'auto';
    const max = Math.floor(panel.clientHeight * 0.5);
    const next = Math.min(ta.scrollHeight, max);
    ta.style.height = next + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }, [input]);

  // Re-pin to the bottom when the user sends, so their new message and the
  // incoming response are visible even if they'd scrolled up earlier.
  const handleMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  };

  const send = async () => {
    if (!input.trim() || streaming || !hasApiKey) return;
    stickToBottomRef.current = true;
    const text = input.trim();
    setInput('');

    const url = detectUrl(text);
    let updatedProject = project;
    let crawlMessage = null;

    if (url && project.crawledUrl !== url) {
      setCrawling(true);
      try {
        const crawlData = await api.crawl(url);
        updatedProject = { ...project, crawledUrl: url, crawledData: crawlData };
        const skipped = crawlData.skipped?.length ? `\nSkipped (${crawlData.skipped.length}): ${crawlData.skipped.map(s => s.url).join(', ')}` : '';
        crawlMessage = {
          role: 'system',
          content: `Crawled ${crawlData.pageCount} page(s) from ${url}.${skipped}`,
          timestamp: new Date().toISOString(),
        };
      } catch (e) {
        crawlMessage = {
          role: 'system',
          content: `Crawl failed for ${url}: ${e.message}. Continuing without crawl context.`,
          timestamp: new Date().toISOString(),
        };
      } finally {
        setCrawling(false);
      }
    }

    const liveContent = buildUserContent(text, attachments);
    const savedContent = attachments.length > 0
      ? `${text}\n\n[Attached: ${attachments.map(a => a.name).join(', ')}]`
      : text;

    // Snapshot scope at send time, then immediately clear so the pill goes
    // away while the request is in flight. The chip on the user message
    // takes over as the visual indicator.
    const sendScope = inlineScope || null;
    if (sendScope && onClearInlineScope) onClearInlineScope();

    const userMsg = {
      role: 'user',
      content: savedContent,
      model,
      timestamp: new Date().toISOString(),
      ...(sendScope ? { inlineScope: { breadcrumb: sendScope.breadcrumb, page: sendScope.page } } : {}),
    };
    const newMessages = [...messages];
    if (crawlMessage) newMessages.push(crawlMessage);
    newMessages.push(userMsg);

    preSendMessagesRef.current = messages;
    preSendProjectRef.current = project;
    onUpdate(undefined, newMessages, updatedProject);

    const sentAttachments = attachments;
    setAttachments([]);

    // Honor any "Context Cleared" marker the user inserted — only send messages
    // AFTER the most recent marker to the API, but keep the full history visible.
    const lastClearIdx = newMessages.map(m => m.kind).lastIndexOf('context-clear');
    const messagesForApi = lastClearIdx >= 0 ? newMessages.slice(lastClearIdx + 1) : newMessages;
    const apiMessages = messagesForApi
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, i, arr) => {
        const isLast = i === arr.length - 1;
        if (isLast && m.role === 'user' && Array.isArray(liveContent)) {
          return { role: m.role, content: liveContent };
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content) };
      });

    setStreaming(true);
    setStreamingText('');
    streamStartRef.current = Date.now();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const storageKey = `gen:${project.slug}`;

    // Design brief: the first user message in the session, regardless of any
    // Clear-context markers. Sent in context so the backend can cache it and
    // keep it available across context clears.
    const firstUserMsg = newMessages.find(m => m.role === 'user' && typeof m.content === 'string');
    const designBrief = firstUserMsg?.content || '';

    // Page-context tier: cheap by default, opt-in to expand.
    //   inline + unchecked  → 'none'    (element scope is enough)
    //   inline + checked    → 'current' (the scoped page)
    //   main   + unchecked  → 'current' (the active page)
    //   main   + checked    → 'all'     (every page — cross-page changes)
    const pageContext = sendScope
      ? (includeExtraContext ? 'current' : 'none')
      : (includeExtraContext ? 'all' : 'current');

    // Reset the per-prompt checkbox to the SCOPE default after send. Main Chat
    // with 2+ pages stays checked (default = include all). Single-page Main
    // Chat resets to unchecked (current = the only page; "all" would just
    // duplicate it). Page threads reset to unchecked (default = current page
    // only) — for a freshly-added page thread, this means the auto-checked
    // first turn flips off naturally once messages exist. Inline mode default
    // is unchecked (element scope).
    const pageCount = Object.keys(pages || {}).length;
    const scopeDefault = !inlineScope && activeScope === SITE_THREAD && pageCount > 1;
    if (includeExtraContext !== scopeDefault) setIncludeExtraContext(scopeDefault);
    // Crawl-data toggle: same reset pattern. Stays off after iteration turns
    // so the next send doesn't accidentally re-send 50k tokens of crawl —
    // the user has to consciously re-tick when they need it.
    if (includeCrawlData) setIncludeCrawlData(false);

    let result;
    try {
      result = await streamChat({
        model,
        messages: apiMessages,
        context: {
          slug: project.slug,
          crawledData: updatedProject.crawledData,
          includeCrawlData,
          activePage,
          currentPages: pages,
          pageContext,
          designBrief,
          scope: activeScope || SITE_THREAD,
        },
        inlineScope: sendScope,
        onDelta: (_d, full) => setStreamingText(full),
        onPreparingImages: (data) => setImagePoolStatus(data),
        onJobId: (jid) => {
          jobIdRef.current = jid;
          localStorage.setItem(storageKey, JSON.stringify({
            jobId: jid,
            startedAt: streamStartRef.current,
            model,
          }));
        },
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError' || ctrl.signal.aborted) {
        localStorage.removeItem(storageKey);
        setImagePoolStatus(null);
        return;
      }
      // Stream dropped — fall back to polling if we have a jobId.
      const jid = e.jobId || jobIdRef.current;
      if (jid) {
        try {
          result = await pollJobResult(jid, { signal: ctrl.signal });
        } catch (pollErr) {
          if (pollErr.name === 'AbortError') { localStorage.removeItem(storageKey); return; }
          localStorage.removeItem(storageKey);
          const errMsg = { role: 'system', content: `Error: ${pollErr.message}`, timestamp: new Date().toISOString() };
          onUpdate(undefined, [...newMessages, errMsg], updatedProject);
          setStreaming(false);
          setImagePoolStatus(null);
          setStreamingText('');
          return;
        }
      } else {
        localStorage.removeItem(storageKey);
        const errMsg = { role: 'system', content: `Error: ${e.message}`, timestamp: new Date().toISOString() };
        onUpdate(undefined, [...newMessages, errMsg], updatedProject);
        setStreaming(false);
        setImagePoolStatus(null);
        setStreamingText('');
        return;
      }
    } finally {
      abortRef.current = null;
      preSendMessagesRef.current = null;
      preSendProjectRef.current = null;
      jobIdRef.current = null;
    }

    localStorage.removeItem(storageKey);
    const elapsedSecs = streamStartRef.current ? Math.floor((Date.now() - streamStartRef.current) / 1000) : null;
    streamStartRef.current = null;

    // If the user hit Stop while the result was already in flight (e.g. the
    // 'done' event was buffered at the moment they clicked), don't apply it —
    // stopStream() has already recorded the stop and reset the UI.
    if (ctrl.signal.aborted) {
      setImagePoolStatus(null);
      return;
    }

    applyResultRef.current(result, newMessages, updatedProject, model, elapsedSecs);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const pageNames = Object.keys(pages || {});

  return (
    <div className="chat-panel" ref={panelRef}>
      <ScopeBar
        pages={pageNames}
        activeScope={activeScope || SITE_THREAD}
        onScopeChange={onScopeChange}
        disabled={streaming}
        currentPages={pages}
        onPagesAction={onPagesAction}
        project={project}
        onProjectPatch={onProjectPatch}
        onOpenCodePanel={onOpenCodePanel}
      />
      <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {messages.length === 0 && !streaming && !crawling && !imagePoolStatus && (
          <div className="chat-empty">
            {activeScope === SITE_THREAD
              ? 'Main Chat — for project-wide changes (theme, header, footer, nav). Paste a URL to crawl, or describe the site.'
              : `Chat scoped to ${activeScope}. Describe a change.`}
          </div>
        )}
        {messages.map((m, i) => <Message key={i} msg={m} />)}
        {crawling && <div className="chat-msg system"><div className="body">Crawling…</div></div>}
        {(streaming || imagePoolStatus) && (
          <StreamingMessage
            text={streamingText}
            model={model}
            isUpdate={Object.keys(pages || {}).length > 0}
            startedAt={streamStartRef.current}
            imagePoolStatus={imagePoolStatus}
          />
        )}
      </div>
      <div className="chat-input">
        {inlineScope && (
          <div className="chat-inline-scope" title={inlineScope.breadcrumb}>
            <span className="scope-label">Prompting for:</span>
            <code className="scope-bc">{inlineScope.breadcrumb}</code>
            <button
              className="scope-clear"
              type="button"
              onClick={onClearInlineScope}
              disabled={streaming}
              aria-label="Clear inline scope"
              title="Cancel inline scope"
            >×</button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map(a => (
              <div key={a.id} className="chat-attachment-pill" title={a.displayName || a.name}>
                <span className="kind">{a.kind === 'image-ref' ? '🖼' : a.kind === 'audio-ref' ? '🔊' : a.kind === 'video-ref' ? '🎬' : '📄'}</span>
                <span className="name">{truncateName(a.displayName || a.name)}</span>
                <button
                  className="remove"
                  onClick={() => removeAttachment(a.id)}
                  disabled={streaming}
                  aria-label={`Remove ${a.name}`}
                >×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={hasApiKey ? "Describe a change, or paste a URL… (Cmd+Enter to send)" : "Set ANTHROPIC_API_KEY in .env first"}
          disabled={!hasApiKey || streaming}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,video/*,.txt,.html,.htm,.md,text/plain,text/html"
          style={{ display: 'none' }}
          onChange={handleAttach}
        />
        <div className="chat-input-row">
          <div className="chat-input-left">
            <select
              value={model}
              onChange={(e) => {
                const next = e.target.value;
                setModel(next);
                onUpdate(undefined, undefined, { ...project, lastModel: next });
              }}
              disabled={streaming}
            >
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <button
              onClick={clearContext}
              disabled={streaming || messages.length === 0}
              title="Reset conversation context (keeps history visible, sends fresh context to the model on next message)"
            >
              Clear Context
            </button>
          </div>
          <span className="spacer" />
          <button
            className="icon-only"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming || !hasApiKey}
            title="Attach images or text files"
            aria-label="Attach files"
          >
            <PaperclipIcon />
          </button>
          {streaming ? (
            <button className="danger" onClick={stopStream}>
              <StopIcon /> Stop
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={(!input.trim() && attachments.length === 0) || !hasApiKey}>
              <SendIcon /> Send
            </button>
          )}
        </div>
        <div className="chat-input-options">
          <div className="chat-context-toggles">
            <label
              className="chat-context-toggle"
              title={inlineScope
                ? "Adds the current page's HTML to this prompt (default: element-scope only). Resets after sending."
                : "Adds every page's HTML to this prompt (default: only the active page). Resets after sending."}
            >
              <input
                type="checkbox"
                checked={includeExtraContext}
                onChange={(e) => setIncludeExtraContext(e.target.checked)}
                disabled={streaming}
              />
              <span>{inlineScope ? 'Include this page context' : 'Include all page contexts'}</span>
            </label>
            {project.crawledData && !inlineScope && (
              <label
                className="chat-context-toggle"
                title="Adds the original crawled site data (titles, descriptions, page text) to this prompt. Big — only check when you actually need source content, e.g. building a new page from the crawl. Resets after sending."
              >
                <input
                  type="checkbox"
                  checked={includeCrawlData}
                  onChange={(e) => setIncludeCrawlData(e.target.checked)}
                  disabled={streaming}
                />
                <span>Include crawled site data{formatCrawlSize(project.crawledData)}</span>
              </label>
            )}
          </div>
          <span className="spacer" />
          <span
            className="chat-session-cost"
            title="Session total — sum of every assistant response's cost across every chat thread in this project"
          >
            Session: {formatCost(sessionTotal ?? totalCost(messages))}
          </span>
        </div>
      </div>
    </div>
  );
}

// Scope selector bar — single "Editing: <name>" dropdown plus page-actions
// menu. Sits at the top of the chat panel, aligned with the preview toolbar.
//
// Dropdown contents are scope-aware:
//   - 0 pages: no dropdown (label shows "Editing: index.html", disabled).
//   - 1 page: no dropdown (no other scope to switch to).
//   - 2+ pages: dropdown lists "All Pages" (SITE_THREAD) + every page file.
//
// The page-actions ellipsis (Add / Duplicate / Delete) hides until pages exist.
function ScopeBar({ pages, activeScope, onScopeChange, disabled, currentPages, onPagesAction, project, onProjectPatch, onOpenCodePanel }) {
  const [open, setOpen] = useState(false);
  // Page dialog: same component handles both Add and Duplicate, differentiated
  // by `dialogKind`. Duplicate uses the active scope as the source page (or
  // index.html when in "All Pages" / SITE_THREAD scope).
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKind, setDialogKind] = useState('add');
  const [dialogSource, setDialogSource] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleAdd = () => {
    setOpen(false);
    setDialogKind('add');
    setDialogSource(null);
    setDialogOpen(true);
  };

  const handleDuplicate = () => {
    setOpen(false);
    const source = activeScope === SITE_THREAD ? pages[0] : activeScope;
    if (!source || !currentPages[source]) { alert('Pick a page to duplicate first.'); return; }
    setDialogKind('duplicate');
    setDialogSource(source);
    setDialogOpen(true);
  };

  // Both kinds funnel through the same action. For 'add' we receive a stub;
  // for 'duplicate' we receive the source page's HTML — the runtime treats
  // them identically (it just writes whatever HTML it gets to the new file).
  const handleDialogCreate = ({ name, html, navLabel }) => {
    onPagesAction({ action: 'add', name, html, navLabel });
  };

  const handleDelete = () => {
    if (!onPagesAction) return;
    setOpen(false);
    const target = activeScope === SITE_THREAD ? pages[0] : activeScope;
    if (!target || !currentPages[target]) { alert('Pick a page to delete first.'); return; }
    if (target === 'index.html') { alert('Cannot delete index.html.'); return; }
    if (!window.confirm(`Delete ${target}? Nav links to it will be stripped from other pages.`)) return;
    onPagesAction({ action: 'remove', name: target });
  };

  const hasPages = pages.length > 0;
  const showAllPagesOption = pages.length >= 2;
  const dropdownOpenable = hasPages && pages.length >= 2; // only worth opening when there's something to switch to
  const label = activeScope === SITE_THREAD ? 'All Pages' : (activeScope || 'index.html');

  return (
    <div className="chat-scope-bar">
      <div className="scope-bar-left">
        <div className="scope-page-wrap" ref={wrapRef}>
          <button
            type="button"
            className={`scope-btn with-caret${dropdownOpenable ? '' : ' static'}`}
            onClick={() => dropdownOpenable && setOpen(o => !o)}
            disabled={disabled || !dropdownOpenable}
            title={dropdownOpenable ? 'Switch chat scope' : 'Editing this page'}
          >
            <span className="scope-prefix">Editing:</span> {label}
          </button>
          {open && dropdownOpenable && (
            <div className="scope-page-list">
              {showAllPagesOption && (
                <button
                  type="button"
                  className={activeScope === SITE_THREAD ? 'active' : ''}
                  onClick={() => { onScopeChange(SITE_THREAD); setOpen(false); }}
                >
                  All Pages
                </button>
              )}
              {pages.map(name => (
                <button
                  key={name}
                  type="button"
                  className={name === activeScope ? 'active' : ''}
                  onClick={() => { onScopeChange(name); setOpen(false); }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="scope-bar-right">
        {hasPages && onOpenCodePanel && onProjectPatch && (
          <>
            <button
              type="button"
              className="scope-actions-btn"
              onClick={() => openCodePanelForHeadFoot({
                activeScope, project, onProjectPatch, onOpenCodePanel,
              })}
              disabled={disabled}
              title={activeScope === SITE_THREAD
                ? 'Edit HEAD and FOOTER code for all pages'
                : `Edit HEAD and FOOTER code for ${activeScope}`}
              aria-label="Edit page code"
            >
              <CodeBracketsIcon />
            </button>
            <button
              type="button"
              className="scope-actions-btn"
              onClick={() => openCodePanelForGlobalCss({
                project, onProjectPatch, onOpenCodePanel,
              })}
              disabled={disabled}
              title="Edit global CSS"
              aria-label="Edit global CSS"
            >
              <CurlyBracesIcon />
            </button>
          </>
        )}
        {hasPages && (
          <ScopeActionsMenu
            disabled={disabled}
            onAdd={handleAdd}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
          />
        )}
      </div>
      <AddPageDialog
        open={dialogOpen}
        kind={dialogKind}
        sourceName={dialogSource}
        onClose={() => setDialogOpen(false)}
        indexHtml={currentPages?.['index.html'] || ''}
        existingPages={currentPages}
        onCreate={handleDialogCreate}
      />
    </div>
  );
}

// Square ellipsis menu on the right of the chat scope bar. Hosts the page
// management actions (Add / Duplicate / Delete). Visual parity with the
// preview-toolbar undo/redo buttons.
function ScopeActionsMenu({ disabled, onAdd, onDuplicate, onDelete }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="scope-actions" ref={wrapRef}>
      <button
        type="button"
        className="scope-actions-btn"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Page actions"
        aria-label="Page actions"
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="3" cy="7.5" r="1.2" fill="currentColor" />
          <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
          <circle cx="12" cy="7.5" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="scope-actions-list">
          <button type="button" onClick={() => { setOpen(false); onAdd(); }}>
            <PlusIcon /> Add Page
          </button>
          <button type="button" onClick={() => { setOpen(false); onDuplicate(); }}>
            <CopyIcon /> Duplicate page
          </button>
          <button type="button" onClick={() => { setOpen(false); onDelete(); }}>
            <TrashIcon /> Delete page
          </button>
        </div>
      )}
    </div>
  );
}

function CodeBracketsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function CurlyBracesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

// Session-builder helpers for the scope bar's <> and {} icons. They live
// outside the ScopeBar function to keep the render body compact and to make
// the wire-up (project → tabs → onSave patch) explicit and testable.
function openCodePanelForHeadFoot({ activeScope, project, onProjectPatch, onOpenCodePanel }) {
  const isAllPages = activeScope === SITE_THREAD;
  const scopeLabel = isAllPages ? 'All Pages' : activeScope;
  const currentHead = isAllPages
    ? (project?.globalHead || '')
    : (project?.pageCode?.[activeScope]?.head || '');
  const currentBody = isAllPages
    ? (project?.globalBodyEnd || '')
    : (project?.pageCode?.[activeScope]?.bodyEnd || '');

  onOpenCodePanel({
    key: `code-${isAllPages ? '__site' : activeScope}`,
    title: `Code · ${scopeLabel}`,
    tabs: [
      {
        id: 'head',
        label: 'HEAD',
        lang: 'html',
        value: currentHead,
        placeholder: '<!-- Injected before </head>. Analytics tags, meta, link, style, script — all valid. -->',
      },
      {
        id: 'bodyEnd',
        label: 'FOOTER',
        lang: 'html',
        value: currentBody,
        placeholder: '<!-- Injected before </body>. Chat widgets, tracking pixels, deferred scripts. -->',
      },
    ],
    initialTabId: 'head',
    onSave: (values) => {
      const head = values.head || '';
      const bodyEnd = values.bodyEnd || '';
      if (isAllPages) {
        onProjectPatch({ globalHead: head, globalBodyEnd: bodyEnd });
      } else {
        const nextCode = { ...(project?.pageCode || {}) };
        if (!head && !bodyEnd) {
          delete nextCode[activeScope];
        } else {
          nextCode[activeScope] = { head, bodyEnd };
        }
        onProjectPatch({ pageCode: nextCode });
      }
    },
    onCancel: () => {},
  });
}
function openCodePanelForGlobalCss({ project, onProjectPatch, onOpenCodePanel }) {
  onOpenCodePanel({
    key: 'code-global-css',
    title: 'Global CSS',
    tabs: [
      {
        id: 'css',
        label: 'CSS',
        lang: 'css',
        value: project?.globalCss || '',
        placeholder: '/* Applied to every page. Loaded after page styles so it wins the cascade. */',
      },
    ],
    onSave: (values) => onProjectPatch({ globalCss: values.css || '' }),
    onCancel: () => {},
  });
}
function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function StreamingMessage({ text, model, isUpdate, startedAt, imagePoolStatus }) {
  const [elapsed, setElapsed] = useState(
    startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0
  );

  useEffect(() => {
    if (!startedAt) return;
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [startedAt]);

  const editIdx = editStartIndex(text);
  const designIdx = designStartIndex(text);
  let label;
  if (designIdx === -1) label = 'Thinking';        // no design marker yet → answering or preamble
  else if (editIdx !== -1) label = 'Applying edits';
  else if (isUpdate) label = 'Updating design';
  else label = 'Generating design';

  let imagePoolLabel = null;
  if (imagePoolStatus?.status === 'searching') {
    imagePoolLabel = <><Spinner /> Preparing images…</>;
  } else if (imagePoolStatus?.status === 'ready') {
    imagePoolLabel = `Image pool ready: ${imagePoolStatus.poolSize} images`;
  }

  return (
    <div className="chat-msg assistant">
      <div className="who">assistant · {MODEL_LABELS[model] || model}</div>
      <div className="body">
        {/* Show the spinner the moment the request starts, before the first
            token arrives, so there's no dead empty-bubble phase. */}
        <span className="gen-status" style={{ display: 'flex' }}>
          <Spinner /> {label}… ({formatDuration(elapsed)})
        </span>
        {imagePoolLabel && (
          <div className="crawl-info" style={{ marginTop: 4 }}>{imagePoolLabel}</div>
        )}
      </div>
    </div>
  );
}

function Message({ msg }) {
  if (msg.kind === 'context-clear') {
    return (
      <div className="chat-msg context-clear">
        <span className="line" />
        <span className="label">{msg.content}</span>
        <span className="line" />
      </div>
    );
  }
  const cacheRead = msg.usage?.cache_read_input_tokens || 0;
  const cacheWrite = msg.usage?.cache_creation_input_tokens || 0;
  const cost = msg.usage ? calculateCost(msg.model, msg.usage) : 0;
  return (
    <div className={`chat-msg ${msg.role}`}>
      <div className="who">
        {msg.role}{msg.model ? ` · ${MODEL_LABELS[msg.model] || msg.model}` : ''}
        {msg.duration != null ? ` (${formatDuration(msg.duration)})` : ''}
      </div>
      {msg.inlineScope && (
        <div className="msg-inline-chip" title={msg.inlineScope.breadcrumb}>
          ↳ inline: <code>{msg.inlineScope.breadcrumb}</code>
        </div>
      )}
      <div className={`body${msg.kind === 'stopped' ? ' stopped' : ''}`}>{msg.content}</div>
      {msg.files?.length > 0 && (
        <div className="crawl-info">Updated: {msg.files.join(', ')}</div>
      )}
      {msg.imageStats && (
        <div className="crawl-info">Used {msg.imageStats.used} image{msg.imageStats.used !== 1 ? 's' : ''}. Discarded {msg.imageStats.discarded} unused image{msg.imageStats.discarded !== 1 ? 's' : ''}.</div>
      )}
      {msg.usage && (
        <div className="crawl-info" style={{ borderLeftColor: 'var(--text-faint)' }}>
          {msg.usage.input_tokens} in · {msg.usage.output_tokens} out
          {cacheRead > 0 && ` · ${cacheRead} cached ✓`}
          {cacheWrite > 0 && ` · ${cacheWrite} cache write`}
          {` · ${formatCost(cost)}`}
        </div>
      )}
    </div>
  );
}

function buildUserContent(text, attachments) {
  if (!attachments || attachments.length === 0) return text;
  const blocks = [];
  if (text.trim()) blocks.push({ type: 'text', text });

  const imageRefs = attachments.filter(a => a.kind === 'image-ref');
  if (imageRefs.length > 0) {
    const list = imageRefs.map(a => `- uploads/${a.name} (${a.mediaType})`).join('\n');
    blocks.push({
      type: 'text',
      text: `The user has attached the following image asset(s) to this project. Use them in the design with \`<img src="uploads/FILENAME">\` paths exactly as shown — do not embed base64 or use any other path. The frontend resolves these paths automatically.\n\n${list}`,
    });
  }

  const audioRefs = attachments.filter(a => a.kind === 'audio-ref');
  if (audioRefs.length > 0) {
    const list = audioRefs.map(a => `- uploads/${a.name} (${a.mediaType})`).join('\n');
    blocks.push({
      type: 'text',
      text: `The user has attached the following audio file(s) to this project. Use them with \`<audio src="uploads/FILENAME" controls></audio>\` paths exactly as shown. The frontend resolves these paths automatically.\n\n${list}`,
    });
  }

  const videoRefs = attachments.filter(a => a.kind === 'video-ref');
  if (videoRefs.length > 0) {
    const list = videoRefs.map(a => `- uploads/${a.name} (${a.mediaType})`).join('\n');
    blocks.push({
      type: 'text',
      text: `The user has attached the following video file(s) to this project. Use them with \`<video src="uploads/FILENAME" controls></video>\` paths exactly as shown. The frontend resolves these paths automatically.\n\n${list}`,
    });
  }

  for (const a of attachments) {
    if (a.kind === 'text') {
      blocks.push({
        type: 'text',
        text: `--- Attached file: ${a.name} ---\n${a.data}\n--- End of ${a.name} ---`,
      });
    }
  }
  return blocks;
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
function PaperclipIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}
function truncateName(name, max = 40) {
  if (name.length <= max) return name;
  return name.slice(0, max - 3) + '…';
}

// Rough token estimate for the crawled-data blob, shown in the toggle label
// so the user can see the cost before ticking the box. ~4 chars per token is
// a coarse but standard approximation; off by 10-20% is fine for a UI hint.
function formatCrawlSize(crawledData) {
  if (!crawledData) return '';
  const chars = JSON.stringify(crawledData).length;
  const tokens = Math.round(chars / 4);
  if (tokens < 1000) return ` (~${tokens} tok)`;
  return ` (~${Math.round(tokens / 1000)}k tok)`;
}

// Remove INLINE block headers + their element bodies from `text` so the
// FILE/PATCH/REGION parsers don't accidentally pick up text inside them.
// The body ends at the next OUR-style marker (INLINE/FILE/EDIT/REGION/PAGES)
// — NOT at any HTML comment, since the element body itself may contain
// `<!-- ... -->` comments (common inside SVG/HTML).
function stripInlineBlocks(text) {
  const head = /<!--\s*INLINE:\s*[0-9.]+\s+in\s+[^\s>]+\s*-->/gi;
  const markerRe = /<!--\s*(?:INLINE|FILE|EDIT|REGION|PAGES):/gi;
  let result = '';
  let pos = 0;
  let m;
  while ((m = head.exec(text)) !== null) {
    result += text.slice(pos, m.index);
    const bodyStart = m.index + m[0].length;
    markerRe.lastIndex = bodyStart;
    const next = markerRe.exec(text);
    pos = next ? next.index : text.length;
  }
  result += text.slice(pos);
  return result;
}
