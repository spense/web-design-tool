import React from 'react';

export default function ExportModal({ slug, result, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export complete</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
          Files: {result.files.join(', ')}
        </p>
        <pre style={{ fontSize: 11 }}>{result.exportDir}</pre>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
