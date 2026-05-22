import express from 'express';
import { getAnthropic, MODELS } from '../anthropic.js';

const router = express.Router();

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
