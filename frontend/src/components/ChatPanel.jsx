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
  const [model, setModel] = useState(project.lastModel || 'sonnet');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [attachments, setAttachments] = useState([]); // [{id, name, kind, mediaType, data}]
  const messagesRef = useRef(null);
  const panelRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const handleAttach = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file
    const newOnes = [];
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const isText = file.type.startsWith('text/') || /\.(txt|html?|md)$/i.test(file.name);
      if (!isImage && !isText) continue;
      try {
        if (isImage) {
          // Upload to backend; reference by filename instead of sending bytes to API.
          const meta = await api.uploadAsset(project.slug, file);
          newOnes.push({
            id: Math.random().toString(36).slice(2, 10),
            name: meta.filename,           // canonical (sanitized) filename on disk
            displayName: file.name,
            kind: 'image-ref',
            mediaType: meta.mediaType,
            sizeBytes: meta.sizeBytes,
          });
        } else {
          // Text/HTML: still inline content into the API call so the model can read it.
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

    // Build the LIVE user message content (sent to API). May be a structured
    // array if attachments are present.
    const liveContent = buildUserContent(text, attachments);

    // Saved-to-history version: just the prompt text + a small note about
    // what was attached. We don't persist base64 image data in session.json.
    const savedContent = attachments.length > 0
      ? `${text}\n\n[Attached: ${attachments.map(a => a.name).join(', ')}]`
      : text;

    const userMsg = { role: 'user', content: savedContent, model, timestamp: new Date().toISOString() };
    const newMessages = [...messages];
    if (crawlMessage) newMessages.push(crawlMessage);
    newMessages.push(userMsg);

    onUpdate(undefined, newMessages, updatedProject);

    // Clear attachments now that they're committed to this turn.
    const sentAttachments = attachments;
    setAttachments([]);

    // History messages stay as plain text strings; only the latest user
    // message uses structured content (so attachments hit the API).
    const apiMessages = newMessages
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
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map(a => (
              <div key={a.id} className="chat-attachment-pill" title={a.displayName || a.name}>
                <span className="kind">{(a.kind === 'image-ref' || a.kind === 'image') ? '🖼' : '📄'}</span>
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
          accept="image/*,.txt,.html,.htm,.md,text/plain,text/html"
          style={{ display: 'none' }}
          onChange={handleAttach}
        />
        <div className="chat-input-row">
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
          <button onClick={() => fileInputRef.current?.click()} disabled={streaming || !hasApiKey} title="Attach images or text files">
            Attach
          </button>
          <span className="spacer" />
          <button className="primary" onClick={send} disabled={(!input.trim() && attachments.length === 0) || streaming || !hasApiKey}>
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

// Build an Anthropic content array from prompt text + attachments.
// Returns a plain string when there are no attachments (to keep simple turns simple).
function buildUserContent(text, attachments) {
  if (!attachments || attachments.length === 0) return text;
  const blocks = [];
  if (text.trim()) blocks.push({ type: 'text', text });

  // Group image references into a single concise note so the model knows what to use.
  const imageRefs = attachments.filter(a => a.kind === 'image-ref');
  if (imageRefs.length > 0) {
    const list = imageRefs.map(a => `- uploads/${a.name} (${a.mediaType})`).join('\n');
    blocks.push({
      type: 'text',
      text: `The user has attached the following image asset(s) to this project. Use them in the design with \`<img src="uploads/FILENAME">\` paths exactly as shown — do not embed base64 or use any other path. The frontend resolves these paths automatically.\n\n${list}`,
    });
  }

  for (const a of attachments) {
    if (a.kind === 'text') {
      blocks.push({
        type: 'text',
        text: `--- Attached file: ${a.name} ---\n${a.data}\n--- End of ${a.name} ---`,
      });
    }
    // image-ref handled above; old 'image' kind no longer used
  }
  return blocks;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result; // data:image/...;base64,XXXX
      const idx = String(result).indexOf(',');
      resolve(idx >= 0 ? String(result).slice(idx + 1) : String(result));
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
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
