import React, { useEffect, useRef, useState } from 'react';
import { streamChat, api } from '../api.js';
import { parseFileBlocks, detectUrl } from '../parseFiles.js';

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

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages, streamingText, crawling]);

  const send = async () => {
    if (!input.trim() || streaming || !hasApiKey) return;
    const text = input.trim();
    setInput('');

    const url = detectUrl(text);
    let updatedProject = project;
    let crawlMessage = null;

    // Crawl if URL detected and we haven't already crawled (or it's a new URL)
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

    // Save user message immediately so it shows up
    onUpdate(undefined, newMessages, updatedProject);

    // Build API-shape message history (drop system messages, keep only user/assistant)
    const apiMessages = newMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content) }));

    setStreaming(true);
    setStreamingText('');
    let fullText = '';
    try {
      fullText = await streamChat({
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

    // Parse files out of the full response
    const { files, prose } = parseFileBlocks(fullText);
    const assistantMsg = {
      role: 'assistant',
      content: prose || fullText,
      model,
      timestamp: new Date().toISOString(),
      files: Object.keys(files),
    };
    const finalMessages = [...newMessages, assistantMsg];

    // Merge new files into existing pages
    const newPages = { ...pages, ...files };

    const finalProject = {
      ...updatedProject,
      modelHistory: [...(updatedProject.modelHistory || []), { model, at: new Date().toISOString() }],
    };

    onUpdate(newPages, finalMessages, finalProject);
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
    <div className="chat-panel">
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && !streaming && !crawling && (
          <div className="chat-empty">
            Paste a URL to crawl, or describe the site you want to design.
          </div>
        )}
        {messages.map((m, i) => <Message key={i} msg={m} />)}
        {crawling && <div className="chat-msg system"><div className="body">Crawling…</div></div>}
        {streaming && (
          <Message msg={{ role: 'assistant', content: previewProse(streamingText), model, streaming: true }} />
        )}
      </div>
      <div className="chat-input">
        <textarea
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

function previewProse(text) {
  // Show prose stream, replacing any started <!-- FILE: --> block with a placeholder
  const idx = text.search(/<!--\s*FILE:/i);
  if (idx === -1) return text;
  const before = text.slice(0, idx).trim();
  return (before ? before + '\n\n' : '') + '⟨generating HTML…⟩';
}

function Message({ msg }) {
  return (
    <div className={`chat-msg ${msg.role}`}>
      <div className="who">
        {msg.role}{msg.model ? ` · ${msg.model}` : ''}{msg.streaming ? ' · streaming' : ''}
      </div>
      <div className="body">{msg.content}</div>
      {msg.files?.length > 0 && (
        <div className="crawl-info">Updated: {msg.files.join(', ')}</div>
      )}
    </div>
  );
}
