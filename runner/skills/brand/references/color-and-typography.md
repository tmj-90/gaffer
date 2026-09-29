# Colour & typography framework

The concrete craft behind a brand's palette and type. Gaffer expresses palette as `oklch`
custom properties and type as a `clamp()` scale so delivery agents consume tokens, not literals.
Feed these into the three-tier token architecture in the `design-system` pack.

## Colour system structure

A deliberate palette has four tiers, not "a primary and a grey":

```
Primary (1–2)     main brand colour (CTAs, headers) + a supporting primary
Secondary (2–3)   accents for highlights and interactive states
Neutral (3–5)     backgrounds, text (heading/body/muted), borders/dividers
Semantic (4)      success · warning · error · info — fixed meanings
```

Apply the **60 / 30 / 10** ratio as a sanity check: ~60% dominant/neutral surface, ~30%
secondary, ~10% accent. It's a guide, not a law — break it deliberately for editorial moments.

### Document the palette

Give every colour a name, a value, and a *usage* — a swatch with no stated job invites misuse.

```css
:root {
  /* Primary */
  --color-primary:        oklch(55% 0.20 264);   /* CTAs, links, key emphasis */
  --color-primary-strong: oklch(48% 0.20 264);   /* hover/active */

  /* Neutral */
  --color-background: oklch(98% 0.00 0);
  --color-text:       oklch(22% 0.02 264);
  --color-muted:      oklch(50% 0.01 264);        /* captions, secondary text — 5.7:1 */
  --color-border:     oklch(92% 0.00 0);

  /* Semantic — fixed meanings, do not repurpose */
  --color-success: oklch(72% 0.17 150);
  --color-warning: oklch(80% 0.15 85);
  --color-error:   oklch(58% 0.22 27);
  --color-info:    oklch(62% 0.16 250);
}
```

Why `oklch`: perceptually uniform lightness means tints/shades and hover steps are predictable.
It does **not** give you the WCAG contrast ratio — that is computed from relative luminance, so
measure every pair actually used (a script, the repo's checker, or a browser devtools contrast
readout) and record it in the brand doc: body text ≥ 4.5:1, large text (≥ 24px, or ≥ 18.66px
bold) ≥ 3:1, UI boundaries, icons and focus rings ≥ 3:1. Do it per theme — a pair that passes in
light often fails in dark.

Fill colours are not text colours. Bright semantic hues (the warning yellow above) typically fail
4.5:1 as text on a light surface; give each role a text-safe variant (`--color-warning-text`,
lower lightness) and use the bright value for fills, borders and icons with a text label. Keep
chroma within sRGB for key UI colours unless the repo targets wide-gamut displays deliberately —
out-of-gamut `oklch` values are clipped differently across browsers.

## Typography framework

### Font stack

A deliberate **display + text pairing** with a stated rationale beats a default system stack
used by accident. Cap it at two families (plus optional mono) unless there's a real reason.

```css
--font-display: 'Your Display', Georgia, serif;        /* impact, headings */
--font-text:    'Your Text', system-ui, sans-serif;     /* long-form readability */
--font-mono:    'JetBrains Mono', ui-monospace, monospace;
```

Self-host the fonts (faster than a third-party host, no cross-origin connection, no visitor data
sent to a font CDN), subset to the scripts the product ships, and use WOFF2. Preload **only** the
single critical weight used above the fold. Use `font-display: swap` with a metric-matched
fallback (`size-adjust`, `ascent-override`, `descent-override` on a local fallback `@font-face`)
so the swap does not shift layout, or `font-display: optional` when the brand can tolerate the
fallback on a slow first visit. Variable fonts replace several static weights with one file.

### Type scale

Pick a ratio (1.25 Major Third is a safe default), base 16px, and express sizes as `clamp()`
fluid tokens so they scale with the viewport without media queries.

| Role | Size | Weight | Line height |
|------|------|--------|-------------|
| Display | `clamp(2.5rem, 1rem + 6vw, 3.8rem)` | 700 | 1.1 |
| H1 | `clamp(2rem, 1.2rem + 3vw, 3rem)` | 700 | 1.2 |
| H2 | `clamp(1.6rem, 1.2rem + 1.6vw, 2.4rem)` | 600 | 1.25 |
| H3 | `clamp(1.3rem, 1.1rem + 0.8vw, 1.9rem)` | 600 | 1.3 |
| Body large | 1.125rem | 400 | 1.6 |
| Body | 1rem | 400 | 1.5 |
| Small | 0.875rem | 400 | 1.5 |
| Caption | 0.75rem | 400 | 1.4 |

Body text never below 16px (1rem, so user font settings apply); line-height ~1.5 for body,
tighter (1.1–1.3) for large headings; 45–75 characters per line. Fluid `clamp()` sizes must keep a
`rem` component in the preferred value (`1rem + 2vw`, not `4vw` alone) so text still grows with
browser zoom (WCAG 1.4.4). The layout must survive the WCAG 1.4.12 text-spacing overrides
(line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em) without clipping.
