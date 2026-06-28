---
name: brand
description: Use to establish or audit a product's brand so the factory's output looks intentional, not template — when a ticket asks to "create a brand", "define the design system / visual identity / palette / typography", or when delivered UI looks generic and needs a deliberate direction. Detects existing brand and extends it in its own idiom, or commits to one specific direction (palette, type pairing, voice) and writes a BRAND.md. Invoke whenever the factory needs a design foundation before building UI.
stack: []
area: frontend
---

# Establish or audit the brand

A factory that ships UI without a brand ships templates. This skill gives the product a
**deliberate, specific** visual and verbal identity so everything built afterwards looks
intentional. It either **audits and extends** an existing brand in its own idiom, or
**commits to one direction** — never a vague "clean minimal" default that means nothing.

Run it two ways: as a **delivery skill** when a ticket asks for brand work (branch,
implement, evidence, submit like any other ticket), or as a **lore seed** when you want the
brand to govern future work — `suggest_lore` it so every later ticket inherits it.

This skill owns the *identity* (direction, palette, type pairing, voice). The **structural**
layer it feeds into — the three-tier token architecture and component state specs — lives in
the `design-system` pack; the *visual execution* of surfaces lives in `frontend-design`. Keep
`SKILL.md` lean and load the craft depth on demand:

| Topic | Reference |
|-------|-----------|
| Colour system (tiers, 60/30/10, `oklch` tokens, contrast) + typography (pairing, fluid scale) | `references/color-and-typography.md` |
| Voice (spectrums, traits, do/don't), messaging hierarchy, consistency/approval checklist | `references/voice-and-messaging.md` |

## Steps

1. **Consult and detect, in parallel.** Call `search_lore` (Memory MCP) for any existing
   brand, positioning, voice, or design ADRs. In the repo, look for `BRAND.md`,
   `tokens.css`, a `styles/tokens.css`, a `.brand/` dir, or a `:root` block of CSS custom
   properties. Decide: **does a brand already exist?**
2. **If a brand exists → AUDIT and EXTEND in its idiom.** Do not overwrite it with your
   taste. Read its palette, type, and voice, then:
   - Check it against the **required-qualities** bar below and name where it falls short.
   - Fill gaps and add missing tokens *in the existing direction* (e.g. derive a hover/
     focus state, a missing surface tier, a dark variant) — extend, don't replace.
   - Record the audit findings and the additions in `BRAND.md`.
3. **If no brand exists → COMMIT to one specific direction.** Pick a real direction the
   product actually wants and say why — editorial/magazine, neo-brutalism, glassmorphism
   with real depth, light/dark luxury, bento, Swiss/International, retro-futurism. Never
   "clean minimal", never default to dark mode reflexively. Then define all of:
   - **Palette** as `oklch` design tokens — surface, text, accent, plus semantic roles
     (success/warning/danger) and at least one depth/surface tier. Color used semantically,
     not one decorative accent on gray-on-white. (Tiers, 60/30/10, contrast →
     `references/color-and-typography.md`.)
   - **Type pairing** — a deliberate display + text pairing with a stated rationale and a
     fluid scale (`clamp()` tokens), not a default system stack used by accident. (Scale +
     loading → `references/color-and-typography.md`.)
   - **Voice & positioning** — who it's for, the one-line promise, and 3–5 voice
     attributes with a do/don't example each. (Spectrums, traits, messaging hierarchy →
     `references/voice-and-messaging.md`.)
   - **Anti-template checklist** — list which of the required qualities the brand delivers.
4. **Write the artifacts.** Output a `BRAND.md` (direction + rationale, palette, type,
   voice, checklist) and, when the work is visual, a `tokens.css` sketch of the custom
   properties so delivery agents have something concrete to consume:

   ```css
   :root {
     --color-surface: oklch(98% 0.01 95);
     --color-text:    oklch(22% 0.02 265);
     --color-accent:  oklch(64% 0.19 28);   /* used semantically, not decoratively */
     --text-display:  clamp(2.5rem, 1rem + 6vw, 6rem);
     --text-base:     clamp(1rem, 0.94rem + 0.3vw, 1.125rem);
     --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
   }
   ```
5. **Flag, don't invent, when strategy is unknown.** If the product's positioning or
   audience is genuinely undecided, do not fabricate one to look complete. Surface it as a
   drafted decision: as a delivery skill, `mark_ticket_blocked` with the open question; as a
   lore seed, `suggest_lore` the brand *with the open questions named* — a human resolves
   them. Guessing a strategy is worse than naming the gap.
6. **Land it.** As a **delivery skill**: you came in via `create-branch`, so commit, then
   use `record-evidence` and `submit-review` (the `BRAND.md` diff + the checklist is your
   evidence) — never self-approve. As a **lore seed**: `suggest_lore` (Memory MCP) the
   brand so future tickets inherit it; it stays a suggestion until a human ratifies it.

## Required qualities (the bar to clear)

The brand must enable output that demonstrates at least four. Name which in `BRAND.md`:

1. Clear hierarchy through scale contrast
2. Intentional spacing rhythm, not uniform padding everywhere
3. Depth or layering — overlap, surfaces, shadow, or motion
4. Typography with character and a real pairing strategy
5. Color used semantically, not just decoratively
6. Hover, focus, and active states that feel designed
7. Grid-breaking editorial or bento composition where it fits
8. Texture, grain, or atmosphere when the direction calls for it
9. Motion that clarifies flow rather than distracts
10. Data visualization treated as part of the system, not an afterthought

## Banned (an audit must catch these)

- Default card grids with uniform spacing and no hierarchy
- Stock centered-headline + gradient-blob hero with a generic CTA
- Unmodified library/Tailwind/shadcn defaults passed off as finished design
- Uniform radius, spacing, and shadow across every component
- Safe gray-on-white with one decorative accent color
- Default font stacks used without a deliberate reason
- Reflexive dark mode chosen by habit rather than fit

## Rules

- Commit to a direction — "clean minimal" is not a direction. State the choice and the why.
- Tokens, not hardcoded values: `oklch` palette and `clamp()` type scale as custom
  properties so delivery agents reuse them instead of re-inventing styling per component.
- Extend an existing brand in its own idiom; never overwrite it with your preference.
- Animate compositor-friendly properties (`transform`, `opacity`, `clip-path`); never
  bake layout-bound animation (`width`, `top`, `margin`) into the system.
- Flag unknown strategy as a drafted decision — never fabricate positioning to look done.
- As a delivery skill, stay on a feature branch and never self-approve; as a lore seed,
  `suggest_lore` only — a human ratifies.
