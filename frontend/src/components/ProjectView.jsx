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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getProject(tab.slug)
      .then(d => {
        if (cancelled) return;
        setData(d);
        const firstPage = Object.keys(d.pages || {})[0];
        if (firstPage) setActivePage(firstPage);
      })
      .catch(e => console.error(e))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [tab.slug]);

  const persist = useCallback(async (next) => {
    setData(next);
    try { await api.saveProject(tab.slug, next); } catch (e) { console.error(e); }
  }, [tab.slug]);

  const updatePages = useCallback((newPages, newMessages, newProject) => {
    if (!data) return;
    const next = {
      project: newProject || data.project,
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

  const handleApplyTokens = useCallback((newPages) => {
    if (!data) return;
    persist({ ...data, pages: newPages });
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
        project={data.project}
        onFaviconChange={handleFaviconChange}
        scrollAnimations={data.project.scrollAnimations !== false}
        onScrollAnimationsChange={handleScrollAnimationsChange}
        chatCollapsed={chatCollapsed}
        onToggleChatCollapsed={() => setChatCollapsed(c => !c)}
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
