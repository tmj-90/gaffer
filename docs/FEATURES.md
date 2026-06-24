# Gaffer — feature tour

A longer walk through what the factory actually does, surface by surface. The
[README](../README.md) is the scannable version; this is the deep-dive.

> Every screenshot here uses a neutral **demo dataset** — a fake "TaskFlow"
> task-management product with two repos (`taskflow-api`, `taskflow-web`). It is
> not anyone's real code, and it's seeded purely to show the surfaces with
> believable content.

---

## The planning engine — brief → dependency-ordered epic

The headline feature. A one-line brief becomes a **phased, dependency-ordered
epic of tickets**, each ready to be worked through plan → implement → test →
review.

### How the decomposition works

The "Plan a build" panel runs a real, multi-turn decomposer (the dashboard's
`POST /plan-build` spawns `runner/bin/decompose.mjs`, a headless `claude -p`):

1. **Clarify.** The first turn usually comes back as a short list of
   **clarifying questions** — cadence, scope, whether to extend an existing
   service or stand up a new one. You answer in plain language; answered
   questions are treated as settled on later turns.
2. **Propose.** Once it has enough, it returns a **plan**: an epic plus an
   ordered list of tickets. Every ticket carries a title, a description,
   **acceptance criteria**, a target repo, a priority, and an explicit
   **`dependsOn`** edge naming the tickets it can't start before.
3. **Confirm.** The plan is *proposed only* — nothing is created until you press
   **"Create these tickets"**. Confirmed tickets land as **draft**, so the
   planning step never sneaks work into the queue.

You are never trapped in the clarify loop: **"Build the tickets"** forces the
best plan from the brief and answers so far, and a long conversation
force-plans rather than dead-ending.

![Plan a build mid-decompose](img/plan-build.png)

*The brief "add recurring tasks" decomposed into the proposed **Recurring tasks**
epic. Each ticket has its own acceptance criteria; ticket #2 already shows it
`depends on #1`. The guardrail banner is explicit: proposes only, confirmed
tickets land as draft.*

### Greenfield vs brownfield

The decomposer takes one of two shapes depending on whether you point it at an
existing repo:

| Mode | When | What the plan looks like |
|---|---|---|
| **Greenfield** | "New app", no target repo | Exactly **one bootstrap ticket** (`git init` + scaffold, no dependencies); every other ticket transitively depends on it. A one-liner becomes a brand-new, structured repo. |
| **Brownfield** | "Extend existing", a target repo/scope is chosen | **Zero bootstrap tickets** — there's nothing to scaffold. Every ticket is stamped with the target repo, so the plan *extends* what's already there. |

The TaskFlow example above is brownfield: "add recurring tasks" to the existing
`taskflow-api` / `taskflow-web` repos — data model first, then the API surface,
the regeneration worker, the UI, and finally the docs.

### The epic as a first-class object

Once confirmed, the epic isn't just a label on a pile of tickets — it's the
dependency graph the board enforces. Tickets are **gated phase by phase**: a
phase can't start until the one before it is done.

![The Epics view, expanded](img/epics.png)

*The Recurring-tasks epic as four phases. Phase 1 (the data-model migration)
unblocks Phase 2 (the API), which unblocks Phase 3 (the regeneration worker and
the UI, which run in parallel), which unblocks Phase 4 (the docs). Each card
shows what it's "blocked by" until its dependencies land.*

---

## The work board

Day-to-day, work lives on the board. Tickets flow through
**draft → ready → in-progress → blocked → review** lanes:

- **Draft** — being shaped; vague tickets park here for a human rather than
  being forced through. Acceptance criteria are added before a ticket can go
  ready.
- **Ready** — claimable; the runner picks these up.
- **In progress** — claimed by an agent (the card shows which one).
- **Blocked** — surfaced for a human, not silently retried forever.
- **In review** — delivered, awaiting your sign-off.

Every card carries a **risk badge**, a **priority**, and live
**acceptance-criteria progress** (`2/3 satisfied`).

![The work board](img/board.png)

*Tickets spread across the lanes: drafts being shaped, ready work waiting, one
ticket claimed and in progress by the demo agent, and one delivered into review.*

---

## The human review gate

When an agent delivers, the ticket lands in **Review** — and this is the
structural barrier the whole design hangs on.

- The agent **cannot approve or merge its own work**. Approval is enforced
  server-side; an agent actor is refused unless you explicitly opt into agent
  approval (see [Settings](#control-you-opt-into)).
- The diff you review is the **real `git diff`**, computed server-side from the
  delivery branch against the repo's default branch — not a summary the agent
  wrote about itself.
- The **Approve button stays disabled until that diff actually loads.** You
  can't sign off on a change you couldn't see; even the keyboard shortcut
  fails closed.
- **Reject** loops the ticket back for rework (or abandons it), with your reason
  recorded and its acceptance criteria reset.

![The review gate](img/review.png)

*An in-review ticket: its evidence (passing tests), 3/3 satisfied acceptance
criteria, and the server-verified diff for `taskflow-api` — the migration and
its round-trip test. Approve / send-back are the human's alone.*

---

## The Factory Map

Real products are several repos, not one. The **Factory Map** models that:
**scope nodes** group repos into products, systems and capabilities, and each
repo is linked into a node with a **relation** and a **default access** level —
`write`, `read`, `test`, or `none`.

This is what lets a ticket scoped to a product reach exactly the repos that
product owns, at exactly the access it's been granted — a boundary the runner
enforces, not a suggestion. Repos with no mapping behave as standalone
single-repo scopes, so nothing has to be mapped to start working.

![A scope node and its mapped repos](img/factory-map.png)

*The TaskFlow product node and its two `owns` / `write` repos. The panel also
shows how nodes connect to each other (`contains` / `depends_on`) to build the
graph.*

---

## Durable repo memory — the Repo Understanding engine

Gaffer doesn't re-learn a repo from cold on every run. **Memory** is the durable,
human-gated knowledge the factory works from:

- **Repo Digest** — a living TLDR of each repo's **overview / structure /
  conventions / stack**, seeded at onboarding and refreshed deterministically as
  tickets merge. It carries a freshness stamp and an honest caveat: it's a map
  to *verify against the code* for high-stakes work, never a substitute for it.
- **Feature ledger** — what's `backlog → building → shipped` per repo, so the
  factory knows what already exists before it proposes building it again.
- **Lore** — the team's recorded conventions, decisions, gotchas, and cross-repo
  boundaries. It's **read-only in the product**: agents *draft* lore through an
  MCP review gate, and a human approves it via the memory CLI — it is never
  silently rewritten.

![A repo's digest and feature ledger](img/memory.png)

*The Repo Digest for `taskflow-api` — overview, structure, conventions and
stack, with its freshness line and the "verify against code" caveat. The feature
ledger and gated lore live on the same surface.*

Memory is also usable standalone — see
[`packages/memory/README.md`](../packages/memory/README.md).

---

## Control you opt into

Gaffer is **supervised by default**. A human readies tickets, a human approves
merges, and memory drafts wait for review. **Settings** is where you decide how
much of that to hand over — and every autonomy flag is **off until you turn it
on**:

| Flag | Effect when on |
|---|---|
| `DISPATCH_ALLOW_AGENT_APPROVE` | An agent actor may approve a ticket's review (otherwise human-only). |
| `MERGE_ON_AGENT_REVIEW` | Fire the merge when an agent — not just a human — approves. |
| `MEMORY_AUTO_APPROVE` | Accept memory draft records without a human review step. |

The same panel controls the **idle loops** (background work the factory mines
between real tickets) and the **planning-debate** depth.

![The Settings panel](img/settings.png)

*Autonomy flags, all opt-in and shown off; idle loops; and planning debate.
Nothing here is enabled by default — full hands-off autonomy is a deliberate
choice you make, not the starting state.*

---

## Where to go next

- [`../README.md`](../README.md) — the overview, architecture, install and safety
  model.
- [`../quickstart.md`](../quickstart.md) — a guided first run.
- [`../SECURITY.md`](../SECURITY.md) — the full threat model and honest residual
  limits.
- [`../runner/README.md`](../runner/README.md) — the runner runbook.
