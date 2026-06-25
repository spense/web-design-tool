import React, { useEffect, useMemo, useRef, useState } from 'react';
import { extractUnwiredNavLinks, slugifyLabel } from '../navBinding.js';

// Modal picker for adding OR duplicating a page. Two paths in either mode:
//   1. Pick an unwired nav item from index.html — derives filename from the
//      label, also rewires every page's nav so href="#" → href="newfile.html"
//      (the wiring happens in ProjectView.handlePagesAction via navLabel).
//   2. Custom filename — for pages that aren't in the nav at all (404,
//      legal/privacy, off-nav hidden links). No nav rewiring.
//
// `kind` switches the dialog between "add" (creates a stub) and "duplicate"
// (copies the contents of `sourceName`). The picker UI is identical between
// modes — only the resulting page contents differ. Duplicate also defaults
// the Custom-filename input to `<source>-copy.html` so the common case is
// one click.
//
// Filename validation mirrors the prior window.prompt path so both flows
// reject the same invalid inputs.
const FILENAME_RE = /^[a-z0-9][a-z0-9_-]*\.html$/i;

export default function AddPageDialog({ open, onClose, kind = 'add', sourceName, indexHtml, existingPages, onCreate }) {
  const [mode, setMode] = useState('list'); // 'list' | 'custom'
  const [customName, setCustomName] = useState('');
  const [error, setError] = useState('');
  const customInputRef = useRef(null);
  const dialogRef = useRef(null);

  const isDuplicate = kind === 'duplicate';
  const title = isDuplicate ? 'Duplicate page' : 'Add page';
  // For duplicate: source page text + suggested default for Custom input.
  const sourceHtml = isDuplicate ? (existingPages?.[sourceName] || '') : '';
  const defaultCustomName = useMemo(() => {
    if (!isDuplicate || !sourceName) return '';
    const base = sourceName.replace(/\.html$/, '');
    let candidate = `${base}-copy.html`;
    let n = 2;
    while (existingPages?.[candidate]) { candidate = `${base}-copy-${n++}.html`; }
    return candidate;
  }, [isDuplicate, sourceName, existingPages]);

  // Available nav items = those in index.html that point to "#" AND aren't
  // already wired to a real file in this project. Sorted by document order.
  const navOptions = useMemo(() => {
    if (!open) return [];
    const all = extractUnwiredNavLinks(indexHtml);
    return all.filter(opt => !existingPages?.[opt.slug]);
  }, [open, indexHtml, existingPages]);

  // Reset on every open so the dialog never carries stale state. Duplicate
  // mode pre-fills Custom with `<source>-copy.html` so the most common
  // duplicate (keep the layout, give it a sibling name) is one click.
  useEffect(() => {
    if (open) {
      setMode('list');
      setCustomName(isDuplicate ? defaultCustomName : '');
      setError('');
    }
  }, [open, isDuplicate, defaultCustomName]);

  // Focus the custom-name input the moment the user switches to that mode.
  useEffect(() => {
    if (mode === 'custom') customInputRef.current?.focus();
  }, [mode]);

  // Escape closes, click outside closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  const buildStub = (filename) => {
    const titleCase = filename
      .replace(/\.html$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    return `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${titleCase}</title></head>\n<body><p>New page — prompt the model in this chat to generate the content.</p></body>\n</html>`;
  };

  // For duplicate mode: clone the source page's HTML; the model can iterate
  // from the existing layout/content. For add mode: emit a minimal stub the
  // model fills in via the first prompt.
  const buildHtml = (filename) => isDuplicate ? sourceHtml : buildStub(filename);

  const handlePickNav = (opt) => {
    if (existingPages?.[opt.slug]) {
      setError(`${opt.slug} already exists.`);
      return;
    }
    onCreate({ name: opt.slug, html: buildHtml(opt.slug), navLabel: opt.label });
    onClose();
  };

  const handleCustomSubmit = (e) => {
    e?.preventDefault?.();
    const raw = customName.trim().toLowerCase();
    if (!raw) { setError('Enter a filename.'); return; }
    const normalized = raw.endsWith('.html') ? raw : `${raw}.html`;
    if (!FILENAME_RE.test(normalized)) {
      setError('Filename must be lowercase letters/digits/dashes ending in .html');
      return;
    }
    if (existingPages?.[normalized]) {
      setError(`${normalized} already exists.`);
      return;
    }
    onCreate({ name: normalized, html: buildHtml(normalized) });
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="add-page-dialog" ref={dialogRef} role="dialog" aria-label={title}>
        <div className="add-page-header">
          <h3>{title}</h3>
          <button type="button" className="add-page-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {isDuplicate && sourceName && (
          <div className="add-page-source">
            Duplicating from <code>{sourceName}</code>
          </div>
        )}

        {mode === 'list' && (
          <div className="add-page-body">
            <button
              type="button"
              className="add-page-row custom"
              onClick={() => { setError(''); setMode('custom'); }}
            >
              <span className="row-label">Custom filename…</span>
              <span className="row-hint">Off-nav page (404, legal, hidden link)</span>
            </button>

            {navOptions.length > 0 && (
              <>
                <div className="add-page-divider">Unlinked menu items in index.html</div>
                {navOptions.map(opt => (
                  <button
                    key={opt.slug}
                    type="button"
                    className="add-page-row"
                    onClick={() => handlePickNav(opt)}
                  >
                    <span className="row-label">{opt.label}</span>
                    <span className="row-slug">{opt.slug}</span>
                  </button>
                ))}
              </>
            )}

            {navOptions.length === 0 && (
              <div className="add-page-empty">
                No unwired nav items found in <code>index.html</code>. Use Custom filename to add an off-nav page.
              </div>
            )}

            {error && <div className="add-page-error">{error}</div>}
          </div>
        )}

        {mode === 'custom' && (
          <form className="add-page-body" onSubmit={handleCustomSubmit}>
            <label className="add-page-label" htmlFor="add-page-custom-input">
              Filename
            </label>
            <input
              id="add-page-custom-input"
              ref={customInputRef}
              type="text"
              className="add-page-input"
              value={customName}
              onChange={(e) => { setCustomName(e.target.value); setError(''); }}
              placeholder="services.html"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="add-page-hint">
              Lowercase letters, digits, dashes; <code>.html</code> auto-added if missing.
            </div>
            {error && <div className="add-page-error">{error}</div>}
            <div className="add-page-actions">
              <button type="button" onClick={() => { setError(''); setMode('list'); }}>
                Back
              </button>
              <button type="submit" className="primary">
                Create
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
