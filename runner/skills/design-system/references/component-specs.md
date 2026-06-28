# Component specs

A component is specified when its **variants**, **sizes**, and **full state matrix** are all
defined — not just the happy-path default. These are starting specs; adapt the values to the
repo's tokens and `brand`, but keep the *coverage*. All colours reference semantic tokens.

## Button

**Variants** — `default` (primary bg, on-primary text), `secondary` (muted bg, foreground
text), `outline` (transparent + border), `ghost` (transparent, no border), `link` (primary
text, no bg), `destructive` (destructive bg, on-destructive text).

**Sizes**

| Size | Height | Padding X | Padding Y | Font | Icon |
|------|--------|-----------|-----------|------|------|
| sm | 32px | 12px | 6px | 14px | 16px |
| default | 40px | 16px | 8px | 14px | 18px |
| lg | 48px | 24px | 12px | 16px | 20px |
| icon | 40px | 0 | 0 | — | 18px |

**States**

| State | Background | Text | Opacity | Cursor |
|-------|------------|------|---------|--------|
| default | `--button-bg` | `--button-fg` | 1 | pointer |
| hover | one step darker | fg | 1 | pointer |
| active | darkest | fg | 1 | pointer |
| focus | bg + **visible ring** | fg | 1 | pointer |
| disabled | muted | muted-fg | 0.5 | not-allowed |
| loading | bg | fg | 0.7 | wait |

Anatomy: `[leading icon] Label [trailing icon]` — keep a min 44×44px hit target even when the
visual is smaller.

## Input (text / textarea / select / checkbox / radio / switch)

**Sizes** — sm 32px (`8px 12px`, 14px), default 40px (`8px 12px`, 14px), lg 48px (`12px 16px`, 16px).

**States**

| State | Border | Background | Ring |
|-------|--------|------------|------|
| default | border | card | none |
| hover | border (one step stronger) | card | none |
| focus | primary | card | primary @ ~20% |
| error | destructive | card | destructive @ ~20% |
| disabled | muted | muted | none |

Anatomy: optional label above · `[icon] value/placeholder [action]` · helper **or** error text
below. Never use the placeholder as the only label.

## Card

| Variant | Shadow | Border | Use |
|---------|--------|--------|-----|
| default | sm | 1px | standard |
| elevated | lg | none | prominent content |
| outline | none | 1px | subtle container |
| interactive | sm → md on hover | 1px | clickable |

Spacing: header `24px 24px 0`, content `24px`, footer `0 24px 24px`, inner gap `16px`.

## Badge

Variants: default (primary), secondary (muted), outline, destructive, success, warning.
Sizes: sm (`4px 8px`, 11px, h20), default (`4px 10px`, 12px, h24), lg (`6px 12px`, 14px, h28).

## Alert

| Variant | Icon | Background | Border |
|---------|------|------------|--------|
| default | info | surface tint | border |
| destructive | alert | destructive tint | destructive |
| success | check | success tint | success |
| warning | warning | warning tint | warning |

Anatomy: `[icon] Title [×]` with description beneath. Never signal severity by colour alone —
the icon carries it too.

## Dialog

| Size | Max width | Use |
|------|-----------|-----|
| sm | 384px | confirmations |
| default | 512px | standard |
| lg | 640px | complex forms |
| xl | 768px | data-heavy |
| full | `100% − 32px` | full-screen on mobile |

Anatomy: header (title + description + `[×]`) · scrollable content · footer (`[Cancel] [Confirm]`).
Trap focus, restore it on close, and close on `Esc`.

## Table

Row states: default (surface), hover (muted), selected (primary @ ~10%), striped (alternating).
Alignment: text left, numbers right, status/badge centre, actions right.
Density: cell padding `12px 16px`; row height compact 40px / default 48px / comfortable 56px.

---

These specs intentionally stop at structure + state coverage. For the *cross-component* rules —
state priority, the focus-ring spec, error/loading/disabled treatment, and the a11y/ARIA
requirements — see `states-and-variants.md`. For where the values come from, see
`token-architecture.md`.
