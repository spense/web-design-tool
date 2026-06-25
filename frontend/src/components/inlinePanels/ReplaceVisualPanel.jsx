import React, { useState, useRef, useEffect } from 'react';
import Spinner from '../Spinner.jsx';
import { api } from '../../api.js';
import { classifyElement } from '../../inlineEdit/selectionUtils.js';
import { sanitizeSvg } from '../../inlineEdit/svgSanitize.js';

// Replace visual: depending on the selected element we show different flows.
//   <img> / element w/ background-image → Pixabay search + Upload file
//   <svg>                               → Upload .svg + Paste code (advanced)
// `onApply` is called with one of:
//   { kind: 'image', path }            → set src / background-image
//   { kind: 'svg',   markup }          → replace outerHTML with new <svg>
export default function ReplaceVisualPanel({ element, slug, onApply }) {
  const klass = classifyElement(element);
  if (klass.isSvg) {
    return <SvgFlow element={element} slug={slug} onApply={onApply} />;
  }
  return <ImageFlow slug={slug} onApply={onApply} />;
}

/* ─── Image / background-image flow ──────────────────────────────────── */

function ImageFlow({ slug, onApply }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [pickingId, setPickingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await api.inlinePixabaySearch(query.trim());
      setHits(res.hits || []);
    } catch (e) {
      setError(e.message || 'Search failed');
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search();
    }
  };

  const pick = async (hit) => {
    setPickingId(hit.id);
    setError(null);
    try {
      const { path } = await api.inlinePixabayDownload(slug, hit);
      onApply({ kind: 'image', path });
    } catch (e) {
      setError(e.message || 'Download failed');
    } finally {
      setPickingId(null);
    }
  };

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const { filename } = await api.inlineUploadFile(slug, file);
      onApply({ kind: 'image', path: `uploads/${filename}` });
    } catch (e) {
      setError(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="panel-form">
      <div className="panel-label">Search Pixabay</div>
      <div className="rv-search-row">
        <input
          type="text"
          className="rv-search-input"
          placeholder="e.g. mountain landscape"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <button
          type="button"
          className="primary"
          onClick={search}
          disabled={!query.trim() || searching}
        >
          {searching ? <Spinner /> : 'Search'}
        </button>
      </div>

      {hits.length > 0 && (
        <div className="rv-grid">
          {hits.map(h => (
            <button
              key={h.id}
              type="button"
              className={`rv-thumb ${pickingId === h.id ? 'picking' : ''}`}
              onClick={() => pick(h)}
              disabled={!!pickingId}
              title={h.tags}
            >
              <img src={h.webformatURL} alt={h.tags} loading="lazy" />
              {pickingId === h.id && <span className="rv-thumb-loading"><Spinner /></span>}
            </button>
          ))}
        </div>
      )}

      {hits.length === 0 && !searching && query && !error && (
        <div className="rv-empty">No results.</div>
      )}

      <div className="panel-label rv-or">Or upload</div>
      <label className={`rv-upload ${uploading ? 'uploading' : ''}`}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.svg"
          onChange={(e) => handleUpload(e.target.files?.[0])}
          disabled={uploading}
          hidden
        />
        <span>
          {uploading ? <><Spinner /> Uploading…</> : 'Choose image…'}
        </span>
      </label>

      {error && <div className="panel-error">{error}</div>}
    </div>
  );
}

/* ─── SVG flow ──────────────────────────────────────────────────────── */

function getIframeCssVars(element) {
  try {
    const doc = element?.ownerDocument;
    const root = doc?.documentElement;
    if (!root) return {};
    for (const sheet of doc.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText === ':root') {
          const vars = {};
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (prop.startsWith('--')) vars[prop] = rule.style.getPropertyValue(prop);
          }
          return vars;
        }
      }
    }
  } catch {}
  return {};
}

function SvgFlow({ element, slug, onApply }) {
  // Prompt-based generation state
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState(null); // raw svg string awaiting Apply
  const [genError, setGenError] = useState(null);

  // Advanced (paste) state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pastedError, setPastedError] = useState(null);

  // Upload state
  const [uploadError, setUploadError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const applyMarkup = (markup) => {
    const result = sanitizeSvg(markup);
    if (!result.ok) return result;
    onApply({ kind: 'svg', markup: result.svg.outerHTML });
    return { ok: true };
  };

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setGenError(null);
    setGenResult(null);
    try {
      const currentSvg = element?.outerHTML || '';
      const { svg } = await api.inlineGenerateSvg(prompt.trim(), currentSvg);
      // Sanitize so the preview never shows untrusted content.
      const result = sanitizeSvg(svg);
      if (!result.ok) {
        setGenError(result.error);
        return;
      }
      setGenResult(result.svg.outerHTML);
    } catch (e) {
      setGenError(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handlePromptKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && prompt.trim() && !generating) {
      e.preventDefault();
      generate();
    }
  };

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const text = await file.text();
      const result = applyMarkup(text);
      if (!result.ok) setUploadError(result.error);
    } catch (e) {
      setUploadError(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handlePasteApply = () => {
    setPastedError(null);
    const result = applyMarkup(pasted);
    if (!result.ok) setPastedError(result.error);
  };

  return (
    <div className="panel-form">
      <div className="panel-label">Generate from prompt</div>
      <textarea
        className="panel-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handlePromptKeyDown}
        placeholder="e.g. A simple line-style wrench icon"
        rows={2}
        disabled={generating}
        autoFocus
      />

      {genResult && !generating && (
        <>
          <div className="panel-label">Preview</div>
          <div
            className="rv-svg-preview"
            style={getIframeCssVars(element)}
            dangerouslySetInnerHTML={{ __html: genResult }}
          />
        </>
      )}
      {genError && <div className="panel-error">{genError}</div>}

      <div className="panel-footer">
        {!genResult ? (
          <button
            type="button"
            className="primary"
            onClick={generate}
            disabled={!prompt.trim() || generating}
          >
            {generating ? <><Spinner /> Generating…</> : 'Generate'}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => { setGenResult(null); }}>Try again</button>
            <button type="button" className="primary" onClick={() => applyMarkup(genResult)}>Apply</button>
          </>
        )}
      </div>

      <div className="panel-label">Or upload</div>
      <label className={`rv-upload ${uploading ? 'uploading' : ''}`}>
        <input
          type="file"
          accept=".svg,image/svg+xml"
          onChange={(e) => handleUpload(e.target.files?.[0])}
          disabled={uploading}
          hidden
        />
        <span>{uploading ? <><Spinner /> Reading…</> : 'Choose .svg…'}</span>
      </label>
      {uploadError && <div className="panel-error">{uploadError}</div>}

      <button
        type="button"
        className="rv-advanced-toggle"
        onClick={() => setShowAdvanced(v => !v)}
      >
        {showAdvanced ? '▾' : '▸'} Paste SVG code
      </button>

      {showAdvanced && (
        <>
          <textarea
            className="panel-textarea"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="<svg ...> ... </svg>"
            rows={5}
            spellCheck={false}
          />
          {pastedError && <div className="panel-error">{pastedError}</div>}
          <div className="panel-footer">
            <button
              type="button"
              className="primary"
              onClick={handlePasteApply}
              disabled={!pasted.trim()}
            >Apply</button>
          </div>
        </>
      )}
    </div>
  );
}
