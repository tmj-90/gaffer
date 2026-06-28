---
name: mobile-ui
description: Use when a ticket builds or reworks UI in a React Native / Expo (or React + Capacitor) mobile app and it must feel like a real, store-credible native app — not a wrapped mobile website. Covers the native-feel bar, safe-area/gesture/haptics, store-readiness, and mobile performance. Invoke for "make this screen feel native", "build the mobile X screen", "this feels like a website", "would this get approved", or as the mobile pack for any app-UI change.
stack: [react-native, native, expo]
area: mobile
---

# Build store-credible native-feel mobile UI

Change the **skin, never the skeleton.** Build mobile UI that clears a native-feel bar and
a store-readiness bar — without touching gameplay, navigation routes, state, scoring, or
business logic. Where a redesign implies a structural change ("this should be a sheet, not a
modal"), flag it as a **proposal**; do not silently implement it.

## The three non-negotiable bars

A "premium" mobile surface must clear all three at once — failing any one ships as
not-premium regardless of the others.

1. **Native feel.** Every hybrid/RN screen reads as a mobile website until deliberately
   de-websified. Tells to close: centred modals (→ bottom sheets), fade transitions
   (→ slide/shared-element), missing swipe-back and hardware-back handling, no haptics on
   primary taps, fonts flashing, wrong scroll bounce, ignored safe-area insets, default
   launch screen.
2. **Maturity (indie → store-credible).** Tidying a plateau makes the plateau more visible.
   Recommit: real type scale, brand chrome (not generic), activated margins, ambient life,
   and **one named hero detail per screen** — the deliberate moment the user remembers.
3. **Store readiness.** Most "wouldn't get approved" intuition is a finite checklist:
   tap targets ≥ 44pt, privacy/permission strings present, real launch screen, Dynamic
   Type / large-text support, working hardware back (Android), opposite colour scheme,
   no placeholder content.

## Steps

1. **Read the lore + brand/tokens first.** `search_lore` (Memory MCP) and any
   `BRAND.md`/`DESIGN.md`/`tokens` file. If a brand/design system exists, **extend it in
   its idiom** (Brand-Respecting Mode) — audit + close gaps; do not re-pitch the aesthetic.
   Confirm the stack (RN/Expo or React + Capacitor) and match its component conventions.
2. **Audit the screen** against the three bars: score native-feel per item, diagnose
   maturity, pre-screen store-rejection triggers. Note gameplay/logic surfaces to leave alone.
3. **Respect safe areas.** Use the safe-area insets (`react-native-safe-area-context` /
   the env-inset equivalent) for top/bottom/notch; never hardcode status-bar heights.
4. **Gestures + navigation feel native.** Swipe-back, hardware back (Android), bottom
   sheets over centred modals, slide/shared-element transitions over fades. Keep the
   navigation routes and actions exactly as they are.
5. **Haptics + sound hooks** on primary interactions (selection, confirm, error) via the
   platform haptics API — subtle, consistent, behind a tokenised hook.
6. **Tokens drive presentation** — colour, type scale, spacing, motion, radius. No raw hex
   or magic numbers in components; scrolls hide scrollbars, use momentum, and disable global
   pull-to-refresh except where intended.
7. **Performance:** keep the main interaction loop at 60fps; animate on the native driver
   (`useNativeDriver: true` / Reanimated worklets); virtualise long lists (`FlatList`/
   `FlashList`); avoid layout thrash and oversized images.
8. **Verify + evidence.** Run the repo's tests + lint; a migration ends **green** — a
   failing gameplay test means logic changed (roll back, never edit the test to pass). Add
   tests for new visual contracts (component states, screen smoke tests). Record
   `test_output` via `record-evidence` and submit for review.

## Build / Test

- Run the repo's configured test + lint; type-check (`tsc --noEmit`) for TS.
- Every screen migration ends green with a successful build; default failing tests to
  **roll back the migration**, never to modifying the test.
- Prefer screenshot/visual checks on a real device or simulator at the supported tiers;
  test with Reduce Motion, large text (200%), VoiceOver/TalkBack, and the opposite colour scheme.
- The DoD is verified by the repo's configured commands — record the output as evidence.

## Review checklist (a mobile reviewer must check)

- **No web-hybrid tells** — bottom sheets not centred modals, slide not fade, swipe-back +
  hardware-back work, no font flash, scroll bounce/momentum correct.
- **Safe-area insets honoured** — nothing under the notch / home indicator; no hardcoded bar heights.
- **Haptics on primary taps**, consistent and subtle.
- **Tap targets ≥ 44pt**; Dynamic Type / large-text supported; opposite colour scheme holds.
- **One hero detail per screen** named and present; type scale + chrome are committed, not generic.
- **Tokens, not hardcoded** colour/spacing/type; no raw hex / magic numbers in components.
- **Performance** — native-driver animation, virtualised long lists, 60fps on the main loop.
- **Skeleton preserved** — routes, navigation actions, state, scoring, and component
  prop/event contracts unchanged; structural changes raised as proposals, not silently made.
- **Store triggers cleared** — privacy strings, real launch screen, no placeholder content.

## Rules

- Change the skin, never the skeleton — no logic/navigation/state/scoring changes.
- Clear all three bars (native feel, maturity, store readiness) — failing one fails the surface.
- Safe-area insets, native gestures, haptics, native-driver animation — no hardcoded bar heights.
- Tokens for all presentation; structural changes are proposals, not silent edits; tests stay green.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A mobile convention this repo enforces — the design system/tokens, brand voice, a native-feel pattern, a store-submission requirement, or a "never touch" gameplay/logic boundary.** That kind of fact is *lore* — it would have saved you time had the
previous agent recorded it, and it will save the next one. Capture it.

When you learn something that future agents on this repo should know *before they
start* — a convention, a gotcha, an architectural fact, a decision, a boundary —
call the Memory MCP `suggest_lore` tool once, at the close of your work:

- `title` — the rule/fact in a few words.
- `summary` — one self-contained paragraph: the *what* and the *why*.
- `body` — the detail and evidence that lets a human verify it.
- `repos` — the repo(s) the rule applies to.
- `tags` — lowercase (e.g. `conventions`, `gotchas`, `security`, `db`).
- `source` — a URL to the ticket/PR/ADR that justifies it (records without a
  source are lower-trust); `confidence` — `low` for an inferred convention,
  `high` only when you have a source.

**This is suggested, gated knowledge — not auto-truth.** `suggest_lore` lands a
DRAFT; a human reviews and approves it. You never approve your own lore.

**Capture reusable knowledge, not ticket noise.** Lore is a convention, gotcha,
decision, or boundary the *next* agent needs — never per-ticket trivia (what this
diff changed, a path you happened to read, transient task state). The honest test:
*would a teammate six months from now thank you for this record?* If unsure, skip —
a missing record costs one re-search; a noisy one costs every future reader.
