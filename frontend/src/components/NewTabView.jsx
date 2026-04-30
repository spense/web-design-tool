import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function NewTabView({ onProjectOpened }) {
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const refresh = () => api.listProjects().then(setProjects).catch(e => setErr(e.message));
  useEffect(() => { refresh(); }, []);

  const handleNew = async () => {
    setBusy(true); setErr(null);
    try {
      const { project } = await api.createProject(undefined);
      onProjectOpened(project);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const handleOpen = async (slug) => {
    const project = projects.find(p => p.slug === slug);
    if (project) onProjectOpened(project);
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const { project } = await api.importProject(file);
      onProjectOpened(project);
    } catch (err) { setErr(err.message); }
    finally { setBusy(false); e.target.value = ''; }
  };

  const handleDelete = async (e, slug) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${slug}"? This cannot be undone.`)) return;
    try { await api.deleteProject(slug); refresh(); } catch (err) { setErr(err.message); }
  };

  return (
    <div className="new-tab-view">
      <div className="new-tab-card">
        <h1>Web Design Tool</h1>
        <p>Generate and iterate on website designs with AI.</p>

        <div className="new-tab-actions">
          <button className="primary" onClick={handleNew} disabled={busy}>New Project</button>
          <button onClick={() => fileRef.current?.click()} disabled={busy}>Import .zip</button>
          <input ref={fileRef} type="file" accept=".zip" onChange={handleImport} style={{ display: 'none' }} />
        </div>

        {err && <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ fontSize: 12, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          Open Project
        </div>
        <div className="project-list">
          {projects.length === 0 && <div className="project-list-empty">No projects yet.</div>}
          {projects.map(p => (
            <div key={p.slug} className="project-list-item" onClick={() => handleOpen(p.slug)}>
              <div>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="meta">{p.slug}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="meta">
                  {p.modified ? new Date(p.modified).toLocaleString() : ''}
                </div>
                <button className="ghost" onClick={(e) => handleDelete(e, p.slug)} title="Delete" style={{ padding: '2px 8px', fontSize: 12 }}>×</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
