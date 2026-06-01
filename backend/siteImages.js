import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import path from 'path';
import { getAnthropic, MODELS } from './anthropic.js';
import { downloadToProject } from './pixabay.js';

const FETCH_TIMEOUT = 10000;
const MAX_SITE_IMAGES = 25;
const DOWNLOAD_CONCURRENCY = 6;

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function hashId(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 8);
}

function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(jpg|jpeg|png|gif|webp|avif|svg)$/.test(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch { /* ignore */ }
  return '.jpg';
}

// Decide whether the user is asking to reuse EXISTING images from the crawled
// site (not Pixabay/stock), and from which page. Returns
// { needsSiteImages: boolean, targetUrl: string|null, placementHint: string }.
// targetUrl is returned as-is from the model; the caller resolves/validates it
// against the crawled site's origin.
export async function evaluateSiteImageIntent(crawledData, userPrompt) {
  if (!userPrompt || !crawledData?.startUrl) return { needsSiteImages: false };

  const knownPages = (crawledData.pages || []).map(p => p.url).filter(Boolean).slice(0, 20);
  const parts = [`Crawled site home: ${crawledData.startUrl}`];
  if (knownPages.length) parts.push(`Known pages:\n${knownPages.join('\n')}`);
  parts.push(`User request: ${userPrompt}`);
  const context = parts.join('\n');

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 250,
      system: `You decide whether a web-design prompt is asking to REUSE the EXISTING images from the user's own crawled website (e.g. a gallery, portfolio, customer logo bank, team avatars, product photos) — as opposed to searching for NEW stock photos.

Answer YES only when the user clearly wants images that already exist on their site — e.g. "pull the gallery images from /portfolio", "use the customer logos from the about page", "grab the team photos from our site", "reuse the product shots from the shop page".

Answer NO when the user wants new/stock imagery ("find a photo of...", "add a hero image of mountains"), is only doing layout/style changes ("move the image", "make it bigger"), or isn't talking about the existing site's images at all.

When YES, identify which page to pull from:
- "targetUrl" should be the page URL or path the user named (absolute URL, or a path like "/portfolio", or a known page from the list). If the user didn't name a page, use the site home URL.
- "placementHint" should briefly restate where/how the user wants the images used (e.g. "in a gallery section", "as a logo strip in the footer"). Empty string if unspecified.

Return ONLY a JSON object:
- If YES: {"needsSiteImages": true, "targetUrl": "...", "placementHint": "..."}
- If NO: {"needsSiteImages": false}`,
      messages: [{ role: 'user', content: context }],
    });
    const text = msg.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      if (result.needsSiteImages) {
        console.log(`[siteImages] Haiku: reuse site images from ${result.targetUrl || '(home)'}`);
        return {
          needsSiteImages: true,
          targetUrl: typeof result.targetUrl === 'string' ? result.targetUrl : null,
          placementHint: typeof result.placementHint === 'string' ? result.placementHint : '',
        };
      }
      console.log(`[siteImages] Haiku: not a site-image reuse request`);
    }
  } catch (err) {
    console.error('[siteImages] Haiku intent check failed, skipping:', err.message);
  }
  return { needsSiteImages: false };
}

// Resolve a model-supplied target (absolute URL or path) against the crawled
// site's origin. Returns an absolute URL string on the same origin, or the home
// URL as a safe fallback. Same-origin enforcement prevents fetching arbitrary
// external hosts from a prompt.
export function resolveTargetUrl(target, startUrl) {
  let home;
  try { home = new URL(startUrl); } catch { return null; }
  if (!target) return home.href;
  try {
    const u = new URL(target, home);
    if (u.origin !== home.origin) return home.href;
    return u.href;
  } catch {
    return home.href;
  }
}

// Fetch a single page and extract its content images with light semantic
// metadata (alt text + nearest caption). No dimensions — sizing/aspect ratio is
// the model's call. Returns [{ url, alt, caption }].
export async function crawlPageImages(targetUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  let html;
  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WebDesignTool/0.1 (+local)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) throw new Error(`Not HTML: ${ctype}`);
    html = await res.text();
  } finally {
    clearTimeout(t);
  }

  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src || src.startsWith('data:')) return;
    let abs;
    try { abs = new URL(src, targetUrl).href; } catch { return; }
    if (seen.has(abs)) return;
    seen.add(abs);
    const alt = ($(el).attr('alt') || '').trim();
    const caption = $(el).closest('figure').find('figcaption').first().text().trim()
      || ($(el).attr('title') || '').trim();
    out.push({ url: abs, alt, caption });
  });
  return out.slice(0, MAX_SITE_IMAGES);
}

// Download crawled site images into the project's uploads/ dir so they become
// local assets (survive export and downstream R2 upload). Never reference the
// remote URL in the design. Returns a pool: [{ path, description, width, height }].
export async function buildSiteImagePool(slug, images) {
  const pool = [];
  for (let i = 0; i < images.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = images.slice(i, i + DOWNLOAD_CONCURRENCY);
    const downloads = await Promise.all(
      batch.map(img => {
        const label = slugify(img.alt || img.caption) || 'image';
        const filename = `site-${label}-${hashId(img.url)}${extFromUrl(img.url)}`;
        return downloadToProject(slug, img.url, filename)
          .then(result => (result ? { ...result, img } : null))
          .catch(() => null);
      })
    );
    for (const dl of downloads) {
      if (!dl) continue;
      const description = [dl.img.alt, dl.img.caption].filter(Boolean).join(' — ') || 'site image';
      pool.push({ path: `uploads/${dl.filename}`, description, width: 0, height: 0 });
    }
  }
  console.log(`[siteImages] downloaded ${pool.length} site images for project ${slug}`);
  return pool;
}
