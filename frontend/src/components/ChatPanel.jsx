import React, { useEffect, useRef, useState } from 'react';
import { streamChat, api } from '../api.js';
import { parseFileBlocks, detectUrl, generationStartIndex } from '../parseFiles.js';
import { parsePatchBlocks, applyPatches, editStartIndex } from '../parsePatch.js';
import Spinner from './Spinner.jsx';

const MODELS = [
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.7' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

export default function ChatPanel({ project, pages, messages, activePage, onUpdate, hasApiKey }) {
  const [input, setInput] = useState('');
  const [model, setModel] = useState('sonnet');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [crawling, setCrawling] = useState(false);
  const messagesRef = useRef(null);
  const panelRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages, streamingText, crawling]);

  // Auto-grow textarea up to 50% of chat panel height, then scroll inside.
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

    const userMsg = { role: 'user', content: text, model, timestamp: new Date().toISOString() };
    const newMessages = [...messages];
    if (crawlMessage) newMessages.push(crawlMessage);
    newMessages.push(userMsg);

    onUpdate(undefined, newMessages, updatedProject);

    const apiMessages = newMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content) }));

    setStreaming(true);
    setStreamingText('');
    let result;
    try {
      result = await streamChat({
        model,
        messages: apiMessages,
        context: {
          crawledData: updatedProject.crawledData,
          activePage,
          currentPages: pages,
        },
        onDelta: (_d, full) => setStreamingText(full),
      });
    } catch (e) {
      const errMsg = { role: 'system', content: `Error: ${e.message}`, timestamp: new Date().toISOString() };
      onUpdate(undefined, [...newMessages, errMsg], updatedProject);
      setStreaming(false);
      setStreamingText('');
      return;
    }

    const fullText = result.text;
    const usage = result.usage;

    // Try patches first; if any present, apply to existing pages.
    const { edits, prose: patchProse } = parsePatchBlocks(fullText);
    const editFiles = Object.keys(edits);

    // Then look for full FILE blocks (new files / wholesale rewrites).
    const { files, prose: fileProse } = parseFileBlocks(fullText);
    const fileNames = Object.keys(files);

    let updatedPages = { ...pages, ...files };
    let appliedSummary = [];
    const failureMessages = [];

    if (editFiles.length > 0) {
      const result = applyPatches(updatedPages, edits);
      updatedPages = result.updatedPages;
      for (const [name, count] of Object.entries(result.applied)) {
        appliedSummary.push(`${name} (${count} edit${count === 1 ? '' : 's'})`);
      }
      if (result.failed.length > 0) {
        const failed = result.failed.map(f => `  • ${f.filename}: ${f.reason === 'not_found' ? 'file not found' : "couldn't find SEARCH block"}`).join('\n');
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

    // Pick whichever prose we got (patch-mode prose if there are patches, else file-mode prose).
    const prose = editFiles.length > 0 ? patchProse : fileProse;
    let displayContent = prose;
    if (!displayContent) {
      const didSomething = editFiles.length > 0 || fileNames.length > 0;
      displayContent = didSomething
        ? (Object.keys(pages).length > 0 ? 'Design updated.' : 'Design generated.')
        : '(empty response)';
    }

    const assistantMsg = {
      role: 'assistant',
      content: displayContent,
      model,
      timestamp: new Date().toISOString(),
      files: appliedSummary,
      usage,
    };
    const finalMessages = [...newMessages, assistantMsg, ...failureMessages];

    const finalProject = {
      ...updatedProject,
      modelHistory: [...(updatedProject.modelHistory || []), { model, at: new Date().toISOString() }],
    };

    onUpdate(updatedPages, finalMessages, finalProject);
    setStreaming(false);
    setStreamingText('');
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
        {messages.length === 0 && !streaming && !crawling && (
          <div className="chat-empty">
            Paste a URL to crawl, or describe the site you want to design.
          </div>
        )}
        {messages.map((m, i) => <Message key={i} msg={m} />)}
        {crawling && <div className="chat-msg system"><div className="body">Crawling…</div></div>}
        {streaming && (
          <StreamingMessage
            text={streamingText}
            model={model}
            isUpdate={Object.keys(pages || {}).length > 0}
          />
        )}
      </div>
      <div className="chat-input">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={hasApiKey ? "Describe a change, or paste a URL… (Cmd+Enter to send)" : "Set ANTHROPIC_API_KEY in .env first"}
          disabled={!hasApiKey || streaming}
        />
        <div className="chat-input-row">
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={streaming}>
            {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <span className="spacer" />
          <button className="primary" onClick={send} disabled={!input.trim() || streaming || !hasApiKey}>
            {streaming ? 'Generating…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StreamingMessage({ text, model, isUpdate }) {
  const editIdx = editStartIndex(text);
  const genIdx = generationStartIndex(text);
  const idx = genIdx;
  const proseOnly = idx === -1 ? text : text.slice(0, idx).trim();
  const generating = idx !== -1;
  // Pick label: EDIT mode → "Applying edits"; otherwise generate vs update.
  let label;
  if (editIdx !== -1) label = 'Applying edits';
  else if (isUpdate) label = 'Updating design';
  else label = 'Generating design';
  return (
    <div className="chat-msg assistant">
      <div className="who">assistant · {model}</div>
      <div className="body">
        {proseOnly}
        {generating && (
          <span className="gen-status" style={{ marginTop: proseOnly ? 8 : 0, display: 'flex' }}>
            <Spinner /> {label}…
          </span>
        )}
      </div>
    </div>
  );
}

function Message({ msg }) {
  const cacheRead = msg.usage?.cache_read_input_tokens || 0;
  const cacheWrite = msg.usage?.cache_creation_input_tokens || 0;
  return (
    <div className={`chat-msg ${msg.role}`}>
      <div className="who">
        {msg.role}{msg.model ? ` · ${msg.model}` : ''}
      </div>
      <div className="body">{msg.content}</div>
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
