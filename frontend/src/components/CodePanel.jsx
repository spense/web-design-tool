import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { html as langHtml } from '@codemirror/lang-html';
import { css as langCss } from '@codemirror/lang-css';
import { javascript as langJs } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { validateByLang } from '../codeValidate.js';

// Swappable code editor that replaces ChatPanel in the project view. Session
// contract:
//   {
//     title: string,           // shown next to Cancel
//     tabs: [                  // 1..N tabs
//       { id, label, lang: 'html'|'css'|'js', value, placeholder? }
//     ],
//     initialTabId?: string,   // defaults to first tab
//     onSave: (valuesById: { [id]: string }) => void
//     onCancel: () => void
//   }
//
// The component owns edited-value state so switching tabs mid-edit doesn't
// wipe your work. Save routes through the validator; the first tab with an
// error blocks save and gets focus.

// Chrome overrides layered on top of oneDark. oneDark supplies syntax
// highlighting; this makes background/gutter/cursor match the app palette
// so the panel doesn't look like a floating island in a different theme.
function buildAppChrome() {
  return EditorView.theme({
    '&': {
      backgroundColor: 'var(--bg-elev)',
      height: '100%',
      fontSize: '13px',
    },
    '.cm-content': {
      caretColor: 'var(--accent)',
      fontFamily: 'var(--mono)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-elev)',
      color: 'var(--text-faint)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(124, 156, 255, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(124, 156, 255, 0.08)', color: 'var(--text-dim)' },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(124, 156, 255, 0.25) !important',
    },
    '.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(124, 156, 255, 0.25) !important',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)' },
  }, { dark: true });
}

function langExt(lang) {
  switch (lang) {
    case 'html': return langHtml({ autoCloseTags: true, matchClosingTags: true });
    case 'css':  return langCss();
    case 'js':
    case 'javascript': return langJs();
    default: return [];
  }
}

// Very simple syntax highlight colors — matches the base language extensions'
// default tokens. Custom highlight styling is not shipped here; CodeMirror's
// built-in defaults render sanely in dark themes.

export default function CodePanel({ session }) {
  const { title, tabs, initialTabId, onSave, onCancel } = session;
  const firstTabId = tabs[0]?.id;
  const [activeTabId, setActiveTabId] = useState(initialTabId || firstTabId);
  // valuesById: mirrors the incoming tabs' values but tracks edits per tab.
  const [valuesById, setValuesById] = useState(() =>
    Object.fromEntries(tabs.map(t => [t.id, t.value ?? '']))
  );
  const [error, setError] = useState(null); // { tabId, message, line? }
  const [saving, setSaving] = useState(false);
  const editorRef = useRef(null);

  // Extensions: language + oneDark syntax highlighting + our chrome overrides
  // (order matters — chrome must come after oneDark so our bg/gutter win).
  const chrome = useMemo(buildAppChrome, []);
  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  // Clear the error strip when the user starts editing the tab that has an
  // error — otherwise it just sits there stale until they Save again.
  useEffect(() => {
    if (error && error.tabId === activeTabId) return;
    // Different tab active → hide error banner but keep it for its own tab.
  }, [activeTabId, error]);

  const handleChange = (tabId, next) => {
    setValuesById(prev => (prev[tabId] === next ? prev : { ...prev, [tabId]: next }));
    if (error && error.tabId === tabId) setError(null);
  };

  const handleSave = async () => {
    // Validate every tab; first failing tab wins focus.
    for (const t of tabs) {
      const v = valuesById[t.id] ?? '';
      const r = validateByLang(t.lang, v);
      if (!r.ok) {
        setActiveTabId(t.id);
        setError({ tabId: t.id, message: r.message, line: r.line });
        return;
      }
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(valuesById);
    } catch (e) {
      setError({ tabId: activeTabId, message: e?.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    // Cmd/Ctrl+S saves. Esc cancels — but only when the editor doesn't have
    // any active tooltip / autocomplete popup, so a keystroke that would
    // dismiss a suggestion doesn't also close the panel.
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      // Only cancel if focus isn't inside an autocomplete tooltip (there's no
      // reliable way to test that; deferring for now — Esc always cancels).
      onCancel?.();
    }
  };

  return (
    <div className="code-panel" onKeyDown={handleKeyDown}>
      <div className="code-panel-header">
        <button type="button" className="code-panel-cancel" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <div className="code-panel-title">{title}</div>
        <button
          type="button"
          className="primary code-panel-save"
          onClick={handleSave}
          disabled={saving}
          title="Save (⌘S)"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {tabs.length > 1 && (
        <div className="code-panel-tabs" role="tablist">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              type="button"
              className={`code-panel-tab ${t.id === activeTabId ? 'active' : ''}`}
              onClick={() => setActiveTabId(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="code-panel-editor">
        <CodeMirror
          ref={editorRef}
          value={valuesById[activeTab.id] ?? ''}
          onChange={(next) => handleChange(activeTab.id, next)}
          theme={oneDark}
          extensions={[langExt(activeTab.lang), chrome]}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
            searchKeymap: true,
            tabSize: 2,
          }}
          placeholder={activeTab.placeholder || ''}
          height="100%"
          style={{ height: '100%' }}
        />
      </div>

      {error && (
        <div className="code-panel-error" role="alert">
          <span className="code-panel-error-lang">
            {(tabs.find(t => t.id === error.tabId)?.label) || 'Error'}
            {error.line ? ` · line ${error.line}` : ''}
          </span>
          <span className="code-panel-error-msg">{error.message}</span>
        </div>
      )}
    </div>
  );
}
