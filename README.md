# Cinder Labs

Local-only AI design tool for generating and iterating on small-business website designs (lead-gen sites for local trades). Built around Claude with prompt caching, design tokens, and a two-mode generate/edit protocol.

## Setup

1. `cp .env.example .env` and add `ANTHROPIC_API_KEY` (https://console.anthropic.com/settings/keys) and optionally `PIXABAY_API_KEY` (https://pixabay.com/api/docs/ — free)
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
- `anthropic.js` — Claude SDK client, `MODELS` map, `SYSTEM_PROMPT`, `MULTI_PAGE_WORKFLOW`, `INLINE_MODE` (system prompt extension for scoped single-element edits).
- `storage.js` — filesystem CRUD for projects (read/write/list/rename/delete).
- `crawler.js` — fetches a competitor URL with cheerio, extracts title/meta/headings/links/colors as intake data.
- `parseFiles.js` — server-side parser for `<!-- FILE: -->` blocks (mirrored on frontend).
- `parsePatch.js` — server-side mirrors of frontend patch helpers: `parsePatchBlocks`/`applyPatches`, `parseRegionBlocks`/`applyRegions`, **`parseInlineBlocks`/`applyInlineBlocks`** (uses cheerio for DOM-level inline edits). Kept in sync with the frontend so the orchestrator can detect failures and trigger recovery.
- `pixabay.js` — Pixabay API client: search, download, term extraction (via Haiku), pool building, and cleanup of unused images.
- `routes/`:
  - `projects.js` — CRUD: list, get, create, rename, delete, save.
  - `chat.js` — streaming SSE endpoint (the main one). Pre-generation Pixabay image search and post-generation cleanup integrated here.
  - `crawl.js` — POST a URL, returns structured intake data.
  - `export.js` — extracts CSS into external stylesheets, copies assets/favicons, writes the export bundle to disk. Cleans up unused Pixabay images before copying. No API call — purely local.
  - `import.js` — accepts a zip, creates a project from it (backend kept as reference; UI removed).
  - `uploads.js` — image upload + serve (sanitized filenames, suffix collision avoidance). Also used by the inline-edit Replace visual upload flow.
  - `pixabay.js` — proxy routes for Pixabay search and download (keeps API key server-side).
  - `inline.js` — backend routes for the inline-edit toolbar's standalone actions:
    - `POST /api/inline/rewrite-text` — Haiku-driven plain-text rewrite for a snippet.
    - `POST /api/inline/generate-svg` — Sonnet 4.6 SVG generation for the Replace SVG flow; output is constrained to a single `<svg>` element with strict style conventions.
    - `GET /api/inline/pixabay-search?q=` — live Pixabay search for the Replace BG/IMG drawer.
    - `POST /api/inline/download-pixabay` — downloads a chosen Pixabay hit into the project's `uploads/` dir using the `pb-` prefix convention.
  - `appState.js` — persists open tabs / active tab in `app-state.json`.

### Frontend

- `App.jsx` — root, tab/project state, project list, project routing.
- `api.js` — fetch wrappers + `streamChat` (SSE reader). Returns `{ text, usage, stopReason }`.
- `parseFiles.js` — extracts `<!-- FILE: name.html -->` blocks. Splits trailing prose off file content at `</html>` so commentary after a file doesn't contaminate the saved HTML. Also exports `isCompleteHtmlDoc()` (requires `<body` and ends with `</html>`).
- `parsePatch.js` — extracts `<!-- EDIT: name -->` SEARCH/REPLACE blocks (`applyPatches`), `<!-- REGION: -->` blocks (`applyRegions`), and `<!-- INLINE: <path> in <page> -->` blocks (`applyInlineBlocks` — DOM-level swap via `DOMParser` and nth-child selector path).
- `tokenRewriter.js` — parses and rewrites `:root { --token: value }` blocks across all pages.
- `themePresets.js` — color / font / sizing / spacing / radius preset definitions.
- `colorUtils.js` — hex/HSL math for theme generation.
- `components/`
  - `ProjectView.jsx` — wires together ChatPanel + PreviewPanel for one project. Owns `inlineScope` state (used to route the inline-edit Prompt action into the chat input).
  - `ChatPanel.jsx` — chat input, model picker, streaming display, attachment handling, response parsing, persistence. **This is where most of the response handling lives.** Also renders the inline-edit scope pill, applies returned INLINE blocks, and shows chips on user messages that were scoped.
  - `PreviewPanel.jsx` — iframe preview at mobile/tablet/desktop widths, page dropdown, Tools button, export, and the inline-edit Select toggle. Owns all selection state and overlays.
  - `SelectionToolbar.jsx` — floating toolbar that anchors to the selected element. Breadcrumb climb, ambient CSS-spec readout, and the filtered action buttons (Replace / Edit text / Rewrite / Prompt / Remove).
  - `SelectionPanel.jsx` — lower-right floating drawer that dispatches to one of the action sub-panels.
  - `inlinePanels/` — one component per drawer action: `EditTextPanel`, `RewriteTextPanel`, `ReplaceVisualPanel` (Pixabay + upload for image/bg; prompt + upload + paste for SVG).
  - `ToolsMenu.jsx` — applies theme presets by rewriting `:root` tokens across all pages without re-running the model.
  - `TabBar.jsx`, `NewTabView.jsx`, `ExportModal.jsx`, `Spinner.jsx` — UI primitives.
- `inlineEdit/`
  - `selectionUtils.js` — selector-path resolve (nth-child indices from `<body>`), element classifier, identity fingerprint (used to detect when an external edit invalidates the saved selection).
  - `commit.js` — shared "parse source HTML → resolve path → run mutator → re-serialize" pipeline used by all standalone inline actions (Remove, Edit text, Rewrite, Replace visual).
  - `svgSanitize.js` — parses SVG markup, validates single `<svg>` root, strips `<script>`, `<foreignObject>`, on-handlers, `javascript:` URLs.
  - `htmlSanitize.js` — same idea for arbitrary HTML fragments returned by the prompt-change action (single root, tag-match, strip scripts/iframes/on-handlers).
  - `icons.jsx` — single-color SVG icons for the toolbar.
  - `specs.js` — computed-style readout for the toolbar (font/size/weight/color, w×h, padding, margin, background, border, radius).

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
uploads/             user-attached images + Pixabay images (pb-* prefix)
exports/             {timestamp}/ folders, each containing the export bundle + zip
```

Every call to `saveProject` snapshots `pages.json` + last message into `history/`. **This is invaluable for diagnosing regressions** — you can walk forward through history snapshots to find exactly which turn broke something. (That's how we found the truncated-`contact.html` bug.)

---

## Anthropic integration

### Models (`backend/anthropic.js:14`)

```
opus   → claude-opus-4-7
opus46 → claude-opus-4-6
sonnet → claude-sonnet-4-6
haiku  → claude-haiku-4-5
```

Default in UI is sonnet; user can switch per turn. `project.lastModel` is persisted.

### System prompt structure (`backend/anthropic.js:20`)

The `SYSTEM_PROMPT` covers:

- **Output mode selection**: FULL FILE vs PATCH vs REGION (see below).
- **Information architecture (IA) — required first step** — before generating HTML, the model must make and state two decisions in its prose commentary: (1) single-page or multi-page, and (2) the section/page plan. The model is instructed to improve on the existing site's structure — merge thin pages, split overloaded ones, cut filler, add what's missing. The existing site's nav and page count are a starting point, not a constraint.
- **Layout archetypes** — every design must follow a structural archetype that drives layout decisions. Seven archetypes are defined: `classic-stack`, `editorial`, `split-screen-dual`, `fullwidth-media-bands`, `modular-blocks`, `data-forward-stats`, `asymmetric-overlap`. Selection priority: (1) explicit in user prompt, (2) inferred from prompt context, (3) randomly assigned by the backend. Four blend pairs are also defined. On first generation, if no archetype is detected in the user prompt, `chat.js` injects a random one into the dynamic system context (see "Random archetype injection" below).
- **Design tokens contract** — required `:root` CSS variables for colors, typography, spacing, border-radius, shadows. **Every brand/theme color must reference `var(--color-…)`, not a literal.** Major spacing, body/heading font-size, border-radius, and font-family are also thematic. The contract exists so the Tools menu can swap themes by rewriting `:root` without re-running the model.
- **Section backgrounds must use vars** — hero sections, CTA bands, footers, nav bars — no hardcoded hex/rgb for backgrounds. Dark sections on a light design must define dedicated tokens (e.g. `--color-surface-inverse`, `--color-text-inverse`) in `:root`. Without this, theme switching leaves hardcoded backgrounds unchanged while text color swaps, causing illegible combinations.
- **Mobile responsiveness** — mobile-first CSS, breakpoints at 390/768/1024+, fluid images, 44px touch targets.
- **Header/content alignment** — when the header uses the same `max-width` as content sections, horizontal padding must not misalign it. Either drop padding above the max-width breakpoint, or include it in the max-width calc.
- **Image sourcing** — Pixabay images replace `placehold.co` as the default. Before generation, Haiku extracts search terms from crawled data or the user prompt, Pixabay is searched, and ~25 images are downloaded to `uploads/` with a `pb-` prefix. The image pool is injected into the prompt context. After generation, unused `pb-*` files are cleaned up. Falls back to `placehold.co` when no Pixabay key is configured, the search fails, or the user explicitly requests placeholders. Images can be used as inline `<img>` or CSS `background-image`.
- **Visual rules** — inline CSS in `<style>` in `<head>`, no external deps except Google Fonts, real business copy (no lorem), inline single-color SVG icons (no emojis).
- **Section–nav linkage** — for single-page designs, every `<section>` must have an `id` and the nav must link to it. No orphan sections or dead nav links.
- **Multi-page rules** — every linked page must be a complete document with the same nav/header/footer markup and same `:root` tokens; page-appropriate body content.
- **Nav styles** — Style A: in-page anchors (`#services`) for single-page; Style B: bare filenames (`about.html`) for multi-page; Style C: hybrid when the user describes a mix.
- **Nav trigger / hamburger rules** — checkbox+label pattern (no JS), one of three patterns (standard responsive, always-trigger drawer, hybrid), trigger lives in header layout, opened menu renders as its own positioned surface.
- **Anti-meta rules** — no design-rationale comments in HTML, no "Designed by X" attribution, no "Style Guide" sections.

### Chat request flow (`backend/routes/chat.js`)

```
POST /api/chat  (SSE)
body: { model, messages, context: { slug, crawledData, activePage, currentPages } }
```

The system prompt is split into **two blocks** to maximize prompt caching:

1. **Cached** (`cache_control: ephemeral`): `SYSTEM_PROMPT` + `MULTI_PAGE_WORKFLOW` (first gen only) + crawled intake data. Stable for the life of a project.
2. **Uncached (dynamic)**: Pixabay image pool (when available) + random archetype injection (first gen only, see below) + active-page hint + every current file's full contents. Changes every turn.

**Random archetype injection**: on first generation, `chat.js` checks whether the user's message contains a recognized archetype slug. If not, it calls `pickRandomArchetype()` (exported from `anthropic.js`) to select a random archetype (with ~25% chance of a blend pair) and injects it into the dynamic system block. This gives the model a concrete structural starting point instead of defaulting to the same pattern. The injection also reminds the model to state its IA decisions and archetype choice in commentary. The selected archetype is logged: `[chat] injected random archetype: X`.

The model sees the full current state of every file under `<!-- CURRENT FILE: name -->` headers — that's what enables byte-exact PATCH SEARCH matching.

The endpoint streams Anthropic SSE deltas back to the client and emits a final `done` event with `{ text, stopReason, usage }`. `max_tokens: 64000`. Every completed turn logs `[chat] model=… stop=… in=… out=… cache_write=… cache_read=…` — `stop=max_tokens` is the truncation signal.

---

## Generation & edit protocol

The model picks one of three output modes per response (FULL FILE, PATCH, INLINE).

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

### INLINE mode

```
<!-- INLINE: 1.2.0 in index.html -->
<section class="hero" id="home">...</section>
```

Used **only** when the chat request carries an `inlineScope` (the user clicked the Prompt action in the inline-edit toolbar). The header carries a dot-joined nth-child selector path from `<body>` and the target filename. The body is exactly one replacement element with the same root tag as the original.

Mutually exclusive with FILE/PATCH/REGION for that turn — the system prompt enforces this and PATCH-mode auto-recovery is skipped for inline-scoped turns. Parsed by `parseInlineBlocks` and applied by `applyInlineBlocks` (DOM-level swap; either the path + tag resolve or the apply fails loudly with a system message).

---

## Truncation safety net

The original symptom: a multi-page restyle hit `max_tokens` mid-output, the FULL FILE for `contact.html` got cut off in CSS (no `<body>`, no `</html>`), and the partial file silently overwrote the previously-good one. Nav links still pointed at `contact.html`, but the file rendered blank.

Three layers prevent recurrence:

1. **`max_tokens: 64000`** in `backend/routes/chat.js`. Comfortably fits a multi-page restyle.
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

## Inline-edit toolbar

A click-to-edit overlay on the design preview. Lets the user point at any element in the iframe and run targeted actions on it without round-tripping through chat for every small change.

### UX

1. Toggle **Select** in the preview toolbar to enter selection mode.
2. Hover over the design — elements highlight under the cursor (dashed outline).
3. Click an element to select it (solid outline, floating toolbar appears).
4. **Option-click** (Alt+click) digs through z-stacked layers — repeat at the same spot to cycle deeper. Necessary for reaching elements under gradient overlays or behind `pointer-events:none` decorative siblings.
5. While Select mode is on, `pointer-events: auto !important` is forced on every element in the iframe so previously-unreachable overlays/backgrounds can be selected.

### Toolbar anatomy

- **Breadcrumb** — `tag` or `tag#id` chips from outermost ancestor down to the clicked element. Click any chip to climb the chain. Capped at 4 visible with a leading `…` ellipsis when deeper.
- **CSS specs readout** — vertical CSS-like display of computed styles (font family/size/weight/color, w×h, padding, margin, background, border, radius). Font block hides when the element has no own text content.
- **Action buttons** — filtered by element type:
  - **Replace** (img / bg-image / svg) — opens the Replace visual drawer. Label adapts: "Replace IMG", "Replace BG", "Replace SVG".
  - **Edit text** (text-leaf elements only) — manual textarea, replaces `textContent`.
  - **Rewrite** (text-leaf elements only) — AI-powered, Haiku 4.5, plain text only.
  - **Prompt** — universal, hidden for SVG (Replace SVG already has a prompt). Routes through the main chat panel.
  - **Remove** — universal. Native `confirm()` before commit.

A "text-leaf" element is one whose own textContent is non-empty AND whose children (if any) are all inline-formatting tags (`<span>`, `<strong>`, `<em>`, `<a>`, etc.). This catches `<div>One-line label</div>` while excluding block containers like `<section>` or `<div class="card">…blocks…</div>`.

### How edits commit

Every standalone action (Remove, Edit text, Rewrite, Replace visual) flows through `inlineEdit/commit.js`:

1. Parse the **saved source HTML** for the active page (not the live iframe DOM — that contains runtime injections like our overlay divs and token-override inline styles).
2. Resolve the selector path (dot-joined nth-child indices from `<body>`).
3. Run a mutator function on the parsed target node.
4. Re-serialize and push through `onApplyTokens` — the same path chat edits use, so **undo/redo work for free** via the existing history snapshot system.

### Selection identity (fingerprinting)

When the user selects an element, a fingerprint is captured (tag, id, text prefix, child count). After any iframe re-render (chat edit, undo, redo, our own commit), the install effect:

1. Re-resolves the selector path against the new DOM.
2. Verifies the resolved element matches the fingerprint.
3. If it doesn't (e.g. chat removed the ancestor and the path now lands on a sibling) — selection clears cleanly instead of leaving the toolbar anchored to a wrong element.

This is critical because nth-child paths can accidentally resolve to a different element if siblings were removed above the selection — without the fingerprint check, the toolbar would silently re-anchor to the wrong place.

### Prompt action: chat integration

Unlike the other actions, **Prompt routes through the main chat panel** instead of opening a drawer. This is so the model inherits:

- Full crawl data (business name, services, tone) — solves the "model generates generic tech hero" problem.
- Active model selection (Sonnet / Opus / Haiku).
- Conversation history.
- Streaming, stop, job-recovery infrastructure.

Flow:

1. User clicks Prompt → `PreviewPanel` calls `onInlinePrompt({ path, page, tag, outerHTML, breadcrumb })`.
2. `ProjectView` stores `inlineScope` and (if collapsed) auto-expands the chat panel.
3. `ChatPanel` renders a pill above the textarea: "Prompting for: section > div > h2".
4. User types the instruction, hits Send. Scope is snapshotted, then immediately cleared from parent state — the pill goes away, the user message gets a chip showing the scope was applied.
5. `streamChat` sends `inlineScope` in the request body. Backend appends `INLINE_MODE` to the system prompt + a "INLINE EDIT SCOPE" dynamic context block.
6. Model returns prose + a single `<!-- INLINE: <path> in <page> -->` block with the replacement element.
7. `applyResult` parses the INLINE block (`parseInlineBlocks` + `applyInlineBlocks`) and applies it through normal save/persist.

### Safety / validation

- **HTML fragments from the model** (prompt-change, replace-visual SVG) run through `htmlSanitize.js` / `svgSanitize.js`: must parse cleanly, must have a single root, root tag must match the original. `<script>`, `<iframe>`, `<object>`, `<embed>`, `<foreignObject>`, `on*` attributes, and `javascript:` URLs are silently stripped.
- **INLINE block parsing** terminates only at our marker comments (`INLINE:`, `FILE:`, `EDIT:`, `REGION:`, `PAGES:`), never at arbitrary `<!-- … -->` — the element body itself may contain HTML comments (common inside SVGs).

### Known limitations (v1)

- **CSS rule edits are not possible inline.** The model only sees the element's outerHTML, not the page stylesheet. For visual changes it falls back to inline `style="…"` overrides — functional but accumulates style-attr cruft over many edits. For cross-cutting CSS changes, use the main chat.
- **`background-image` from `::before`/`::after` pseudo-elements** can't be replaced — inline style on the element doesn't reach pseudo-element CSS.
- **Background-image replacement** writes `style="background-image: url(...) !important"` to win the cascade even against class rules using `!important`. The override is unquoted (`url(uploads/foo.jpg)`) so HTML serialization doesn't entity-encode the quotes and break the downstream `rewriteUploadsUrls` pass.
- **Pixabay-downloaded images** for inline replacements persist in `uploads/` until the next chat turn runs `cleanupUnusedImages` — consistent with chat-driven image swaps. Once cleaned, the previous image's history snapshot still references a missing file.

---

## Pixabay image integration

Replaces `placehold.co` placeholders with real stock photos from Pixabay. Requires `PIXABAY_API_KEY` in `.env` (free at https://pixabay.com/api/docs/). Degrades gracefully when absent — falls back to `placehold.co`.

### How it works

1. **Pre-generation search** (`chat.js`): Before the first `runTurn()`, if `PIXABAY_API_KEY` is set:
   - A Haiku call extracts 5-8 search terms from crawled data and/or user prompt (~$0.001, ~1-2s)
   - Pixabay API is searched for each term (3-5 parallel requests)
   - Top ~25 unique images are downloaded to `projects/{slug}/uploads/` with a `pb-` prefix (e.g. `pb-bakery-interior-12345.jpg`)
   - The image pool (paths + descriptions) is injected into the dynamic system prompt block

2. **During generation**: The model picks contextually relevant images from the pool. Images can be used as inline `<img src="uploads/pb-...">` or CSS `background-image: url(uploads/pb-...)`.

3. **Post-generation cleanup** (`chat.js` + `pixabay.js:cleanupUnusedImages`): Scans all page HTML for `pb-*` filenames. Deletes any unreferenced `pb-*` files from `uploads/`.

4. **Export**: The existing `uploads/` → `assets/` pipeline handles Pixabay images automatically. A pre-export cleanup pass removes stale `pb-*` files.

### When search triggers

- **First generation**: Always searches (based on crawled data + user prompt)
- **Subsequent prompts with image keywords** (`image`, `photo`, `picture`, `background`, `gallery`, `hero`, etc.): Searches with new terms, merges with existing pool
- **Subsequent prompts without image keywords**: Injects existing `pb-*` pool into prompt (no API calls, no latency)
- **No Pixabay key**: Skipped entirely, model uses `placehold.co`

### Pixabay API constraints

- **No hotlinking**: Images must be downloaded and self-hosted (URLs expire after 24h)
- **No attribution required** on final sites
- **Rate limit**: 100 requests per 60 seconds
- **Media types**: Supports `photo` (default), `illustration`, and `video` via `options.type`

### Key files

- `backend/pixabay.js` — core module: `searchImages()`, `buildImagePool()`, `extractSearchTerms()`, `cleanupUnusedImages()`, `formatPoolForPrompt()`, `listExistingPool()`
- `backend/routes/pixabay.js` — API proxy routes (`GET /api/pixabay/search`, `POST /api/pixabay/download`), scaffolded for future image tooltip feature
- Integration points in `backend/routes/chat.js` (pre/post generation) and `backend/routes/export.js` (pre-export cleanup)

### Frontend support

- `PreviewPanel.jsx:rewriteUploadsUrls` handles both `src`/`href` attributes and CSS `url()` references for `uploads/` paths
- `ChatPanel.jsx` shows a "Preparing images…" indicator (same style as "Crawling…") when a Pixabay search is running
- `api.js:streamChat` handles the `preparingImages` SSE event from the backend

---

## Crawler / intake

`POST /api/crawl { url }` runs `backend/crawler.js`. Cheerio extracts title, meta description, text (8K chars max), headings, image URLs, nav links, and inline color hints (looks for `color:` / `background:` literals). The result becomes `project.crawledData` and is injected into the cached system block as `--- INTAKE DATA (crawled from {url}) ---`. The model uses it for real business copy, service lists, hours, etc.

---

## Export / import

**Export** (`routes/export.js`): cleans up unused Pixabay images, extracts inline CSS into external stylesheets, rewrites upload paths to `assets/`, injects critical animation CSS and favicon `<link>` tags, then writes the bundle to `exports/{timestamp}/`. No API call — purely local file operations.

**Import** (`routes/import.js`): accepts a zip via multipart form, creates a fresh project, populates `pages.json` from `.html` files in the zip. Backend route is kept as a reference; the UI import button has been removed (use clone instead).

---

## Per-turn flow

For reference, here's what happens on a chat send:

1. User types in `ChatPanel`. Attachments encoded into structured `messages` content blocks (text + image/file references). If the user clicked the inline-edit Prompt action, the chat input also carries an `inlineScope` describing the target element.
2. `streamChat` POSTs to `/api/chat` with `{ model, messages, context, inlineScope }`. Backend builds split system blocks: cached (`SYSTEM_PROMPT` + `MULTI_PAGE_WORKFLOW` for first gen + `INLINE_MODE` when scoped + crawled intake) and dynamic (image pool / archetype / current files / inline-scope details).
3. If Pixabay is configured and a search is needed (first gen or image keywords in prompt): extract search terms via Haiku, search Pixabay, download images to `uploads/`, inject pool into prompt. A `preparingImages` SSE event triggers the "Preparing images…" indicator in the UI.
4. Backend opens an Anthropic stream. Frontend renders a spinner during streaming (model prose commentary is hidden until the final message).
5. On `done`: parse REGION blocks, then INLINE blocks (`parseInlineBlocks`), then PATCH blocks (`parsePatchBlocks`), then FILE blocks (`parseFileBlocks`). INLINE blocks are stripped before the file/patch parsers run (their bodies may contain HTML the file parser would otherwise grab). Apply each in order; reject incomplete files; surface system messages for any failures or truncation.
6. Post-generation: cleanup unused `pb-*` images from `uploads/` (signal is "any code-changing block emitted" — FILE, EDIT, REGION, or INLINE).
7. Persist updated `pages` + appended messages + `modelHistory` entry via `PUT /api/projects/{slug}`. Storage writes a history snapshot.

Inline-edit standalone actions (Remove / Edit text / Rewrite / Replace visual) bypass step 2 — they mutate the saved source HTML directly via `inlineEdit/commit.js` and push through `onApplyTokens`, which lands in step 7 with the same history-snapshot guarantees.

---

## Diagnosing regressions

Walk `projects/{slug}/history/` chronologically. Each snapshot is a full `pages.json` + last user/assistant message. Compare consecutive snapshots' file lengths or grep for the structural element you care about (e.g. `<header`) — the turn where it disappears is the offending one. The corresponding `session.json` entry tells you the prompt that caused it.
