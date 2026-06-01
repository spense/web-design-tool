import * as cheerio from 'cheerio';

const MAX_PAGES = 20;
const FETCH_TIMEOUT = 10000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WebDesignTool/0.1 (+local)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) throw new Error(`Not HTML: ${ctype}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractPage(html, url) {
  const $ = cheerio.load(html);
  const title = $('title').text().trim() || null;
  const description = $('meta[name="description"]').attr('content') || null;
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const t = $(el).text().trim();
    if (t) headings.push({ level: el.tagName.toLowerCase(), text: t });
  });
  const navLinks = [];
  $('nav a[href], header a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const t = $(el).text().trim();
    if (href && t) navLinks.push({ href, text: t });
  });
  // color hints from inline styles
  const colorHints = new Set();
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const matches = style.match(/#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)/g);
    if (matches) matches.forEach(c => colorHints.add(c));
  });
  return {
    url,
    title,
    description,
    text,
    headings: headings.slice(0, 30),
    navLinks: navLinks.slice(0, 40),
    colorHints: Array.from(colorHints).slice(0, 20),
  };
}

function sameOriginLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const u = new URL(href, baseUrl);
      if (u.origin !== base.origin) return;
      u.hash = '';
      const path = u.pathname + u.search;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|mp3)$/i.test(u.pathname)) return;
      links.add(u.origin + path);
    } catch {}
  });
  return Array.from(links);
}

export async function crawlSite(startUrl) {
  const visited = new Set();
  const queue = [startUrl];
  const pages = [];
  const skipped = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const html = await fetchHtml(url);
      pages.push(extractPage(html, url));
      if (pages.length === 1) {
        // only enqueue links discovered on the homepage
        for (const link of sameOriginLinks(html, url)) {
          if (!visited.has(link) && queue.length + pages.length < MAX_PAGES) {
            queue.push(link);
          }
        }
      }
    } catch (err) {
      skipped.push({ url, error: err.message });
    }
  }

  return {
    startUrl,
    crawledAt: new Date().toISOString(),
    pages,
    skipped,
    pageCount: pages.length,
  };
}
