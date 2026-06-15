// Per-model token pricing in USD per million tokens. Update these alongside
// the MODELS map in backend/anthropic.js when adding a new model or when
// Anthropic publishes new rates.
//
// Keys match the values in MODELS (the short keys we send to the backend),
// AND the resolved model IDs the backend returns in messages — so lookups
// work whether a stored message has 'sonnet' or 'claude-sonnet-4-6'.
const PRICING = {
  // Sonnet 4.6 — $3 / $15 per MTok, cached reads $0.30, cache writes $3.75
  sonnet:                { in: 3,    out: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6':   { in: 3,    out: 15,  cacheRead: 0.30, cacheWrite: 3.75 },
  // Opus 4.6 / 4.7 — $15 / $75 per MTok, cached reads $1.50, cache writes $18.75
  opus:                  { in: 15,   out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  opus46:                { in: 15,   out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-6':     { in: 15,   out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-7':     { in: 15,   out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  // Haiku 4.5 — $1 / $5 per MTok, cached reads $0.10, cache writes $1.25
  haiku:                 { in: 1,    out: 5,   cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-haiku-4-5':    { in: 1,    out: 5,   cacheRead: 0.10, cacheWrite: 1.25 },
};

// Fallback for unknown models — use Sonnet rates so the number isn't wildly
// off. The pricing line still renders rather than disappearing entirely.
const FALLBACK = PRICING.sonnet;

// Calculate the USD cost of a single response. `usage` is the object the
// Anthropic SDK returns: { input_tokens, output_tokens,
// cache_creation_input_tokens, cache_read_input_tokens }. `input_tokens` from
// the API is ONLY the non-cached portion of the input, so we add the cache
// read/write counts separately at their respective rates.
export function calculateCost(model, usage) {
  if (!usage) return 0;
  const rates = PRICING[model] || FALLBACK;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  return (
    (inTok * rates.in +
      outTok * rates.out +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}

// Sum cost across an array of messages (handles missing usage gracefully).
export function totalCost(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.usage) {
      total += calculateCost(m.model, m.usage);
    }
  }
  return total;
}

// Format a USD amount for compact inline display. Sub-cent values get more
// precision so a $0.0034 single message doesn't show as "$0.00".
export function formatCost(usd) {
  if (!usd || usd < 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1)    return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
