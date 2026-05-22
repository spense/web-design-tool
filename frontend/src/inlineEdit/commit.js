// Apply an inline edit by mutating a fresh parse of the SAVED HTML string
// (not the live iframe DOM, which has runtime-only injections like our
// selection overlays, token-override inline styles, animation override
// stylesheets, etc.).
//
// The selector path resolves identically in both because:
//   - our injected overlay divs are APPENDED to <body>, so they don't shift
//     nth-child indices of any other body children;
//   - element children are positional and identical between live DOM and a
//     fresh parse of the same source HTML.
//
// Returns the new HTML string for the page, or null if the path didn't
// resolve (caller should bail).

import { resolveSelectorPath } from './selectionUtils.js';

export function commitInlineEdit({ sourceHtml, selectorPath, mutator }) {
  if (!sourceHtml || !selectorPath) return null;
  const doc = new DOMParser().parseFromString(sourceHtml, 'text/html');
  const target = resolveSelectorPath(selectorPath, doc);
  if (!target) return null;
  try {
    mutator(target, doc);
  } catch (err) {
    console.error('[inline-edit] mutator threw:', err);
    return null;
  }
  return serializeDoc(doc, sourceHtml);
}

function serializeDoc(doc, original) {
  const m = original.match(/^\s*(<!doctype[^>]*>)/i);
  const doctype = m ? m[1] : '<!DOCTYPE html>';
  return `${doctype}\n${doc.documentElement.outerHTML}`;
}
