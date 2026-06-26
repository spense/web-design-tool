import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EMBED_SCOPE_ALL, EMBED_SCOPE_PAGE, EMBED_POSITION_BODY_END, newEmbedId } from '../embeds.js';

const SITE_THREAD = '__site';

// Scope-aware embed manager. Mounted next to the page-actions ellipsis on
// the chat scope bar. Lists embeds that match the current chat scope:
//   - SITE_THREAD ("All Pages") → site-wide embeds (scope='all')
//   - page filename             → that page's embeds (scope='page', page=name)
// A page-scope view also surfaces inherited site-wide embeds as read-only
// chips so the user can see everything that actually injects on the page.
export default function EmbedPopover({ embeds, activeScope, onChange, onClose }) {
  const ref = useRef(null);
  const [editing, setEditing] = useState(null); // embed id being edited, or 'new'
  const [draft, setDraft] = useState(null);     // { id, name, code, scope, page }

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  const list = Array.isArray(embeds) ? embeds : [];
  const isAllPages = activeScope === SITE_THREAD;
  const scopeLabel = isAllPages ? 'All Pages' : activeScope;

  // Embeds shown in the editable list: ones that BELONG to the current scope.
  const ownEmbeds = useMemo(() => {
    if (isAllPages) return list.filter(e => e.scope === EMBED_SCOPE_ALL);
    return list.filter(e => e.scope === EMBED_SCOPE_PAGE && e.page === activeScope);
  }, [list, isAllPages, activeScope]);

  // When viewing a page, surface site-wide embeds as read-only context.
  const inheritedEmbeds = useMemo(() => {
    if (isAllPages) return [];
    return list.filter(e => e.scope === EMBED_SCOPE_ALL);
  }, [list, isAllPages]);

  const startNew = () => {
    setEditing('new');
    setDraft({
      id: newEmbedId(),
      name: '',
      code: '',
      scope: isAllPages ? EMBED_SCOPE_ALL : EMBED_SCOPE_PAGE,
      page: isAllPages ? null : activeScope,
      position: EMBED_POSITION_BODY_END,
    });
  };

  const startEdit = (embed) => {
    setEditing(embed.id);
    setDraft({ ...embed });
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft(null);
  };

  const saveDraft = () => {
    if (!draft) return;
    const code = String(draft.code || '').trim();
    if (!code) { alert('Paste the embed code first.'); return; }
    const name = String(draft.name || '').trim() || 'Untitled embed';
    const scope = draft.scope === EMBED_SCOPE_ALL ? EMBED_SCOPE_ALL : EMBED_SCOPE_PAGE;
    const page = scope === EMBED_SCOPE_PAGE ? (draft.page || activeScope) : null;
    const next = { id: draft.id, name, code, scope, page, position: EMBED_POSITION_BODY_END };
    const exists = list.some(e => e.id === next.id);
    const updated = exists
      ? list.map(e => (e.id === next.id ? next : e))
      : [...list, next];
    onChange(updated);
    cancelEdit();
  };

  const removeEmbed = (id) => {
    if (!window.confirm('Remove this embed?')) return;
    onChange(list.filter(e => e.id !== id));
    if (editing === id) cancelEdit();
  };

  return (
    <div className="embed-popover" ref={ref}>
      <div className="embed-header">
        <div className="embed-title">
          <span className="embed-scope-prefix">Embeds for:</span> {scopeLabel}
        </div>
        {!editing && (
          <button type="button" className="embed-add-btn" onClick={startNew} title="Add new embed">
            + Add
          </button>
        )}
      </div>

      {editing && draft && (
        <EmbedEditor
          draft={draft}
          setDraft={setDraft}
          onSave={saveDraft}
          onCancel={cancelEdit}
        />
      )}

      {!editing && (
        <>
          {ownEmbeds.length === 0 ? (
            <div className="embed-empty">
              No embeds for {scopeLabel}. Click <strong>+ Add</strong> to paste a snippet
              (a script tag, custom element, iframe, etc.). It will be injected just before
              <code>&lt;/body&gt;</code> on {isAllPages ? 'every page' : `this page`}.
            </div>
          ) : (
            <ul className="embed-list">
              {ownEmbeds.map(e => (
                <li key={e.id} className="embed-row">
                  <div className="embed-row-main">
                    <div className="embed-row-name">{e.name}</div>
                    <div className="embed-row-meta">
                      {previewCode(e.code)}
                    </div>
                  </div>
                  <div className="embed-row-actions">
                    <button type="button" onClick={() => startEdit(e)} title="Edit">Edit</button>
                    <button type="button" className="danger" onClick={() => removeEmbed(e.id)} title="Remove">×</button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {inheritedEmbeds.length > 0 && (
            <div className="embed-inherited">
              <div className="embed-inherited-label">Inherited from All Pages</div>
              <ul className="embed-inherited-list">
                {inheritedEmbeds.map(e => (
                  <li key={e.id} title="Edit in the All Pages scope">
                    <span className="embed-inherited-name">{e.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmbedEditor({ draft, setDraft, onSave, onCancel }) {
  return (
    <div className="embed-editor">
      <label className="embed-field">
        <span className="embed-field-label">Name</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
          placeholder="WiseOx Chat"
          autoFocus
        />
      </label>

      <label className="embed-field">
        <span className="embed-field-label">Code</span>
        <textarea
          value={draft.code}
          onChange={(e) => setDraft(d => ({ ...d, code: e.target.value }))}
          placeholder={'<wiseox-chat …></wiseox-chat>\n<script src="…"></script>'}
          spellCheck={false}
          rows={8}
        />
      </label>

      <div className="embed-editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" onClick={onSave}>Save</button>
      </div>
    </div>
  );
}

function previewCode(code) {
  const flat = String(code || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= 80) return flat;
  return flat.slice(0, 80) + '…';
}
