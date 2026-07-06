# Skill selection & stacks

How the factory decides which SKILL.md packs to mount into a delivery prompt,
why that policy is deliberately *broad*, and where the `repositories.stack`
model is heading next.

Implementation: `runner/bin/select-skills.mjs` (CLI used by `tick.sh`).
Tests: `runner/test/select-skills.test.mjs`.

---

## 1. The model we just shipped: broad-inclusion (denylist)

### What changed

Selection flipped from an **allowlist** (mount a pack only if the repo's `stack`
string names it) to **broad-inclusion** (mount every plausibly-relevant pack by
default; only *off-domain* packs stay opt-in). A skill's `area:` frontmatter tag
now sorts it into one of three buckets:

| Bucket | Areas | Rule |
| --- | --- | --- |
| **Universal** | `quality`, `testing`, `review`, `workflow`, `security` | Always eligible — the delivery mechanics fire on every ticket. |
| **Delivery** | `language`, `frontend`, `mobile`, `backend`, `data`, `refactor`, `docs` | Always eligible — every code-relevant pack fires regardless of stack. |
| **Off-domain** | `marketing`, `product`, `planning`, `devops`, `infra`, `meta`, `security-ops` | Opt-in — mounted only if the skill is stack-tagged and the ticket's stack intersects, or an explicit `--area` names it. |

A skill with **no `area:`** is treated as fully cross-cutting and is always
eligible. See `skillMatches`, `UNIVERSAL_AREAS`, and `DELIVERY_AREAS` in
`select-skills.mjs`.

### Why — the exclusion bug

The old allowlist gated language/frontend/mobile packs on the repo's `stack`
string. When that string was mis-registered or incomplete it *silently
excluded* the pack the files in front of the agent actually needed:

- `java-conventions` never mounted on a Java-backend ticket whose repo `stack`
  didn't list `java`.
- `mobile-ui` / `brand` never mounted on a mobile app whose compound `stack`
  string didn't spell out `react-native`.

An excluded skill is **invisible**: the agent can't ask for what it can't see,
and the delivery silently skips the conventions/UI guidance it should have had.

### Why broad-inclusion is cheap — progressive-disclosure economics

Claude Code uses *progressive disclosure*: for a mounted skill it loads only the
name + one-line description into context until the agent actually invokes it.
Listing **all the bundled skill descriptions is a few thousand tokens**, and that prefix is stable
across ticks so it is almost entirely **prompt-cached**. So the cost delta of
mounting a pack the agent never uses is negligible.

The two error modes are therefore wildly asymmetric:

- **Over-inclusion** (mount an unused pack): ~one cached description line. Nearly free.
- **Under-inclusion** (exclude a needed pack): invisible, and the delivery ships
  without guidance it needed. Costly, and hard to detect after the fact.

Given that asymmetry the correct default is *include*. Precise stack detection
stops being load-bearing: the agent, not the selector, makes the final call on
which mounted skill to open.

### Why off-domain packs still stay opt-in

The denylist keeps marketing / product / planning / devops / infra / meta /
security-ops packs off a normal feature delivery. A backend feature ticket
should not be handed a slide-deck, an SEO audit, or a Terraform pattern pack —
those belong to different kinds of work and are pulled in explicitly via
`--area` (or a stack tag like `terraform` / `kubernetes` for the infra packs).

---

## 2. Future direction: `stack` should become structured

### Today's hack

`repositories.stack` is a single nullable **compound string**
(`packages/crew/src/config/schema.ts` — `stack: z.string().nullable()`), e.g.
`"typescript-react-native-expo-java"`. `expandStacks` / `ticketStacks` split it
on `-` / `/` into tokens so a skill tagged with either the broad or a specific
stack still matches. It works, but it is a lexical hack:

- No way to say a repo is *both* a TypeScript RN app *and* a Java service
  without smashing everything into one dash-joined blob.
- Token collisions (`native`, `expo`) leak across unrelated concerns.
- A monorepo with a web front end, a mobile app, and a Java backend has one
  flat string that describes none of its paths accurately.

### Where it should go

1. **`stack[]` (array) as the minimum step** — replace the compound string with
   an explicit list of stack tags, dropping the split-on-dash guesswork.
2. **Per-path stacks tied to the scope graph (better)** — the codebase already
   models sub-repo structure via `scope_nodes` / `ticket_scope_nodes` (see
   `docs/spec-driven-development.md` and `packages/memory/src/core/repoUnderstanding.ts`).
   Attaching a stack to a scope node lets a ticket resolve stacks from the
   *paths it actually touches* — real monorepo routing, not a repo-wide blob.

### The key insight: it's a later refinement, not urgent

**Broad-inclusion makes precise stack detection non-critical.** Because delivery
and universal packs mount regardless of stack, a wrong or coarse `stack` value
no longer *excludes* the right pack — at worst it mounts a few extra cached
description lines. The only thing stack precision still gates is off-domain,
stack-tagged packs (terraform / kubernetes / docker), which are a small,
low-stakes set.

So `stack[]` / per-path scope-graph routing is worth doing, but as a refinement
that pays off **when the skill library grows large enough that
descriptions-in-context actually strain the budget** — at which point tighter
selection (mount fewer, more precisely) starts to matter again. Until then,
broad-inclusion buys us correctness cheaply and lets stack modelling mature on
its own timeline.
