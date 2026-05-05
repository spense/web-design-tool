import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import TabBar from './components/TabBar.jsx';
import NewTabView from './components/NewTabView.jsx';
import ProjectView from './components/ProjectView.jsx';

export default function App() {
  const [config, setConfig] = useState(null);
  const [tabs, setTabs] = useState([]); // [{id, slug|null, name}]
  const [activeId, setActiveId] = useState(null);
  const [streamingTabs, setStreamingTabs] = useState(() => new Set());
  const restoredRef = useRef(false);

  const setTabStreaming = useCallback((id, isStreaming) => {
    setStreamingTabs(prev => {
      const has = prev.has(id);
      if (isStreaming === has) return prev;
      const next = new Set(prev);
      if (isStreaming) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  // Load config + restore tabs on mount
  useEffect(() => {
    (async () => {
      try { setConfig(await api.getConfig()); } catch { setConfig({ hasApiKey: false }); }
      try {
        const state = await api.getAppState();
        if (state?.openTabs?.length) {
          // Validate that each project slug still exists; drop stale tabs.
          // Also override saved tab.name with the live project.json name so
          // renames done in a previous session show up after reload.
          const projects = await api.listProjects();
          const projectMap = new Map(projects.map(p => [p.slug, p]));
          const valid = state.openTabs
            .filter(t => !t.slug || projectMap.has(t.slug))
            .map(t => t.slug
              ? { ...t, name: projectMap.get(t.slug).name, favicon: projectMap.get(t.slug).favicon || null }
              : t);
          if (valid.length) {
            setTabs(valid);
            setActiveId(valid.find(t => t.id === state.activeTab)?.id || valid[0].id);
            restoredRef.current = true;
            return;
          }
        }
      } catch {}
      // First-run: open a single empty new-tab
      const id = newId();
      setTabs([{ id, slug: null, name: 'New Tab' }]);
      setActiveId(id);
      restoredRef.current = true;
    })();
  }, []);

  // Persist tabs whenever they change (after restoration).
  useEffect(() => {
    if (!restoredRef.current) return;
    api.saveAppState({
      openTabs: tabs.map(t => ({ id: t.id, slug: t.slug, name: t.name })),
      activeTab: activeId,
    }).catch(() => {});
  }, [tabs, activeId]);

  const addTab = useCallback(() => {
    const id = newId();
    setTabs(t => [...t, { id, slug: null, name: 'New Tab' }]);
    setActiveId(id);
  }, []);

  const closeTab = useCallback((id) => {
    if (streamingTabs.has(id)) {
      const ok = window.confirm('This tab is still generating a design. Closing will cancel it. Close anyway?');
      if (!ok) return;
    }
    setStreamingTabs(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setTabs(t => {
      const idx = t.findIndex(x => x.id === id);
      const next = t.filter(x => x.id !== id);
      if (next.length === 0) {
        const nid = newId();
        setActiveId(nid);
        return [{ id: nid, slug: null, name: 'New Tab' }];
      }
      if (id === activeId) {
        const fallback = next[Math.max(0, idx - 1)] || next[0];
        setActiveId(fallback.id);
      }
      return next;
    });
  }, [activeId, streamingTabs]);

  const updateTab = useCallback((id, patch) => {
    setTabs(t => t.map(x => x.id === id ? { ...x, ...patch } : x));
  }, []);

  const renameTab = useCallback(async (id, name) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    const oldName = tab.name;
    // Optimistic local update
    updateTab(id, { name });
    if (tab.slug) {
      try {
        const updated = await api.renameProject(tab.slug, name);
        // Backend may have changed the slug to match the new name — sync it.
        if (updated?.slug && updated.slug !== tab.slug) {
          updateTab(id, { slug: updated.slug, name: updated.name });
        } else if (updated?.name) {
          updateTab(id, { name: updated.name });
        }
      } catch (e) {
        // Revert local change and surface the error.
        updateTab(id, { name: oldName });
        alert(`Rename failed: ${e.message}`);
      }
    }
  }, [tabs, updateTab]);

  const activeTab = tabs.find(t => t.id === activeId);

  return (
    <div className="app">
      {config && !config.hasApiKey && (
        <div className="banner">
          ANTHROPIC_API_KEY is not set. Add it to <code>.env</code> at the project root and restart the server. Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: '#1a0a0a', textDecoration: 'underline' }}>console.anthropic.com/settings/keys</a>.
        </div>
      )}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeTab}
        onAdd={addTab}
        onRename={renameTab}
      />
      {tabs.map(t => (
        <div
          key={t.id}
          className="tab-pane"
          style={{ display: t.id === activeId ? 'contents' : 'none' }}
        >
          {t.slug ? (
            <ProjectView
              tab={t}
              isActive={t.id === activeId}
              onUpdateTab={(patch) => updateTab(t.id, patch)}
              hasApiKey={config?.hasApiKey}
              onStreamingChange={(b) => setTabStreaming(t.id, b)}
            />
          ) : (
            t.id === activeId && (
              <NewTabView
                onProjectOpened={(project) => updateTab(t.id, { slug: project.slug, name: project.name, favicon: project.favicon || null })}
              />
            )
          )}
        </div>
      ))}
    </div>
  );
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}
