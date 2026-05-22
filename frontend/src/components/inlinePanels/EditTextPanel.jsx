import React, { useState, useEffect, useRef } from 'react';

// Manual text editor. Replaces the element's full textContent — any nested
// children at the selected level are wiped. The user controls granularity
// by where they selected.
export default function EditTextPanel({ element, onApply, hasMixedChildren }) {
  const [value, setValue] = useState(() => element?.textContent || '');
  const taRef = useRef(null);

  useEffect(() => {
    setValue(element?.textContent || '');
    // Focus + select all on open so users can immediately type to replace.
    queueMicrotask(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.select(); }
    });
  }, [element]);

  const original = element?.textContent || '';
  const dirty = value !== original;

  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && dirty) {
      e.preventDefault();
      onApply(value);
    }
  };

  return (
    <div className="panel-form">
      <textarea
        ref={taRef}
        className="panel-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={6}
        spellCheck
      />
      {hasMixedChildren && (
        <div className="panel-hint">
          This element contains nested tags. Saving will replace them with plain text.
        </div>
      )}
      <div className="panel-footer">
        <button
          type="button"
          className="primary"
          onClick={() => onApply(value)}
          disabled={!dirty}
        >Save</button>
      </div>
    </div>
  );
}
