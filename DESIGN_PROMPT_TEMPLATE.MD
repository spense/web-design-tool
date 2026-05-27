# Design Prompt Template

Fill in this template for each new website project. Keep the placeholders that apply, delete the rest. Order matters — placing the data source and image strategy near the top primes the model before the design direction is interpreted.

- Sections in `{{…}}` are placeholders to replace.
- Sections wrapped in `[[ … ]]` are conditional branches — keep the branch that applies and delete the others.
- Sections marked *(optional)* can be omitted entirely if you don't have an opinion; the model will infer or default.

---

# {{Business Name}} — Design Brief

## 1. Business snapshot
- **Industry / trade:** {{e.g. residential HVAC, family-law firm, artisan bakery}}
- **Location & service area:** {{city, region, radius served}}
- **What they sell:** {{1–2 sentences on the actual offer}}
- **Target customer:** {{who's hiring/buying — homeowners, small businesses, etc.}}
- **Primary conversion goal:** {{phone call | quote form | online booking | newsletter | foot traffic}}
- **Differentiator / USP:** {{why pick them over the competitor down the street}}

## 2. Data source for intake (pick ONE branch)

[[ BRANCH A — Crawl an existing URL
- **Crawl URL:** {{https://current-site.example.com}}
- **Use the crawl for:** {{services list | hours | testimonials | team bios | all of it}}
- **Ignore from the crawl:** {{anything stale — e.g. "old pricing", "outdated team page"}}
]]

[[ BRANCH B — Attached files (no crawl)
Attach files directly to this chat — text documents (TXT, MD, PDF, DOCX) and/or images. The model will read whatever's attached and infer content from it.

- **What's attached** *(optional — only worth listing if placement matters)*:
  - `{{business-info.pdf}}` → {{primary content reference}}
  - `{{hero.jpg}}` → {{use as hero background}}
  - `{{owner-bio.md}}` → {{about section copy}}
- **Anything to emphasize from the attachments:** {{e.g. "the services list in the PDF is current — the website's is not"}}
- **Anything the attachments don't cover:** {{tell the model whether to invent plausible content, ask back, or skip the section}}

Don't pre-define an IA here — let it fall out of what's actually in the attachments plus §3 below.
]]

[[ BRANCH C — Hybrid (crawl + supplemental)
- **Crawl URL:** {{https://…}}
- **Override / add on top of the crawl:**
  - {{e.g. "New service launched: heat-pump installs"}}
  - {{e.g. "Replace old testimonials with the three in `testimonials.txt`"}}
- **Attached supplemental files** *(optional)*: {{filenames + what they cover}}
]]

## 3. Information architecture *(optional — model decides if blank)*
- **Structure:** {{single-page | multi-page | model's call}}
- **Pages or sections wanted:** {{Home, Services, About, Contact — or "model's call"}}
- **Must-have sections:** {{e.g. service-area map, FAQ, financing callout, license & insured badge}}
- **Sections to skip:** {{e.g. no blog, no testimonials section}}
- **Contact pattern:** {{full contact form | booking CTA only | phone-first hero | no form}}
- **Preserve the source IA?** {{no, improve it (default) | yes, mirror the crawled/attached structure exactly}}

## 4. Layout archetype *(optional — random if blank)*
Choose ONE, or write "model's pick" / "random" to let the system inject one. Optionally blend two with "+".

Options:
`classic-stack` · `editorial` · `split-screen-dual` · `fullwidth-media-bands` ·
`modular-blocks` · `data-forward-stats` · `asymmetric-overlap`

- **Archetype:** {{classic-stack | editorial | … | model's pick | random}}
- **Why** *(optional)*: {{1 line on what about the business calls for this}}

## 5. Visual tone
- **Mood (3–5 adjectives):** {{e.g. trustworthy, weathered, hand-made, warm}}
- **Color direction:** {{e.g. "deep forest green primary, cream surfaces, brick-red accent" — or "you choose, lean earthy"}}
- **Light / dark surface preference:** {{light | dark | mixed (dark hero + light body)}}
- **Typography feel:** {{e.g. "serif headings, humanist sans body" | "all geometric sans" | "model's pick from Google Fonts"}}
- **Density / spacing:** {{compact | comfortable | roomy}}
- **Corner shape:** {{sharp | subtle radius | pill / very rounded}}
- **Icon style** *(optional)*: {{single-color line-art (default) | solid silhouette | duotone | illustrated | emoji}}
- **Motion** *(optional)*: {{default scroll-reveal | no motion / reduced motion}}
- **References / inspiration** *(optional)*: {{site names, brands, or aesthetics to evoke — and what NOT to copy}}

## 6. Copy & language voice
- **Voice:** {{e.g. plainspoken and direct | warm and conversational | premium and restrained | technical and authoritative}}
- **Reading level:** {{e.g. 8th-grade plain English | industry-fluent}}
- **Person / POV:** {{"we" first-person plural | second-person "you" focused | third-person}}
- **Words to use:** {{trade-specific terms the customer expects to see}}
- **Words to avoid:** {{e.g. "synergy", "leverage", "best-in-class", any competitor names}}
- **Language / locale:** {{en-US | en-CA | bilingual EN/FR | etc.}}
- **CTA verbs:** {{e.g. "Get a Quote", "Book Now", "Call Today" — list the ones you want repeated}}

## 7. Imagery strategy (pick ONE branch)

[[ BRANCH A — Use Pixabay (default)
- **Image vibe:** {{e.g. "real worksite photos, no stock-y handshake shots"}}
- **Suggested search terms** *(optional)*: {{the system auto-extracts these if omitted}}
- **Where photos go:** {{hero bg | service cards | gallery section | team placeholders}}
- **Avoid:** {{e.g. people-in-suits stock, illustrations, anything obviously AI-generated}}
]]

[[ BRANCH B — Reuse imagery from the crawled site
- **Pull image references from:** {{the crawl URL in §2}}
- **Specifically keep:** {{e.g. the team photos, before/after gallery shots}}
- Note: crawled images come in as references in `crawledData.images` — treat as layout inspiration. To actually use them as `<img>` sources, save them locally and attach them via Branch C.
]]

[[ BRANCH C — Use uploaded assets only
- **Attached images and where they go:**
  - `{{filename1.jpg}}` → {{hero background}}
  - `{{filename2.jpg}}` → {{about-us section, owner photo}}
  - `{{filename3.svg}}` → {{logo in header}}
- **For remaining image slots:** {{Pixabay fallback | placeholder | none/decorative-only}}
- **Strict uploads-only?** {{yes — do not pull any stock imagery | no — fill gaps with Pixabay}}
]]

[[ BRANCH D — Placeholders only
- Use `placehold.co` for all image slots; the client will iterate on imagery later.
]]

## 8. Brand assets *(if any)*
- **Logo:** {{attached as filename, or "make a wordmark using --font-heading"}}
- **Locked brand colors (hex):** {{primary: #…, accent: #… — or "none, you choose"}}
- **Locked fonts:** {{Google Fonts names — or "none, you choose"}}

## 9. Hero treatment *(optional — model decides per archetype if blank)*
- **Hero style:** {{big photo background | split image+text | typographic-only | video-still | minimal / no hero}}
- **Headline angle:** {{the one promise the hero should make}}
- **Primary CTA:** {{button label + where it should go (#contact, tel:, etc.)}}
- **Secondary CTA** *(optional)*: {{e.g. "See our work"}}

## 10. Navigation *(optional — defaults if blank)*
- **Style:** {{standard responsive (default) | always-trigger drawer | hybrid (inline + utility trigger)}}
- **Trigger icon:** {{hamburger (default) | two-line | "MENU" text | dots — or "model's pick"}}

## 11. Constraints & non-negotiables
Hard rules the design must follow. Group them here rather than scattering them through the brief.
- {{e.g. "No JavaScript beyond the required scroll-reveal observer."}}
- {{e.g. "Phone number must appear in the header on every page."}}
- {{e.g. "Include a license #1234567 badge in the footer."}}
- {{e.g. "No testimonials, no team photos — owner is camera-shy."}}
- {{e.g. "Compliance: must show 'Equal Housing Lender' badge."}}

## 12. Stretch / nice-to-have *(optional)*
- {{Anything that's a "if you have the room" — e.g. FAQ accordion, stat band, financing calculator placeholder}}

---

## How the branches map to the system

- **Data source (§2):**
  - Branch A populates `project.crawledData` via the `/api/crawl` route and lands in the cached system block.
  - Branch B lives in the user message as attached files. Images come through `uploads/`; text/document attachments come through Anthropic's document content blocks. The model reads whatever's attached — don't try to retype the content in the prompt itself.
  - Branch C uses both: the crawl provides the structured intake, the attachments override or add on top.
- **Information architecture (§3):** Optional. Without direction, the model picks. The "preserve the source IA" toggle lets you override the system's default ("improve, don't mirror") when you want an exact structural match.
- **Archetype (§4):** Leaving it blank or writing "random" lets `chat.js` inject one automatically on first generation. Naming one (or a blend) suppresses the random pick.
- **Imagery (§7):**
  - Branch A is the default Pixabay path — search terms auto-extract from §1/§2 if you don't supply your own.
  - Branch B treats crawled image URLs as references only — to actually use one, download it and attach via Branch C.
  - Branch C requires the files to be attached in the chat composer; the template just tells the model where to place them. The "strict uploads-only" toggle is what tells the model to ignore the Pixabay pool even if one is present.
  - Branch D forces `placehold.co` fallback.
- **Visual tone & copy voice (§5–6):** These don't have dedicated system-prompt slots — they ride in the user message and shape the design through normal interpretation. The token-related items in §5 (density, corner, typography) get baked into `:root` so the Tools menu can later swap them.
- **Constraints (§11):** Hard requirements. The model is more reliable when "must" rules are grouped in one block instead of scattered.

## Minimum-viable version

If you want a quick brief instead of the full template, the load-bearing sections are **§1, §2 (one branch), §5 (mood + color), §7 (one branch)**. Everything else is refinement.
