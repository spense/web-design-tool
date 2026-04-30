import React from 'react';
import { api } from '../api.js';

export default function ExportModal({ slug, result, onClose }) {
  const handoff = `Handoff to Web Engine:
Copy this entire export folder into your Web Engine project at:
  /sites/[client-slug]/intake/design-reference/
Then copy brief.md and tokens.json up one level to:
  /sites/[client-slug]/
Claude Code will use these as the visual source of truth for the Astro build.`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export complete</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
          Files: {result.files.join(', ')}
        </p>
        <pre style={{ fontSize: 11 }}>{result.exportDir}</pre>
        <pre>{handoff}</pre>
        <div className="modal-actions">
          <a
            href={api.downloadExportUrl(slug, result.timestamp)}
            download
          >
            <button className="primary">Download .zip</button>
          </a>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
