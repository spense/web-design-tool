// Inline selection state + iframe-side listener install, factored out of
// PreviewPanel so the preview file stays focused on rendering. Behavior is
// identical to the original in-file implementation — this is a pure refactor.
//
// What lives here:
//   - selectMode toggle + all selection state (path, fingerprint, chain, index, rect)
//   - overlay div injection + mousemove/click/scroll listeners inside the iframe
//   - reposition-on-change / on-resize
//   - Esc-to-deselect / click-outside-to-deselect
//   - select-mode CSS class on the iframe html
//
// What stays in PreviewPanel:
//   - link edit dialog state (dialog is chrome, not selection)
//   - anchor click interception (belongs with page navigation)
//   - runtime CSS/JS injection (animations, upcoming global head/body/css)

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSelectorPath,
  resolveSelectorPath,
  getElementChain,
  isSelectable,
  isVisuallyHidden,
  topSelectableAt,
  fingerprintElement,
  matchesFingerprint,
} from './selectionUtils.js';

export function useInlineSelection({ iframeRef, displayHtml }) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectorPath, setSelectorPath] = useState(null);
  const [selectionFingerprint, setSelectionFingerprint] = useState(null);
  const [chainIndex, setChainIndex] = useState(0);
  const [chain, setChain] = useState([]);
  const [selectionRect, setSelectionRect] = useState(null);
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
  }, [iframeRef]);

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
  }, [iframeRef, translateRect]);

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
  }, [iframeRef]);

  // Install overlays + listeners inside the iframe. Runs whenever displayHtml
  // changes (iframe re-mounts).
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
        // If the topmost hit is a legitimately-hidden surface (closed mobile
        // overlay, stashed drawer) that the global pointer-events override
        // re-enabled, walk down to the next selectable element underneath.
        if (target === hoverEl || target === activeEl || !isSelectable(target, doc) || isVisuallyHidden(target)) {
          const fallback = topSelectableAt(doc, e.clientX, e.clientY);
          if (fallback) target = fallback;
        }
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
          // Same fallback as onMouseMove: if the topmost hit is a hidden
          // overlay re-enabled by the select-mode pointer-events override,
          // walk to the next visible selectable element underneath.
          if (!isSelectable(target, doc) || isVisuallyHidden(target)) {
            const fallback = topSelectableAt(doc, e.clientX, e.clientY);
            if (fallback) target = fallback;
          }
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
      // Protect modal dialogs (Edit Link, etc.) — they're rendered outside
      // the iframe and the selection chrome, so without this exemption every
      // click inside the dialog would clear the very selection the dialog
      // is about to mutate. `.modal-backdrop` covers any current/future
      // modal that reuses the standard overlay class.
      if (t.closest && (t.closest('.selection-toolbar') || t.closest('.selection-panel') || t.closest('.modal-backdrop'))) return;
      clearSelection();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [selectorPath, clearSelection, iframeRef]);

  // Clear selection when select mode is turned off.
  useEffect(() => {
    if (!selectMode) clearSelection();
  }, [selectMode, clearSelection]);

  // Force arrow cursor inside iframe when select mode is on.
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    doc.documentElement.classList.toggle('__sel-mode', selectMode);
  }, [selectMode, displayHtml, iframeRef]);

  return {
    selectMode, setSelectMode,
    selectorPath, setSelectorPath,
    selectionFingerprint, setSelectionFingerprint,
    chain,
    chainIndex, setChainIndex,
    selectionRect,
    activeAction, setActiveAction,
    clearSelection,
  };
}
