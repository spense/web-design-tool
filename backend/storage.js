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
  const session = await readJson(path.join(dir, 'session.json'), { messages: [] });
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
  await writeJson(path.join(projectDir(slug), 'session.json'), { messages: [] });
  return { project, pages: {}, session: { messages: [] } };
}

export async function saveProject(slug, { project, pages, session }) {
  const dir = projectDir(slug);
  const now = new Date().toISOString();
  if (project) {
    project.modified = now;
    await writeJson(path.join(dir, 'project.json'), project);
  }
  if (pages) await writeJson(path.join(dir, 'pages.json'), pages);
  if (session) await writeJson(path.join(dir, 'session.json'), session);
  if (pages || session) {
    await writeJson(path.join(dir, 'history', `${now.replace(/[:.]/g, '-')}.json`), {
      timestamp: now,
      pages: pages || undefined,
      lastMessage: session?.messages?.[session.messages.length - 1] || null,
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

export async function deleteProject(slug) {
  await fs.rm(projectDir(slug), { recursive: true, force: true });
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
