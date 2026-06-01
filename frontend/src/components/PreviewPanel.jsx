import React, { useState, useRef, useEffect, useCallback } from 'react';
import Spinner from './Spinner.jsx';
import ToolsMenu from './ToolsMenu.jsx';
import SelectionToolbar from './SelectionToolbar.jsx';
import SelectionPanel from './SelectionPanel.jsx';
import { IconPointer } from '../inlineEdit/icons.jsx';
import { commitInlineEdit } from '../inlineEdit/commit.js';
import { extractTokens } from '../tokenRewriter.js';
import {
  getSelectorPath,
  resolveSelectorPath,
  getElementChain,
  isSelectable,
  fingerprintElement,
  matchesFingerprint,
} from '../inlineEdit/selectionUtils.js';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: '100%' },
  tablet: { label: 'Tablet', width: 768 },
  mobile: { label: 'Mobile', width: 390 },
};

export default function PreviewPanel({ pages, activePage, onActivePage, onExport, exporting, snapshot, onSnapshot, onApplyTokens, activeColor, activeFont, slug, project, onFaviconChange, scrollAnimations, onScrollAnimationsChange, chatCollapsed, onToggleChatCollapsed, canUndo, canRedo, onUndo, onRedo, onInlinePrompt }) {
  const [viewport, setViewport] = useState('desktop');
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const iframeRef = useRef(null);
  const pageDropdownRef = useRef(null);
  const savedScrollRef = useRef(0);
  const scrollAnimationsRef = useRef(scrollAnimations);
  scrollAnimationsRef.current = scrollAnimations;
  const [displayHtml, setDisplayHtml] = useState('');

  // ── Inline selection state ────────────────────────────────────────────────
  // Selection mode toggle. When OFF, the iframe behaves normally (anchor
  // clicks navigate). When ON, clicks select elements for inline editing.
  const [selectMode, setSelectMode] = useState(false);
  // Path of nth-child indices from <body> down to the chosen element.
  // Persists across iframe re-renders so the selection re-resolves on re-mount.
  const [selectorPath, setSelectorPath] = useState(null);
  // Identity snapshot of the selected element. After an iframe re-render,
  // we re-resolve the path AND verify it points to the same element — paths
  // alone are not enough (sibling shifts can land on a different element).
  const [selectionFingerprint, setSelectionFingerprint] = useState(null);
  // Index into the ancestor chain. 0 = outermost ancestor, last = clicked el.
  const [chainIndex, setChainIndex] = useState(0);
  // Live ancestor chain for the currently-selected element (refs into the iframe DOM).
  const [chain, setChain] = useState([]);
  // Selected element's rect, translated into the PARENT viewport.
  const [selectionRect, setSelectionRect] = useState(null);
  // Which inline action is currently open in the panel.
  const [activeAction, setActiveAction] = useState(null);

  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  // Read chain/chainIndex through refs inside long-lived listeners (the
  // iframe's `scroll` handler is installed once per iframe-load and would
  // otherwise capture stale values from before the user selected anything).
  const chainRef = useRef(chain);
  chainRef.current = chain;
  const chainIndexRef = useRef(chainIndex);
  chainIndexRef.current = chainIndex;

  const pageNames = Object.keys(pages || {});
  const rawHtml = pages?.[activePage] || '';
  const html = rawHtml ? rewriteUploadsUrls(rawHtml, slug) : '';

  // Sync displayHtml whenever the underlying html changes (chat responses,
  // page switches, tools changes, undo/redo).
  useEffect(() => {
    // Save scroll position before the iframe reloads with new srcDoc
    try {
      const win = iframeRef.current?.contentWindow;
      if (win) savedScrollRef.current = win.scrollY || 0;
    } catch {}
    setDisplayHtml(html);
  }, [html]);

  const handleApplyTokens = (newPages, projectPatch) => {
    // Apply CSS vars + fonts directly to live iframe DOM for instant feedback;
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
    onApplyTokens(newPages, projectPatch);
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

  // Translate an iframe-viewport rect into PARENT viewport coordinates.
  const translateRect = useCallback((rect) => {
    const iframe = iframeRef.current;
    if (!iframe || !rect) return null;
    const ifr = iframe.getBoundingClientRect();
    return {
      top: ifr.top + rect.top,
      left: ifr.left + rect.left,
      right: ifr.left + rect.right,
      bottom: ifr.top + rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  // Update the iframe-side selection overlay div + the parent toolbar position
  // for the currently-selected element. Reads chain/chainIndex via refs so
  // long-lived iframe-scroll listeners always see the latest selection
  // (otherwise the listener captures stale values from install time).
  const repositionForSelection = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc) return;
    const el = chainRef.current[chainIndexRef.current];
    const overlay = doc.getElementById('__sel-active');
    if (!el || !overlay) {
      if (overlay) overlay.style.display = 'none';
      setSelectionRect(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const win = iframe.contentWindow;
    overlay.style.display = 'block';
    overlay.style.top    = `${rect.top + (win?.scrollY || 0)}px`;
    overlay.style.left   = `${rect.left + (win?.scrollX || 0)}px`;
    overlay.style.width  = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    setSelectionRect(translateRect(rect));
  }, [translateRect]);

  // Clear all selection state.
  const clearSelection = useCallback(() => {
    setSelectorPath(null);
    setSelectionFingerprint(null);
    setChain([]);
    setChainIndex(0);
    setSelectionRect(null);
    setActiveAction(null);
    const doc = iframeRef.current?.contentDocument;
    const overlay = doc?.getElementById('__sel-active');
    if (overlay) overlay.style.display = 'none';
    const hover = doc?.getElementById('__sel-hover');
    if (hover) hover.style.display = 'none';
  }, []);

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

  // ── Install selection overlays + listeners inside the iframe ──────────────
  // Runs whenever displayHtml changes (iframe re-mounts) or selectMode flips.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !displayHtml) return;

    let mounted = true;
    let cleanupFns = [];

    const install = () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !doc.body) return;
      // Idempotency: never double-install on the same doc instance.
      // (srcDoc swaps create a new doc, which won't carry this flag.)
      if (doc.__selInstalled) return;
      doc.__selInstalled = true;

      // Inject overlay style + divs once per iframe doc.
      if (!doc.getElementById('__sel-style')) {
        const style = doc.createElement('style');
        style.id = '__sel-style';
        style.textContent = `
          #__sel-hover, #__sel-active {
            position: absolute;
            /* !important so the global html.__sel-mode * { pointer-events:
               auto !important } rule doesn't make our own overlays
               mouse-targetable (which would cause a hover-flicker loop:
               show overlay → target becomes overlay → hide → repeat). */
            pointer-events: none !important;
            z-index: 2147483646;
            box-sizing: border-box;
            display: none;
          }
          #__sel-hover {
            outline: 1.5px dashed #7c9cff;
            outline-offset: -1px;
            background: rgba(124, 156, 255, 0.06);
          }
          #__sel-active {
            outline: 2px solid #7c9cff;
            outline-offset: -1px;
            background: rgba(124, 156, 255, 0.10);
          }
          /* Force arrow cursor + make every element clickable while editing.
             pointer-events:none is common on decorative overlays (gradients,
             glows, bg-image layers) so they don't block clicks on the
             design's interactive elements — but that also makes them
             unreachable to our selection tool. We override only while
             select mode is on; when it's off, the design behaves normally. */
          html.__sel-mode, html.__sel-mode * {
            cursor: default !important;
            pointer-events: auto !important;
          }
        `;
        doc.head.appendChild(style);
      }
      const ensureDiv = (id) => {
        let el = doc.getElementById(id);
        if (!el) {
          el = doc.createElement('div');
          el.id = id;
          doc.body.appendChild(el);
        }
        return el;
      };
      const hoverEl = ensureDiv('__sel-hover');
      const activeEl = ensureDiv('__sel-active');

      // Re-resolve any existing selection path against the (possibly new) DOM.
      // Path-only resolution is not enough — after a chat edit that removes
      // an ancestor, the same indices can accidentally land on a sibling
      // that is NOT the originally-selected element. Verify identity via
      // fingerprint, and clear selection if it doesn't match.
      if (selectorPath) {
        const resolved = resolveSelectorPath(selectorPath, doc);
        const stillSameEl = resolved && matchesFingerprint(selectionFingerprint, resolved);
        if (resolved && stillSameEl) {
          const newChain = getElementChain(resolved, doc);
          if (mounted) {
            setChain(newChain);
            setChainIndex(i => Math.min(i, newChain.length - 1));
          }
        } else if (mounted) {
          // Either the path no longer resolves, or it resolves to a
          // different element. Clear selection in both cases.
          setSelectorPath(null);
          setSelectionFingerprint(null);
          setChain([]);
          setChainIndex(0);
          setSelectionRect(null);
          setActiveAction(null);
        }
      } else {
        hoverEl.style.display = 'none';
        activeEl.style.display = 'none';
      }

      const onMouseMove = (e) => {
        if (!selectModeRef.current) {
          hoverEl.style.display = 'none';
          return;
        }
        let target = e.target;
        // Clicking/hovering an icon's internals (path, g, …) should highlight
        // the whole <svg>, not the inner node.
        const svgRoot = target.closest && target.closest('svg');
        if (svgRoot) target = svgRoot;
        if (!isSelectable(target, doc) || target === hoverEl || target === activeEl) {
          hoverEl.style.display = 'none';
          return;
        }
        const r = target.getBoundingClientRect();
        hoverEl.style.display = 'block';
        hoverEl.style.top    = `${r.top + (win.scrollY || 0)}px`;
        hoverEl.style.left   = `${r.left + (win.scrollX || 0)}px`;
        hoverEl.style.width  = `${r.width}px`;
        hoverEl.style.height = `${r.height}px`;
      };
      const onMouseLeave = () => { hoverEl.style.display = 'none'; };

      // Tracks alt-click "dig" cycles. Holding Alt and clicking the same
      // spot repeatedly walks through every selectable element under the
      // cursor (top → bottom → wrap), letting the user reach images that
      // sit beneath overlays / gradients / decorative siblings with a
      // higher z-index.
      let lastAltClick = { x: -1, y: -1, idx: -1 };

      // Capture-phase click handler — intercepts before anchor handlers
      // (which were attached on bubble in the onLoad effect above).
      const onClickCapture = (e) => {
        if (!selectModeRef.current) return;
        let target = e.target;

        if (e.altKey) {
          // Find every selectable element at the cursor, top-to-bottom.
          const stack = doc.elementsFromPoint
            ? doc.elementsFromPoint(e.clientX, e.clientY).filter(el => isSelectable(el, doc))
            : [];
          if (stack.length > 1) {
            // Same spot as last alt-click? advance index. Else start at 1
            // (skip the topmost, since a regular click already gives them that).
            const samePos = Math.abs(e.clientX - lastAltClick.x) < 6 &&
                            Math.abs(e.clientY - lastAltClick.y) < 6;
            const nextIdx = samePos
              ? (lastAltClick.idx + 1) % stack.length
              : 1;
            target = stack[nextIdx];
            lastAltClick = { x: e.clientX, y: e.clientY, idx: nextIdx };
          }
        } else {
          lastAltClick = { x: -1, y: -1, idx: -1 };
        }

        // Selecting any part of an icon resolves to the whole <svg>.
        const svgRoot = target.closest && target.closest('svg');
        if (svgRoot) target = svgRoot;

        if (!isSelectable(target, doc)) return;
        e.preventDefault();
        e.stopPropagation();
        const path = getSelectorPath(target, doc);
        if (!path) return;
        const newChain = getElementChain(target, doc);
        setSelectorPath(path);
        setSelectionFingerprint(fingerprintElement(target));
        setChain(newChain);
        setChainIndex(newChain.length - 1);
        setActiveAction(null);
      };

      const onScroll = () => repositionForSelection();

      doc.addEventListener('mousemove', onMouseMove);
      doc.addEventListener('mouseleave', onMouseLeave);
      doc.addEventListener('click', onClickCapture, { capture: true });
      win.addEventListener('scroll', onScroll, { passive: true });

      cleanupFns.push(() => {
        doc.removeEventListener('mousemove', onMouseMove);
        doc.removeEventListener('mouseleave', onMouseLeave);
        doc.removeEventListener('click', onClickCapture, { capture: true });
        win.removeEventListener('scroll', onScroll);
      });
    };

    // Two install triggers — always attach the load listener (so srcDoc
    // swaps get fresh listeners on the new doc) AND attempt right now (in
    // case the doc is already loaded by the time this effect runs). The
    // __selInstalled flag on the doc makes both paths idempotent per-doc.
    iframe.addEventListener('load', install);
    install();
    cleanupFns.push(() => iframe.removeEventListener('load', install));

    return () => {
      mounted = false;
      // Clear the install marker on the current doc so a fresh effect
      // iteration can re-install if React re-runs us for the same doc.
      try {
        const d = iframe.contentDocument;
        if (d) delete d.__selInstalled;
      } catch {}
      cleanupFns.forEach(fn => { try { fn(); } catch {} });
    };
    // Re-install when iframe content changes. selectorPath intentionally NOT
    // a dep — we resolve it inside install using the closure's value, and
    // a separate effect handles selection-only updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayHtml]);

  // When chain / chainIndex change, reposition overlay + parent toolbar.
  useEffect(() => {
    repositionForSelection();
  }, [chain, chainIndex, repositionForSelection]);

  // Reposition on parent window resize.
  useEffect(() => {
    const onResize = () => repositionForSelection();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [repositionForSelection]);

  // Esc to deselect.
  useEffect(() => {
    if (!selectorPath) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectorPath, clearSelection]);

  // Clicking anywhere in the parent doc outside the iframe + selection UI
  // deselects. Clicks INSIDE the iframe never reach this listener (iframe
  // events don't propagate to parent doc), so the iframe-side click handler
  // still gets to do its own selection logic. Protected zones: the iframe
  // element itself (scrollbar, border), the floating selection toolbar, and
  // the floating selection panel.
  useEffect(() => {
    if (!selectorPath) return;
    const onMouseDown = (e) => {
      const t = e.target;
      if (!t) return;
      if (iframeRef.current && t === iframeRef.current) return;
      if (t.closest && (t.closest('.selection-toolbar') || t.closest('.selection-panel'))) return;
      clearSelection();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [selectorPath, clearSelection]);

  // Clear selection when select mode is turned off.
  useEffect(() => {
    if (!selectMode) clearSelection();
  }, [selectMode, clearSelection]);

  // Force arrow cursor inside iframe when select mode is on.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    doc.documentElement.classList.toggle('__sel-mode', selectMode);
  }, [selectMode, displayHtml]);

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
          <button
            type="button"
            className="chat-collapse-toggle"
            onClick={onToggleChatCollapsed}
            title={chatCollapsed ? 'Expand chat sidebar' : 'Collapse chat sidebar'}
            aria-label={chatCollapsed ? 'Expand chat sidebar' : 'Collapse chat sidebar'}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
              <line x1="6" y1="3.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1.25" />
              {chatCollapsed ? (
                <path d="M9 6.5L10.5 8L9 9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M10.5 6.5L9 8L10.5 9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
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
                activeColor={activeColor}
                activeFont={activeFont}
                onClose={() => setToolsOpen(false)}
                slug={slug}
                project={project}
                onFaviconChange={onFaviconChange}
                scrollAnimations={scrollAnimations}
                onScrollAnimationsChange={onScrollAnimationsChange}
              />
            )}
          </div>
          <button
            type="button"
            className={`inspect-toggle ${selectMode ? 'active' : ''}`}
            onClick={() => setSelectMode(m => !m)}
            disabled={!html}
            title={selectMode ? 'Exit select mode' : 'Enter select mode'}
          >
            <IconPointer />
            <span>Select</span>
          </button>
          <div className="undo-redo">
            <button onClick={onUndo} disabled={!canUndo} title="Undo">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.5 5.5H10C11.933 5.5 13.5 7.067 13.5 9C13.5 10.933 11.933 12.5 10 12.5H7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M5.5 2.5L2.5 5.5L5.5 8.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button onClick={onRedo} disabled={!canRedo} title="Redo">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12.5 5.5H5C3.067 5.5 1.5 7.067 1.5 9C1.5 10.933 3.067 12.5 5 12.5H7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M9.5 2.5L12.5 5.5L9.5 8.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
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
        {selectMode && selectionRect && chain.length > 0 && (
          <SelectionToolbar
            rect={selectionRect}
            chain={chain}
            selectedIndex={chainIndex}
            onPick={(i) => {
              setChainIndex(i);
              // Update selectorPath + fingerprint to the picked ancestor.
              const el = chain[i];
              const doc = iframeRef.current?.contentDocument;
              if (el && doc) {
                const p = getSelectorPath(el, doc);
                if (p) setSelectorPath(p);
                setSelectionFingerprint(fingerprintElement(el));
              }
            }}
            onAction={(actionId) => {
              if (actionId === 'remove') {
                const el = chain[chainIndex];
                const tag = el?.tagName?.toLowerCase() || 'element';
                if (!window.confirm(`Remove this <${tag}>?`)) return;
                const newHtml = commitInlineEdit({
                  sourceHtml: pages?.[activePage] || '',
                  selectorPath,
                  mutator: (target) => target.remove(),
                });
                if (!newHtml) {
                  console.warn('[inline-edit] remove failed: could not resolve element');
                  return;
                }
                onApplyTokens({ ...pages, [activePage]: newHtml });
                clearSelection();
                return;
              }
              if (actionId === 'prompt-change') {
                // Route Prompt action to the main chat panel with an inline
                // scope pill. ChatPanel inherits crawl data, model selection,
                // history, and review surface.
                const el = chain[chainIndex];
                if (!el || !selectorPath || !onInlinePrompt) return;
                const breadcrumb = chain
                  .map(n => n.id ? `${n.tagName.toLowerCase()}#${n.id}` : n.tagName.toLowerCase())
                  .join(' > ');
                onInlinePrompt({
                  path: selectorPath.join('.'),
                  page: activePage,
                  tag: el.tagName.toLowerCase(),
                  outerHTML: el.outerHTML,
                  breadcrumb,
                });
                // Keep the visual selection so the user has spatial reference
                // while typing the prompt. Don't open the drawer panel.
                return;
              }
              setActiveAction(actionId);
            }}
            activeAction={activeAction}
          />
        )}
        {selectMode && activeAction && chain[chainIndex] && (
          <SelectionPanel
            action={activeAction}
            element={chain[chainIndex]}
            slug={slug}
            onClose={() => setActiveAction(null)}
            onApply={(payload) => {
              const target = chain[chainIndex];
              let mutator = null;
              let updatedFingerprint = null;

              // ── Text edit + rewrite ────────────────────────────────────
              if (activeAction === 'edit-text' || activeAction === 'rewrite-text') {
                const text = payload;
                mutator = (t) => { t.textContent = text; };
                updatedFingerprint = {
                  tag: target.tagName,
                  id: target.id || null,
                  textPrefix: text.trim().replace(/\s+/g, ' ').slice(0, 60),
                  childCount: 0,
                };
              }
              // ── Replace visual ─────────────────────────────────────────
              else if (activeAction === 'replace-visual') {
                if (payload.kind === 'image') {
                  const newPath = payload.path;
                  if (target.tagName === 'IMG') {
                    mutator = (t) => { t.setAttribute('src', newPath); };
                  } else {
                    // Element with background-image — write an inline style
                    // override. Use !important so we win the cascade even
                    // against class rules that themselves use !important
                    // (common in design-system CSS). Also clean up any
                    // existing inline background-image / background-shorthand
                    // so we don't accumulate cruft on repeat replacements.
                    mutator = (t) => {
                      const prev = t.getAttribute('style') || '';
                      let cleaned = prev
                        .replace(/background-image\s*:\s*[^;]+;?\s*/gi, '')
                        // Strip 'background' shorthand too — it would set
                        // background-image to none/initial without our knowing.
                        .replace(/(^|;)\s*background\s*:\s*[^;]+;?/gi, '$1')
                        .trim();
                      if (cleaned && !cleaned.endsWith(';')) cleaned += ';';
                      // CSS allows unquoted URLs and they survive HTML
                      // attribute serialization cleanly. Quoting with " here
                      // gets entity-encoded to &quot; during serialization,
                      // which breaks rewriteUploadsUrls' downstream match.
                      const next = `${cleaned}background-image: url(${newPath}) !important;`.trim();
                      t.setAttribute('style', next);
                    };
                  }
                  updatedFingerprint = null;
                } else if (payload.kind === 'svg') {
                  const newMarkup = payload.markup;
                  mutator = (t, doc) => {
                    const tmp = doc.createElement('div');
                    tmp.innerHTML = newMarkup;
                    const fresh = tmp.firstElementChild;
                    if (!fresh || fresh.tagName.toLowerCase() !== 'svg') return;
                    t.replaceWith(fresh);
                  };
                  updatedFingerprint = {
                    tag: 'svg',
                    id: null,
                    textPrefix: '',
                    childCount: 0,
                  };
                }
              }

              if (!mutator) return;
              const newHtml = commitInlineEdit({
                sourceHtml: pages?.[activePage] || '',
                selectorPath,
                mutator,
              });
              if (!newHtml) {
                console.warn('[inline-edit] commit failed: could not resolve element');
                return;
              }
              if (updatedFingerprint) setSelectionFingerprint(updatedFingerprint);
              onApplyTokens({ ...pages, [activePage]: newHtml });
              setActiveAction(null);
            }}
          />
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
  let result = html.replace(/(src|href)=(['"])(?:\.\/)?uploads\/([^'"]+)\2/g,
    (_, attr, q, file) => `${attr}=${q}${base}${file}${q}`);
  // Match url(...) with optional quote OR entity-encoded quote on either
  // side. When inline styles are written via setAttribute and re-serialized,
  // browsers encode inner double quotes as &quot; — which is not a quote
  // character, so a naive [\'"] would miss the URL. We emit the rewritten
  // URL unquoted (CSS accepts that) to sidestep the encoding issue entirely.
  const DELIM = `(?:["']|&quot;|&apos;|&#34;|&#39;)?`;
  const re = new RegExp(`url\\(\\s*${DELIM}(?:\\.\\/)?uploads\\/([^)\\s"'&]+)\\s*${DELIM}\\s*\\)`, 'g');
  result = result.replace(re, (_, file) => `url(${base}${file})`);
  return result;
}
