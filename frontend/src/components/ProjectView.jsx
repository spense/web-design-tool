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

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await api.exportProject(tab.slug, 'sonnet');
      setExportResult(result);
    } catch (e) {
      alert('Export failed: ' + e.message);
    } finally {
      setExporting(false);
    }
  }, [tab.slug]);

  if (loading) return <div className="preview-empty">Loading…</div>;
  if (!data) return <div className="preview-empty">Project not found.</div>;

  return (
    <div className="project-view">
      <ChatPanel
        project={data.project}
        pages={data.pages}
        messages={data.session.messages || []}
        activePage={activePage}
        onUpdate={updatePages}
        hasApiKey={hasApiKey}
        onStreamingChange={onStreamingChange}
      />
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
      />
      {exportResult && (
        <ExportModal
          slug={tab.slug}
          result={exportResult}
          onClose={() => setExportResult(null)}
        />
      )}
    </div>
  );
}
