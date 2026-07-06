import React from 'react';
import { classifyElement } from '../inlineEdit/selectionUtils.js';
import { computeElementSpecs } from '../inlineEdit/specs.js';
import {
  IconImage, IconPencil, IconSparkles, IconWand, IconTrash, IconLink, IconMotion,
} from '../inlineEdit/icons.jsx';

// Walk up from `el` to the nearest enclosing <section> (or the element itself
// if it is one). Returns null if the chain doesn't include a section.
function enclosingSection(el) {
  let cur = el;
  while (cur && cur.tagName) {
    if (cur.tagName === 'SECTION') return cur;
    cur = cur.parentElement;
  }
  return null;
}

// True if the section (or any descendant) carries any animation markup.
function sectionHasAnim(section) {
  if (!section) return false;
  const selector = '.animate-in, .animate-in-up, .animate-in-left, .animate-in-right, .animate-in-scale, .animate-in-blur, .animate-in-stagger, .parallax-bg, [data-parallax], .sticky-eyebrow, [data-countup], .marquee-strip';
  if (section.matches?.(selector)) return true;
  return !!section.querySelector?.(selector);
}

// Condensed breadcrumb label — tag + optional #id only (no classes).
function crumbLabel(el) {
  if (!el || !el.tagName) return '';
  const tag = el.tagName.toLowerCase();
  return el.id ? `${tag}#${el.id}` : tag;
}

const MAX_CRUMBS = 4;

function replaceLabel(klass) {
  if (klass.isSvg) return 'Replace SVG';
  if (klass.isImg) return 'Replace IMG';
  if (klass.hasBgImage) return 'Replace BG';
  return 'Replace';
}

export default function SelectionToolbar({
  rect,
  chain,
  selectedIndex,
  onPick,
  onAction,
  activeAction,
}) {
  if (!rect || !chain.length) return null;
  const el = chain[selectedIndex];
  const klass = classifyElement(el);
  const { textSpecs, boxSpecs } = computeElementSpecs(el, !!klass.isTextBearing);

  // Position above element if room, else below.
  const TOOLBAR_APPROX_H = 220;
  const useAbove = rect.top > TOOLBAR_APPROX_H + 8;
  const style = useAbove
    ? { left: Math.max(8, rect.left), top: rect.top - 6, transform: 'translateY(-100%)' }
    : { left: Math.max(8, rect.left), top: rect.bottom + 6 };

  const fullChain = chain.map((node, i) => ({ node, originalIndex: i }));
  const ellided = fullChain.length > MAX_CRUMBS;
  const shown = ellided ? fullChain.slice(-MAX_CRUMBS) : fullChain;

  const actions = [];
  if (klass.canReplaceVisual) actions.push({ id: 'replace-visual', Icon: IconImage, label: replaceLabel(klass) });
  if (klass.isTextBearing) {
    actions.push({ id: 'edit-text',    Icon: IconPencil,   label: 'Edit text' });
    actions.push({ id: 'rewrite-text', Icon: IconSparkles, label: 'Rewrite' });
  }
  // Prompt is redundant for SVG (Replace SVG already has a prompt field).
  if (!klass.isSvg) actions.push({ id: 'prompt-change', Icon: IconWand, label: 'Prompt' });
  // Edit Link only for <a> elements with an href — retargets the link
  // without going through chat. Picks from project pages or accepts a
  // manual URL (relative or absolute).
  if (klass.isLink) actions.push({ id: 'edit-link', Icon: IconLink, label: 'Edit Link' });
  // Animations toggle: only meaningful when the selection lives inside a
  // <section> that contains animation markup. Label flips based on the
  // section's current data-anim-off state.
  const animSection = enclosingSection(el);
  if (animSection && sectionHasAnim(animSection)) {
    const off = animSection.hasAttribute('data-anim-off');
    actions.push({
      id: 'anim-toggle',
      Icon: IconMotion,
      label: off ? 'Enable motion' : 'Disable motion',
    });
  }
  if (klass.isRemovable) actions.push({ id: 'remove', Icon: IconTrash, label: 'Remove' });

  return (
    <div
      className="selection-toolbar"
      style={style}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="sel-breadcrumb">
        {ellided && <span className="crumb-ellipsis" title="More ancestors above">…</span>}
        {shown.map((entry, i) => (
          <React.Fragment key={entry.originalIndex}>
            {(i > 0 || ellided) && <span className="crumb-sep">›</span>}
            <button
              type="button"
              className={`crumb ${entry.originalIndex === selectedIndex ? 'active' : ''}`}
              onClick={() => onPick(entry.originalIndex)}
              title={crumbLabel(entry.node)}
            >
              {crumbLabel(entry.node)}
            </button>
          </React.Fragment>
        ))}
      </div>

      <div className="sel-specs">
        {textSpecs && (
          <div className="specs-group">
            {textSpecs.map(s => (
              <div className="spec-row" key={s.k}>
                <span className="spec-k">{s.k}</span>
                <span className="spec-v">{s.v}</span>
              </div>
            ))}
          </div>
        )}
        <div className="specs-group">
          {boxSpecs.map(s => (
            <div className="spec-row" key={s.k}>
              <span className="spec-k">{s.k}</span>
              <span className="spec-v">{s.v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="sel-actions">
        {actions.map(a => (
          <button
            key={a.id}
            type="button"
            className={`sel-action ${activeAction === a.id ? 'active' : ''}`}
            onClick={() => onAction(a.id)}
            title={a.label}
          >
            <span className="ico" aria-hidden><a.Icon /></span>
            <span className="lbl">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
