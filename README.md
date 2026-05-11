# Cinder Labs

Local-only AI design tool for generating and iterating on small-business website designs (lead-gen sites for local trades). Built around Claude with prompt caching, design tokens, and a two-mode generate/edit protocol.

## Setup

1. `cp .env.example .env` and add `ANTHROPIC_API_KEY` (https://console.anthropic.com/settings/keys)
2. `npm run install:all`
3. `npm start` — runs backend (Express, port 3001) and frontend (Vite, port 5173) concurrently

Open http://localhost:5173. Projects are saved under `/projects/` (gitignored).

`npm start` uses `concurrently` to run both servers; backend uses `node --watch server.js`, so backend file edits hot-reload. Vite handles frontend HMR. Look for `[backend]` (blue) and `[frontend]` (magenta) prefixes in terminal output.

---

## Architecture

```
backend/  Express server + Anthropic SDK + filesystem storage
frontend/ React + Vite SPA
projects/ Per-project working directories (gitignored)
```

Frontend is a single SPA. Each "tab" is a project. Generated HTML is rendered into an iframe via `srcDoc`.

### Backend

- `server.js` — Express setup, CORS, route mounting, port 3001.
- `anthropic.js` — Claude SDK client, `MODELS` map, `SYSTEM_PROMPT`, `EXPORT_SYSTEM_PROMPT`.
- `storage.js` — filesystem CRUD for projects (read/write/list/rename/delete).
- `crawler.js` — fetches a competitor URL with cheerio, extracts title/meta/headings/links/colors as intake data.
- `parseFiles.js` — server-side parser for `<!-- FILE: -->` blocks (mirrored on frontend).
- `routes/`:
  - `projects.js` — CRUD: list, get, create, rename, delete, save.
  - `chat.js` — streaming SSE endpoint (the main one).
  - `crawl.js` — POST a URL, returns structured intake data.
  - `export.js` — generates `brief.md` + `tokens.json` + `design-session.md` via `EXPORT_SYSTEM_PROMPT`, then zips with all pages + uploads.
  - `import.js` — accepts a zip, creates a project from it.
  - `uploads.js` — image upload + serve (sanitized filenames, suffix collision avoidance).
  - `appState.js` — persists open tabs / active tab in `app-state.json`.

### Frontend

- `App.jsx` — root, tab/project state, project list, project routing.
- `api.js` — fetch wrappers + `streamChat` (SSE reader). Returns `{ text, usage, stopReason }`.
- `parseFiles.js` — extracts `<!-- FILE: name.html -->` blocks. Splits trailing prose off file content at `</html>` so commentary after a file doesn't contaminate the saved HTML. Also exports `isCompleteHtmlDoc()` (requires `<body` and ends with `</html>`).
- `parsePatch.js` — extracts `<!-- EDIT: name -->` headers and SEARCH/REPLACE blocks; `applyPatches()` does byte-exact matching against current files (with a whitespace-tolerant fallback).
- `tokenRewriter.js` — parses and rewrites `:root { --token: value }` blocks across all pages.
- `themePresets.js` — color / font / sizing / spacing / radius preset definitions.
- `colorUtils.js` — hex/HSL math for theme generation.
- `components/`
  - `ProjectView.jsx` — wires together ChatPanel + PreviewPanel for one project.
  - `ChatPanel.jsx` — chat input, model picker, streaming display, attachment handling, response parsing, persistence. **This is where most of the response handling lives.**
  - `PreviewPanel.jsx` — iframe preview at mobile/tablet/desktop widths, page dropdown, Tools button, export.
  - `ToolsMenu.jsx` — applies theme presets by rewriting `:root` tokens across all pages without re-running the model.
  - `TabBar.jsx`, `NewTabView.jsx`, `ExportModal.jsx`, `Spinner.jsx` — UI primitives.

---

## Storage layout

Each project lives in `projects/{slug}/`:

```
project.json         metadata: name, slug, created, modified, crawledUrl,
                     crawledData, modelHistory, uploads, tokenSnapshot
                     (tokenSnapshot also stores __googleFonts — the original
                     Google Fonts query string, used to restore fonts on
                     "Original" selection in the Tools menu)
pages.json           { "index.html": "<!DOCTYPE...>", "contact.html": "...", ... }
session.json         { messages: [{role, content, timestamp}, ...] }
history/             snapshot per save: {ISO-timestamp}.json holds pages + last message
uploads/             user-attached images
exports/             {timestamp}/ folders, each containing the export bundle + zip
```

Every call to `saveProject` snapshots `pages.json` + last message into `history/`. **This is invaluable for diagnosing regressions** — you can walk forward through history snapshots to find exactly which turn broke something. (That's how we found the truncated-`contact.html` bug.)

---

## Anthropic integration

### Models (`backend/anthropic.js:14`)

```
opus   → claude-opus-4-7
sonnet → claude-sonnet-4-6
haiku  → claude-haiku-4-5
```

Default in UI is sonnet; user can switch per turn. `project.lastModel` is persisted.

### System prompt structure (`backend/anthropic.js:20`)

The `SYSTEM_PROMPT` covers:

- **Output mode selection**: FULL FILE vs PATCH (see below).
- **Design tokens contract** — required `:root` CSS variables for colors, typography, spacing, border-radius, shadows. **Every brand/theme color must reference `var(--color-…)`, not a literal.** Major spacing, body/heading font-size, border-radius, and font-family are also thematic. The contract exists so the Tools menu can swap themes by rewriting `:root` without re-running the model.
- **Section backgrounds must use vars** — hero sections, CTA bands, footers, nav bars — no hardcoded hex/rgb for backgrounds. Dark sections on a light design must define dedicated tokens (e.g. `--color-surface-inverse`, `--color-text-inverse`) in `:root`. Without this, theme switching leaves hardcoded backgrounds unchanged while text color swaps, causing illegible combinations.
- **Mobile responsiveness** — mobile-first CSS, breakpoints at 390/768/1024+, fluid images, 44px touch targets.
- **Header/content alignment** — when the header uses the same `max-width` as content sections, horizontal padding must not misalign it. Either drop padding above the max-width breakpoint, or include it in the max-width calc.
- **Visual rules** — inline CSS in `<style>` in `<head>`, no external deps except Google Fonts, `https://placehold.co/` for placeholders, real business copy (no lorem), inline single-color SVG icons (no emojis), required sections for landing pages.
- **Multi-page rules** — every linked page must be a complete document with the same nav/header/footer markup and same `:root` tokens; page-appropriate body content.
- **Nav styles** — Style A: in-page anchors (`#services`) for single-page; Style B: bare filenames (`about.html`) for multi-page. Never mixed.
- **Nav trigger / hamburger rules** — checkbox+label pattern (no JS), one of three patterns (standard responsive, always-trigger drawer, hybrid), trigger lives in header layout, opened menu renders as its own positioned surface.
- **Anti-meta rules** — no design-rationale comments in HTML, no "Designed by X" attribution, no "Style Guide" sections.

### Chat request flow (`backend/routes/chat.js`)

```
POST /api/chat  (SSE)
body: { model, messages, context: { crawledData, activePage, currentPages } }
```

The system prompt is split into **two blocks** to maximize prompt caching:

1. **Cached** (`cache_control: ephemeral`): `SYSTEM_PROMPT` + crawled intake data. Stable for the life of a project.
2. **Uncached**: active-page hint + every current file's full contents. Changes every turn.

The model sees the full current state of every file under `<!-- CURRENT FILE: name -->` headers — that's what enables byte-exact PATCH SEARCH matching.

The endpoint streams Anthropic SSE deltas back to the client and emits a final `done` event with `{ text, stopReason, usage }`. `max_tokens: 32000`. Every completed turn logs `[chat] model=… stop=… in=… out=… cache_write=… cache_read=…` — `stop=max_tokens` is the truncation signal.

### EXPORT_SYSTEM_PROMPT (`backend/anthropic.js:220`)

A separate prompt used only by `routes/export.js`. Produces three artifacts from the final HTML + chat history: `brief.md` (design direction summary), `tokens.json` (extracted CSS variable values), `design-session.md` (decisions and rejected directions).

---

## Generation & edit protocol

The model picks one of two output modes per response.

### FULL FILE mode

```
<!-- FILE: index.html -->
<!DOCTYPE html>
<html>...</html>

<!-- FILE: contact.html -->
<!DOCTYPE html>
...
```

Used for first generation, new pages, or "more than ~50% structural change." Each block is a complete `<!DOCTYPE html>` document. Parsed by `frontend/src/parseFiles.js:parseLabeled`. Trailing prose after `</html>` is split off and attached to the response prose, not the file.

### PATCH mode

```
<!-- EDIT: index.html -->
<<<<<<< SEARCH
<h1 class="hero-title">Old Text</h1>
=======
<h1 class="hero-title">New Text</h1>
>>>>>>> REPLACE
```

Used for iterations: copy edits, color tweaks, list changes, theme/restyle (rewrite `:root` tokens), single-section swaps. SEARCH must be byte-exact against the current file. Multiple SEARCH/REPLACE pairs per file allowed; multiple files per response allowed. Parsed and applied by `frontend/src/parsePatch.js`. Failures surface as a "Patch failed for: …" system message.

The system prompt explicitly forbids re-emitting unrelated sibling pages just to "stay in sync" — shared `:root` tokens already do that, and re-emitting risks truncation that wipes out an existing page.

---

## Truncation safety net

The original symptom: a multi-page restyle hit `max_tokens` mid-output, the FULL FILE for `contact.html` got cut off in CSS (no `<body>`, no `</html>`), and the partial file silently overwrote the previously-good one. Nav links still pointed at `contact.html`, but the file rendered blank.

Three layers prevent recurrence:

1. **`max_tokens: 32000`** in `backend/routes/chat.js`. Up from 16K — comfortably fits a multi-page restyle.
2. **`stop_reason` propagation**. Backend forwards `stop_reason` in the `done` SSE event. Frontend `streamChat` returns it. `ChatPanel` raises a "Response hit the output token limit and was truncated" system message when it equals `"max_tokens"`.
3. **Page completeness gate** (`frontend/src/parseFiles.js:isCompleteHtmlDoc`). Before persisting, every FULL FILE block must contain `<body` and end with `</html>`. Failures are listed in a "Skipped writing incomplete file(s)" system message; the previous good copy is preserved. The parser also strips trailing prose from file content so model commentary after `</html>` doesn't false-flag the check.

PATCH mode is independently safer: SEARCH/REPLACE never wholesale overwrites a file, and a missing SEARCH match fails loudly with "Patch failed for…".

---

## Theme system (Tools menu)

The design-tokens contract makes themes a client-side rewrite, not an LLM call.

- `frontend/src/tokenRewriter.js` — `extractTokens(html)` reads `:root { --foo: bar }`; `applyTokens(html, vars)` rewrites them in place; `applyToAllPages(pages, vars)` does it across the whole project. Also exports `extractGoogleFontsQuery(html)` to capture the original Google Fonts link URL for snapshot storage.
- `frontend/src/themePresets.js` — preset definitions for color palettes, font pairings, sizing scales, spacing scales, radius scales.
- `frontend/src/colorUtils.js` — hex/HSL utilities used to derive accent/contrast colors from a primary.
- `components/ToolsMenu.jsx` — UI for picking a preset; on apply, rewrites `:root` across all pages and persists. **Never calls the model.**

### Scroll-preserving live DOM injection

Tools changes do **not** reload the iframe. Instead, `PreviewPanel.handleApplyTokens` sets CSS custom properties directly on `iframe.contentDocument.documentElement.style` and syncs Google Fonts `<link>` tags in the live `<head>`. A `displayHtml` state (separate from the underlying `html`) controls `srcDoc` — it only updates for non-tools changes (chat responses, page switches), so tools changes never trigger an iframe navigation. The source HTML (`pages`) is still updated and persisted on every tools change for export and refresh correctness.

### Color themes

All color themes are **derived from the design's brand color** at runtime (no hardcoded palettes):

| ID | Label | Character |
|----|-------|-----------|
| `default` | Original | Restores the snapshot's original colors |
| `rich` | Rich | Deep, jewel-toned dark surfaces (bg ~7% lightness) with high contrast; primary auto-lightened for readability on dark |
| `vivid` | Vivid | Crisp white base, primary saturation boosted ~1.2×, near-black text — punchy and clean |
| `monochrome` | Mono | Light tonal scale built from the brand hue; low-saturation surfaces, brand color preserved |

Each theme's `build(currentTokens, snapshot)` function takes the current `--color-primary`, converts to HSL, and derives a full palette.

### Font pairings

Eight non-original pairings, each using distinct Google Fonts with no shared typefaces. Labels include font names in parentheses (e.g. "Bold (Bebas Neue, Roboto)"). The "Original" label dynamically shows the design's snapshot fonts.

When "Original" is selected, the stored `__googleFonts` query is used to restore the correct Google Fonts `<link>` tag. A fallback derives the query from the snapshot's `--font-heading` / `--font-body` font names for older projects that lack `__googleFonts`.

### Sizing & spacing

- **Font sizing** uses snapshot-relative multipliers (Small: 0.85×, Default: restore snapshot, Large: 1.25×) via `buildSizingTokens()` — no hardcoded px values. This ensures "Default" always returns to the design's original sizes regardless of what they were.
- **Spacing** also uses snapshot-relative multipliers (Compact: 0.6×, Comfortable: 1.0×, Roomy: 1.5×) via `buildSpacingTokens()`.

This is why the system prompt is so strict about "no hardcoded brand colors / fonts / major spacing outside `:root`" — anything hardcoded is locked and the Tools menu can't swap it.

---

## Crawler / intake

`POST /api/crawl { url }` runs `backend/crawler.js`. Cheerio extracts title, meta description, text (8K chars max), headings, image URLs, nav links, and inline color hints (looks for `color:` / `background:` literals). The result becomes `project.crawledData` and is injected into the cached system block as `--- INTAKE DATA (crawled from {url}) ---`. The model uses it for real business copy, service lists, hours, etc.

---

## Export / import

**Export** (`routes/export.js`): runs `EXPORT_SYSTEM_PROMPT` against the final HTML + chat history to produce `brief.md`, `tokens.json`, `design-session.md`; zips those plus all `pages.json` files and `uploads/`. Saved to `exports/{timestamp}/`. The `/api/export/{slug}/download/{timestamp}` endpoint serves the zip.

**Import** (`routes/import.js`): accepts a zip via multipart form, creates a fresh project, populates `pages.json` from `.html` files in the zip and seeds session messages from the markdown artifacts.

---

## Per-turn flow

For reference, here's what happens on a chat send:

1. User types in `ChatPanel`. Attachments encoded into structured `messages` content blocks (text + image/file references).
2. `streamChat` POSTs to `/api/chat`. Backend builds split system blocks, opens an Anthropic stream.
3. Frontend renders deltas live; HTML/EDIT markers are detected via `generationStartIndex` and the streaming view shows a "Generating design" spinner past that point.
4. On `done`: parse PATCH blocks first (`parsePatchBlocks`), then FILE blocks (`parseFileBlocks`). Apply patches to `pages`, merge any complete FILE blocks. Reject incomplete files. Surface system messages for any failures or truncation.
5. Persist updated `pages` + appended messages + `modelHistory` entry via `PUT /api/projects/{slug}`. Storage writes a history snapshot.

---

## Diagnosing regressions

Walk `projects/{slug}/history/` chronologically. Each snapshot is a full `pages.json` + last user/assistant message. Compare consecutive snapshots' file lengths or grep for the structural element you care about (e.g. `<header`) — the turn where it disappears is the offending one. The corresponding `session.json` entry tells you the prompt that caused it.
