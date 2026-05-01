const API = '/api';

async function jsonReq(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  getConfig: () => jsonReq('GET', '/config'),
  listProjects: () => jsonReq('GET', '/projects'),
  getProject: (slug) => jsonReq('GET', `/projects/${slug}`),
  createProject: (name) => jsonReq('POST', '/projects', { name }),
  saveProject: (slug, payload) => jsonReq('PUT', `/projects/${slug}`, payload),
  renameProject: (slug, name) => jsonReq('PATCH', `/projects/${slug}/name`, { name }),
  deleteProject: (slug) => jsonReq('DELETE', `/projects/${slug}`),
  crawl: (url) => jsonReq('POST', '/crawl', { url }),
  exportProject: (slug, model) => jsonReq('POST', `/export/${slug}`, { model }),
  downloadExportUrl: (slug, timestamp) => `${API}/export/${slug}/download/${timestamp}`,
  importProject: async (file) => {
    const fd = new FormData();
    fd.append('zip', file);
    fd.append('name', file.name.replace(/\.zip$/i, ''));
    const res = await fetch(API + '/import', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  getAppState: () => jsonReq('GET', '/app-state'),
  saveAppState: (state) => jsonReq('PUT', '/app-state', state),
};

// Streaming chat: calls onDelta(chunk) and resolves with full text on done.
export async function streamChat({ model, messages, context, onDelta, signal }) {
  const res = await fetch(API + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, context }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const evt of events) {
      const lines = evt.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === 'delta') {
        fullText += parsed.delta;
        onDelta?.(parsed.delta, fullText);
      } else if (event === 'done') {
        return { text: parsed.text || fullText, usage: parsed.usage || null };
      } else if (event === 'error') {
        throw new Error(parsed.error || 'Stream error');
      }
    }
  }
  return { text: fullText, usage: null };
}
