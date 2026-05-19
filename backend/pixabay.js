import fs from 'fs/promises';
import path from 'path';
import { projectDir } from './storage.js';
import { getAnthropic, MODELS } from './anthropic.js';

const PIXABAY_BASE = 'https://pixabay.com/api/';
const PIXABAY_VIDEO_BASE = 'https://pixabay.com/api/videos/';
const MAX_POOL_SIZE = 25;
const DOWNLOAD_CONCURRENCY = 6;

function getKey() {
  return process.env.PIXABAY_API_KEY || '';
}

function slugifyTag(tag) {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export async function searchImages(query, options = {}) {
  const key = getKey();
  if (!key) return [];
  const type = options.type || 'photo';
  const isVideo = type === 'video';
  const base = isVideo ? PIXABAY_VIDEO_BASE : PIXABAY_BASE;
  const params = new URLSearchParams({
    key,
    q: query,
    per_page: String(options.perPage || 8),
    safesearch: 'true',
  });
  if (!isVideo) params.set('image_type', type === 'illustration' ? 'illustration' : 'photo');

  const res = await fetch(`${base}?${params}`);
  if (!res.ok) {
    console.error(`[pixabay] search failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const data = await res.json();
  return (data.hits || []).map(hit => ({
    id: hit.id,
    tags: hit.tags,
    description: hit.tags,
    webformatURL: hit.webformatURL,
    largeImageURL: isVideo ? (hit.videos?.medium?.url || hit.videos?.small?.url) : hit.largeImageURL,
    width: isVideo ? (hit.videos?.medium?.width || 640) : hit.imageWidth,
    height: isVideo ? (hit.videos?.medium?.height || 360) : hit.imageHeight,
    isVideo,
  }));
}

export async function downloadToProject(slug, imageUrl, filename) {
  const dir = path.join(projectDir(slug), 'uploads');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, filename);
  try {
    await fs.access(dest);
    return { filename, skipped: true };
  } catch { /* doesn't exist, proceed */ }

  const res = await fetch(imageUrl);
  if (!res.ok) {
    console.error(`[pixabay] download failed for ${imageUrl}: ${res.status}`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buffer);
  return { filename, sizeBytes: buffer.length };
}

export async function extractSearchTerms(crawledData, userPrompt) {
  const parts = [];
  if (crawledData) {
    if (crawledData.title) parts.push(`Business: ${crawledData.title}`);
    if (crawledData.description) parts.push(`Description: ${crawledData.description}`);
    const pageTexts = crawledData.pages?.map(p => p.title || '').filter(Boolean).join(', ');
    if (pageTexts) parts.push(`Pages: ${pageTexts}`);
  }
  if (userPrompt) parts.push(`User request: ${userPrompt}`);
  const context = parts.join('\n');
  if (!context.trim()) return ['business', 'professional', 'modern'];

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 200,
      system: 'Extract 5-8 Pixabay image search terms from the business context below. Return ONLY a JSON array of strings. Focus on: business type imagery, services offered, atmosphere, textures, and backgrounds that would suit the website. Example: ["bakery storefront", "fresh bread close-up", "pastry display", "cozy cafe interior", "flour texture", "wooden table"]',
      messages: [{ role: 'user', content: context }],
    });
    const text = msg.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const terms = JSON.parse(match[0]);
      if (Array.isArray(terms) && terms.length > 0) {
        console.log(`[pixabay] extracted ${terms.length} search terms via Haiku`);
        return terms.slice(0, 8);
      }
    }
  } catch (err) {
    console.error('[pixabay] Haiku term extraction failed, using fallback:', err.message);
  }

  const words = context.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const unique = [...new Set(words)].filter(w => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'make', 'website', 'site', 'page', 'new', 'use', 'create'].includes(w));
  return unique.slice(0, 5);
}

export async function buildImagePool(slug, searchTerms, options = {}) {
  const key = getKey();
  if (!key || !searchTerms.length) return [];

  const allHits = new Map();
  const searchPromises = searchTerms.map(term =>
    searchImages(term, { type: options.type || 'photo', perPage: 8 })
  );
  const results = await Promise.all(searchPromises);
  for (const hits of results) {
    for (const hit of hits) {
      if (!allHits.has(hit.id)) allHits.set(hit.id, hit);
    }
  }

  const selected = [...allHits.values()].slice(0, MAX_POOL_SIZE);
  console.log(`[pixabay] ${allHits.size} unique results, downloading ${selected.length}`);

  const pool = [];
  for (let i = 0; i < selected.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = selected.slice(i, i + DOWNLOAD_CONCURRENCY);
    const downloads = await Promise.all(
      batch.map(hit => {
        const ext = hit.isVideo ? '.mp4' : '.jpg';
        const filename = `pb-${slugifyTag(hit.tags.split(',')[0] || 'image')}-${hit.id}${ext}`;
        return downloadToProject(slug, hit.largeImageURL, filename).then(result => {
          if (result) return { ...result, hit };
          return null;
        });
      })
    );
    for (const dl of downloads) {
      if (!dl) continue;
      pool.push({
        path: `uploads/${dl.filename}`,
        description: dl.hit.description,
        width: dl.hit.width,
        height: dl.hit.height,
      });
    }
  }
  console.log(`[pixabay] pool ready: ${pool.length} images for project ${slug}`);
  return pool;
}

export function formatPoolForPrompt(pool) {
  if (!pool.length) return '';
  const lines = pool.map(img =>
    `- ${img.path} — ${img.description} (${img.width}x${img.height})`
  );
  return `\n\n--- IMAGE POOL ---\nThe following images have been downloaded and are available for use in the design.\nReference them by their exact path as <img src="uploads/pb-..."> or background-image: url(uploads/pb-...).\nUse inline <img> for content images (team photos, gallery items, service illustrations) and CSS background-image for atmospheric/decorative use (hero backgrounds, section textures, overlays).\nPick images that best match each section's content and purpose.\n\n${lines.join('\n')}\n`;
}

export async function cleanupUnusedImages(slug, pages) {
  const uploadsDir = path.join(projectDir(slug), 'uploads');
  let entries;
  try {
    entries = await fs.readdir(uploadsDir);
  } catch { return []; }

  const pbFiles = entries.filter(f => f.startsWith('pb-'));
  if (!pbFiles.length) return [];

  const allHtml = Object.values(pages).join('\n');
  const deleted = [];
  for (const file of pbFiles) {
    if (!allHtml.includes(file)) {
      try {
        await fs.unlink(path.join(uploadsDir, file));
        deleted.push(file);
      } catch { /* ignore */ }
    }
  }
  if (deleted.length) console.log(`[pixabay] cleaned up ${deleted.length} unused images`);
  return deleted;
}

export async function listExistingPool(slug) {
  const uploadsDir = path.join(projectDir(slug), 'uploads');
  try {
    const entries = await fs.readdir(uploadsDir);
    return entries
      .filter(f => f.startsWith('pb-'))
      .map(f => ({
        path: `uploads/${f}`,
        description: f.replace(/^pb-/, '').replace(/-\d+\.\w+$/, '').replace(/-/g, ' '),
        width: 0,
        height: 0,
      }));
  } catch { return []; }
}
