import React, { useState, useRef, useEffect } from 'react';
import Spinner from './Spinner.jsx';
import ToolsMenu from './ToolsMenu.jsx';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: '100%' },
  tablet: { label: 'Tablet', width: 768 },
  mobile: { label: 'Mobile', width: 390 },
};

export default function PreviewPanel({ pages, activePage, onActivePage, onExport, exporting, snapshot, onSnapshot, onApplyTokens }) {
  const [viewport, setViewport] = useState('desktop');
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const iframeRef = useRef(null);
  const pageDropdownRef = useRef(null);
  const pageNames = Object.keys(pages || {});
  const html = pages?.[activePage] || '';

  // Close page dropdown on outside click (parent doc).
  useEffect(() => {
    if (!pageMenuOpen) return;
    const onDoc = (e) => {
      if (pageDropdownRef.current && !pageDropdownRef.current.contains(e.target)) {
        setPageMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pageMenuOpen]);

  // Intercept iframe nav clicks; ALSO close any open popovers when the user
  // clicks anywhere inside the iframe (parent doc's mousedown listener can't
  // see clicks inside a child document).
  const closeAllPopovers = () => {
    setPageMenuOpen(false);
    setToolsOpen(false);
  };
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !html) return;
    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.addEventListener('mousedown', closeAllPopovers, { capture: true });
        doc.querySelectorAll('a[href]').forEach(a => {
          a.addEventListener('click', (ev) => {
            const href = a.getAttribute('href') || '';
            const resolved = resolveLink(href, pages, doc);
            if (resolved.action === 'page') {
              ev.preventDefault();
              onActivePage(resolved.target);
            } else if (resolved.action === 'scroll') {
              ev.preventDefault();
              const el = doc.getElementById(resolved.target);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (resolved.action === 'block') {
              ev.preventDefault();
            }
          });
        });
      } catch {}
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [html, pages, onActivePage]);

  const copyHtml = async () => {
    try { await navigator.clipboard.writeText(html); } catch {}
  };

  const openFullScreen = () => {
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    // Revoke after the new tab has had time to load
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="preview-panel">
      <div className="preview-toolbar">
        <div className="left">
          <div className="page-dropdown" ref={pageDropdownRef}>
            <button onClick={() => setPageMenuOpen(o => !o)} disabled={pageNames.length === 0}>
              {activePage || 'No pages'} {pageNames.length > 1 ? '▾' : ''}
            </button>
            {pageMenuOpen && pageNames.length > 0 && (
              <div className="page-dropdown-list">
                {pageNames.map(name => (
                  <button
                    key={name}
                    className={name === activePage ? 'active' : ''}
                    onClick={() => { onActivePage(name); setPageMenuOpen(false); }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="tools-wrap">
            <button onClick={() => setToolsOpen(o => !o)} disabled={!html} title="Theme tools">
              Tools ▾
            </button>
            {toolsOpen && (
              <ToolsMenu
                pages={pages}
                activePage={activePage}
                snapshot={snapshot}
                onSnapshot={onSnapshot}
                onApply={onApplyTokens}
                onClose={() => setToolsOpen(false)}
              />
            )}
          </div>
        </div>
        <div className="center">
          <div className="viewport-toggle">
            {Object.entries(VIEWPORTS).map(([key, v]) => (
              <button
                key={key}
                className={viewport === key ? 'active' : ''}
                onClick={() => setViewport(key)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div className="right">
          <button onClick={openFullScreen} disabled={!html} title="Open in new browser tab">Full screen ↗</button>
          <button onClick={copyHtml} disabled={!html}>Copy HTML</button>
          <button className="primary" onClick={onExport} disabled={!html || exporting}>
            {exporting ? <><Spinner /> Exporting…</> : 'Export'}
          </button>
        </div>
      </div>
      <div className="preview-frame-wrap">
        {html ? (
          <iframe
            ref={iframeRef}
            className="preview-frame"
            srcDoc={html}
            title={activePage}
            style={{
              width: VIEWPORTS[viewport].width,
              height: viewport === 'desktop' ? '100%' : 'min(100%, 900px)',
              minHeight: '100%',
            }}
            sandbox="allow-same-origin allow-forms"
          />
        ) : (
          <div className="preview-empty">
            No design yet. Send a message in chat to generate one.
          </div>
        )}
      </div>
    </div>
  );
}

// Decide what to do with a clicked anchor inside the iframe.
//   { action: 'page',   target: 'about.html' }   → switch to that page in our UI
//   { action: 'scroll', target: 'services'  }    → scroll to element with that id
//   { action: 'block' }                          → it's `#` or empty, prevent default
//   { action: 'native' }                         → let the browser handle it
function resolveLink(href, pages, doc) {
  if (!href) return { action: 'block' };
  if (href === '#') return { action: 'block' };

  // External / scheme-prefixed: let it through.
  if (/^(https?:|mailto:|tel:|sms:)/i.test(href)) return { action: 'native' };

  // Same-page anchor — scroll if the target id exists.
  if (href.startsWith('#')) {
    const id = href.slice(1);
    if (id && doc.getElementById(id)) return { action: 'scroll', target: id };
    return { action: 'block' };
  }

  // Strip leading slashes/dots, query string, fragment.
  let path = href.replace(/^\.?\/*/, '').split('?')[0];
  const fragment = path.includes('#') ? path.split('#')[1] : null;
  path = path.split('#')[0];
  const last = path.split('/').pop();

  // Direct page match.
  if (pages[last]) return { action: 'page', target: last };
  // Try adding .html if the AI omitted it.
  if (!last.includes('.') && pages[`${last}.html`]) return { action: 'page', target: `${last}.html` };
  // Maybe it was meant as a section anchor on the same page.
  if (last && doc.getElementById(last)) return { action: 'scroll', target: last };
  if (fragment && doc.getElementById(fragment)) return { action: 'scroll', target: fragment };
  // Try slug-ifying the link text as a last resort? No — too risky.

  return { action: 'block' };
}
