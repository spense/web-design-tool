import React, { useEffect, useRef, useState, useCallback } from 'react';
import { streamChat, pollJobResult, api } from '../api.js';
import { parseFileBlocks, detectUrl, isCompleteHtmlDoc } from '../parseFiles.js';
import { parsePatchBlocks, applyPatches, parseRegionBlocks, applyRegions, editStartIndex } from '../parsePatch.js';
import Spinner from './Spinner.jsx';

const MODELS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
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

export default function ChatPanel({ project, pages, messages, activePage, onUpdate, hasApiKey, onStreamingChange }) {
  const [input, setInput] = useState('');
  const [model, setModel] = useState(project.lastModel || 'sonnet');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [preparingImages, setPreparingImages] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const messagesRef = useRef(null);
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

    const regions = parseRegionBlocks(fullText);
    // Strip REGION blocks before running other parsers so they don't leak into prose.
    const textWithoutRegions = fullText.replace(/<!--\s*REGION:[\s\S]*?<!--\s*\/REGION\s*-->/gi, '');
    const { edits, prose: patchProse } = parsePatchBlocks(textWithoutRegions);
    const editFiles = Object.keys(edits);
    const { files, prose: fileProse } = parseFileBlocks(textWithoutRegions);

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

    const prose = editFiles.length > 0 ? patchProse : fileProse;
    let displayContent = prose;
    if (!displayContent) {
      const didSomething = editFiles.length > 0 || fileNames.length > 0 || regions.length > 0;
      displayContent = didSomething
        ? (Object.keys(pages).length > 0 ? 'Design updated.' : 'Design generated.')
        : '(empty response)';
    }

    const assistantMsg = {
      role: 'assistant',
      content: displayContent,
      model: usedModel,
      timestamp: new Date().toISOString(),
      files: appliedSummary,
      usage,
      duration: elapsedSecs,
    };
    const finalMessages = [...baseMessages, assistantMsg, ...failureMessages];
    const finalProject = {
      ...baseProject,
      modelHistory: [...(baseProject.modelHistory || []), { model: usedModel, at: new Date().toISOString() }],
    };

    onUpdate(updatedPages, finalMessages, finalProject);
    setStreaming(false);
    setStreamingText('');
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

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages, streamingText, crawling]);

  useEffect(() => {
    onStreamingChangeRef.current?.(streaming || crawling || preparingImages);
  }, [streaming, crawling, preparingImages]);

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

  const send = async () => {
    if (!input.trim() || streaming || !hasApiKey) return;
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

    const userMsg = { role: 'user', content: savedContent, model, timestamp: new Date().toISOString() };
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
    abortRef.current = new AbortController();

    const storageKey = `gen:${project.slug}`;

    let result;
    try {
      result = await streamChat({
        model,
        messages: apiMessages,
        context: {
          slug: project.slug,
          crawledData: updatedProject.crawledData,
          activePage,
          currentPages: pages,
        },
        onDelta: (_d, full) => { setPreparingImages(false); setStreamingText(full); },
        onPreparingImages: () => setPreparingImages(true),
        onJobId: (jid) => {
          jobIdRef.current = jid;
          localStorage.setItem(storageKey, JSON.stringify({
            jobId: jid,
            startedAt: streamStartRef.current,
            model,
          }));
        },
        signal: abortRef.current.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError' || abortRef.current?.signal.aborted) {
        localStorage.removeItem(storageKey);
        setPreparingImages(false);
        return;
      }
      // Stream dropped — fall back to polling if we have a jobId.
      const jid = e.jobId || jobIdRef.current;
      if (jid) {
        try {
          result = await pollJobResult(jid, { signal: abortRef.current?.signal });
        } catch (pollErr) {
          if (pollErr.name === 'AbortError') { localStorage.removeItem(storageKey); return; }
          localStorage.removeItem(storageKey);
          const errMsg = { role: 'system', content: `Error: ${pollErr.message}`, timestamp: new Date().toISOString() };
          onUpdate(undefined, [...newMessages, errMsg], updatedProject);
          setStreaming(false);
          setPreparingImages(false);
          setStreamingText('');
          return;
        }
      } else {
        localStorage.removeItem(storageKey);
        const errMsg = { role: 'system', content: `Error: ${e.message}`, timestamp: new Date().toISOString() };
        onUpdate(undefined, [...newMessages, errMsg], updatedProject);
        setStreaming(false);
        setPreparingImages(false);
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

    applyResultRef.current(result, newMessages, updatedProject, model, elapsedSecs);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="chat-panel" ref={panelRef}>
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && !streaming && !crawling && !preparingImages && (
          <div className="chat-empty">
            Paste a URL to crawl, or describe the site you want to design.
          </div>
        )}
        {messages.map((m, i) => <Message key={i} msg={m} />)}
        {crawling && <div className="chat-msg system"><div className="body">Crawling…</div></div>}
        {preparingImages && <div className="chat-msg system"><div className="body">Preparing images…</div></div>}
        {streaming && (
          <StreamingMessage
            text={streamingText}
            model={model}
            isUpdate={Object.keys(pages || {}).length > 0}
            startedAt={streamStartRef.current}
          />
        )}
      </div>
      <div className="chat-input">
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
      </div>
    </div>
  );
}

function StreamingMessage({ text, model, isUpdate, startedAt }) {
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
  let label;
  if (editIdx !== -1) label = 'Applying edits';
  else if (isUpdate) label = 'Updating design';
  else label = 'Generating design';

  return (
    <div className="chat-msg assistant">
      <div className="who">assistant · {MODEL_LABELS[model] || model}</div>
      <div className="body">
        <span className="gen-status" style={{ display: 'flex' }}>
          <Spinner /> {label}… ({formatDuration(elapsed)})
        </span>
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
  return (
    <div className={`chat-msg ${msg.role}`}>
      <div className="who">
        {msg.role}{msg.model ? ` · ${MODEL_LABELS[msg.model] || msg.model}` : ''}
        {msg.duration != null ? ` (${formatDuration(msg.duration)})` : ''}
      </div>
      <div className={`body${msg.kind === 'stopped' ? ' stopped' : ''}`}>{msg.content}</div>
      {msg.files?.length > 0 && (
        <div className="crawl-info">Updated: {msg.files.join(', ')}</div>
      )}
      {msg.usage && (
        <div className="crawl-info" style={{ borderLeftColor: 'var(--text-faint)' }}>
          {msg.usage.input_tokens} in · {msg.usage.output_tokens} out
          {cacheRead > 0 && ` · ${cacheRead} cached ✓`}
          {cacheWrite > 0 && ` · ${cacheWrite} cache write`}
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
