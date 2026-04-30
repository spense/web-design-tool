import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import TabBar from './components/TabBar.jsx';
import NewTabView from './components/NewTabView.jsx';
import ProjectView from './components/ProjectView.jsx';

export default function App() {
  const [config, setConfig] = useState(null);
  const [tabs, setTabs] = useState([]); // [{id, slug|null, name}]
  const [activeId, setActiveId] = useState(null);
  const restoredRef = useRef(false);

  // Load config + restore tabs on mount
  useEffect(() => {
    (async () => {
      try { setConfig(await api.getConfig()); } catch { setConfig({ hasApiKey: false }); }
      try {
        const state = await api.getAppState();
        if (state?.openTabs?.length) {
          // Validate that each project slug still exists; drop stale tabs.
          const projects = await api.listProjects();
          const slugs = new Set(projects.map(p => p.slug));
          const valid = state.openTabs.filter(t => !t.slug || slugs.has(t.slug));
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
  }, [activeId]);

  const updateTab = useCallback((id, patch) => {
    setTabs(t => t.map(x => x.id === id ? { ...x, ...patch } : x));
  }, []);

  const renameTab = useCallback(async (id, name) => {
    const tab = tabs.find(t => t.id === id);
    updateTab(id, { name });
    if (tab?.slug) {
      try { await api.renameProject(tab.slug, name); } catch (e) { console.error(e); }
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
      {activeTab && (
        activeTab.slug
          ? <ProjectView
              key={activeTab.id}
              tab={activeTab}
              onUpdateTab={(patch) => updateTab(activeTab.id, patch)}
              hasApiKey={config?.hasApiKey}
            />
          : <NewTabView
              onProjectOpened={(project) => updateTab(activeTab.id, { slug: project.slug, name: project.name })}
            />
      )}
    </div>
  );
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}
