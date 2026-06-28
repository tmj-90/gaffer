---
name: md-document
description: Use when converting long-form markdown (specs, RFCs, reports, plans, explainers) into a readable, well-structured single-file HTML document with sticky TOC, search, and code-copy. Triggers on "convert this spec to HTML", "markdown to doc", "make this RFC readable", "publish this as a document", or "md to HTML". For slide decks, use `slides-deck`. Input must be ≥ 100 lines to warrant HTML rendering.
stack: []
area: docs
---

# Convert long-form markdown into a readable HTML document

Markdown wins for short content; a well-rendered HTML document wins for long specs and RFCs where navigation matters.

**Minimum viable document features:** sticky TOC, scrollspy, code-copy buttons, search filter. Single-file output — no framework runtime.

## When to use (and when not to)

| Input | Action |
|-------|--------|
| Spec / RFC / report / plan / explainer ≥ 100 lines | This skill |
| Slide deck (clear `---` slide boundaries) | `slides-deck` |
| Code review (diff blocks dominate) | Not this skill |
| < 100 lines | Leave as markdown — conversion overhead not worth it |

## Document structure requirements

The source markdown must have:
- A single `# Title` (H1) — becomes the `<title>` and page heading.
- `## Section` (H2) headings — TOC entries.
- `### Sub-section` (H3) headings — TOC sub-entries (optional).

If the source lacks this hierarchy, impose it before converting — a flat markdown wall produces a flat, unusable HTML document.

## Output spec

Single `.html` file with:
- **Sticky sidebar TOC** — generated from H2/H3 headings; highlights current section on scroll (scrollspy).
- **Search filter** — filters TOC entries and highlights matching sections; pure JS, no dependencies.
- **Code-copy buttons** — on every `<pre><code>` block.
- **Design tokens** — CSS custom properties for brand colour, font, spacing (use the repo's `brand` skill tokens if available; fall back to neutral defaults).
- **External dependencies** — Google Fonts CSS + Prism.js CDN only; no framework runtime.
- **Print style** — sidebar hidden; content full-width; page breaks before H2.

## Steps

1. **Validate the input.** Is it ≥ 100 lines? Does it have a clear H1 + H2 structure? If not, impose structure first.
2. **Check for design tokens.** `search_lore` for brand colours and typography. If found, use them as CSS custom properties. If not, use neutral defaults.
3. **Convert markdown to HTML.** Preserve all code blocks with language tags (Prism.js highlights them). Preserve tables, blockquotes, and lists.
4. **Generate the TOC** from H2/H3 headings. Give each heading an `id` attribute (slugified heading text).
5. **Inject interactivity.** Sticky TOC CSS; scrollspy JS (IntersectionObserver); search filter (input filters TOC items by text match, highlights matching sections); code-copy buttons.
6. **Inline all CSS.** No external stylesheet except Google Fonts (single `<link>`). Prism.js via CDN `<script>` at body end.
7. **Verify.** Open in browser; confirm TOC navigates correctly; confirm search filters; confirm Prism.js highlights code blocks; record evidence.

## Build / Test

- Open the file in Chrome and Firefox — no server needed for a single-file HTML.
- Tab through the page to verify keyboard accessibility.
- Print preview: confirm sidebar hides and content is full-width.

## Review checklist

- **Single file** — no external CSS or JS (except Google Fonts and Prism CDN).
- **TOC generated from H2/H3** — all headings present; IDs unique.
- **Scrollspy works** — current section highlighted as you scroll.
- **Code-copy buttons on all code blocks** — tested in browser.
- **Search filter functional** — filters TOC and highlights matching content.
- **Print style correct** — sidebar hidden; page breaks before H2.

## Rules

- Don't ship a document with a flat heading structure — impose H1/H2/H3 first.
- No framework runtime in the output — it must open as a file without a server.
- If < 100 lines, return the markdown as-is — don't over-engineer short content.
