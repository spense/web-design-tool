import React, { useState, useRef, useEffect } from 'react';
import Spinner from './Spinner.jsx';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: '100%' },
  tablet: { label: 'Tablet', width: 768 },
  mobile: { label: 'Mobile', width: 390 },
};

export default function PreviewPanel({ pages, activePage, onActivePage, onExport, exporting }) {
  const [viewport, setViewport] = useState('desktop');
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const iframeRef = useRef(null);
  const pageNames = Object.keys(pages || {});
  const html = pages?.[activePage] || '';

  // Intercept iframe nav clicks to re-route between project pages.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !html) return;
    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href') || '';
          // resolve to a possible filename
          const last = href.split('/').pop().split('?')[0].split('#')[0];
          if (pages[last]) {
            a.addEventListener('click', (ev) => {
              ev.preventDefault();
              onActivePage(last);
            });
          } else if (href === '#' || href === '' || href.startsWith('#')) {
            // leave anchor links alone
          }
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
          <div className="page-dropdown">
            <button onClick={() => setPageMenuOpen(o => !o)} disabled={pageNames.length === 0}>
              {activePage || 'No pages'} {pageNames.length > 1 ? '▾' : ''}
            </button>
            {pageMenuOpen && pageNames.length > 0 && (
              <div className="page-dropdown-list" onMouseLeave={() => setPageMenuOpen(false)}>
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
