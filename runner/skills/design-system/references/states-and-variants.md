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
disabled  >  loading  >  error  >  active  >  focus  >  hover  >  default
```

A disabled control never shows hover; a loading control never shows active. Resolve to the
highest-priority state, don't stack them — with one exception: focus is always visible, so an
invalid field that has focus shows the error-coloured focus ring (see *Error*).

### Transitions

Keep durations short. Colour, border and shadow transitions on state changes are fine (paint
only, no layout); anything that moves or scales uses `transform`/`opacity`. Never transition
`width`, `height`, `padding` or `margin`.

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
  outline: var(--ring-width) solid var(--color-ring);
  outline-offset: var(--ring-offset);
}
```

Ring width 2px · offset 2px · colour `--color-ring`, at least 3:1 against the surrounding
background in every theme (WCAG 1.4.11). Prefer `outline` to a `box-shadow` ring: shadows
disappear in Windows forced-colours (high contrast) mode. If you must use a shadow ring, keep
`outline: 2px solid transparent` so forced-colours mode still draws one. A sticky header or
toast must not cover the focused element (WCAG 2.2 2.4.11) — set `scroll-padding-top`.
For composite controls, lift the ring to the container with `:focus-within`.

## Disabled

```css
.disabled {
  opacity: var(--opacity-disabled);   /* 0.5 */
  pointer-events: none;
  cursor: not-allowed;
}
```

Use the native `disabled` attribute by default (removes the control from the tab order and
blocks activation). Use `aria-disabled="true"` instead — and block activation in the handler —
only when the control must stay focusable, e.g. so a screen-reader user can discover a submit
button and the reason it is unavailable. Never both on one element. WCAG exempts inactive
controls from contrast minimums, but keep the label legible and pair the disabled look with a
reason in text where the user needs one.

## Loading

```css
.loading { position: relative; pointer-events: none; }
.loading > * { opacity: 0.7; }
.loading::after { content: ''; /* spinner */ }
```

Spinner placement: button → replace icon / centre, keeping the button's width and accessible
name stable; input → trailing; card → centre overlay; page → a skeleton at the final layout
size rather than a centred spinner (no layout shift). Set `aria-busy="true"` on the region being
updated, and announce start/finish through a polite `role="status"` region that already exists
in the DOM.

## Error

```css
.error { border-color: var(--color-destructive); color: var(--color-destructive); }
.error:focus-visible {
  outline: 2px solid transparent; /* shows in forced-colours mode, where shadows vanish */
  box-shadow: 0 0 0 2px var(--color-background),
              0 0 0 4px var(--color-destructive);
}
```

Put the message below the field, give it the error colour **and** an icon, phrase it as the
fix ("Enter a date in the past"), and clear it on valid input. Wire `aria-invalid="true"` +
`aria-describedby` to the message. Announce errors on submit via the form's error summary (focus
moves to it) rather than a `role="alert"` on every field, which fires a burst of interruptions.

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
| Large text (≥ 24px, or ≥ 18.66px bold) | 3:1 |
| UI components / focus indicator | 3:1 |

- **Never rely on colour alone** — pair it with an icon, text, or pattern.
- Focus must always be visible; tab order matches visual order.
- ARIA for states:

```html
<button disabled>Submit</button>                       <!-- native disable -->
<button aria-disabled="true" aria-describedby="why">Submit</button>
<span id="why">Complete the required fields to submit</span>
<section aria-busy="true">…</section>
<div role="status" class="sr-only"><!-- "Saving…" / "Saved" inserted here --></div>
<input id="email" aria-invalid="true" aria-describedby="email-error">
<span id="email-error">Enter an email address like name@example.com</span>
```
