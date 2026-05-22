import React, { useState, useEffect, useRef } from 'react';
import Spinner from '../Spinner.jsx';
import { api } from '../../api.js';

// AI-powered rewrite. User describes the change in a prompt. Model returns
// plain text only; result replaces the element's full textContent.
export default function RewriteTextPanel({ element, onApply, hasMixedChildren }) {
  const original = element?.textContent || '';
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState(null); // proposed rewrite, pre-apply
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const taRef = useRef(null);

  useEffect(() => {
    setPrompt('');
    setResult(null);
    setError(null);
    queueMicrotask(() => taRef.current?.focus());
  }, [element]);

  const generate = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const out = await api.inlineRewriteText(original, prompt.trim());
      setResult(out.text);
    } catch (e) {
      setError(e.message || 'Rewrite failed');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && prompt.trim() && !loading) {
      e.preventDefault();
      generate();
    }
  };

  return (
    <div className="panel-form">
      <div className="panel-label">Original</div>
      <div className="panel-original">{original}</div>

      <div className="panel-label">Instruction</div>
      <textarea
        ref={taRef}
        className="panel-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="e.g. Make this shorter and more confident"
        rows={3}
        disabled={loading}
      />

      {result && !loading && (
        <>
          <div className="panel-label">Proposed rewrite</div>
          <div className="panel-proposal">{result}</div>
        </>
      )}

      {error && <div className="panel-error">{error}</div>}

      {hasMixedChildren && (
        <div className="panel-hint">
          This element contains nested tags. Applying will replace them with plain text.
        </div>
      )}

      <div className="panel-footer">
        {!result ? (
          <button
            type="button"
            className="primary"
            onClick={generate}
            disabled={!prompt.trim() || loading}
          >
            {loading ? <><Spinner /> Generating…</> : 'Generate'}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => { setResult(null); setPrompt(''); }}>Try again</button>
            <button type="button" className="primary" onClick={() => onApply(result)}>Apply</button>
          </>
        )}
      </div>
    </div>
  );
}
