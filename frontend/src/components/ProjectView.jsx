import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import ChatPanel from './ChatPanel.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import ExportModal from './ExportModal.jsx';

export default function ProjectView({ tab, onUpdateTab, hasApiKey, onStreamingChange }) {
  const [data, setData] = useState(null); // { project, pages, session }
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState('index.html');
  const [exportResult, setExportResult] = useState(null);
  const [exporting, setExporting] = useState(false);

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
