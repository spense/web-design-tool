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
  duplicateProject: (slug) => jsonReq('POST', `/projects/${slug}/duplicate`),
  getHistory: (slug) => jsonReq('GET', `/projects/${slug}/history`),
  getHistoryEntry: (slug, timestamp) => jsonReq('GET', `/projects/${slug}/history/${timestamp}`),
  pruneHistory: (slug, after) => jsonReq('POST', `/projects/${slug}/history/prune`, { after }),
  crawl: (url) => jsonReq('POST', '/crawl', { url }),
  exportProject: (slug) => jsonReq('POST', `/export/${slug}`),
  getExportStatus: (slug) => jsonReq('GET', `/export/${slug}/status`),
  clearExportStatus: (slug) => jsonReq('DELETE', `/export/${slug}/status`),
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
  uploadAsset: async (slug, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API}/projects/${slug}/uploads`, { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  uploadUrl: (slug, filename) => `${API}/projects/${slug}/uploads/${encodeURIComponent(filename)}`,

  faviconFileUrl: (slug, name, version) => {
    const v = version != null ? `?v=${version}` : '';
    return `${API}/projects/${slug}/favicon/file/${encodeURIComponent(name)}${v}`;
  },
  // High-res URL for in-app previews (tabs, project list, section cards).
  // Generated favicons use SVG (sharp at any size); uploaded ones use the
  // 192px PNG so retina displays still get crisp downscaling.
  faviconCrispUrl: (slug, favicon) => {
    if (!favicon?.selected) return null;
    const v = favicon.version != null ? `?v=${favicon.version}` : '';
    if (favicon.selected === 'generated') {
      return `${API}/projects/${slug}/favicon/file/generated.svg${v}`;
    }
    return `${API}/projects/${slug}/favicon/file/uploaded-192.png${v}`;
  },
  saveGeneratedFavicon: async (slug, { svg, pngs, params }) => {
    const fd = new FormData();
    fd.append('svg', new Blob([svg], { type: 'image/svg+xml' }), 'generated.svg');
    for (const [size, blob] of Object.entries(pngs)) {
      fd.append(`png_${size}`, blob, `generated-${size}.png`);
    }
    fd.append('params', JSON.stringify(params));
    const res = await fetch(`${API}/projects/${slug}/favicon/generated`, { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  saveUploadedFavicon: async (slug, { original, pngs }) => {
    const fd = new FormData();
    fd.append('original', original, original.name || 'upload');
    for (const [size, blob] of Object.entries(pngs)) {
      fd.append(`png_${size}`, blob, `uploaded-${size}.png`);
    }
    const res = await fetch(`${API}/projects/${slug}/favicon/uploaded`, { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
  selectFavicon: (slug, selected) => jsonReq('PATCH', `/projects/${slug}/favicon/select`, { selected }),
  deleteUploadedFavicon: (slug) => jsonReq('DELETE', `/projects/${slug}/favicon/uploaded`),
};

// Streaming chat: calls onDelta(chunk) and resolves with full text on done.
// Calls onJobId(jobId) as soon as the server assigns a job — use it to poll
// if the connection drops before the 'done' event arrives.
export async function streamChat({ model, messages, context, onDelta, onJobId, signal }) {
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
  let jobId = null;
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
      if (event === 'jobId') {
        jobId = parsed.jobId;
        onJobId?.(jobId);
      } else if (event === 'delta') {
        fullText += parsed.delta;
        onDelta?.(parsed.delta, fullText);
      } else if (event === 'done') {
        return { text: parsed.text || fullText, usage: parsed.usage || null, stopReason: parsed.stopReason || null };
      } else if (event === 'error') {
        throw new Error(parsed.error || 'Stream error');
      }
    }
  }
  // Connection dropped before 'done' — attach jobId so caller can poll.
  const err = new Error('Stream connection dropped');
  err.jobId = jobId;
  throw err;
}

// Poll a background job until it completes or times out (10 min).
export async function pollJobResult(jobId, { signal } = {}) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    await new Promise(r => setTimeout(r, 1500));
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const res = await fetch(`${API}/chat/${jobId}`, { signal });
    if (!res.ok) throw new Error('Job not found or expired');
    const job = await res.json();
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.error || 'Generation failed');
  }
  throw new Error('Generation timed out');
}
