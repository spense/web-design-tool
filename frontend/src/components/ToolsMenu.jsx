import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  colorThemes, fontPairings, sizingScales, spacingScales, radiusScales,
  buildSizingTokens, buildSpacingTokens, pickCategory,
} from '../themePresets.js';
import { extractTokens, applyToAllPages } from '../tokenRewriter.js';

export default function ToolsMenu({ pages, activePage, snapshot, onSnapshot, onApply, onClose }) {
  const ref = useRef(null);
  const html = pages?.[activePage] || (pages ? Object.values(pages)[0] : '');
  const tokens = extractTokens(html) || {};
  const usable = Object.keys(tokens).length >= 4;

  // Snapshot original tokens the first time the menu opens for this project.
  useEffect(() => {
    if (!snapshot && usable) onSnapshot(tokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on outside click
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  // Track active selections per category. Color & font we just remember the
  // last click; size/spacing/radius we infer from the actual token values.
  const inferredSizing = useMemo(() => inferSizing(tokens, snapshot), [tokens, snapshot]);
  const inferredRadius = useMemo(() => inferRadius(tokens), [tokens]);
  const inferredSpacing = useMemo(() => inferSpacing(tokens, snapshot), [tokens, snapshot]);

  const [activeColor, setActiveColor] = useState('default');
  const [activeFont, setActiveFont] = useState('original');

  if (!usable) {
    return (
      <div className="tools-popover" ref={ref}>
        <div className="tools-empty">
          This design wasn't built with theme tokens. Generate a fresh design or ask the AI to refactor it to use CSS variables.
        </div>
      </div>
    );
  }

  const applyColor = (theme) => {
    const next = theme.build(tokens, snapshot);
    setActiveColor(theme.id);
    onApply(applyToAllPages(pages, { tokens: next }));
  };
  const applyFont = (pairing) => {
    setActiveFont(pairing.id);
    if (pairing.id === 'original') {
      const restore = pickCategory(snapshot || tokens, 'font');
      onApply(applyToAllPages(pages, { tokens: restore }));
      return;
    }
    const tokensPatch = {
      '--font-heading': pairing.heading,
      '--font-body': pairing.body,
    };
    onApply(applyToAllPages(pages, { tokens: tokensPatch, googleFonts: pairing.googleFonts }));
  };
  const applySizing = (scale) => {
    if (scale.id === 'default') {
      const restore = pickCategory(snapshot || tokens, 'sizing');
      onApply(applyToAllPages(pages, { tokens: restore }));
      return;
    }
    const next = buildSizingTokens(tokens, snapshot, scale.multiplier);
    onApply(applyToAllPages(pages, { tokens: next }));
  };
  const applySpacing = (scale) => {
    const next = buildSpacingTokens(tokens, snapshot, scale.multiplier);
    onApply(applyToAllPages(pages, { tokens: next }));
  };
  const applyRadius = (scale) => {
    onApply(applyToAllPages(pages, { tokens: scale.vars }));
  };

  return (
    <div className="tools-popover" ref={ref}>
      <div className="tools-section">
        <div className="tools-label">Color theme</div>
        <div className="tools-row">
          {colorThemes.map(theme => (
            <ColorOption
              key={theme.id}
              theme={theme}
              tokens={tokens}
              snapshot={snapshot}
              active={activeColor === theme.id}
              onClick={() => applyColor(theme)}
            />
          ))}
        </div>
      </div>

      <div className="tools-section">
        <div className="tools-label">Font family</div>
        <select
          className="tools-select"
          value={activeFont}
          onChange={(e) => {
            const p = fontPairings.find(p => p.id === e.target.value);
            if (p) applyFont(p);
          }}
        >
          {fontPairings.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="tools-section">
        <div className="tools-label">Font size</div>
        <Segment options={sizingScales} activeId={inferredSizing} onPick={applySizing} />
      </div>

      <div className="tools-section">
        <div className="tools-label">Spacing</div>
        <Segment options={spacingScales} activeId={inferredSpacing} onPick={applySpacing} />
      </div>

      <div className="tools-section">
        <div className="tools-label">Border radius</div>
        <Segment options={radiusScales} activeId={inferredRadius} onPick={applyRadius} />
      </div>
    </div>
  );
}

function ColorOption({ theme, tokens, snapshot, active, onClick }) {
  let left, right;
  if (theme.id === 'default') {
    left = snapshot?.['--color-bg'] || tokens['--color-bg'] || '#fff';
    right = snapshot?.['--color-primary'] || tokens['--color-primary'] || '#000';
  } else if (theme.swatch) {
    left = theme.swatch[0];
    right = theme.swatch[1] || tokens['--color-primary'] || '#000';
  } else {
    const base = snapshot || tokens;
    const built = theme.build(base, snapshot);
    left = built['--color-bg'] || '#fff';
    right = built['--color-primary'] || '#000';
  }
  return (
    <button
      className={`tools-swatch ${active ? 'active' : ''}`}
      onClick={onClick}
      title={theme.description || theme.label}
    >
      <span className="tools-swatch-circle">
        <span style={{ background: left }} />
        <span style={{ background: right }} />
      </span>
      <span className="tools-swatch-label">{theme.label}</span>
    </button>
  );
}

function Segment({ options, activeId, onPick }) {
  return (
    <div className="tools-segment">
      {options.map(o => (
        <button
          key={o.id}
          className={activeId === o.id ? 'active' : ''}
          onClick={() => onPick(o)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── inference ──────────────────────────────────────────────────────────────

function inferSizing(tokens, snapshot) {
  const snapBase = snapshot?.['--font-size-base'];
  const currBase = tokens['--font-size-base'];
  if (!snapBase || !currBase) return 'default';
  const ratio = parseFloat(currBase) / parseFloat(snapBase);
  if (isNaN(ratio)) return 'default';
  if (Math.abs(ratio - 0.85) < 0.04) return 'small';
  if (Math.abs(ratio - 1.25) < 0.04) return 'large';
  return 'default';
}

function inferRadius(tokens) {
  const md = tokens['--radius-md'];
  const button = tokens['--radius-button'];
  // If Pill: button is 999 but md is not 999 (Large values)
  if (button === '999px' && md !== '999px') return 'pill';
  // Otherwise match by --radius-md
  const m = radiusScales.find(s => s.vars['--radius-md'] === md && s.id !== 'pill');
  return m?.id || 'small';
}

function inferSpacing(tokens, snapshot) {
  if (!snapshot) return 'comfortable';
  const cur = parseLen(tokens['--space-md']);
  const base = parseLen(snapshot['--space-md']);
  if (cur == null || base == null || base === 0) return 'comfortable';
  const ratio = cur / base;
  // Pick closest scale
  let best = 'comfortable';
  let bestDiff = Infinity;
  for (const s of spacingScales) {
    const diff = Math.abs(ratio - s.multiplier);
    if (diff < bestDiff) { bestDiff = diff; best = s.id; }
  }
  return best;
}

function parseLen(v) {
  if (!v) return null;
  const m = String(v).match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}
