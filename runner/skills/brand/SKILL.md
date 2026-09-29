---
name: brand
description: Use to establish or audit a product's brand so the factory's output looks intentional, not template — when a ticket asks to "create a brand", "define the design system / visual identity / palette / typography", or when delivered UI looks generic and needs a deliberate direction. Detects existing brand and extends it in its own idiom, or commits to one specific direction (palette, type pairing, voice) and writes a BRAND.md. Invoke whenever the factory needs a design foundation before building UI.
stack: []
area: frontend
---

# Establish or audit the brand

A factory that ships UI without a brand ships templates. This skill gives the product a
**specific** visual and verbal identity — or audits and extends the one it has — and
writes it down in a form delivery agents can consume: `BRAND.md` plus tokens. It owns
identity (direction, palette, type pairing, voice). The token *structure* belongs to the
`design-system` skill; surface execution to the `frontend-design` skill.

| Depth | Reference |
|-------|-----------|
| Palette tiers, `oklch` tokens, contrast, type pairing and fluid scale | `references/color-and-typography.md` |
| Voice spectrums, traits, messaging hierarchy, consistency checklist | `references/voice-and-messaging.md` |

## Steps

1. **Detect.** Call `search_lore` for brand, positioning, voice and design ADRs. In the
   repo look for `BRAND.md`, `DESIGN.md`, token files (`*.tokens.json`, `tokens.css`,
   `theme.ts`), a `:root` block of custom properties, logo assets, and marketing copy.
   Read the product's README and the ticket for audience and purpose. Decide: does a
   brand exist?
2. **Brand exists → audit and extend in its idiom.** Do not replace it with your taste.
   - Score it against the required qualities (step 4) and the banned list below; name
     each gap with the file and value.
   - Measure every text/background pair the brand uses, in every theme, against WCAG
     contrast (4.5:1 body, 3:1 large text and UI) — compute the ratio; `oklch` lightness
     is not a contrast ratio. A brand colour that fails as text gets a darker text-safe
     variant, not a waiver.
   - Fill gaps in the existing direction: hover/active steps, a missing surface tier, a
     dark variant, a text-safe accent, missing semantic roles.
3. **No brand → commit to one direction** and write why it fits this product and
   audience: editorial/magazine, Swiss/International, neo-brutalism, bento, glassmorphism
   with real depth, light or dark luxury, retro-futurism. "Clean minimal" is not a
   direction; dark mode is chosen for the users, not by habit. Then define:
   - **Palette** as `oklch` tokens with a stated job per colour: surfaces (at least two
     tiers), text (primary, muted), accent, and the semantic roles success / warning /
     danger / info — each with a text-safe variant where the fill colour fails as text.
   - **Type pairing** — display + text families with a reason (and mono if the product
     shows code or data), a `clamp()` fluid scale, and a loading plan: self-hosted,
     subset, one critical weight preloaded, metric-matched fallback.
   - **Voice** — audience, the one-line promise, 3–5 voice traits each with a "we say / we
     don't say" pair, and how voice shifts in errors and empty states.
4. **Check the required qualities.** The brand must let delivered UI show at least four of
   the ten qualities listed in the `frontend-design` skill (scale hierarchy, spacing
   rhythm, depth, typographic character, semantic colour, designed states, composition,
   atmosphere, clarifying motion, data-viz in the system). Name the four-plus in
   `BRAND.md`.
5. **Write the artifacts.** `BRAND.md`: direction and rationale, palette table (token,
   value, job, contrast result), type pairing and scale, voice, qualities delivered, open
   questions. When the work is visual, a token file in the repo's format (DTCG JSON or
   CSS custom properties — see the `design-system` skill), for example:

   ```css
   :root {
     --color-surface: oklch(98% 0.01 95);
     --color-text: oklch(22% 0.02 265);
     --color-accent: oklch(64% 0.19 28); /* fill only; text uses --color-accent-text */
     --color-accent-text: oklch(50% 0.19 28);
     --text-display: clamp(2.5rem, 1rem + 6vw, 6rem);
     --text-base: clamp(1rem, 0.94rem + 0.3vw, 1.125rem);
     --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
   }
   ```

6. **Flag, don't invent, unknown strategy.** If positioning or audience is genuinely
   undecided and the ticket does not settle it, do not fabricate one. As a delivery skill,
   `mark_ticket_blocked` with the specific question; as a lore seed, `suggest_lore` the
   brand with the open questions named.
7. **Land it.** As a delivery skill (you are on the ticket's worktree branch — the
   `create-branch` skill verifies), commit, record per-AC evidence with the
   `record-evidence` skill (the `BRAND.md` diff, contrast table, qualities list), then
   stop; the runner submits for review. As a lore seed, `suggest_lore` the brand; it
   stays a suggestion until a human ratifies it.

## Banned (an audit must catch these)

- Default card grids with uniform spacing and no hierarchy.
- The centred headline + gradient-blob hero with a generic CTA.
- Unmodified library/Tailwind/shadcn defaults passed off as finished design.
- Identical radius, spacing and shadow on every component.
- Grey-on-white with one decorative accent colour.
- Default font stacks with no stated reason; more than two families without a reason.
- An accent colour used for body-size text when it fails 4.5:1.
- Reflexive dark mode chosen by habit rather than fit.

## Done when

`BRAND.md` states one direction with its rationale; every palette pair has a measured
contrast result that passes in every theme; the type pairing, scale and loading plan are
defined; voice has traits with examples; four or more required qualities are named;
open strategic questions are listed rather than guessed; tokens exist in the repo's
format.

## Rules

- Commit to a direction and state why; never "clean minimal".
- Tokens, not literals, so delivery agents reuse them.
- Extend an existing brand in its idiom; never overwrite it with preference.
- Motion tokens are for `transform`/`opacity`; never bake layout-bound animation into the
  system.
- Unknown strategy is a named open question, never an invented answer.
