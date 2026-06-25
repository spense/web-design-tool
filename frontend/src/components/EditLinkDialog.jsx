import React, { useEffect, useMemo, useRef, useState } from 'react';

// Modal for retargeting an `<a>` element's href. Mirrors AddPageDialog's
// look-and-feel: a list of project pages (the common case — point this
// link at services.html), plus a Custom field for any URL the user wants
// (anchor like `#contact`, relative path, or absolute URL).
//
// Mutation happens in PreviewPanel's onApply path — this dialog only
// resolves "what should the new href be?" and hands it back via onApply.

export default function EditLinkDialog({ open, onClose, currentHref, pages, currentPage, onApply }) {
  const [mode, setMode] = useState('list'); // 'list' | 'custom'
  const [customHref, setCustomHref] = useState('');
  const customInputRef = useRef(null);
  const dialogRef = useRef(null);

  // Project pages, with the current active page first so it's obvious which
  // is "this page" when the user is wiring an in-page anchor.
  const pageList = useMemo(() => {
    if (!pages) return [];
    const names = Object.keys(pages);
    return names.sort((a, b) => {
      if (a === currentPage) return -1;
      if (b === currentPage) return 1;
      if (a === 'index.html') return -1;
      if (b === 'index.html') return 1;
      return a.localeCompare(b);
    });
  }, [pages, currentPage]);

  useEffect(() => {
    if (open) {
      setMode('list');
      // Pre-fill the Custom input with whatever the link currently points
      // to — even when "list" mode is showing — so switching to Custom
      // gives the user the current value as a starting point to edit
      // rather than a blank field.
      setCustomHref(currentHref || '');
    }
  }, [open, currentHref]);

  useEffect(() => {
    if (mode === 'custom') {
      customInputRef.current?.focus();
      customInputRef.current?.select();
    }
  }, [mode]);

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

  const handlePickPage = (name) => {
    onApply(name);
    onClose();
  };

  const handleCustomSubmit = (e) => {
    e?.preventDefault?.();
    const v = customHref.trim();
    if (!v) return;
    onApply(v);
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="add-page-dialog" ref={dialogRef} role="dialog" aria-label="Edit link">
        <div className="add-page-header">
          <h3>Edit link</h3>
          <button type="button" className="add-page-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {currentHref && (
          <div className="add-page-source">
            Currently linked to <code>{currentHref}</code>
          </div>
        )}

        {mode === 'list' && (
          <div className="add-page-body">
            <button
              type="button"
              className="add-page-row custom"
              onClick={() => setMode('custom')}
            >
              <span className="row-label">Custom URL…</span>
              <span className="row-hint">Anchor, relative path, or absolute URL</span>
            </button>

            {pageList.length > 0 && (
              <>
                <div className="add-page-divider">Pages in this project</div>
                {pageList.map(name => {
                  const isCurrent = currentHref === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      className={`add-page-row${isCurrent ? ' is-current' : ''}`}
                      onClick={() => handlePickPage(name)}
                    >
                      <span className="row-label">{name}</span>
                      {name === currentPage && <span className="row-hint">(this page)</span>}
                      {isCurrent && <span className="row-hint">current</span>}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}

        {mode === 'custom' && (
          <form className="add-page-body" onSubmit={handleCustomSubmit}>
            <label className="add-page-label" htmlFor="edit-link-custom-input">
              URL
            </label>
            <input
              id="edit-link-custom-input"
              ref={customInputRef}
              type="text"
              className="add-page-input"
              value={customHref}
              onChange={(e) => setCustomHref(e.target.value)}
              placeholder="#section-id, ../path, or https://example.com"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="add-page-hint">
              Use <code>#anchor</code> for in-page scroll, a filename like <code>about.html</code> for project pages, or any absolute URL.
            </div>
            <div className="add-page-actions">
              <button type="button" onClick={() => setMode('list')}>
                Back
              </button>
              <button type="submit" className="primary">
                Apply
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
