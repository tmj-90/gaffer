---
name: design-system
description: Use when a ticket needs a *systematic* token + component foundation for a frontend — the three-layer token architecture (primitive → semantic → component), W3C DTCG design-token files, theming and dark mode, component specs with full state coverage, or a recommendation for which design system a product should have. Invoke for "set up design tokens", "define the component system", "we keep hardcoding colours — fix it", "what design system should this product use", or as the structural backbone that `frontend-design` and `brand` build distinctive UI on top of.
stack: [react, web]
area: frontend
---

# Build a systematic design system

The `brand` skill decides the identity; the `frontend-design` skill decides how a surface
looks. This pack decides how that look is **structured so it scales**: a three-layer
token architecture with one source of truth, component specs that cover every state, and
checks that stop raw values leaking back in. Load a reference when you need depth:

| Topic | Reference |
|-------|-----------|
| Layers, naming, dark mode, DTCG JSON, migration from flat tokens | `references/token-architecture.md` |
| Variants, sizes and state matrices for button/input/card/badge/alert/dialog/table | `references/component-specs.md` |
| State priority, focus rings, error/loading patterns, ARIA per state | `references/states-and-variants.md` |

## The architecture in one breath

```css
/* PRIMITIVE — raw values, no meaning. Change rarely. */
--blue-600: oklch(55% 0.2 264);
/* SEMANTIC — purpose. The theme seam: light/dark/brand override only this layer. */
--color-primary: var(--blue-600);
/* COMPONENT — per-component knobs, referencing semantic tokens. */
--button-bg: var(--color-primary);
```

Components consume component or semantic tokens — **never a primitive, never a literal**.
Themes (dark, high contrast, a second brand) re-point semantic tokens and nothing else.

**Source of truth.** If the repo keeps tokens as W3C Design Tokens Community Group
(DTCG) JSON — the format reached its first stable version, 2025.10, in October 2025 —
those files are the source: tokens carry `$value` and `$type`, aliases are written
`{color.blue.600}`, and a build tool (Style Dictionary or the repo's equivalent)
generates CSS variables, Tailwind theme and native values. Edit the JSON and regenerate;
never hand-edit generated output. If the repo has only CSS custom properties, those are
the source. Do not introduce a second source.

## Steps

1. **Read what exists.** `search_lore` for design-system ADRs; find token files
   (`*.tokens.json`, `tokens/`, `theme.ts`, `:root` blocks, Tailwind config), the build
   command that generates outputs, and two sibling components. Extend the existing system
   in its idiom; never add a competing one.
2. **Audit before adding.** Count literals in component styles (commands below). Every
   leak you touch is either replaced by an existing token or justifies a new one.
3. **Place each new token in its layer.** Primitive only for a genuinely new raw value;
   semantic for a new purpose (`--color-surface-raised`, `--space-section`); component
   only when one component must diverge. Names describe purpose, not appearance
   (`--color-danger`, not `--color-red`). Colour primitives in `oklch` (house idiom), type
   in a `clamp()` fluid scale, spacing on one base unit (4px or 8px).
4. **Theme at the semantic seam.** Dark mode and other themes override semantic tokens in
   one block (`[data-theme="dark"]`, `.dark` or `@media (prefers-color-scheme: dark)`, per
   the repo) and set `color-scheme` so native controls and scrollbars follow. A theme that
   overrides a primitive or a component token means the seam is in the wrong place.
5. **Verify contrast per theme.** For every foreground/background semantic pair actually
   used (text on surface, text on primary, border on surface, focus ring on surface),
   compute the WCAG contrast ratio in each theme: 4.5:1 for body text, 3:1 for large text,
   UI boundaries and focus indicators. `oklch` lightness is not the WCAG ratio — compute
   it (a script, the repo's checker, or a test). Record the table.
6. **Specify components fully.** Variants, sizes (explicit height, padding, font token),
   and the state matrix — default, hover, focus-visible, active, disabled, loading, error,
   plus selected/checked where relevant — with the ARIA each state exposes. Priority when
   several apply: disabled > loading > error > active > focus > hover > default. Focus is
   always visible (`:focus-visible` ring from `--color-ring`, never `outline: none` alone).
   Details: the references.
7. **Recommending a system for a new product:** reason from the product, not a kit —
   (a) pattern and density (marketing, data-dense dashboard, transactional flow),
   (b) direction (defer to `brand`), (c) palette posture (semantic roles incl. success/
   warning/danger/info; dark mode only if users need it), (d) accessibility and
   performance targets stated up front. Output a short rationale plus the token and
   component scaffold; hand visual execution to `frontend-design`.
8. **Verify and evidence.** Regenerate token outputs if the repo builds them and confirm
   the diff is only what you intended; run lint, type-check and tests; run the leak
   checks; render the changed components in every theme through the repo's component or
   screenshot tests where they exist. Record per-AC evidence with the
   `record-evidence` skill (leak count before/after, contrast table), then stop.

## Leak checks

Run on changed component and style files (exclude the token files themselves):

- raw colours: `grep -rEn '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(' src/components`
- raw type sizes: `grep -rEn 'font-size:\s*[0-9.]+px' src/components`
- primitives referenced from components: `grep -rEn 'var\(--(gray|blue|red|green)-[0-9]+' src/components`
- Tailwind arbitrary values where tokens exist: `grep -rEn '\[(#|[0-9]+px)' src/components`

Adjust paths and primitive names to the repo. New matches in your diff are defects for the
builder to fix unless the line is itself a token definition; a reviewer lists them as
`(optional)` unless one breaks an AC or a theme's contrast.

## Done when

No new literal or primitive reference in components; every theme overrides only semantic
tokens; the contrast table passes in every theme; each touched component's state matrix
is implemented with visible focus; generated outputs match the source.

## Capture lore

**A repo's token architecture — the layer split, the naming convention, the dark-mode seam, or a "never reference a primitive in a component" rule — is exactly the fact the next agent needs before they start.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
