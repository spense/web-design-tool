import React, { useState, useEffect, useRef } from 'react';
import Spinner from '../Spinner.jsx';
import { api } from '../../api.js';
import { validateAndSanitizeHtml } from '../../inlineEdit/htmlSanitize.js';

// "Tell the AI what to do with this element." Powerful and the riskiest of
// the inline actions — the model returns arbitrary HTML which we strictly
// validate (single root, same tag) and sanitize (no scripts / on-handlers /
// javascript: urls) before applying.
export default function PromptChangePanel({ element, onApply }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { markup }
  const [error, setError] = useState(null);
  const taRef = useRef(null);

  const rootTag = element?.tagName?.toLowerCase() || 'div';

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
    setResult(null);
    try {
      const { html } = await api.inlinePromptChange(element.outerHTML, prompt.trim());
      const validated = validateAndSanitizeHtml(html, rootTag);
      if (!validated.ok) {
        setError(validated.error);
        return;
      }
      setResult({ markup: validated.markup });
    } catch (e) {
      setError(e.message || 'Generation failed');
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
      <div className="panel-label">Target</div>
      <div className="panel-original pc-target">
        &lt;{rootTag}&gt; — {element.children?.length || 0} child element{element.children?.length === 1 ? '' : 's'}
      </div>

      <div className="panel-label">Instruction</div>
      <textarea
        ref={taRef}
        className="panel-textarea"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="e.g. Make this section background dark blue with white text"
        rows={3}
        disabled={loading}
      />

      {result && !loading && (
        <>
          <div className="panel-label">Generated markup</div>
          <pre className="pc-preview">{result.markup}</pre>
          <div className="panel-hint">
            Applying will replace the element. The root tag stays &lt;{rootTag}&gt;.
          </div>
        </>
      )}

      {error && <div className="panel-error">{error}</div>}

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
            <button type="button" onClick={() => setResult(null)}>Try again</button>
            <button type="button" className="primary" onClick={() => onApply({ markup: result.markup })}>Apply</button>
          </>
        )}
      </div>
    </div>
  );
}
