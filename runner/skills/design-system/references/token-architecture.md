# Token architecture

A three-layer token system is what makes a design system themeable and scalable instead of a
pile of one-off values. Each layer references the one below it; you never skip a layer.

```
┌──────────────────────────────────────────────┐
│  Component   --button-bg, --card-padding      │  per-component knobs · change freely
├──────────────────────────────────────────────┤
│  Semantic    --color-primary, --space-section │  purpose aliases · the theme-switch seam
├──────────────────────────────────────────────┤
│  Primitive   --blue-600, --space-4            │  raw values · change rarely
└──────────────────────────────────────────────┘
```

| Layer | Holds | Changes when |
|-------|-------|--------------|
| Primitive | raw colours, sizes, radii, shadows, durations | the foundation itself shifts (rare) |
| Semantic | meaning assigned to primitives (primary, muted, destructive, section spacing) | you theme (light/dark/brand variant) |
| Component | component-specific overrides referencing the semantic layer | a single component needs to diverge |

## Layer 1 — Primitive (raw values)

No meaning, just the scale. Gaffer uses `oklch` for colour (perceptual uniformity → predictable
contrast and tints) and `clamp()` for fluid type.

```css
:root {
  /* Colour — oklch(lightness chroma hue) */
  --gray-50:  oklch(98% 0.00 0);
  --gray-200: oklch(92% 0.00 0);
  --gray-500: oklch(64% 0.01 264);
  --gray-900: oklch(22% 0.02 264);
  --blue-500: oklch(62% 0.18 264);
  --blue-600: oklch(55% 0.20 264);
  --blue-700: oklch(48% 0.20 264);
  --red-600:  oklch(55% 0.22 27);

  /* Spacing — 4px base */
  --space-1: 0.25rem;  --space-2: 0.5rem;  --space-3: 0.75rem;
  --space-4: 1rem;     --space-6: 1.5rem;  --space-8: 2rem;  --space-12: 3rem;

  /* Type — fluid via clamp(min, preferred, max) */
  --font-size-sm:   0.875rem;
  --font-size-base: 1rem;
  --font-size-lg:   1.125rem;
  --font-size-2xl:  clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
  --font-size-4xl:  clamp(2.25rem, 1.5rem + 3vw, 3.5rem);

  /* Radius / shadow / motion */
  --radius-sm: 0.25rem;  --radius-default: 0.5rem;  --radius-lg: 0.75rem;
  --shadow-sm: 0 1px 2px oklch(0% 0 0 / 0.05);
  --shadow-default: 0 1px 3px oklch(0% 0 0 / 0.1);
  --duration-fast: 150ms;  --duration-normal: 300ms;
}
```

## Layer 2 — Semantic (purpose aliases)

This is the seam you theme against. Everything below is *meaning*, not raw colour.

```css
:root {
  --color-background: var(--gray-50);
  --color-foreground: var(--gray-900);
  --color-card:       oklch(100% 0 0);

  --color-primary:        var(--blue-600);
  --color-primary-hover:  var(--blue-700);
  --color-primary-foreground: oklch(100% 0 0);

  --color-muted:            var(--gray-200);
  --color-muted-foreground: var(--gray-500);
  --color-destructive:      var(--red-600);

  --color-border: var(--gray-200);
  --color-ring:   var(--blue-500);

  --spacing-component: var(--space-4);
  --spacing-section:   var(--space-12);
}
```

## Layer 3 — Component (per-component knobs)

References the semantic layer so a component can diverge without touching the theme.

```css
:root {
  --button-bg:        var(--color-primary);
  --button-fg:        var(--color-primary-foreground);
  --button-hover-bg:  var(--color-primary-hover);
  --button-padding-x: var(--space-4);
  --button-radius:    var(--radius-default);

  --card-bg:      var(--color-card);
  --card-border:  var(--color-border);
  --card-padding: var(--space-4);
  --card-radius:  var(--radius-lg);
  --card-shadow:  var(--shadow-default);
}
```

## Dark mode — override semantic only

Dark mode is **not** a new palette; it's a re-aliasing of the semantic layer. Primitives and
component tokens stay put.

```css
.dark {
  --color-background: var(--gray-900);
  --color-foreground: var(--gray-50);
  --color-card:       oklch(26% 0.02 264);
  --color-muted:      oklch(32% 0.02 264);
  --color-border:     oklch(36% 0.02 264);
}
```

If you find yourself overriding a component token or a primitive in `.dark`, the seam is in the
wrong place — push the variation up to the semantic layer.

## Naming convention

```
--{category}-{item}-{variant}-{state}

--color-primary           category-item
--color-primary-hover     category-item-state
--button-bg-hover         component-property-state
--space-section-sm        category-semantic-variant
```

| Category | Examples |
|----------|----------|
| color | primary, secondary, muted, destructive, success, warning |
| space | 1, 2, 4, 8, section, component |
| font-size | sm, base, lg, 2xl, 4xl |
| radius | sm, default, lg, full |
| shadow | sm, default, lg |
| duration | fast, normal, slow |

## File organisation

```
tokens/
├── primitives.css   /* raw oklch / clamp values */
├── semantic.css     /* purpose aliases */
├── components.css   /* component tokens */
└── index.css        /* imports all */
```

Or a single file with `/* === PRIMITIVES === */`, `/* === SEMANTIC === */`,
`/* === COMPONENTS === */`, `/* === DARK MODE === */` section comments.

## Migrating from flat tokens

Flat tokens (`--button-primary-bg: #2563EB`) bake meaning and value together, so theming means
find-and-replace. Split them:

```css
/* before */  --button-primary-bg: #2563EB;
/* after */   --blue-600: oklch(55% 0.20 264);   /* primitive */
              --color-primary: var(--blue-600);   /* semantic  */
              --button-bg: var(--color-primary);  /* component */
```

## Interop

Tokens map cleanly to the **W3C Design Tokens (DTCG)** JSON shape (`$value` / `$type`) for
tooling, and to a Tailwind theme by feeding the semantic layer into `theme.extend`. Keep the
CSS custom properties as the single source of truth; generate other formats from them, never
the reverse.
