import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const APP_STATE_FILE = path.join(ROOT, 'app-state.json');

export async function ensureProjectsDir() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

export function projectDir(slug) {
  return path.join(PROJECTS_DIR, slug);
}

async function readJson(p, fallback) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Session schema v2: { schemaVersion: 2, threads: { __site: [], "index.html": [...] } }
// v1 was { messages: [...] } — a single thread.
//
// Migration rule: v1 messages move into the "index.html" thread (preserves the
// no-regression behavior of seeing prior chat when opening an existing project).
// __site starts empty. The site-thread is the cross-page / theme conversation.
export const SITE_THREAD = '__site';
export function normalizeSession(raw, pageNames = []) {
  // Already v2 shape.
  if (raw && raw.schemaVersion === 2 && raw.threads && typeof raw.threads === 'object') {
    const threads = { ...raw.threads };
    if (!Array.isArray(threads[SITE_THREAD])) threads[SITE_THREAD] = [];
    // Ensure every existing page has at least an empty thread slot.
    for (const name of pageNames) {
      if (!Array.isArray(threads[name])) threads[name] = [];
    }
    return { changed: false, session: { schemaVersion: 2, threads } };
  }
  // v1 or empty.
  const prev = Array.isArray(raw?.messages) ? raw.messages : [];
  const threads = { [SITE_THREAD]: [] };
  // Drop prior messages into index.html if it exists, otherwise leave them
  // attached to index.html anyway — projects always have an index page once
  // they've been generated, and an empty-pages project has no prior messages.
  threads['index.html'] = prev;
  for (const name of pageNames) {
    if (!threads[name]) threads[name] = [];
  }
  return { changed: true, session: { schemaVersion: 2, threads } };
}

async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}

export async function listProjects() {
  await ensureProjectsDir();
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readJson(path.join(PROJECTS_DIR, entry.name, 'project.json'), null);
    if (meta) projects.push(meta);
  }
  projects.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return projects;
}

export async function getProject(slug) {
  const dir = projectDir(slug);
  const project = await readJson(path.join(dir, 'project.json'), null);
  if (!project) return null;
  const pages = await readJson(path.join(dir, 'pages.json'), {});
  const rawSession = await readJson(path.join(dir, 'session.json'), null);
  const pageNames = Object.keys(pages);
  const { changed, session } = normalizeSession(rawSession, pageNames);
  if (changed) {
    // Persist the migrated shape so subsequent reads are fast.
    await writeJson(path.join(dir, 'session.json'), session);
    // For v1→v2 migrations, seed lastScope to the thread that received the
    // migrated messages, so existing projects open into their visible chat
    // (no regression for the user). Only set if not already present.
    if (!project.lastScope) {
      const populated = Object.entries(session.threads || {})
        .find(([k, v]) => k !== SITE_THREAD && Array.isArray(v) && v.length > 0);
      project.lastScope = populated ? populated[0] : SITE_THREAD;
      await writeJson(path.join(dir, 'project.json'), project);
    }
  }
  return { project, pages, session };
}

export async function createProject({ name }) {
  const date = new Date().toISOString().slice(0, 10);
  const baseName = name || `untitled_project_${date}`;
  let slug = slugify(`${baseName}-${date}`);
  let suffix = 1;
  while (await exists(projectDir(slug))) {
    slug = slugify(`${baseName}-${date}-${++suffix}`);
  }
  const now = new Date().toISOString();
  const project = {
    slug,
    name: baseName,
    created: now,
    modified: now,
    crawledUrl: null,
    crawledData: null,
    modelHistory: [],
  };
  await writeJson(path.join(projectDir(slug), 'project.json'), project);
  await writeJson(path.join(projectDir(slug), 'pages.json'), {});
  const session = { schemaVersion: 2, threads: { [SITE_THREAD]: [], 'index.html': [] } };
  await writeJson(path.join(projectDir(slug), 'session.json'), session);
  return { project, pages: {}, session };
}

export async function saveProject(slug, { project, pages, session, skipHistory, activeThread }) {
  const dir = projectDir(slug);
  const now = new Date().toISOString();
  if (project) {
    project.modified = now;
    // The favicon and ogImage are owned by their own endpoints — never let a
    // client PUT clobber them.
    const existing = await readJson(path.join(dir, 'project.json'), null);
    if (existing && Object.prototype.hasOwnProperty.call(existing, 'favicon')) {
      project.favicon = existing.favicon;
    } else if (!Object.prototype.hasOwnProperty.call(project, 'favicon')) {
      // Leave undefined; readers tolerate either form.
    }
    if (existing && Object.prototype.hasOwnProperty.call(existing, 'ogImage')) {
      project.ogImage = existing.ogImage;
    }
    await writeJson(path.join(dir, 'project.json'), project);
  }
  let pagesChanged = false;
  if (pages) {
    const existingPages = await readJson(path.join(dir, 'pages.json'), {});
    pagesChanged = JSON.stringify(pages) !== JSON.stringify(existingPages);
    await writeJson(path.join(dir, 'pages.json'), pages);
  }
  if (session) await writeJson(path.join(dir, 'session.json'), session);
  if (pagesChanged && !skipHistory) {
    // Resolve lastMessage from the just-touched thread; fall back to scanning
    // all threads for the most recent message if no thread hint was provided
    // (e.g. an older client). Always tolerate the legacy v1 shape.
    let lastMessage = null;
    if (session?.threads && activeThread && Array.isArray(session.threads[activeThread])) {
      const arr = session.threads[activeThread];
      lastMessage = arr[arr.length - 1] || null;
    } else if (session?.threads) {
      let newest = null;
      for (const arr of Object.values(session.threads)) {
        if (!Array.isArray(arr)) continue;
        const m = arr[arr.length - 1];
        if (m && (!newest || (m.timestamp || '') > (newest.timestamp || ''))) newest = m;
      }
      lastMessage = newest;
    } else if (Array.isArray(session?.messages)) {
      lastMessage = session.messages[session.messages.length - 1] || null;
    }
    await writeJson(path.join(dir, 'history', `${now.replace(/[:.]/g, '-')}.json`), {
      timestamp: now,
      pages,
      lastMessage,
    });
  }
}

export async function renameProject(slug, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) {
    const err = new Error('Project name cannot be empty.');
    err.status = 400;
    throw err;
  }

  const data = await getProject(slug);
  if (!data) return null;

  // No-op when the name didn't actually change (case-insensitive).
  if (data.project.name?.toLowerCase() === trimmed.toLowerCase() && data.project.name === trimmed) {
    return data.project;
  }

  // Reject if another project already uses this name (case-insensitive).
  const others = (await listProjects()).filter(p => p.slug !== slug);
  if (others.some(p => p.name?.toLowerCase() === trimmed.toLowerCase())) {
    const err = new Error(`A project named "${trimmed}" already exists.`);
    err.status = 409;
    throw err;
  }

  // Compute new slug from name + the project's creation date (preserves the
  // original {name}-{date} pattern so collisions are minimized).
  const createdDate = (data.project.created || new Date().toISOString()).slice(0, 10);
  const newSlug = slugify(`${trimmed}-${createdDate}`);

  // Rename the folder if the slug changed.
  if (newSlug !== slug) {
    if (await exists(projectDir(newSlug))) {
      const err = new Error(`A project folder for "${newSlug}" already exists.`);
      err.status = 409;
      throw err;
    }
    await fs.rename(projectDir(slug), projectDir(newSlug));
  }

  // Update project.json in (the possibly-new) directory.
  const updated = {
    ...data.project,
    name: trimmed,
    slug: newSlug,
    modified: new Date().toISOString(),
  };
  await writeJson(path.join(projectDir(newSlug), 'project.json'), updated);
  return updated;
}

// Targeted update of just project.favicon. Bypasses saveProject's merge so
// the favicon endpoints can actually write this field. Other concurrent
// PUTs to project.json from the client cannot clobber what we write here.
export async function saveProjectFavicon(slug, favicon) {
  const p = path.join(projectDir(slug), 'project.json');
  const existing = await readJson(p, null);
  if (!existing) return null;
  if (favicon == null) delete existing.favicon;
  else existing.favicon = favicon;
  existing.modified = new Date().toISOString();
  await writeJson(p, existing);
  return existing;
}

export async function saveProjectOgImage(slug, ogImage) {
  const p = path.join(projectDir(slug), 'project.json');
  const existing = await readJson(p, null);
  if (!existing) return null;
  if (ogImage == null) delete existing.ogImage;
  else existing.ogImage = ogImage;
  existing.modified = new Date().toISOString();
  await writeJson(p, existing);
  return existing;
}

export async function deleteProject(slug) {
  await fs.rm(projectDir(slug), { recursive: true, force: true });
}

export async function duplicateProject(slug) {
  const data = await getProject(slug);
  if (!data) return null;
  const { project: original } = data;

  const newName = `${original.name} Copy`;
  const date = new Date().toISOString().slice(0, 10);
  let newSlug = slugify(`${newName}-${date}`);
  let suffix = 1;
  while (await exists(projectDir(newSlug))) {
    newSlug = slugify(`${newName}-${date}-${++suffix}`);
  }

  await fs.cp(projectDir(slug), projectDir(newSlug), { recursive: true });
  // Drop the inherited exports/ — they belong to the original.
  await fs.rm(path.join(projectDir(newSlug), 'exports'), { recursive: true, force: true });

  const now = new Date().toISOString();
  const updated = {
    ...original,
    slug: newSlug,
    name: newName,
    created: now,
    modified: now,
    duplicatedFrom: original.slug,
  };
  await writeJson(path.join(projectDir(newSlug), 'project.json'), updated);
  return updated;
}

export async function getHistory(slug) {
  const dir = path.join(projectDir(slug), 'history');
  try {
    const files = await fs.readdir(dir);
    return files
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => f.replace('.json', ''));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function getHistoryEntry(slug, timestamp) {
  const file = path.join(projectDir(slug), 'history', `${timestamp}.json`);
  return readJson(file, null);
}

export async function restoreHistory(slug, timestamp, prune = false) {
  const entry = await getHistoryEntry(slug, timestamp);
  if (!entry || !entry.pages) return null;

  await writeJson(path.join(projectDir(slug), 'pages.json'), entry.pages);

  if (prune) {
    const historyDir = path.join(projectDir(slug), 'history');
    const files = await fs.readdir(historyDir);
    const toDelete = files.filter(f => f.endsWith('.json') && f.replace('.json', '') > timestamp);
    await Promise.all(toDelete.map(f => fs.unlink(path.join(historyDir, f))));
  }

  return entry;
}

export async function pruneHistoryAfter(slug, timestamp) {
  const historyDir = path.join(projectDir(slug), 'history');
  try {
    const files = await fs.readdir(historyDir);
    const toDelete = files.filter(f => f.endsWith('.json') && f.replace('.json', '') > timestamp);
    await Promise.all(toDelete.map(f => fs.unlink(path.join(historyDir, f))));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function readAppState() {
  return readJson(APP_STATE_FILE, { openTabs: [], activeTab: null });
}

export async function writeAppState(state) {
  await writeJson(APP_STATE_FILE, state);
}
