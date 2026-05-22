import express from 'express';
import { getAnthropic, MODELS } from '../anthropic.js';
import { searchImages, downloadToProject } from '../pixabay.js';

const router = express.Router();

function slugifyTag(tag) {
  return String(tag || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
}

// GET /api/inline/pixabay-search?q=<query>
// Returns up to 24 Pixabay photo hits for the user-supplied query.
router.get('/pixabay-search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ hits: [] });
    const hits = await searchImages(q, { type: 'photo', perPage: 24 });
    res.json({ hits });
  } catch (err) {
    next(err);
  }
});

// POST /api/inline/generate-svg
// Body: { prompt: string, currentSvg?: string }
// Returns: { svg: string }  — raw <svg>...</svg> markup
//
// Uses Sonnet 4.6 because icon-quality SVG generation suffers noticeably on
// smaller models (wonky paths, inconsistent strokes). currentSvg is sent as
// optional context so the model can match the existing icon's style.
router.post('/generate-svg', async (req, res, next) => {
  try {
    const { prompt, currentSvg } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODELS.sonnet,
      max_tokens: 1500,
      system:
`You generate a single SVG icon from a user description.

STRICT OUTPUT RULES:
- Output ONLY the SVG markup, starting with <svg and ending with </svg>.
- No code fences. No commentary. No explanations. No prose.
- Never use <script>, <foreignObject>, or any on* event handler attributes.

STYLE CONVENTIONS:
- viewBox="0 0 24 24" unless the icon clearly needs a different aspect ratio.
- For line-style icons (the default for UI work): stroke="currentColor", fill="none", stroke-width="1.5", stroke-linecap="round", stroke-linejoin="round".
- For filled/solid icons (when the user asks for filled, solid, glyph, etc.): fill="currentColor", no stroke.
- Omit width/height on the root <svg>; let CSS control sizing.
- Single root <svg> only.
- Keep paths clean and aligned to the viewBox grid.
- If the user provides a reference SVG, match its style (line vs filled, stroke width, viewBox) unless they explicitly ask to change it.`,
      messages: [{
        role: 'user',
        content: currentSvg
          ? `Reference SVG (match its style):\n${currentSvg}\n\nNew icon: ${prompt}\n\nReturn only the new <svg>.`
          : `Icon: ${prompt}\n\nReturn only the <svg>.`,
      }],
    });
    let out = (msg.content?.[0]?.text || '').trim();
    // Be defensive: strip code fences if the model added them anyway.
    out = out.replace(/^```(?:svg|xml|html)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Slice from first <svg to last </svg> in case of stray prose.
    const start = out.search(/<svg\b/i);
    const end = out.lastIndexOf('</svg>');
    if (start < 0 || end < 0) {
      return res.status(502).json({ error: 'model returned non-SVG output' });
    }
    const svg = out.slice(start, end + 6);
    res.json({ svg });
  } catch (err) {
    next(err);
  }
});

// POST /api/inline/download-pixabay
// Body: { slug, url, tags, id }
// Downloads the chosen Pixabay image into the project's uploads/ dir using
// the existing pb- naming convention, returns { path }.
router.post('/download-pixabay', async (req, res, next) => {
  try {
    const { slug, url, tags, id } = req.body || {};
    if (!slug || !url || !id) {
      return res.status(400).json({ error: 'slug, url and id required' });
    }
    const firstTag = String(tags || '').split(',')[0] || 'image';
    const filename = `pb-${slugifyTag(firstTag)}-${id}.jpg`;
    const result = await downloadToProject(slug, url, filename);
    if (!result) return res.status(502).json({ error: 'download failed' });
    res.json({ path: `uploads/${result.filename}` });
  } catch (err) {
    next(err);
  }
});

// POST /api/inline/rewrite-text
// Body: { text: string, prompt: string }
// Returns: { text: string }
//
// Rewrites the supplied text per the user's instruction. Strictly plain text
// out — no HTML, no commentary, no quotes around the result. Used by the
// inline-edit "Rewrite" action which then sets the element's textContent.
router.post('/rewrite-text', async (req, res, next) => {
  try {
    const { text, prompt } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 800,
      system:
`You are rewriting a snippet of website copy. The user will give you the current text and an instruction. Return ONLY the rewritten text — nothing else.

STRICT RULES:
- Output plain text only. No HTML tags, no markdown, no code fences.
- No commentary, no preface, no quotes around the result.
- Preserve the user's apparent tone unless the instruction asks to change it.
- Match the approximate length of the original unless the instruction asks for shorter/longer.
- If the instruction is to replace with literal text (e.g. "replace with Hi Lucy"), return exactly that literal text.
- Do not wrap the result in quotation marks.`,
      messages: [{
        role: 'user',
        content:
`Current text:
"""
${text}
"""

Instruction: ${prompt}

Return only the rewritten text.`,
      }],
    });
    const out = (msg.content?.[0]?.text || '').trim();
    // Strip leading/trailing wrap quotes if the model added them anyway.
    const cleaned = out.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!cleaned) return res.status(502).json({ error: 'empty rewrite' });
    res.json({ text: cleaned });
  } catch (err) {
    next(err);
  }
});

export default router;
