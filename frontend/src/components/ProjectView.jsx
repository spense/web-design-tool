import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import ChatPanel from './ChatPanel.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import ExportModal from './ExportModal.jsx';
import { extractTokens } from '../tokenRewriter.js';
import {
  buildMonogramSvg, chooseParams, renderAllFromSvg,
} from '../faviconRender.js';

export default function ProjectView({ tab, onUpdateTab, hasApiKey, onStreamingChange }) {
  const [data, setData] = useState(null); // { project, pages, session }
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState('index.html');
  const [exportResult, setExportResult] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const autoFaviconRef = useRef(new Set());
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef({ list: [], index: -1 });
  // Inline-edit scope: when set, the next chat turn is constrained to ONE
  // element. The Prompt button in the inline-edit toolbar populates this;
  // ChatPanel renders a pill and includes it in the request; clears on send
  // or via the pill's ✕.
  const [inlineScope, setInlineScope] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getProject(tab.slug), api.getHistory(tab.slug)])
      .then(([d, h]) => {
        if (cancelled) return;
        setData(d);
        setHistory(h);
        // Restore position from project metadata if the user was mid-undo before refresh.
        const saved = d.project.historyPosition;
        const restoredIdx = saved ? h.indexOf(saved) : -1;
        setHistoryIndex(restoredIdx >= 0 ? restoredIdx : h.length - 1);
        const firstPage = Object.keys(d.pages || {})[0];
        if (firstPage) setActivePage(firstPage);
      })
      .catch(e => console.error(e))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [tab.slug]);

  useEffect(() => {
    historyRef.current = { list: history, index: historyIndex };
  }, [history, historyIndex]);

  const persist = useCallback(async (next, { skipHistory } = {}) => {
    // New changes move us to the latest — clear any saved undo position.
    if (next.project?.historyPosition !== undefined) {
      next = { ...next, project: { ...next.project, historyPosition: undefined } };
    }
    setData(next);
    if (skipHistory) return;
    try {
      const { list, index } = historyRef.current;
      if (list.length > 0 && index >= 0 && index < list.length - 1) {
        await api.pruneHistory(tab.slug, list[index]);
      }
      await api.saveProject(tab.slug, next);
      const h = await api.getHistory(tab.slug);
      setHistory(h);
      setHistoryIndex(h.length - 1);
    } catch (e) { console.error(e); }
  }, [tab.slug]);

  const updatePages = useCallback((newPages, newMessages, newProject) => {
    if (!data) return;
    let project = newProject || data.project;
    // A design change from chat/generation re-baselines the Tools menu: the new
    // design becomes the "default", so drop the token snapshot (re-captured on
    // next Tools open, which also refreshes the default swatch to the new
    // colors) and reset the color/font selection to their defaults.
    if (newPages) {
      project = { ...project, tokenSnapshot: null, toolsColor: 'default', toolsFont: 'original' };
    }
    const next = {
      project,
      pages: newPages || data.pages,
      session: newMessages ? { messages: newMessages } : data.session,
    };
    persist(next);
    if (newPages && Object.keys(newPages).length > 0 && !newPages[activePage]) {
      setActivePage(Object.keys(newPages)[0]);
    }
  }, [data, persist, activePage]);

  const handleSnapshot = useCallback((tokens) => {
    if (!data || data.project.tokenSnapshot) return;
    const nextProject = { ...data.project, tokenSnapshot: tokens };
    persist({ ...data, project: nextProject });
  }, [data, persist]);

  const handleApplyTokens = useCallback((newPages, projectPatch) => {
    if (!data) return;
    // projectPatch carries the Tools-menu selection (toolsColor/toolsFont) so
    // it persists alongside the token edit. Unlike updatePages, this path does
    // NOT touch tokenSnapshot — that's the baseline the menu restores to.
    const project = projectPatch ? { ...data.project, ...projectPatch } : data.project;
    persist({ ...data, pages: newPages, project });
  }, [data, persist]);

  const handleScrollAnimationsChange = useCallback((on) => {
    if (!data) return;
    persist({ ...data, project: { ...data.project, scrollAnimations: on } });
  }, [data, persist]);

  const handleFaviconChange = useCallback((favicon) => {
    if (!data) return;
    // Backend already persisted this; just sync local state so the UI
    // (preview / tabs / cards) reflects the new version + selection.
    setData(d => d ? { ...d, project: { ...d.project, favicon } } : d);
    onUpdateTab?.({ favicon });
  }, [data, onUpdateTab]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const handleUndo = useCallback(async () => {
    if (historyIndex <= 0 || !history.length) return;
    const targetIndex = historyIndex - 1;
    try {
      const entry = await api.getHistoryEntry(tab.slug, history[targetIndex]);
      if (entry?.pages) {
        const nextProject = { ...data.project, historyPosition: history[targetIndex] };
        const next = { ...data, pages: entry.pages, project: nextProject };
        setData(next);
        setHistoryIndex(targetIndex);
        // Persist to disk so refreshes and exports reflect the undo,
        // but skip history creation — we're navigating existing entries.
        await api.saveProject(tab.slug, { ...next, skipHistory: true });
      }
    } catch (e) { console.error('undo failed', e); }
  }, [tab.slug, history, historyIndex, data]);

  const handleRedo = useCallback(async () => {
    if (historyIndex >= history.length - 1) return;
    const targetIndex = historyIndex + 1;
    try {
      const entry = await api.getHistoryEntry(tab.slug, history[targetIndex]);
      if (entry?.pages) {
        // At the latest entry, clear the position so future loads default to latest.
        const atLatest = targetIndex === history.length - 1;
        const nextProject = atLatest
          ? { ...data.project, historyPosition: undefined }
          : { ...data.project, historyPosition: history[targetIndex] };
        const next = { ...data, pages: entry.pages, project: nextProject };
        setData(next);
        setHistoryIndex(targetIndex);
        await api.saveProject(tab.slug, { ...next, skipHistory: true });
      }
    } catch (e) { console.error('redo failed', e); }
  }, [tab.slug, history, historyIndex, data]);

  // Auto-generate a monogram favicon the first time this project has pages.
  // Skipped on every subsequent design revision — the user regenerates manually.
  useEffect(() => {
    if (!data) return;
    const slug = tab.slug;
    if (!slug || autoFaviconRef.current.has(slug)) return;
    const fav = data.project.favicon || {};
    if (fav.generated || fav.uploaded) return;
    const pageNames = Object.keys(data.pages || {});
    if (pageNames.length === 0) return;

    autoFaviconRef.current.add(slug);
    (async () => {
      try {
        const html = data.pages[activePage] || data.pages[pageNames[0]];
        const tokens = extractTokens(html) || {};
        const params = chooseParams({ name: data.project.name, tokens, attempt: 0 });
        const svg = buildMonogramSvg(params);
        const pngs = await renderAllFromSvg(svg);
        const result = await api.saveGeneratedFavicon(slug, {
          svg, pngs, params: { ...params, attempt: 0 },
        });
        handleFaviconChange(result.favicon);
      } catch (e) {
        console.error('auto-favicon failed', e);
        autoFaviconRef.current.delete(slug);
      }
    })();
  }, [data, tab.slug, activePage, handleFaviconChange]);

  // Poll export status for this slug until it leaves 'running'. Used both
  // when starting a new export and when resuming after refresh/tab-switch.
  const pollExportStatus = useCallback(async (slug) => {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      let job;
      try {
        job = await api.getExportStatus(slug);
      } catch (e) {
        // Network blip — keep trying until deadline.
        continue;
      }
      // If user switched to another project mid-poll, abandon.
      if (slug !== tab.slug) return;
      if (job.status === 'done') {
        setExportResult(job.result);
        setExporting(false);
        return;
      }
      if (job.status === 'error') {
        alert('Export failed: ' + (job.error || 'Unknown error'));
        setExporting(false);
        try { await api.clearExportStatus(slug); } catch {}
        return;
      }
      if (job.status === 'idle') {
        // Server forgot the job (e.g. backend restart). Stop spinning.
        setExporting(false);
        return;
      }
    }
    setExporting(false);
    alert('Export timed out.');
  }, [tab.slug]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      await api.exportProject(tab.slug);
      pollExportStatus(tab.slug);
    } catch (e) {
      setExporting(false);
      alert('Export failed: ' + e.message);
    }
  }, [tab.slug, pollExportStatus]);

  // On mount (or tab.slug change): pick up any in-progress export and resume
  // showing the spinner; if a recent export completed while we were away,
  // surface the result modal so the user sees it.
  useEffect(() => {
    let cancelled = false;
    const slug = tab.slug;
    (async () => {
      try {
        const job = await api.getExportStatus(slug);
        if (cancelled || slug !== tab.slug) return;
        if (job.status === 'running') {
          setExporting(true);
          pollExportStatus(slug);
        } else if (job.status === 'done' && job.result) {
          setExportResult(job.result);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [tab.slug, pollExportStatus]);

  const handleCloseExportModal = useCallback(() => {
    setExportResult(null);
    // Clear server-side state so this completed export doesn't re-surface
    // on a future refresh.
    api.clearExportStatus(tab.slug).catch(() => {});
  }, [tab.slug]);

  if (loading) return <div className="preview-empty">Loading…</div>;
  if (!data) return <div className="preview-empty">Project not found.</div>;

  return (
    <div className={`project-view${chatCollapsed ? ' chat-collapsed' : ''}`}>
      {!chatCollapsed && (
        <ChatPanel
          project={data.project}
          pages={data.pages}
          messages={data.session.messages || []}
          activePage={activePage}
          onUpdate={updatePages}
          hasApiKey={hasApiKey}
          onStreamingChange={onStreamingChange}
          inlineScope={inlineScope}
          onClearInlineScope={() => setInlineScope(null)}
        />
      )}
      <PreviewPanel
        slug={tab.slug}
        pages={data.pages}
        activePage={activePage}
        onActivePage={setActivePage}
        onExport={handleExport}
        exporting={exporting}
        snapshot={data.project.tokenSnapshot || null}
        onSnapshot={handleSnapshot}
        onApplyTokens={handleApplyTokens}
        activeColor={data.project.toolsColor || 'default'}
        activeFont={data.project.toolsFont || 'original'}
        project={data.project}
        onFaviconChange={handleFaviconChange}
        scrollAnimations={data.project.scrollAnimations !== false}
        onScrollAnimationsChange={handleScrollAnimationsChange}
        chatCollapsed={chatCollapsed}
        onToggleChatCollapsed={() => setChatCollapsed(c => !c)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onInlinePrompt={(scope) => {
          // Auto-expand chat if collapsed so the user can see the pill.
          if (chatCollapsed) setChatCollapsed(false);
          setInlineScope(scope);
        }}
      />
      {exportResult && (
        <ExportModal
          slug={tab.slug}
          result={exportResult}
          onClose={handleCloseExportModal}
        />
      )}
    </div>
  );
}
