import React, { useState, useRef, useEffect } from 'react';
import Spinner from './Spinner.jsx';
import ToolsMenu from './ToolsMenu.jsx';
import { extractTokens } from '../tokenRewriter.js';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: '100%' },
  tablet: { label: 'Tablet', width: 768 },
  mobile: { label: 'Mobile', width: 390 },
};

export default function PreviewPanel({ pages, activePage, onActivePage, onExport, exporting, snapshot, onSnapshot, onApplyTokens, slug, project, onFaviconChange, scrollAnimations, onScrollAnimationsChange }) {
  const [viewport, setViewport] = useState('desktop');
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const iframeRef = useRef(null);
  const pageDropdownRef = useRef(null);
  const toolsUpdateRef = useRef(false);
  const savedScrollRef = useRef(0);
  const scrollAnimationsRef = useRef(scrollAnimations);
  scrollAnimationsRef.current = scrollAnimations;
  const [displayHtml, setDisplayHtml] = useState('');

  const pageNames = Object.keys(pages || {});
  const rawHtml = pages?.[activePage] || '';
  const html = rawHtml ? rewriteUploadsUrls(rawHtml, slug) : '';

  // Sync displayHtml from non-tools changes (chat responses, page switches).
  useEffect(() => {
    if (toolsUpdateRef.current) {
      toolsUpdateRef.current = false;
      return;
    }
    // Save scroll position before the iframe reloads with new srcDoc
    try {
      const win = iframeRef.current?.contentWindow;
      if (win) savedScrollRef.current = win.scrollY || 0;
    } catch {}
    setDisplayHtml(html);
  }, [html]);

  const handleApplyTokens = (newPages) => {
    toolsUpdateRef.current = true;
    // Apply CSS vars + fonts directly to live iframe DOM (no reload, scroll preserved)
    try {
      const iframe = iframeRef.current;
      const doc = iframe?.contentDocument;
      if (doc) {
        const newPageHtml = newPages[activePage] || Object.values(newPages)[0] || '';
        const newTokens = extractTokens(newPageHtml);
        if (newTokens) {
          for (const [k, v] of Object.entries(newTokens)) {
            doc.documentElement.style.setProperty(k, v);
          }
        }
        // Sync all Google Fonts links (preconnects + stylesheet) to match new HTML
        const newFontLinks = newPageHtml.match(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/gi) || [];
        const oldFontLinks = doc.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]');
        oldFontLinks.forEach(el => el.remove());
        if (newFontLinks.length) {
          const frag = doc.createDocumentFragment();
          const tmp = doc.createElement('div');
          tmp.innerHTML = newFontLinks.join('');
          while (tmp.firstChild) frag.appendChild(tmp.firstChild);
          doc.head.appendChild(frag);
        }
      }
    } catch {}
    onApplyTokens(newPages);
  };

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
    if (!iframe || !displayHtml) return;
    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        // Restore scroll position saved before srcDoc swap
        if (savedScrollRef.current) {
          iframe.contentWindow?.scrollTo({ top: savedScrollRef.current, behavior: 'instant' });
          savedScrollRef.current = 0;
        }
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
              if (el) el.scrollIntoView({ behavior: scrollAnimationsRef.current ? 'smooth' : 'instant', block: 'start' });
            } else if (resolved.action === 'block') {
              ev.preventDefault();
            }
          });
        });
      } catch {}
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [displayHtml, pages, onActivePage]);

  // Sync animation toggle override into iframe
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !displayHtml) return;
    const apply = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const id = '__anim-override';
        let existing = doc.getElementById(id);
        if (!scrollAnimations) {
          if (!existing) {
            existing = doc.createElement('style');
            existing.id = id;
            existing.textContent = '.animate-in { opacity: 1 !important; transform: none !important; transition: none !important; }';
            doc.head.appendChild(existing);
          }
        } else {
          if (existing) existing.remove();
          // Reset elements that haven't animated yet so the observer fires fresh
          doc.querySelectorAll('.animate-in:not(.visible)').forEach(el => {
            el.classList.remove('visible');
          });
          // Re-observe all animate-in elements
          if (iframe.contentWindow) {
            const script = doc.createElement('script');
            script.textContent = `
              if (window.__animObserver) window.__animObserver.disconnect();
              window.__animObserver = new IntersectionObserver((entries) => {
                entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); window.__animObserver.unobserve(e.target); } });
              }, { threshold: 0.15 });
              document.querySelectorAll('.animate-in:not(.visible)').forEach(el => window.__animObserver.observe(el));
            `;
            doc.body.appendChild(script);
            script.remove();
          }
        }
      } catch {}
    };
    // Apply immediately if iframe already loaded
    apply();
    // Also apply on load (for page switches)
    iframe.addEventListener('load', apply);
    return () => iframe.removeEventListener('load', apply);
  }, [scrollAnimations, displayHtml]);

  const [copied, setCopied] = useState(false);
  const copyHtml = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
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
          {pageNames.length > 1 && (
            <div className="page-dropdown" ref={pageDropdownRef}>
              <button className="with-caret" onClick={() => setPageMenuOpen(o => !o)}>
                {activePage}
              </button>
              {pageMenuOpen && (
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
          )}
          <div className="tools-wrap">
            <button className="with-caret" onClick={() => setToolsOpen(o => !o)} disabled={!html} title="Theme tools">
              Tools
            </button>
            {toolsOpen && (
              <ToolsMenu
                pages={pages}
                activePage={activePage}
                snapshot={snapshot}
                onSnapshot={onSnapshot}
                onApply={handleApplyTokens}
                onClose={() => setToolsOpen(false)}
                slug={slug}
                project={project}
                onFaviconChange={onFaviconChange}
                scrollAnimations={scrollAnimations}
                onScrollAnimationsChange={onScrollAnimationsChange}
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
          <button onClick={copyHtml} disabled={!html}>{copied ? 'Copied!' : 'Copy HTML'}</button>
          <button className="primary" onClick={onExport} disabled={!html || exporting}>
            {exporting ? <><Spinner /> Exporting…</> : 'Export'}
          </button>
        </div>
      </div>
      <div className="preview-frame-wrap">
        {displayHtml ? (
          <iframe
            ref={iframeRef}
            className="preview-frame"
            srcDoc={displayHtml}
            title={activePage}
            style={{
              width: VIEWPORTS[viewport].width,
              height: viewport === 'desktop' ? '100%' : 'min(100%, 900px)',
              minHeight: '100%',
            }}
            sandbox="allow-same-origin allow-forms allow-scripts"
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

// Rewrite relative `uploads/foo.jpg` paths to an absolute backend URL so the
// srcDoc iframe (no origin) can fetch them.
function rewriteUploadsUrls(html, slug) {
  if (!slug) return html;
  const base = `http://localhost:3001/api/projects/${slug}/uploads/`;
  return html.replace(/(src|href)=(['"])(?:\.\/)?uploads\/([^'"]+)\2/g,
    (_, attr, q, file) => `${attr}=${q}${base}${file}${q}`);
}
