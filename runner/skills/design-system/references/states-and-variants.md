# States and variants

The cross-component discipline: how interactive states behave, how they compose, and the
accessibility floor they all have to clear. `component-specs.md` lists per-component values;
this file is the rules that apply to all of them.

## Interactive states

| State | Trigger | Visual change |
|-------|---------|---------------|
| default | — | base appearance |
| hover | pointer over | slight shift (one step) |
| focus | keyboard / click | **visible** focus ring |
| active | pointer down | strongest shift |
| disabled | `disabled` / `aria-disabled` | reduced opacity, not-allowed |
| loading | async action | spinner + reduced opacity, no pointer events |
| error | invalid input | error border + ring + message |

### State priority (when several apply at once)

```
disabled  >  loading  >  active  >  focus  >  hover  >  default
```

A disabled control never shows hover; a loading control never shows active. Resolve to the
highest-priority state, don't stack them.

### Transitions

Animate only compositor-friendly properties; keep durations short.

```css
.interactive {
  transition-property: color, background-color, border-color, box-shadow;
  transition-duration: var(--duration-fast);   /* 150ms */
  transition-timing-function: ease-in-out;
}
```

| Transition | Duration | Easing |
|------------|----------|--------|
| colour / background / border | 150ms | ease-in-out |
| transform | 200ms | ease-out |
| opacity | 150ms | ease |
| shadow | 200ms | ease-out |

Wrap motion in `@media (prefers-reduced-motion: reduce)` and drop it to near-instant.

## Focus

Never `outline: none` without a replacement. Use `:focus-visible` so the ring shows for
keyboard users without firing on mouse clicks.

```css
.focusable:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 var(--ring-offset) var(--color-background),
    0 0 0 calc(var(--ring-offset) + var(--ring-width)) var(--color-ring);
}
```

Ring width 2px · offset 2px · colour `--color-ring` · offset colour `--color-background`.
For composite controls, lift the ring to the container with `:focus-within`.

## Disabled

```css
.disabled {
  opacity: var(--opacity-disabled);   /* 0.5 */
  pointer-events: none;
  cursor: not-allowed;
}
```

Use the `disabled` attribute for form elements and `aria-disabled="true"` for semantic disable.
Disabled controls still need ~3:1 contrast against their background.

## Loading

```css
.loading { position: relative; pointer-events: none; }
.loading > * { opacity: 0.7; }
.loading::after { content: ''; /* spinner */ }
```

Spinner placement: button → replace icon / centre; input → trailing; card → centre overlay;
page → viewport centre. Announce it: `aria-busy="true"` plus an `sr-only` status string.

## Error

```css
.error { border-color: var(--color-destructive); color: var(--color-destructive); }
.error:focus-visible {
  box-shadow: 0 0 0 2px var(--color-background),
              0 0 0 4px var(--color-destructive);
}
```

Put the message below the field, give it the error colour **and** an icon, and clear it on
valid input. Wire `aria-invalid="true"` + `aria-describedby` to a `role="alert"` message.

## Variant patterns

Variants are token swaps, not new components. Drive them through a local component token so the
base style stays one rule:

```css
.component {              /* default */
  --component-bg: var(--color-primary);
  --component-fg: var(--color-primary-foreground);
  background: var(--component-bg);
  color: var(--component-fg);
}
.component.secondary  { --component-bg: var(--color-secondary);  --component-fg: var(--color-secondary-foreground); }
.component.destructive{ --component-bg: var(--color-destructive);--component-fg: var(--color-destructive-foreground); }
```

Sizes follow the same pattern — swap `--component-height` / `--component-padding` /
`--component-font`, don't rewrite the rule per size.

## Accessibility floor (non-negotiable)

| Element | Min contrast |
|---------|--------------|
| Normal text | 4.5:1 |
| Large text (18px+/14px bold) | 3:1 |
| UI components / focus indicator | 3:1 |

- **Never rely on colour alone** — pair it with an icon, text, or pattern.
- Focus must always be visible; tab order matches visual order.
- ARIA for states:

```html
<button disabled aria-disabled="true">Submit</button>
<button aria-busy="true" aria-describedby="loading-text">
  <span id="loading-text" class="sr-only">Loading…</span>
</button>
<input aria-invalid="true" aria-describedby="error-msg">
<span id="error-msg" role="alert">Error message</span>
```
