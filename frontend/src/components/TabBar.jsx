import React, { useState, useRef, useEffect } from 'react';
import { api } from '../api.js';

export default function TabBar({ tabs, activeId, onSelect, onClose, onAdd, onRename }) {
  return (
    <div className="tab-bar">
      {tabs.map(tab => (
        <Tab
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onRename={(name) => onRename(tab.id, name)}
        />
      ))}
      <button className="tab-add" onClick={onAdd} title="New tab">+</button>
    </div>
  );
}

function Tab({ tab, active, onSelect, onClose, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.name);
  const inputRef = useRef(null);

  useEffect(() => { setDraft(tab.name); }, [tab.name]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== tab.name) onRename(trimmed);
    else setDraft(tab.name);
  };

  const faviconSrc = tab.slug ? api.faviconCrispUrl(tab.slug, tab.favicon) : null;

  return (
    <div className={`tab ${active ? 'active' : ''}`} onClick={() => !editing && onSelect()}>
      {faviconSrc && (
        <img
          className="tab-favicon"
          src={faviconSrc}
          alt=""
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      <div className="name" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setDraft(tab.name); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span title="Double-click to rename">{tab.name}</span>
        )}
      </div>
      <button className="close" onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close">×</button>
    </div>
  );
}
