import React, { useState, useRef, useEffect, useCallback } from 'react';
import Spinner from './Spinner.jsx';
import ToolsMenu from './ToolsMenu.jsx';
import SelectionToolbar from './SelectionToolbar.jsx';
import SelectionPanel from './SelectionPanel.jsx';
import EditLinkDialog from './EditLinkDialog.jsx';
import { IconPointer } from '../inlineEdit/icons.jsx';
import { commitInlineEdit } from '../inlineEdit/commit.js';
import { extractTokens } from '../tokenRewriter.js';
import {
  ANIMATIONS_CSS,
  ANIMATIONS_JS,
  buildEffectOverrideCss,
  buildCountUpOffScript,
} from '../../../backend/animationAssets.js';
import { DEFAULT_ANIMATIONS } from '../animations.js';
import {
  getSelectorPath, fingerprintElement,
  getFlowRoot, getStructuralChildren, isStructuralTopLevel,
  resolveSelectorPath,
} from '../inlineEdit/selectionUtils.js';
import { useInlineSelection } from '../inlineEdit/useInlineSelection.js';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: '100%' },
  tablet: { label: 'Tablet', width: 768 },
  mobile: { label: 'Mobile', width: 390 },
};

export default function PreviewPanel({ pages, activePage, onActivePage, onExport, exporting, snapshot, onSnapshot, onApplyTokens, activeColor, activeFont, slug, project, onFaviconChange, onOgImageChange, animations, onAnimationChange, chatCollapsed, onToggleChatCollapsed, canUndo, canRedo, onUndo, onRedo, onInlinePrompt, onOpenCodePanel }) {
  const effects = animations || DEFAULT_ANIMATIONS;
  const [viewport, setViewport] = useState('desktop');
  const [toolsOpen, setToolsOpen] = useState(false);
  const iframeRef = useRef(null);
  const savedScrollRef = useRef(0);
  // When a cross-page hash link (e.g. services.html#fabrication) is clicked,
  // we switch the active page (which reloads the iframe) and stash the target
  // section id here so the new page can scroll to it once it finishes loading.
  const pendingHashRef = useRef(null);
  // Fade-in toggle drives smooth-scroll behavior on in-page nav clicks (same
  // intent as before: "if you opted out of motion, don't smooth-scroll either").
  const smoothScrollRef = useRef(effects.fadeIn);
  smoothScrollRef.current = effects.fadeIn;
  const [displayHtml, setDisplayHtml] = useState('');

  // ── Inline selection state ────────────────────────────────────────────────
  // All selection lifecycle (state, iframe listeners, deselect handlers) lives
  // in useInlineSelection. The hook keeps PreviewPanel focused on rendering
  // and iframe orchestration.
  const {
    selectMode, setSelectMode,
    selectorPath, setSelectorPath,
    setSelectionFingerprint,
    chain,
    chainIndex, setChainIndex,
    selectionRect,
    activeAction, setActiveAction,
    clearSelection,
  } = useInlineSelection({ iframeRef, displayHtml });

  // Edit Link dialog: opened from the SelectionToolbar's link action. Holds
  // the link's current href so the dialog can pre-fill the Custom field
  // with the existing value when the user wants to tweak it.
  const [linkEditOpen, setLinkEditOpen] = useState(false);
  const [linkEditHref, setLinkEditHref] = useState('');

  // Hover-`+` overlay for inserting a new sibling between structural top-level
  // items in the flow root. Only visible in Select Mode.
  //
  // `domIndex` is the RAW child index into flowRoot.children (not the
  // structural array). This distinction matters when the flow root has
  // non-structural children (hidden mobile-menu <input>, decorative <div>s):
  // a structural index of 2 doesn't necessarily map to DOM index 2. The
  // commit path (commitInlineEdit → target.children[N]) needs a DOM index.
  const [insertGap, setInsertGap] = useState(null); // null | { top, left, width, domIndex }
  // Persistent seam indicator shown while the insert CodePanel is open, so
  // the user retains a spatial reference for where the code will land after
  // the `+` overlay disappears on click. Coordinates are IN THE IFRAME's
  // body coordinate system (position: absolute, relative to body) so the
  // indicator naturally scrolls with content.
  const [insertPreview, setInsertPreview] = useState(null); // null | { bodyY, bodyLeft, bodyWidth }

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

  // Intercept iframe nav clicks; ALSO close any open popovers when the user
  // clicks anywhere inside the iframe (parent doc's mousedown listener can't
  // see clicks inside a child document).
  const closeAllPopovers = () => {
    setToolsOpen(false);
  };
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !displayHtml) return;
    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        // A cross-page hash link set a pending scroll target before switching
        // pages — honor it now that the new page has loaded, taking precedence
        // over restoring the previous scroll position.
        if (pendingHashRef.current) {
          const id = pendingHashRef.current;
          pendingHashRef.current = null;
          savedScrollRef.current = 0;
          const el = doc.getElementById(id);
          if (el) requestAnimationFrame(() => {
            try { el.scrollIntoView({ behavior: 'instant', block: 'start' }); } catch {}
          });
        } else if (savedScrollRef.current) {
          // Restore scroll position saved before srcDoc swap
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
              if (resolved.target === activePage) {
                // Already on this page — no reload will happen, so scroll to the
                // fragment (if any) directly instead of stashing it for onLoad.
                if (resolved.fragment) {
                  const el = doc.getElementById(resolved.fragment);
                  if (el) el.scrollIntoView({ behavior: smoothScrollRef.current ? 'smooth' : 'instant', block: 'start' });
                }
              } else {
                if (resolved.fragment) pendingHashRef.current = resolved.fragment;
                onActivePage(resolved.target);
              }
            } else if (resolved.action === 'scroll') {
              ev.preventDefault();
              const el = doc.getElementById(resolved.target);
              if (el) el.scrollIntoView({ behavior: smoothScrollRef.current ? 'smooth' : 'instant', block: 'start' });
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


  // Inject the canonical animations runtime (CSS + JS) into every iframe doc,
  // plus per-effect override CSS for any toggle that's off. The runtime is
  // idempotent; the override updates without reloading the iframe.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !displayHtml) return;
    const apply = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        // 1. Base CSS (idempotent — keyed by id)
        if (!doc.getElementById('__cinder-anim-css')) {
          const style = doc.createElement('style');
          style.id = '__cinder-anim-css';
          style.textContent = ANIMATIONS_CSS;
          doc.head.appendChild(style);
        }
        // 2. Runtime JS (idempotent — script self-guards via window.__cinderAnim)
        if (!doc.getElementById('__cinder-anim-js')) {
          const script = doc.createElement('script');
          script.id = '__cinder-anim-js';
          script.textContent = ANIMATIONS_JS;
          doc.body.appendChild(script);
        } else if (iframe.contentWindow?.__cinderAnim) {
          // Re-run setup so newly-injected CSS overrides are reflected.
          iframe.contentWindow.__cinderAnim.refresh();
        }
        // 3. Per-effect override (replaced on every render so toggle flips apply live)
        const overrideId = '__cinder-anim-override';
        const overrideCss = buildEffectOverrideCss(effects);
        let override = doc.getElementById(overrideId);
        if (overrideCss) {
          if (!override) {
            override = doc.createElement('style');
            override.id = overrideId;
            doc.head.appendChild(override);
          }
          override.textContent = overrideCss;
        } else if (override) {
          override.remove();
        }
        // 4. Count-up off requires a runtime kick (CSS can't stop a JS tween).
        const countUpOff = buildCountUpOffScript(effects);
        if (countUpOff) {
          const s = doc.createElement('script');
          s.textContent = countUpOff;
          doc.body.appendChild(s);
          s.remove();
        }
        // 5. Hand the current effect state to the runtime so it can tear down
        // effects whose inline DOM changes can't be neutralized by CSS alone
        // (parallax's img-fallback transform, oversized inset/height, etc.).
        if (iframe.contentWindow?.__cinderAnim?.setEffects) {
          iframe.contentWindow.__cinderAnim.setEffects(effects);
        }
      } catch {}
    };
    apply();
    iframe.addEventListener('load', apply);
    return () => iframe.removeEventListener('load', apply);
  }, [effects, displayHtml]);

  // Inject user code (page/global head, page/global body-end, global CSS)
  // as runtime slots so changes reflect live without reloading the iframe.
  // Order rationale:
  //   Head:  global-head → page-head → global-css
  //     - Global scripts (analytics, tracking) load first so per-page scripts
  //       can depend on globals being ready.
  //     - global-css is always last so it wins the CSS cascade over any
  //       inline <style> the page carries.
  //   Body:  global-body-end → page-body-end
  //     - Same rationale: global widgets init first, page scripts run after.
  const pageHead = project?.pageCode?.[activePage]?.head || '';
  const pageBodyEnd = project?.pageCode?.[activePage]?.bodyEnd || '';
  const globalHead = project?.globalHead || '';
  const globalBodyEnd = project?.globalBodyEnd || '';
  const globalCss = project?.globalCss || '';
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !displayHtml) return;
    const apply = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        applyCodeSlots(doc, [
          { slot: 'global-head',    container: doc.head, html: globalHead },
          { slot: 'page-head',      container: doc.head, html: pageHead },
          { slot: 'global-css',     container: doc.head, html: globalCss ? `<style>${globalCss}</style>` : '' },
          { slot: 'global-body-end',container: doc.body, html: globalBodyEnd },
          { slot: 'page-body-end',  container: doc.body, html: pageBodyEnd },
        ]);
      } catch {}
    };
    apply();
    iframe.addEventListener('load', apply);
    return () => iframe.removeEventListener('load', apply);
  }, [displayHtml, pageHead, pageBodyEnd, globalHead, globalBodyEnd, globalCss]);

  // ── Hover-`+` between sibling structural items ─────────────────────────
  // Track mouse position inside the iframe. When it's close to a boundary
  // between two structural top-level items (bottom of item N / top of item
  // N+1), surface a `+` overlay so the user can insert a new sibling. Also
  // covers the "before first" position — the fix for fixed-header cases
  // where hovering above the header is normally impossible.
  //
  // Gated by Select Mode: the affordance only appears while the user is in
  // editing mode. Keeps the preview visually clean during normal browsing.
  useEffect(() => {
    if (!selectMode) { setInsertGap(null); return; }
    const iframe = iframeRef.current;
    if (!iframe || !displayHtml) return;

    // Cached gap descriptors. Each corresponds to a hoverable gap between
    // structural top-level items (plus one before the first and one after
    // the last). `domIndex` is the position in flowRoot.children where a
    // new sibling should be inserted — computed here, so it survives the
    // structural-vs-DOM-index mismatch when the flow root has hidden
    // helpers (mobile-menu <input>) mixed in.
    let gaps = []; // [{ y, left, width, domIndex }]

    const recompute = () => {
      const doc = iframe.contentDocument;
      if (!doc) { gaps = []; return; }
      const flowRoot = getFlowRoot(doc);
      if (!flowRoot) { gaps = []; return; }
      const flowChildren = Array.from(flowRoot.children);
      const struct = getStructuralChildren(doc);
      if (struct.length === 0) { gaps = []; return; }
      const next = [];
      const first = struct[0];
      const firstRect = first.getBoundingClientRect();
      // Gap BEFORE the first structural item — insert at the DOM position
      // of that item (which may be > 0 if hidden helpers precede it).
      next.push({
        y: firstRect.top,
        left: firstRect.left,
        width: firstRect.width,
        domIndex: flowChildren.indexOf(first),
      });
      // Gap AFTER each structural item — insert at the DOM position of the
      // next structural item, or append if this is the last one.
      for (let i = 0; i < struct.length; i++) {
        const el = struct[i];
        const r = el.getBoundingClientRect();
        const nextEl = struct[i + 1];
        const domIndex = nextEl
          ? flowChildren.indexOf(nextEl)
          : flowChildren.length;
        next.push({
          y: r.bottom,
          left: r.left,
          width: r.width,
          domIndex,
        });
      }
      gaps = next;
    };

    const THRESHOLD = 24;

    const onMouseMove = (e) => {
      // Recompute on every mousemove. Rects shift for reasons the scroll /
      // resize / load listeners don't cover — Google Fonts finishing load
      // after initial paint, images resolving, chat edits mutating pages,
      // scroll animations revealing content. A few getBoundingClientRect
      // calls per structural child (usually 3-10) is trivially cheap and
      // guarantees we're always comparing against current layout.
      recompute();
      if (gaps.length === 0) return;
      const y = e.clientY;
      let match = null;
      // Iterate all gaps; pick the closest one within threshold. Ties go
      // to later gaps (a natural preference: hovering exactly between two
      // sections lands on the boundary just crossed).
      for (const g of gaps) {
        if (Math.abs(y - g.y) < THRESHOLD) match = g;
      }
      if (!match) {
        setInsertGap(null);
        return;
      }
      const ifr = iframe.getBoundingClientRect();
      setInsertGap(prev => {
        const next = {
          top: ifr.top + match.y,
          left: ifr.left + match.left,
          width: match.width,
          domIndex: match.domIndex,
        };
        if (prev &&
            prev.top === next.top &&
            prev.left === next.left &&
            prev.width === next.width &&
            prev.domIndex === next.domIndex) {
          return prev;
        }
        return next;
      });
    };

    const install = () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) return;
      recompute();
      doc.addEventListener('mousemove', onMouseMove);
      win.addEventListener('scroll', recompute, { passive: true });
      win.addEventListener('resize', recompute);
    };
    const uninstall = () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (doc) doc.removeEventListener('mousemove', onMouseMove);
      if (win) {
        win.removeEventListener('scroll', recompute);
        win.removeEventListener('resize', recompute);
      }
    };

    iframe.addEventListener('load', install);
    install();
    return () => {
      uninstall();
      iframe.removeEventListener('load', install);
    };
  }, [displayHtml, selectMode]);

  // ── Open the CodePanel session for a new sibling insert. ────────────────
  // Used by both the hover-`+` overlay and the SelectionToolbar's Insert
  // above / Insert below actions. Kept as a callback so both entry points
  // agree on placeholder, title, and commit flow.
  const openInsertPanel = useCallback(({ domIndex, labelPos, tagLabel }) => {
    if (!onOpenCodePanel) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const flowRoot = getFlowRoot(doc);
    if (!flowRoot) return;
    const flowRootPath = getSelectorPath(flowRoot, doc); // [] when flow root is body
    const savedActivePage = activePage;
    const title = tagLabel && labelPos
      ? `Insert ${labelPos} <${tagLabel}>`
      : 'Insert section';

    // Compute the seam position in the iframe's body coordinate system so
    // the indicator scrolls with content. When the anchor exists (inserting
    // BEFORE some element), use its top edge. When appending, use the
    // bottom of the last structural item.
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow;
    if (iframe && win) {
      const flowChildren = Array.from(flowRoot.children);
      const anchorEl = flowChildren[domIndex];
      let seam = null;
      const scrollX = win.scrollX || 0;
      const scrollY = win.scrollY || 0;
      if (anchorEl) {
        const r = anchorEl.getBoundingClientRect();
        seam = { bodyY: r.top + scrollY, bodyLeft: r.left + scrollX, bodyWidth: r.width };
      } else {
        const struct = getStructuralChildren(doc);
        const last = struct[struct.length - 1];
        if (last) {
          const r = last.getBoundingClientRect();
          seam = { bodyY: r.bottom + scrollY, bodyLeft: r.left + scrollX, bodyWidth: r.width };
        }
      }
      if (seam) setInsertPreview(seam);
    }

    onOpenCodePanel({
      key: `insert-${savedActivePage}-${domIndex}`,
      title,
      tabs: [{
        id: 'html',
        label: 'HTML',
        lang: 'html',
        value: '',
        placeholder: '<section>\n  \n</section>',
      }],
      onSave: (values) => {
        const markup = (values.html || '').trim();
        setInsertPreview(null);
        if (!markup) return;
        const newHtml = commitInlineEdit({
          sourceHtml: pages?.[savedActivePage] || '',
          selectorPath: flowRootPath,
          mutator: (target, tdoc) => {
            const tmpl = tdoc.createElement('template');
            tmpl.innerHTML = markup;
            const nodes = Array.from(tmpl.content.childNodes);
            if (nodes.length === 0) return;
            const anchor = target.children[domIndex] || null;
            for (const node of nodes) {
              if (anchor) target.insertBefore(node, anchor);
              else target.appendChild(node);
            }
          },
        });
        if (!newHtml) {
          console.warn('[insert] commit failed');
          return;
        }
        onApplyTokens({ ...pages, [savedActivePage]: newHtml });
      },
      onCancel: () => { setInsertPreview(null); },
    });
  }, [onOpenCodePanel, activePage, pages, onApplyTokens]);

  // Safety net: clear the preview if select mode is toggled off while the
  // panel is open (edge case — cancel/save already cover the normal path).
  useEffect(() => {
    if (!selectMode) setInsertPreview(null);
  }, [selectMode]);

  // Inject / remove a dashed seam indicator inside the iframe body while
  // insertPreview is set. Living inside the iframe (position: absolute in
  // body coords) means it scrolls with content — no fixed-overlap with the
  // CodePanel or drift on scroll.
  //
  // Green + white-outlined so it visually separates from the blue Select
  // hover state (`__sel-hover` / `__sel-active`).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // The injection lives in the iframe's contentDocument. We need to
    // re-inject whenever the doc changes (srcDoc swap on chat edit / undo)
    // AND right now if state is set. Wrap both entry points in a helper.
    const inject = () => {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      // Start clean — remove any stale indicator from a prior state.
      doc.querySelectorAll('[data-slot="__insert-preview"]').forEach(el => el.remove());
      if (!insertPreview) return;
      const div = doc.createElement('div');
      div.setAttribute('data-slot', '__insert-preview');
      div.style.cssText = [
        'position: absolute',
        `top: ${insertPreview.bodyY}px`,
        `left: ${insertPreview.bodyLeft}px`,
        `width: ${insertPreview.bodyWidth}px`,
        'height: 0',
        'border-top: 3px dashed #22c55e',
        'z-index: 2147483644',
        'pointer-events: none',
        'transform: translateY(-1.5px)',
      ].join(';');
      const label = doc.createElement('span');
      label.textContent = 'Insert here';
      label.style.cssText = [
        'position: absolute',
        'top: -12px',
        'left: 12px',
        'background: #22c55e',
        'color: #0b1a10',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        'font-size: 11px',
        'font-weight: 700',
        'letter-spacing: 0.02em',
        'padding: 3px 10px',
        'border-radius: 999px',
        'white-space: nowrap',
        'line-height: 1',
        // White outline + subtle drop shadow so it reads against any bg.
        'box-shadow: 0 0 0 2px #ffffff, 0 3px 8px rgba(0, 0, 0, 0.4)',
      ].join(';');
      div.appendChild(label);
      doc.body.appendChild(div);
    };

    inject();
    // Also re-inject after any iframe reload (chat edit re-renders the doc,
    // wiping our injection — but the user might still have the panel open
    // if they multi-click).
    iframe.addEventListener('load', inject);
    return () => {
      iframe.removeEventListener('load', inject);
      const doc = iframe.contentDocument;
      doc?.querySelectorAll('[data-slot="__insert-preview"]').forEach(el => el.remove());
    };
  }, [insertPreview, displayHtml]);

  const openFullScreen = () => {
    if (!html) return;
    // Bake user code slots (global HEAD/FOOTER/CSS, page HEAD/FOOTER) into the
    // HTML before creating the blob so third-party embed scripts bootstrap
    // during the initial parse — same layout as the export.
    const baked = bakeSiteCode(html, project, activePage);
    const blob = new Blob([baked], { type: 'text/html' });
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
                onOgImageChange={onOgImageChange}
                animations={effects}
                onAnimationChange={onAnimationChange}
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
          {pageNames.length > 0 && (
            <span className="page-label" title="Active page — switch via the page picker in the chat panel">
              {activePage}
            </span>
          )}
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
        {selectMode && insertGap && (
          <>
            {/* Passive hairline — visual only, doesn't intercept clicks so
                the surrounding preview stays interactive. */}
            <div
              className="section-insert-line"
              style={{
                top: insertGap.top,
                left: insertGap.left,
                width: insertGap.width,
              }}
              aria-hidden="true"
            />
            {/* Interactive circle — the only clickable part. Centered on the
                gap width so the click target sits over the seam. */}
            <button
              type="button"
              className="section-insert-btn"
              style={{
                top: insertGap.top,
                left: insertGap.left + insertGap.width / 2,
              }}
              onClick={() => {
                openInsertPanel({ domIndex: insertGap.domIndex });
                setInsertGap(null);
              }}
              aria-label="Insert section here"
              title="Insert section here"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 3.5V12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M3.5 8H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
        {/* Persistent seam indicator lives INSIDE the iframe (see the
            insertPreview effect above), so it scrolls with content and
            doesn't overlap the CodePanel. Nothing rendered here. */}
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
              if (actionId === 'anim-toggle') {
                // Walk up from the selected element to the enclosing <section>;
                // toggle data-anim-off on it. commitInlineEdit walks the
                // selectorPath in a parsed DOM, so we mirror the walk-up there
                // to find the right section node to mutate.
                const el = chain[chainIndex];
                if (!el) return;
                const sectionLive = el.closest?.('section');
                if (!sectionLive) return;
                const turnOn = sectionLive.hasAttribute('data-anim-off');
                const newHtml = commitInlineEdit({
                  sourceHtml: pages?.[activePage] || '',
                  selectorPath,
                  mutator: (target) => {
                    let s = target;
                    while (s && s.tagName !== 'SECTION') s = s.parentElement;
                    if (!s) return;
                    if (turnOn) s.removeAttribute('data-anim-off');
                    else s.setAttribute('data-anim-off', '');
                  },
                });
                if (!newHtml) {
                  console.warn('[inline-edit] anim-toggle failed: could not resolve element');
                  return;
                }
                onApplyTokens({ ...pages, [activePage]: newHtml });
                return;
              }
              if (actionId === 'edit-link') {
                // Open the EditLinkDialog seeded with the anchor's current
                // href. The mutation happens in the dialog's onApply path
                // below, not here — keeps the action menu thin.
                const el = chain[chainIndex];
                if (!el || el.tagName !== 'A') return;
                setLinkEditHref(el.getAttribute('href') || '');
                setLinkEditOpen(true);
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
              if (actionId === 'insert-above' || actionId === 'insert-below') {
                // Sibling insert: the selected element is a top-level structural
                // item under the flow root. Find its DOM index and delegate to
                // openInsertPanel (same commit path as the hover-`+` overlay).
                const el = chain[chainIndex];
                const doc = iframeRef.current?.contentDocument;
                if (!el || !doc) return;
                const flowRoot = getFlowRoot(doc);
                if (!flowRoot) return;
                const kids = Array.from(flowRoot.children);
                const idx = kids.indexOf(el);
                if (idx < 0) return;
                const domIndex = actionId === 'insert-above' ? idx : idx + 1;
                openInsertPanel({
                  domIndex,
                  labelPos: actionId === 'insert-above' ? 'above' : 'below',
                  tagLabel: el.tagName.toLowerCase(),
                });
                return;
              }
              if (actionId === 'edit-code') {
                // Open the code panel with the element's outerHTML as stored
                // in the SAVED source HTML — NOT `el.outerHTML` from the live
                // iframe DOM, which reflects runtime mutations (custom
                // elements expanding into shadow trees, third-party widget
                // hydration, devtools tweaks). The source string is our
                // single source of truth. On save, parse the new markup and
                // replace the element through the same commitInlineEdit
                // pipeline every other action uses.
                const el = chain[chainIndex];
                if (!el || !onOpenCodePanel) return;
                const tag = el.tagName.toLowerCase();
                // Recompute the selector path from the LIVE element right now
                // rather than trusting `selectorPath` state — the picker's
                // onPick updates state via React setters, and if the user
                // clicks Edit Code before the batched re-render commits, the
                // closure could see a stale path from before the pick. Using
                // the live element as the authoritative source removes that
                // window entirely.
                const liveDoc = el.ownerDocument;
                const freshPath = liveDoc ? getSelectorPath(el, liveDoc) : null;
                if (!freshPath) {
                  console.warn('[edit-code] could not derive selector path from live element');
                  return;
                }
                const savedActivePage = activePage;
                const sourceHtml = pages?.[savedActivePage] || '';
                const sourceDoc = new DOMParser().parseFromString(sourceHtml, 'text/html');
                const sourceEl = resolveSelectorPath(freshPath, sourceDoc);
                // Sanity check: source path must land on the same tag as the
                // live element. If it doesn't, something drifted (a runtime
                // injection shifted body indices, a stale DOM ref, etc.) —
                // fall back to live outerHTML so the user at least sees the
                // right section instead of an unrelated sibling.
                let initialValue;
                if (sourceEl && sourceEl.tagName === el.tagName) {
                  initialValue = sourceEl.outerHTML;
                } else {
                  console.warn(
                    '[edit-code] source path drift — live:', el.tagName,
                    'source:', sourceEl?.tagName, 'path:', freshPath,
                    '— falling back to live outerHTML',
                  );
                  initialValue = el.outerHTML;
                }
                onOpenCodePanel({
                  key: `edit-code-${freshPath.join('.')}`,
                  title: `Edit <${tag}>`,
                  tabs: [
                    { id: 'html', label: 'HTML', lang: 'html', value: initialValue },
                  ],
                  onSave: (values) => {
                    const nextMarkup = values.html || '';
                    const newHtml = commitInlineEdit({
                      sourceHtml: pages?.[savedActivePage] || '',
                      selectorPath: freshPath,
                      mutator: (target, doc) => {
                        const tmpl = doc.createElement('template');
                        tmpl.innerHTML = nextMarkup;
                        const nodes = Array.from(tmpl.content.childNodes);
                        if (nodes.length === 0) {
                          target.remove();
                          return;
                        }
                        target.replaceWith(...nodes);
                      },
                    });
                    if (!newHtml) {
                      console.warn('[edit-code] commit failed: could not resolve element');
                      return;
                    }
                    onApplyTokens({ ...pages, [savedActivePage]: newHtml });
                    // Clear selection — the old fingerprint no longer matches
                    // the new markup, so leaving it stale would cause the
                    // next iframe reload to strand the selection UI.
                    clearSelection();
                  },
                  onCancel: () => {},
                });
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
        <EditLinkDialog
          open={linkEditOpen}
          onClose={() => setLinkEditOpen(false)}
          currentHref={linkEditHref}
          pages={pages}
          currentPage={activePage}
          onApply={(nextHref) => {
            // Mutate the selected <a>'s href via the same commitInlineEdit
            // pipeline every other action uses — keeps history / persistence
            // / re-selection behavior consistent.
            const newHtml = commitInlineEdit({
              sourceHtml: pages?.[activePage] || '',
              selectorPath,
              mutator: (target) => {
                if (target.tagName === 'A') target.setAttribute('href', nextHref);
              },
            });
            if (!newHtml) {
              console.warn('[edit-link] commit failed: could not resolve element');
              return;
            }
            onApplyTokens({ ...pages, [activePage]: newHtml });
          }}
        />
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

  // Direct page match. Carry any fragment so the preview can scroll to the
  // target section after the destination page loads (e.g. services.html#fabrication).
  if (pages[last]) return { action: 'page', target: last, fragment };
  // Try adding .html if the AI omitted it.
  if (!last.includes('.') && pages[`${last}.html`]) return { action: 'page', target: `${last}.html`, fragment };
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

// Apply a list of code slots to an iframe document. Each slot has a name
// (used as data-slot attribute for cleanup), a container element (doc.head
// or doc.body), and a raw HTML string. Behavior:
//   - All existing elements with the given slot name are removed first.
//   - Then all slots are re-inserted in list order. Later slots appear later
//     in the DOM, so a globalHead injection wins CSS cascade over a pageHead
//     injection at the same specificity.
//   - <script> tags are re-created (not innerHTML-parsed) so they execute.
function applyCodeSlots(doc, slots) {
  // Remove existing slot nodes across every listed slot name.
  const slotNames = slots.map(s => s.slot);
  for (const name of slotNames) {
    doc.querySelectorAll(`[data-slot="${name}"]`).forEach(el => el.remove());
  }
  // Insert in order.
  for (const { slot, container, html } of slots) {
    if (!html || !container) continue;
    const tmpl = doc.createElement('template');
    tmpl.innerHTML = html;
    const nodes = Array.from(tmpl.content.childNodes);
    for (const node of nodes) {
      if (node.nodeType !== 1) continue; // skip whitespace text nodes
      let toInsert = node;
      if (node.nodeName === 'SCRIPT') {
        // Scripts inserted via innerHTML/template.content do NOT execute.
        // Re-create as a fresh script element so the browser runs it.
        const s = doc.createElement('script');
        for (const attr of node.attributes) s.setAttribute(attr.name, attr.value);
        s.textContent = node.textContent;
        toInsert = s;
      }
      toInsert.setAttribute('data-slot', slot);
      container.appendChild(toInsert);
    }
  }
}

// Inline the code slots into an HTML string. Used by the Full Screen popout
// so the browser parses the user's code as part of the initial HTML load —
// which is the only way most third-party embed scripts bootstrap correctly.
// Mirrors backend/routes/export.js:injectSiteCode so popout and export
// produce the same slot layout.
function bakeSiteCode(html, project, pageName) {
  const globalHead = String(project?.globalHead || '').trim();
  const globalBodyEnd = String(project?.globalBodyEnd || '').trim();
  const globalCss = String(project?.globalCss || '').trim();
  const pageEntry = project?.pageCode?.[pageName] || {};
  const pageHead = String(pageEntry.head || '').trim();
  const pageBodyEnd = String(pageEntry.bodyEnd || '').trim();

  const headParts = [];
  if (globalHead) headParts.push(globalHead);
  if (pageHead) headParts.push(pageHead);
  if (globalCss) headParts.push(`<style>\n${globalCss}\n</style>`);

  const bodyParts = [];
  if (globalBodyEnd) bodyParts.push(globalBodyEnd);
  if (pageBodyEnd) bodyParts.push(pageBodyEnd);

  let result = html;
  if (headParts.length) {
    const block = '\n' + headParts.join('\n') + '\n';
    result = /<\/head>/i.test(result)
      ? result.replace(/<\/head>/i, `${block}</head>`)
      : block + result;
  }
  if (bodyParts.length) {
    const block = '\n' + bodyParts.join('\n') + '\n';
    result = /<\/body>/i.test(result)
      ? result.replace(/<\/body>/i, `${block}</body>`)
      : result + block;
  }
  return result;
}
