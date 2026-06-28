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
  --color-muted:      oklch(64% 0.01 264);        /* captions, secondary text */
  --color-border:     oklch(92% 0.00 0);

  /* Semantic — fixed meanings, do not repurpose */
  --color-success: oklch(72% 0.17 150);
  --color-warning: oklch(80% 0.15 85);
  --color-error:   oklch(58% 0.22 27);
  --color-info:    oklch(62% 0.16 250);
}
```

Why `oklch`: perceptually uniform lightness means tints/shades and hover steps are predictable,
and contrast is easier to reason about than with hex. State each pair's contrast against its
background (text ≥ 4.5:1, large/UI ≥ 3:1) in the brand doc.

## Typography framework

### Font stack

A deliberate **display + text pairing** with a stated rationale beats a default system stack
used by accident. Cap it at two families (plus optional mono) unless there's a real reason.

```css
--font-display: 'Your Display', Georgia, serif;        /* impact, headings */
--font-text:    'Your Text', system-ui, sans-serif;     /* long-form readability */
--font-mono:    'JetBrains Mono', ui-monospace, monospace;
```

Load with `font-display: swap`, `preconnect` to the font host, and preload **only** the single
critical weight.

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

Body text never below 16px; line-height ~1.5 for body, tighter (1.1–1.3) for large headings.
