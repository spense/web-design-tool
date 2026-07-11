# Cinder Labs

Local-only AI design tool for generating and iterating on small-business website designs (lead-gen sites for local trades). Built around Claude with prompt caching, design tokens, and a two-mode generate/edit protocol.

## Setup

1. `cp .env.example .env` and add `ANTHROPIC_API_KEY` (https://console.anthropic.com/settings/keys) and optionally `PIXABAY_API_KEY` (https://pixabay.com/api/docs/ — free)
2. `npm run install:all`
3. `npm start` — runs backend (Express, port 3001) and frontend (Vite, port 5173) concurrently

Open http://localhost:5173. Projects are saved under `/projects/` (gitignored).

To write your first design prompt in the chat UI, start from [`DESIGN_PROMPT_TEMPLATE.MD`](DESIGN_PROMPT_TEMPLATE.MD) — a fill-in brief covering business intake, IA, layout archetype, visual tone, copy voice, and imagery strategy. Fill in the sections that apply and paste it into the chat for a new project.

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
  - `ProjectView.jsx` — wires together ChatPanel + PreviewPanel for one project. Owns `inlineScope` state (used to route the inline-edit Prompt action into the chat input) and `codePanelSession` state (the panel-swap machinery: when non-null, the left slot renders `CodePanel` instead of `ChatPanel`).
  - `ChatPanel.jsx` — chat input, model picker, streaming display, attachment handling, response parsing, persistence. **This is where most of the response handling lives.** Also renders the inline-edit scope pill, applies returned INLINE blocks, shows chips on user messages that were scoped, and hosts the `<>` (page/site HEAD+FOOTER) and `{}` (global CSS) icons in the scope bar.
  - `CodePanel.jsx` — swappable code editor that replaces `ChatPanel` in the left slot. CodeMirror 6-based with `oneDark` syntax highlighting, line numbers, bracket matching. Cancel/Save header, per-tab language routing, inline validation error strip. Cmd/Ctrl+S saves. Panel width transitions from 480→720 via a `.project-panel-slot.is-code` class flip on the shared slot wrapper.
  - `PreviewPanel.jsx` — iframe preview at mobile/tablet/desktop widths, page dropdown, Tools button, export, and the inline-edit Select toggle. Owns the hover-`+` insert overlay + runtime code-slot injection (page/global HEAD/FOOTER, global CSS).
  - `SelectionToolbar.jsx` — floating toolbar that anchors to the selected element. Breadcrumb climb, ambient CSS-spec readout, and the filtered action buttons (Replace / Edit text / Rewrite / Prompt / Edit Code / Insert above / Insert below / Remove).
  - `SelectionPanel.jsx` — lower-right floating drawer that dispatches to one of the action sub-panels.
  - `inlinePanels/` — one component per drawer action: `EditTextPanel`, `RewriteTextPanel`, `ReplaceVisualPanel` (Pixabay + upload for image/bg; prompt + upload + paste for SVG).
  - `ToolsMenu.jsx` — applies theme presets by rewriting `:root` tokens across all pages without re-running the model.
  - `TabBar.jsx`, `NewTabView.jsx`, `ExportModal.jsx`, `Spinner.jsx` — UI primitives.
- `codeValidate.js` — lenient validators for HTML/CSS/JS. Custom tokenizer + balance check for HTML (catches unclosed and mismatched tags including typo'd closes; auto-close-same rules for `<li>`/`<p>`/`<tr>`; recurses into embedded `<style>`/`<script>` blocks). `CSSStyleSheet.replaceSync` + `CSS.supports()` per declaration for CSS (catches structural syntax errors AND typo'd property names). `new Function` for JS. Custom elements, `data-*`, and vendor prefixes are accepted.
- `inlineEdit/`
  - `selectionUtils.js` — selector-path resolve (nth-child indices from `<body>`), element classifier, identity fingerprint. Plus **`getFlowRoot`** / **`getStructuralChildren`** / **`isStructuralTopLevel`** for the section-insert affordances (future-proofs against `<main>` wrapper containers; filters hidden mobile-menu inputs).
  - `useInlineSelection.js` — hook that owns all selection state (mode, path, fingerprint, chain, rect), the iframe overlay install + listeners (mousemove/click/scroll), the deselect handlers (Esc, click-outside, mode-off), and the cursor-mode class. Extracted from `PreviewPanel` for readability — behavior is identical.
  - `commit.js` — shared "parse source HTML → resolve path → run mutator → re-serialize" pipeline used by every commit path (Remove, Edit text, Rewrite, Replace visual, Edit Code, and section insert).
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

                     Custom code fields (all optional strings — omit or ""
                     when unset):
                       globalHead       injected into <head> on every page
                       globalBodyEnd    injected before </body> on every page
                       globalCss        wrapped in <style> and appended last
                                        in <head> so it wins the cascade
                       pageCode         { [pageName]: { head, bodyEnd } } —
                                        per-page HEAD / FOOTER additions

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
- **Information architecture (IA) — required first step** — before generating HTML, the model must make and state two decisions in its prose commentary: (1) single-page or multi-page, and (2) the section/page plan. The model is instructed to improve on the existing site's structure — merge thin pages, split overloaded ones, cut filler, add what's missing. The existing site's nav and page count are a starting point, not a constraint. **Exception**: the improve-by-default behavior yields when the user explicitly asks to preserve/mirror the source IA or supplies a specific page/section list to follow.
- **Layout archetypes** — every design must follow a structural archetype that drives layout decisions. Seven archetypes are defined: `classic-stack`, `editorial`, `split-screen-dual`, `fullwidth-media-bands`, `modular-blocks`, `data-forward-stats`, `asymmetric-overlap`. Selection priority: (1) explicit in user prompt, (2) inferred from prompt context, (3) randomly assigned by the backend. Four blend pairs are also defined. On first generation, if no archetype is detected in the user prompt, `chat.js` injects a random one into the dynamic system context (see "Random archetype injection" below).
- **Design tokens contract** — required `:root` CSS variables for colors, typography, spacing, border-radius, shadows. **Every brand/theme color must reference `var(--color-…)`, not a literal.** Major spacing, body/heading font-size, border-radius, and font-family are also thematic. The contract exists so the Tools menu can swap themes by rewriting `:root` without re-running the model.
- **Section backgrounds must use vars** — hero sections, CTA bands, footers, nav bars — no hardcoded hex/rgb for backgrounds. Dark sections on a light design must define dedicated tokens (e.g. `--color-surface-inverse`, `--color-text-inverse`) in `:root`. Without this, theme switching leaves hardcoded backgrounds unchanged while text color swaps, causing illegible combinations.
- **Mobile responsiveness** — mobile-first CSS, breakpoints at 390/768/1024+, fluid images, 44px touch targets.
- **Header/content alignment** — when the header uses the same `max-width` as content sections, horizontal padding must not misalign it. Either drop padding above the max-width breakpoint, or include it in the max-width calc.
- **Image sourcing** — Pixabay images replace `placehold.co` as the default. Before generation, Haiku extracts search terms from crawled data or the user prompt, Pixabay is searched, and ~25 images are downloaded to `uploads/` with a `pb-` prefix. The image pool is injected into the prompt context. After generation, unused `pb-*` files are cleaned up. Falls back to `placehold.co` when no Pixabay key is configured, the search fails, or the user explicitly requests placeholders. When the user requests uploads-only (e.g. "use only my attached images", "no stock photos"), the Pixabay pool is ignored entirely even if one was provided. Images can be used as inline `<img>` or CSS `background-image`.
- **Visual rules** — inline CSS in `<style>` in `<head>`, no external deps except Google Fonts, real business copy (no lorem), inline single-color SVG icons (no emojis).
- **Copy voice** — honors explicit direction on voice/tone, reading level, POV, CTA verbs, locale, and banned/required words, applied consistently across all pages; defaults to plainspoken second-person copy in the business's locale otherwise.
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
  - **Edit Code** — universal. Opens `CodePanel` with the element's `outerHTML` prefilled; save replaces the element (through `commitInlineEdit`) with the new markup (supports multi-root paste; empty save deletes the element). Full validation on save.
  - **Insert above / Insert below** — appears only when the selection is a direct child of the flow root (see the section-insert section below). Opens `CodePanel` with a `<section>…</section>` placeholder; save inserts as a new sibling. The workaround for the fixed-header case where hovering above the header isn't possible.
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

- **AI-driven CSS rule edits are not possible inline.** The model only sees the element's outerHTML, not the page stylesheet. For AI-generated visual changes it falls back to inline `style="…"` overrides. For direct rule edits, use **Edit Code** on the containing `<section>` (edits inline `<style>` blocks alongside the markup) or the **Global CSS `{}`** icon (applies to every page and wins the cascade).
- **`background-image` from `::before`/`::after` pseudo-elements** can't be replaced via the Replace visual action — inline style on the element doesn't reach pseudo-element CSS. Global CSS or Edit Code on the parent section can override them.
- **Background-image replacement** writes `style="background-image: url(...) !important"` to win the cascade even against class rules using `!important`. The override is unquoted (`url(uploads/foo.jpg)`) so HTML serialization doesn't entity-encode the quotes and break the downstream `rewriteUploadsUrls` pass.
- **Pixabay-downloaded images** for inline replacements persist in `uploads/` until the next chat turn runs `cleanupUnusedImages` — consistent with chat-driven image swaps. Once cleaned, the previous image's history snapshot still references a missing file.

---

## Custom code

Beyond chat-driven edits, the tool has a code-editor path for direct authoring: per-element `outerHTML` edits, section inserts (with an HTML/CSS/JS placeholder scope), per-page HEAD/FOOTER injections, All-Pages HEAD/FOOTER, and a Global CSS field. All of it goes through a shared `CodePanel` component built on CodeMirror 6.

### Panel swap

The left slot in `ProjectView` (`.project-panel-slot`) hosts either `ChatPanel` or `CodePanel` depending on `codePanelSession` state. The wrapping slot owns the width — 480px for chat, 720px for code (a `.is-code` class flip with a 220ms `max-width` transition). Any component in the tree can request the panel via the `onOpenCodePanel(session)` prop:

```js
onOpenCodePanel({
  key: 'unique-key',                    // React key; different keys remount CodePanel
  title: 'Edit <section>',
  tabs: [
    { id: 'html', label: 'HTML', lang: 'html', value: '', placeholder: '…' },
    { id: 'css',  label: 'CSS',  lang: 'css',  value: '' },
    // any of html / css / js
  ],
  initialTabId: 'html',                 // optional; defaults to first tab
  onSave: (valuesById) => { /* patch storage */ },
  onCancel: () => {},
});
```

`CodePanel` validates every tab via `codeValidate.js` before firing `onSave`. First failure focuses that tab and surfaces the error in a red strip below the editor. Cmd/Ctrl+S saves; Esc cancels.

### Validation

`codeValidate.js` exposes `validateHtml`, `validateCss`, `validateJs`, and `validateByLang(lang, input)`. Design goals: catch typos and syntax errors, don't enforce standards-mode rules; custom elements, `data-*` attrs, and vendor prefixes always pass.

- **HTML** — custom tokenizer that walks the source char-by-char and tracks tag balance. Catches unclosed and mismatched close tags (which `htmlparser2` and `DOMParser` silently auto-correct). Handles comments, doctype, CDATA, quoted attrs (`title="a>b"`), raw-text elements (`<script>`/`<style>`), void tags, and HTML5 auto-close-same rules for `<li>`/`<p>`/`<tr>`/etc. After the balance check, recurses into embedded `<style>` and `<script>` blocks and routes their contents through `validateCss`/`validateJs`.
- **CSS** — `CSSStyleSheet.replaceSync` for structural syntax errors, then `CSS.supports(prop, 'initial')` per declaration for typo'd property names (which browsers silently drop for forward-compat, hiding the typo from the structural parser). Skips vendor prefixes and `--custom-props`.
- **JS** — `new Function(src)` catches syntax errors with line/column info. Runtime errors are out of scope.

### Global code fields (`<>` and `{}` icons)

The chat panel's scope bar surfaces two icons:

- **`<>` — page/site HEAD & FOOTER.** Opens `CodePanel` with two tabs (HEAD, FOOTER). Scope-aware: when the active chat scope is `__site` ("All Pages"), edits target `project.globalHead` / `project.globalBodyEnd`. When the scope is a page, they target `project.pageCode[page].head` / `.bodyEnd`. Per-page and All-Pages code stack in the preview — both apply to a page when both are set.
- **`{}` — global CSS.** Opens `CodePanel` with a single CSS tab targeting `project.globalCss`. Ignores the active scope.

Persistence uses `handleProjectPatch` in `ProjectView` with `skipHistory: true` — adding a tracking beacon or CSS override isn't a design change worth undo/redo'ing pages around.

### Runtime injection order

`PreviewPanel` injects the code fields into the live iframe via runtime `data-slot` markers — no iframe reload on edit. `applyCodeSlots` removes any existing slot elements first, then re-inserts in list order. `<script>` tags are re-created via `createElement` (not left as inert template output) so they execute.

Order:

- **Head** (top to bottom of `<head>`):
  1. `global-head` — All-Pages HEAD
  2. `page-head` — per-page HEAD
  3. `global-css` — wrapped in `<style>`, always last so it wins the CSS cascade

- **Body end** (before `</body>`):
  1. `global-body-end` — All-Pages FOOTER
  2. `page-body-end` — per-page FOOTER

Rationale: global scripts (analytics, chat widgets) load first so per-page scripts can rely on them. `globalCss` last so any inline `<style>` the page carries is overridden by the user's Global CSS.

### Section insert

Two entry points, one commit path (`openInsertPanel` in `PreviewPanel`):

- **Hover-`+` overlay** — Only visible in Select Mode. Tracks mouse position inside the iframe; when within 24px of any gap between structural top-level items (or above the first, or below the last), renders a hairline + circular `+` overlay in the parent viewport. Click opens `CodePanel` with a `<section>…</section>` placeholder.
- **Insert above / Insert below toolbar actions** — Appear on the SelectionToolbar when the selection is a direct child of the flow root (`isStructuralTopLevel`). Same `CodePanel` path with the same placeholder. Covers the fixed-header edge case where hovering above the header isn't possible.

Both routes pass a **DOM index** (not a structural index) to the mutator so the position is correct even when the flow root has non-structural children (hidden `<input type="checkbox">` mobile menu toggles, decorative helpers). The mutator uses `<template>.innerHTML` to parse the pasted markup and then `insertBefore` / `appendChild` to place it inside the flow root — supports multi-root paste and section-scoped `<style>` / `<script>` blocks.

**Scoped styles/scripts.** The insert editor is deliberately open. Whatever you paste is inserted verbatim, so you can put a `<style>` or `<script>` block inside the section markup — they'll live and die with the section. IIFE-wrap `<script>` contents to keep variables from leaking to other sections.

### Flow root

The flow root is the element whose direct children are the page's top-level structural items (`<header>`, `<section>`, `<footer>`, etc.). It's what `getStructuralChildren`, `isStructuralTopLevel`, and the section-insert commit path all operate on.

Detection (`getFlowRoot`):
1. If `<body>` has exactly one direct structural `<main>` child, the flow root is that `<main>`.
2. Otherwise the flow root is `<body>`.

`isStructuralChild` filters out non-rendered tags (`<script>`, `<style>`, `<template>`, `<link>`, etc.), elements with the `hidden` attribute, `<input type="hidden">`, and elements with `display:none` / `visibility:hidden` / `opacity:0` / zero-size rect. Fixed-position `<header>` still counts — position doesn't disqualify.

Future-proofs against designs that adopt `<main>` wrappers or add hidden helpers (mobile-menu checkboxes are already common), without hardcoding either shape.

---

## Design engine handoff

The sibling **Web Design Engine** (`/Users/spenserlea/Sites/web-design-engine`) consumes exports from this tool and produces Astro builds. When a project has any custom code set, the export path writes a sidecar `siteCode.json` next to the HTML/CSS/assets, and the engine reads it directly rather than trying to regex-scrape code out of page bodies.

### Sidecar: `siteCode.json`

Owned jointly by this tool and the design engine. Schema (all fields optional; the file is only written when at least one field is set):

```json
{
  "globalCss": "…",
  "globalHead": "<link ...>\n<meta ...>",
  "globalBodyEnd": "<script ...></script>",
  "pages": {
    "index":    { "head": "…", "bodyEnd": "…" },
    "about-us": { "head": "…" }
  }
}
```

**Page slugs strip the `.html` suffix** so they map cleanly to Astro routes (`index.html` → `index`, `about-us.html` → `about-us`).

Built by `buildSiteCodeManifest` in `backend/routes/export.js`. Empty strings and empty per-page objects are dropped.

### What the engine needs to do

- **Global HEAD / FOOTER** — inject into the shared Astro layout so every page carries them.
- **Global CSS** — inject as the final `<style>` in `<head>` (matches the preview's cascade order — it must win over any page-level styles).
- **Per-page HEAD / FOOTER** — inject into the matching route's page component. When both global and per-page code are set, **global loads first** (scripts benefit from that order; per-page code can depend on globals being ready).

### Rewriter contract

The chat-driven code rewriter must **not** touch the sidecar fields during AI regenerations. They're user-authored and not model-visible. The model can generate a section that contains a scoped `<style>` or `<script>` — that's fine; it lives inside `pages.json` and flows through the normal export path.

Section-scoped `<style>` and `<script>` blocks inside `pages.json` need no special engine handling: Astro renders them as-is inside the section. If the engine strips or hoists inline scripts as part of its build, it must preserve those inside sections.

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
