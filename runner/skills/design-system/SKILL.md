---
name: design-system
description: Use when a ticket needs a *systematic* token + component foundation for a frontend — the three-layer token architecture (primitive → semantic → component), component specs with full state coverage, or a recommendation for which design system a product should have. Invoke for "set up design tokens", "define the component system", "we keep hardcoding colours — fix it", "what design system should this product use", or as the structural backbone that `frontend-design` and `brand` build distinctive UI on top of.
stack: [typescript, javascript, react, web]
area: frontend
---

# Build a systematic design system

`frontend-design` decides *how the product should look*; this pack decides *how that look is
structured so it scales*. A design system is the disciplined layer underneath the aesthetic:
a **three-tier token architecture**, **component specs that cover every interactive state**,
and a deliberate match between the product's needs and the system it gets. Get this right and
every later surface reuses tokens instead of re-inventing styling per component.

Keep `SKILL.md` lean — the depth lives in the references; load the one you need on demand:

| Topic | Reference |
|-------|-----------|
| Three-layer token architecture (primitive → semantic → component), dark mode, naming | `references/token-architecture.md` |
| Component specs — variants, sizes, full state matrices for button/input/card/etc. | `references/component-specs.md` |
| Interactive states + variant patterns — state priority, focus rings, error/loading, a11y | `references/states-and-variants.md` |

## The token architecture in one breath

Three layers, each referencing the one below — never skip a layer:

```css
/* PRIMITIVE — raw values, no meaning. Change rarely. */
--blue-600: oklch(55% 0.20 264);
/* SEMANTIC — purpose aliases. This is the theme-switch seam. */
--color-primary: var(--blue-600);
/* COMPONENT — per-component knobs. Change freely. */
--button-bg: var(--color-primary);
```

Why it matters: **theming happens at the semantic layer** (override `--color-primary`, every
component follows). **Per-component tweaks happen at the component layer** without disturbing
anyone else. Components reference *component or semantic* tokens — **never a primitive
directly**, and **never a raw hex/`px`**. See `references/token-architecture.md`.

> House idiom: Gaffer uses **`oklch`** for colour and **`clamp()`** for fluid type at the
> primitive layer (perceptual uniformity, predictable contrast). Adapt the references' hex
> examples to `oklch` to stay consistent with `brand` and `frontend-design`.

## Recommend a tailored design system

When the ask is open-ended ("what should this product use?"), don't reach for a generic kit.
Reason from the product to a *specific* system across four axes:

1. **Pattern / structure** — content-first marketing site, data-dense dashboard/admin, a
   transactional flow, or a component-library/SaaS surface. This sets density, the spacing
   rhythm, and how much the grid is allowed to break.
2. **Style direction** — defer to `brand` if one exists; otherwise pick a real one
   (editorial, Swiss, neo-brutalism, glassmorphism-with-depth, light/dark luxury, bento) and
   say *why it fits this product*. Never "clean minimal".
3. **Palette posture** — how many primitives, which semantic roles (primary + secondary +
   muted + the four status colours), and whether dark mode is a real requirement or a habit.
   Use the 60/30/10 dominant/secondary/accent ratio as a sanity check, not a law.
4. **A11y + performance posture** — contrast floors (4.5:1 text, 3:1 large/UI), visible focus,
   `prefers-reduced-motion`, plus the CWV/bundle budgets from `frontend-design`. State these
   as targets up front so they constrain the system, not get bolted on after.

Output the recommendation as a short rationale + the token + component scaffold it implies —
then hand off to `frontend-design` for the visual execution and `brand` for the identity.

## Component spec discipline

A component isn't "done" until every state is specified, not just the default. For each
component define **variants** (default/secondary/outline/ghost/destructive…), **sizes**
(sm/default/lg with explicit height + padding + font), and the **full state matrix**:

| State | Trigger | Treatment |
|-------|---------|-----------|
| default | — | base |
| hover | pointer over | one step darker/raised |
| focus | keyboard/click | **visible** focus ring (never `outline:none` alone) |
| active | pointer down | darkest |
| disabled | `disabled`/`aria-disabled` | muted + `not-allowed`, opacity ~0.5 |
| loading | async | `aria-busy`, spinner, reduced opacity, no pointer events |
| error | invalid | error border + ring + message, never colour alone |

State **priority** when several apply: disabled > loading > active > focus > hover > default.
The full matrices for button/input/card/badge/alert/dialog/table live in
`references/component-specs.md`; the cross-component state + variant rules in
`references/states-and-variants.md`.

## Steps

1. **Read the lore + existing tokens first.** `search_lore` (Memory MCP) for the design
   system and any token ADRs; inspect `tokens.css`/theme files and a sibling component. If a
   token system or `brand` already exists, **extend it in its idiom** — do not introduce a
   competing one.
2. **Establish the three layers** (or audit the existing set against them). Primitives as raw
   `oklch`/`clamp()` values; semantic aliases for every role; component tokens per component.
   Add a `.dark` block that overrides **semantic** tokens only.
3. **Refuse primitive/hardcoded leaks in components.** Components consume semantic/component
   tokens exclusively — no raw hex, no `px` font sizes, no primitive references.
4. **Specify components fully** — variants, sizes, and the complete state matrix above, with
   accessible focus and ARIA states. An unspecified state is a bug waiting to happen.
5. **If asked to recommend a system**, run the four-axis reasoning above and output a
   rationale + scaffold; hand visual execution to `frontend-design`, identity to `brand`.
6. **Verify + evidence.** Run the repo's tests + lint; for token work, grep components for
   raw hex / `px` font-size leaks. Record `test_output` via `record-evidence` and submit for
   review — never self-approve.

## Build / Test

- Run the repo's configured test + lint; type-check (`tsc --noEmit`) for TS surfaces.
- Token-compliance check: grep component styles for raw hex and `px` font sizes — they should
  reference tokens, not literals.
- Verify focus is visible on every interactive component and that `.dark` only overrides
  semantic tokens (not primitives or component tokens).
- The DoD is verified by the repo's configured commands — record the output as evidence.

## Rules

- Three layers, no skipping: components reference semantic/component tokens, **never** a
  primitive or a raw hex/`px`.
- Theme at the **semantic** layer; tweak at the **component** layer; touch primitives rarely.
- Every component spec covers the full state matrix with a **visible, accessible focus ring**.
- Recommend a *specific* system from product → pattern + style + palette + a11y/perf — defer
  to `brand` for identity and `frontend-design` for visual execution; never duplicate them.
- `oklch` colour + `clamp()` type at the primitive layer to stay consistent with the house packs.

## Capture lore

**A repo's token architecture — the layer split, the naming convention, the dark-mode seam, or a "never reference a primitive in a component" rule — is exactly the fact the next agent needs before they start.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
