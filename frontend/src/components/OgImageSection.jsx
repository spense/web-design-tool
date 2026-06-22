import React, { useRef, useState } from 'react';
import { api } from '../api.js';

const OG_W = 1200;
const OG_H = 630;
const MIN_W = 600;
const MIN_H = 315;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

async function processOgImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (img.width < MIN_W || img.height < MIN_H) {
      throw new Error(`Image too small (${img.width}×${img.height}). Minimum is ${MIN_W}×${MIN_H}.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = OG_W;
    canvas.height = OG_H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OG_W, OG_H);

    // Contain-fit: scale to fit entirely within 1200×630, centered.
    const scale = Math.min(OG_W / img.width, OG_H / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const dx = (OG_W - drawW) / 2;
    const dy = (OG_H - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('Canvas export failed')),
        'image/jpeg',
        0.92,
      );
    });

    const processed = new File([blob], 'og-image.jpg', { type: 'image/jpeg' });
    return processed;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function OgImageSection({ slug, project, onOgImageChange }) {
  const ogImage = project?.ogImage || null;
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const previewUrl = ogImage
    ? api.ogImageFileUrl(slug, ogImage.version)
    : null;

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('upload'); setErr(null);
    try {
      const processed = await processOgImage(file);
      const result = await api.saveOgImage(slug, processed);
      onOgImageChange?.(result.ogImage);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const handleRemove = async () => {
    if (busy) return;
    setBusy('delete'); setErr(null);
    try {
      await api.deleteOgImage(slug);
      onOgImageChange?.(null);
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className="tools-section">
      <div className="tools-label">OG image</div>

      {ogImage ? (
        <>
          <div className="og-image-preview">
            <img src={previewUrl} alt="" />
          </div>
          <div className="og-image-actions">
            <button
              type="button"
              className="og-image-btn"
              onClick={() => fileRef.current?.click()}
              disabled={!!busy}
            >
              {busy === 'upload' ? 'Uploading…' : 'Replace'}
            </button>
            <button
              type="button"
              className="og-image-btn danger"
              onClick={handleRemove}
              disabled={!!busy}
            >
              {busy === 'delete' ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="og-image-upload"
          onClick={() => fileRef.current?.click()}
          disabled={busy === 'upload'}
        >
          {busy === 'upload' ? (
            <span className="favicon-spinner" aria-hidden="true" />
          ) : (
            '+'
          )}
          <span>{busy === 'upload' ? 'Uploading…' : 'Upload image (1200×630)'}</span>
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleUpload}
        style={{ display: 'none' }}
      />

      {err && <div className="favicon-err">{err}</div>}
    </div>
  );
}
