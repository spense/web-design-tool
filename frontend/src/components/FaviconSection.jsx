import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { extractTokens } from '../tokenRewriter.js';
import {
  buildMonogramSvg, chooseParams, renderAllFromSvg, renderAllFromImage,
} from '../faviconRender.js';

export default function FaviconSection({ slug, project, pages, activePage, onFaviconChange }) {
  const favicon = project?.favicon || {};
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(null); // 'regen' | 'upload' | 'select' | 'delete'
  const [err, setErr] = useState(null);

  const hasGenerated = !!favicon.generated;
  const hasUploaded = !!favicon.uploaded;
  const selected = favicon.selected || (hasGenerated ? 'generated' : (hasUploaded ? 'uploaded' : null));
  const version = favicon.version || 0;

  // Card thumbnails use a high-res source so they look sharp on retina at
  // 32 CSS px. Generated → SVG, uploaded → 192px PNG.
  const generatedUrl = hasGenerated
    ? api.faviconFileUrl(slug, 'generated.svg', version)
    : null;
  const uploadedUrl = hasUploaded
    ? api.faviconFileUrl(slug, 'uploaded-192.png', version)
    : null;
  // Native-size preview (16 CSS px) sourced from the 32px PNG so retina /
  // high-density screens get crisp pixel-doubled rendering — matches what
  // modern browsers actually display in their tab strips.
  const activeUrl = selected
    ? api.faviconFileUrl(slug, `${selected}-32.png`, version)
    : null;

  const regenerate = async () => {
    if (busy) return;
    setBusy('regen'); setErr(null);
    try {
      const html = pages?.[activePage] || (pages ? Object.values(pages)[0] : '');
      const tokens = extractTokens(html) || {};
      const nextAttempt = (favicon.generated?.attempt || 0) + 1;
      const params = chooseParams({ name: project.name, tokens, attempt: nextAttempt });
      const svg = buildMonogramSvg(params);
      const pngs = await renderAllFromSvg(svg);
      const result = await api.saveGeneratedFavicon(slug, {
        svg,
        pngs,
        params: { ...params, attempt: nextAttempt },
      });
      onFaviconChange?.(result.favicon);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('upload'); setErr(null);
    try {
      const pngs = await renderAllFromImage(file);
      const result = await api.saveUploadedFavicon(slug, { original: file, pngs });
      onFaviconChange?.(result.favicon);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const select = async (which) => {
    if (busy || which === selected) return;
    setBusy('select'); setErr(null);
    try {
      const result = await api.selectFavicon(slug, which);
      onFaviconChange?.(result.favicon);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const removeUpload = async () => {
    if (busy) return;
    setBusy('delete'); setErr(null);
    try {
      const result = await api.deleteUploadedFavicon(slug);
      onFaviconChange?.(result.favicon);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  if (!hasGenerated && !hasUploaded) {
    return (
      <div className="tools-section">
        <div className="tools-label">Favicon</div>
        <div className="favicon-empty">A favicon is generated automatically when your first design is created.</div>
      </div>
    );
  }

  return (
    <div className="tools-section">
      <div className="tools-label">Favicon</div>

      <div className="favicon-preview-row">
        <span className="favicon-preview-frame" title="Native browser size (16×16)">
          {activeUrl && (
            <img src={activeUrl} width={16} height={16} alt="" style={{ imageRendering: 'auto' }} />
          )}
        </span>
        <span className="favicon-preview-meta">native (16×16)</span>
      </div>

      <div className="favicon-cards">
        <FaviconCard
          label="Generated"
          src={generatedUrl}
          active={selected === 'generated'}
          onSelect={() => select('generated')}
          actionTitle="Regenerate"
          actionIcon={<RefreshIcon />}
          onAction={regenerate}
          busy={busy === 'regen'}
        />
        {hasUploaded ? (
          <FaviconCard
            label="Uploaded"
            src={uploadedUrl}
            active={selected === 'uploaded'}
            onSelect={() => select('uploaded')}
            actionTitle="Remove uploaded image"
            actionIcon={<TrashIcon />}
            actionDanger
            onAction={removeUpload}
            busy={busy === 'delete'}
          />
        ) : (
          <button
            type="button"
            className="favicon-card add"
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'upload'}
            title="Upload a favicon image"
          >
            <span className="favicon-card-thumb favicon-card-thumb-add">
              {busy === 'upload' ? <DotSpinner /> : '+'}
            </span>
            <span className="favicon-card-label">{busy === 'upload' ? 'Uploading…' : 'Upload'}</span>
          </button>
        )}
      </div>

      {hasUploaded && (
        <button
          type="button"
          className="favicon-replace"
          onClick={() => fileRef.current?.click()}
          disabled={busy === 'upload'}
        >
          {busy === 'upload' ? 'Uploading…' : 'Replace upload'}
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
        onChange={handleUpload}
        style={{ display: 'none' }}
      />

      {err && <div className="favicon-err">{err}</div>}
    </div>
  );
}

function FaviconCard({ label, src, active, onSelect, actionTitle, actionIcon, actionDanger, onAction, busy }) {
  return (
    <div className={`favicon-card ${active ? 'active' : ''}`}>
      <button type="button" className="favicon-card-body" onClick={onSelect} title={`Select ${label.toLowerCase()}`}>
        <span className="favicon-card-thumb">
          {src ? <img src={src} alt="" width={32} height={32} /> : null}
        </span>
        <span className="favicon-card-label">{label}</span>
      </button>
      <button
        type="button"
        className={`favicon-card-action ${actionDanger ? 'danger' : ''}`}
        onClick={(e) => { e.stopPropagation(); onAction(); }}
        title={actionTitle}
        disabled={busy}
      >
        {busy ? <DotSpinner /> : actionIcon}
      </button>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <polyline points="21 3 21 8 16 8" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
function DotSpinner() {
  return <span className="favicon-spinner" aria-hidden="true" />;
}
