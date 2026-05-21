import React from 'react';
import { shortLabel } from '../inlineEdit/selectionUtils.js';

const ACTION_LABELS = {
  'replace-visual': 'Replace visual',
  'edit-text':      'Edit text',
  'rewrite-text':   'Rewrite with AI',
  'prompt-change':  'Prompt change',
  'remove':         'Remove',
};

// Floating panel anchored to the lower-right of the preview area.
// Height grows with content; closing is explicit (✕ or Esc).
export default function SelectionPanel({ action, element, onClose }) {
  if (!action || !element) return null;
  return (
    <div
      className="selection-panel"
      onMouseDown={e => e.stopPropagation()}
      role="dialog"
      aria-label={ACTION_LABELS[action] || action}
    >
      <div className="sel-panel-header">
        <div className="sel-panel-titles">
          <div className="title">{ACTION_LABELS[action] || action}</div>
          <div className="subtitle">
            Applies to: <code>{shortLabel(element)}</code>
          </div>
        </div>
        <button
          className="sel-panel-close"
          type="button"
          onClick={onClose}
          title="Close"
        >✕</button>
      </div>
      <div className="sel-panel-body">
        <p className="sel-panel-placeholder">
          Step 1 placeholder. This action will be wired up in a later step.
        </p>
      </div>
    </div>
  );
}
