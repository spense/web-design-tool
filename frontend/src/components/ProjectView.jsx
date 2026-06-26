import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import ChatPanel from './ChatPanel.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import ExportModal from './ExportModal.jsx';
import { extractTokens } from '../tokenRewriter.js';
import { totalCost } from '../pricing.js';
import { bindNavLabelInPages, unbindNavLabelInPages } from '../navBinding.js';
import {
  buildMonogramSvg, chooseParams, renderAllFromSvg,
} from '../faviconRender.js';

// Mirror of backend SITE_THREAD constant. The thread key for project-wide /
// cross-page conversations ("Main Chat"). All other thread keys are page
// filenames like "index.html".
export const SITE_THREAD = '__site';

export default function ProjectView({ tab, onUpdateTab, hasApiKey, onStreamingChange }) {
  const [data, setData] = useState(null); // { project, pages, session }
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState('index.html');
  // Which chat thread the user is currently in. SITE_THREAD = "All Pages"
  // (cross-page work — only surfaced in the dropdown once 2+ pages exist).
  // Any other value is a page filename. Defaults to index.html so brand-new
  // projects, single-page projects, and the very first generation all flow
  // into the page thread directly — Main Chat / All Pages is only useful
  // once there's more than one page to coordinate across.
  const [activeScope, setActiveScope] = useState('index.html');
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
        // Restore the last chat scope so the user lands back in the thread
        // they were last using. Validate it still exists. SITE_THREAD ("All
        // Pages") is only valid when 2+ pages exist; otherwise fall back to
        // index.html to mirror the new dropdown UX.
        const savedScope = d.project.lastScope;
        const pageCount = Object.keys(d.pages || {}).length;
        if (savedScope === SITE_THREAD && pageCount >= 2) {
          setActiveScope(SITE_THREAD);
        } else if (savedScope && savedScope !== SITE_THREAD && d.pages && d.pages[savedScope]) {
          setActiveScope(savedScope);
        } else {
          setActiveScope('index.html');
        }
      })
      .catch(e => console.error(e))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [tab.slug]);

  useEffect(() => {
    historyRef.current = { list: history, index: historyIndex };
  }, [history, historyIndex]);

  const persist = useCallback(async (next, { skipHistory, activeThread } = {}) => {
    // New changes move us to the latest — clear any saved undo position.
    if (next.project?.historyPosition !== undefined) {
      next = { ...next, project: { ...next.project, historyPosition: undefined } };
    }
    setData(next);
    if (skipHistory) {
      // Still persist to disk so e.g. lastScope survives a refresh, but don't
      // create a history snapshot.
      try { await api.saveProject(tab.slug, { ...next, skipHistory: true, activeThread }); } catch (e) { console.error(e); }
      return;
    }
    try {
      const { list, index } = historyRef.current;
      if (list.length > 0 && index >= 0 && index < list.length - 1) {
        await api.pruneHistory(tab.slug, list[index]);
      }
      await api.saveProject(tab.slug, { ...next, activeThread });
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
    // Splice newMessages into the active thread, preserving other threads.
    let session = data.session;
    if (newMessages) {
      const prevThreads = (data.session && data.session.threads) || { [SITE_THREAD]: [] };
      session = {
        schemaVersion: 2,
        threads: { ...prevThreads, [activeScope]: newMessages },
      };
    }
    const next = { project, pages: newPages || data.pages, session };
    persist(next, { activeThread: activeScope });
    if (newPages && Object.keys(newPages).length > 0 && !newPages[activePage]) {
      setActivePage(Object.keys(newPages)[0]);
    }
  }, [data, persist, activePage, activeScope]);

  // Strip every <a href="target.html"> reference (and an enclosing <li> when
  // the link is the li's sole content) from an HTML string. Used when removing
  // a page to keep nav menus internally consistent across the remaining pages.
  const stripNavLinks = (html, target) => {
    if (!html) return html;
    const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // <li>...<a href="target.html">…</a>...</li> where the link is the sole
    // meaningful child — drop the whole li.
    const liRe = new RegExp(`<li\\b[^>]*>\\s*<a\\b[^>]*href=["'](?:\\.\\/)?${esc}(?:#[^"']*)?["'][^>]*>[\\s\\S]*?<\\/a>\\s*<\\/li>`, 'gi');
    // Bare <a href="target.html">…</a> elsewhere.
    const aRe = new RegExp(`<a\\b[^>]*href=["'](?:\\.\\/)?${esc}(?:#[^"']*)?["'][^>]*>[\\s\\S]*?<\\/a>`, 'gi');
    return html.replace(liRe, '').replace(aRe, '');
  };

  const handlePagesAction = useCallback(async (action) => {
    if (!data) return;
    let { pages, session, project } = data;
    let nextScope = activeScope;
    const prevThreads = (session && session.threads) || { [SITE_THREAD]: [] };
    // navBindings: { "about-us.html": "About Us" } — tracks which pages were
    // wired to a nav label via the Add Page picker. Delete uses this to
    // decide whether to restore the matching nav href to "#" (picker-bound)
    // or strip the link entirely (custom / off-nav page).
    let navBindings = { ...(project.navBindings || {}) };

    if (action.action === 'add') {
      pages = { ...pages, [action.name]: action.html };
      // Picker-bound add: rewire every page's matching `<nav>` `<a href="#">`
      // to the new filename and record the binding for later cleanup on delete.
      if (action.navLabel) {
        pages = bindNavLabelInPages(pages, action.navLabel, action.name);
        navBindings[action.name] = action.navLabel;
      }
      session = { schemaVersion: 2, threads: { ...prevThreads, [action.name]: [] } };
      nextScope = action.name;
    } else if (action.action === 'duplicate') {
      const sourceHtml = pages[action.sourceName] || '';
      pages = { ...pages, [action.newName]: sourceHtml };
      session = { schemaVersion: 2, threads: { ...prevThreads, [action.newName]: [] } };
      nextScope = action.newName;
    } else if (action.action === 'remove') {
      const { [action.name]: _removed, ...restPages } = pages;
      const wasBound = !!navBindings[action.name];
      if (wasBound) {
        // Picker-bound page: restore the matching `<nav>` href back to "#" so
        // the menu item itself survives — the user picked a nav label, not a
        // chunk of nav markup to be deleted.
        pages = unbindNavLabelInPages(restPages, action.name);
        delete navBindings[action.name];
      } else {
        // Custom / off-nav page: strip any stray links to it from remaining
        // pages (the legacy behavior — covers nav links the model added on
        // its own and any in-body anchors that referenced the file).
        const cleaned = {};
        for (const [name, html] of Object.entries(restPages)) {
          cleaned[name] = stripNavLinks(html, action.name);
        }
        pages = cleaned;
      }
      const { [action.name]: _t, ...restThreads } = prevThreads;
      session = { schemaVersion: 2, threads: restThreads };
      if (activeScope === action.name) nextScope = 'index.html';
      // Strip page-scoped embeds targeting the removed page so they don't
      // become orphans (invisible to the popover but still on project.embeds).
      if (Array.isArray(project.embeds) && project.embeds.length > 0) {
        const surviving = project.embeds.filter(e => !(e.scope === 'page' && e.page === action.name));
        if (surviving.length !== project.embeds.length) {
          project = { ...project, embeds: surviving };
        }
      }
    } else {
      return;
    }

    setActiveScope(nextScope);
    if (nextScope !== SITE_THREAD) {
      setActivePage(nextScope);
    } else if (!pages[activePage]) {
      // Active page was just removed — fall back to whatever page remains.
      const firstRemaining = Object.keys(pages)[0];
      if (firstRemaining) setActivePage(firstRemaining);
    }
    const nextProject = { ...project, lastScope: nextScope, navBindings, tokenSnapshot: null, toolsColor: 'default', toolsFont: 'original' };
    persist({ project: nextProject, pages, session }, { activeThread: nextScope });
  }, [data, activeScope, activePage, persist]);

  // User clicked Main Chat or a page button in the chat scope selector.
  // Page selection also moves the preview to that page; Main Chat leaves
  // the preview alone.
  const handleScopeChange = useCallback((scope) => {
    setActiveScope(scope);
    if (scope !== SITE_THREAD) setActivePage(scope);
    // Persist as project.lastScope so the next session restores here.
    if (data && data.project.lastScope !== scope) {
      const nextProject = { ...data.project, lastScope: scope };
      persist({ ...data, project: nextProject }, { skipHistory: true });
    }
  }, [data, persist]);

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

  const handleOgImageChange = useCallback((ogImage) => {
    if (!data) return;
    setData(d => d ? { ...d, project: { ...d.project, ogImage } } : d);
  }, [data]);

  // Embeds live on project.embeds — single array, no per-page splatting in
  // pages.json. The preview/export resolve which embeds apply to which page
  // at render time. Skip history snapshots: adding a Calendly embed isn't a
  // design change worth undo/redo'ing pages around.
  const handleEmbedsChange = useCallback((nextEmbeds) => {
    if (!data) return;
    const nextProject = { ...data.project, embeds: nextEmbeds };
    persist({ ...data, project: nextProject }, { skipHistory: true });
  }, [data, persist]);

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

  // Preview-driven page change (iframe nav click, page-label dropdown). Mirror
  // the page selection into the chat scope so the "Editing: X" label stays in
  // sync with what's visible. SITE_THREAD ("All Pages") is sticky — the user
  // explicitly chose a project-wide scope, don't yank them off it just because
  // they clicked a nav link in the preview.
  const handlePreviewActivePage = useCallback((name) => {
    setActivePage(name);
    if (activeScope !== SITE_THREAD && activeScope !== name) {
      handleScopeChange(name);
    }
  }, [activeScope, handleScopeChange]);

  if (loading) return <div className="preview-empty">Loading…</div>;
  if (!data) return <div className="preview-empty">Project not found.</div>;

  return (
    <div className={`project-view${chatCollapsed ? ' chat-collapsed' : ''}`}>
      {!chatCollapsed && (
        <ChatPanel
          project={data.project}
          pages={data.pages}
          messages={(data.session?.threads?.[activeScope]) || []}
          sessionTotal={Object.values(data.session?.threads || {}).reduce(
            (sum, thread) => sum + totalCost(thread),
            0,
          )}
          activePage={activePage}
          activeScope={activeScope}
          onScopeChange={handleScopeChange}
          onPagesAction={handlePagesAction}
          onUpdate={updatePages}
          hasApiKey={hasApiKey}
          onStreamingChange={onStreamingChange}
          inlineScope={inlineScope}
          onClearInlineScope={() => setInlineScope(null)}
          onEmbedsChange={handleEmbedsChange}
        />
      )}
      <PreviewPanel
        slug={tab.slug}
        pages={data.pages}
        activePage={activePage}
        onActivePage={handlePreviewActivePage}
        onExport={handleExport}
        exporting={exporting}
        snapshot={data.project.tokenSnapshot || null}
        onSnapshot={handleSnapshot}
        onApplyTokens={handleApplyTokens}
        activeColor={data.project.toolsColor || 'default'}
        activeFont={data.project.toolsFont || 'original'}
        project={data.project}
        onFaviconChange={handleFaviconChange}
        onOgImageChange={handleOgImageChange}
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
