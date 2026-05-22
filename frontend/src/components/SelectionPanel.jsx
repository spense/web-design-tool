import React from 'react';
import { shortLabel } from '../inlineEdit/selectionUtils.js';
import EditTextPanel from './inlinePanels/EditTextPanel.jsx';
import RewriteTextPanel from './inlinePanels/RewriteTextPanel.jsx';

const ACTION_LABELS = {
  'replace-visual': 'Replace visual',
  'edit-text':      'Edit text',
  'rewrite-text':   'Rewrite with AI',
  'prompt-change':  'Prompt change',
  'remove':         'Remove',
};

// Floating panel anchored to the lower-right of the preview area.
// Dispatches to the sub-view that matches `action`.
export default function SelectionPanel({ action, element, onClose, onApply }) {
  if (!action || !element) return null;

  // Detect whether the element has children (so the editor can warn that
  // saving will replace them with plain text).
  const hasMixedChildren = !!(element.children && element.children.length > 0);

  let body;
  switch (action) {
    case 'edit-text':
      body = <EditTextPanel element={element} onApply={onApply} hasMixedChildren={hasMixedChildren} />;
      break;
    case 'rewrite-text':
      body = <RewriteTextPanel element={element} onApply={onApply} hasMixedChildren={hasMixedChildren} />;
      break;
    default:
      body = (
        <p className="sel-panel-placeholder">
          This action will be wired in a later step.
        </p>
      );
  }

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
        {body}
      </div>
    </div>
  );
}
