# Gaffer — feature tour

A longer walk through what the factory actually does, surface by surface. The
[README](../README.md) is the scannable version; this is the deep-dive.

> Every screenshot here uses a neutral **demo dataset** — a fake "TaskFlow"
> task-management product with two repos (`taskflow-mini`, the task-list
> library, and `taskflow-web`, its web client), a club named Factory Athletic and
> a squad of named agents. It is not anyone's real code, and it's seeded purely
> to show the surfaces with believable content. The ticket in review was
> delivered by a stand-in worker through a real runner tick, so its gates,
> checks and diff are real.

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
   **"Create as draft"** or **"Create & ready"**. Drafts never sneak work into the
   queue; "Create & ready" readies only the tickets that pass the `ready` gate
   (a criterion-less ticket stays draft).

You are never trapped in the clarify loop: **"Build the tickets"** forces the
best plan from the brief and answers so far, and a long conversation
force-plans rather than dead-ending.

![Plan a build mid-decompose: the team talk and the proposed draw](img/plan-build.png)

*The team talk on the Plan-a-build page: the brief "add recurring tasks", the
planner's three clarifying questions, your answer, and the proposed draw, the
**Recurring tasks** epic in four rounds plus the Final acceptance ticket.
Proposed tickets are numbered T1–T5 until you confirm, and T2 shows `after T1`.
Each carries its repo, priority and acceptance criteria. The guardrail banner is
explicit: proposes only, confirmed tickets land as draft.*

### Greenfield vs brownfield

The decomposer takes one of two shapes depending on whether you point it at an
existing repo:

| Mode | When | What the plan looks like |
|---|---|---|
| **Greenfield** | "New app", no target repo | Exactly **one bootstrap ticket** (`git init` + scaffold, no dependencies); every other ticket transitively depends on it. A one-liner becomes a brand-new, structured repo. |
| **Brownfield** | "Extend existing", a target repo/scope is chosen | **Zero bootstrap tickets** — there's nothing to scaffold. Every ticket is stamped with the target repo, so the plan *extends* what's already there. |

The TaskFlow example above is brownfield: "add recurring tasks" to the existing
`taskflow-mini` / `taskflow-web` repos — the data model first, then the API,
then the next-occurrence logic and the repeat picker in parallel, and finally
the docs.

### The epic as a first-class object

Once confirmed, the epic isn't just a label on a pile of tickets — it's the
dependency graph the board enforces. Tickets are **gated phase by phase**: a
phase can't start until the one before it is done.

![The season: the Recurring tasks epic, expanded](img/epics.png)

*The Recurring tasks campaign on The season (`#/epics`), as four rounds and the
Final. Round 1 (the recurrence rule on the task model) unblocks Round 2 (the
API), which unblocks Round 3 (the next-occurrence logic and the repeat picker,
which run in parallel), which unblocks Round 4 (the docs); the Final acceptance
ticket waits on all of them. Each card shows the tickets it waits on until they
land, and the footer names the next fixture: #8, the only one ready.*

---

## The work board

Day-to-day, work lives on the board. Tickets flow through
**draft → ready → in-progress → blocked → review** lanes:

- **Draft** — being shaped; vague tickets park here for a human rather than
  being forced through. Acceptance criteria are added before a ticket can go
  ready.
- **Ready** — claimable; the runner picks these up. A ready ticket with no
  repo it may write to (the default `solo_loose` pack only warns about it) is
  parked as blocked (`no_write_repo`) rather than delivered or retried; one
  whose write repo has no local checkout is parked as `no_local_repo_path`.
- **In progress** — claimed by an agent (the card shows which one).
- **Blocked** — surfaced for a human, not silently retried forever.
- **In review** — delivered, awaiting your sign-off.

Every card carries a **risk badge**, a **priority**, and live
**acceptance-criteria progress** (`2/3 satisfied`).

An acceptance criterion can be **machine-checkable**: give it a check command
(`npm test`, a script, an HTTP probe) and the runner executes it in the delivery
worktree after the Definition-of-Done gates. Exit 0 marks the criterion
satisfied as *runner-verified*, with the output stored as evidence; a failure
sends the delivery back to rework with that output as feedback — and the done
gate refuses a checked criterion an agent merely *claimed* to have met. The
repo page holds the Definition-of-Done gate commands (test / lint / coverage),
auto-detected at onboarding and editable there, because a wrong gate command is
the commonest reason a delivery bounces or ships unverified.

The board is **live**: the control plane streams its event log to the browser,
so a transition shows up within a second instead of on a polling timer.

**The club and the squad.** The header crest carries the club's short name and
its name from `/api/club`; with the full token it opens *Name your club* (name,
crest letters, the two kit colours, with a live preview), and the kit colours
re-dress the header, crest and shirts with a contrast guard. Every agent is shown
by its display name and shirt number (`/api/squad`, or the `agent_display` a
payload carries) on the board cards, the Tactics Board, Review, ticket timelines,
Squad & form and Health. The **Squad** page (`#/squad`) lists the squad and
renames an agent in place; a taken shirt number is refused with the holder's
name, and a read-only token sees no editors.

**The Floor.** `#/floor` draws the live factory as an isometric floor: stations
along a conveyor in lifecycle order (drawing office, Stores, Assembly,
Inspection, test rig, loading bay, Despatch), one parcel per open ticket at its
station, a robot in the agent's shirt number on every live claim, a hazard-taped
jam bay with a beacon for blocked, paused and failed tickets, a spend tank filled
to today's wage bill against the daily budget, and a lorry carrying what was
done today. It reads the Overview's own data and refreshes on the live stream.
Parcels, robots and stations are links with sentence labels; the stations and
benches are also listed as text under the drawing.

![The work board](img/board.png)

*Tickets spread across the lanes: the Recurring tasks drafts being shaped,
ready work waiting, two tickets claimed by Bez and Mo, one blocked after three
rework attempts, and the CSV export Kev delivered into review. On the pitch lists
which agent holds which ticket.*

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
- The **reviewer is never the author**, even when agent approval is allowed: the
  server refuses an approval from the agent that delivered the ticket, and the
  factory's own review pass approves as a distinct, registered reviewer agent (a bare reviewer string is refused).
- The **event log is tamper-evident.** Every event is chained by a SHA-256 hash,
  so a row rewritten, deleted or re-ordered after the fact breaks every hash
  after it; `dispatch events verify`, `dispatch doctor` and the Health view's
  "Event log" card re-derive the chain. Each event also carries the **runner
  tick** that wrote it (the ticket timeline shows a `tick …` chip), so one tick's
  whole trail — the runner's calls and the agent's MCP writes — reads as one.

![The Gaffer's Sign-off](img/review.png)

*An in-review ticket on The Gaffer's Sign-off: no flags, the Definition-of-Done
gates (tests and lint passed), 3 of 3 acceptance criteria satisfied by the
runner's own checks, the evidence trail, and the server-computed diff for
`taskflow-mini` — the new `toCsv` export and its tests. Approve / send-back are
the human's alone.*

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

![The Factory Map: scope nodes and their mapped repos](img/factory-map.png)

*The scouting map (`#/map`): the TaskFlow product node owns both repos with
`write` access and contains the Task list capability and the Web client system;
`depends_on` lines run from the web client to the task list and from the task
list to the Calendar feeds external dependency. Who plays where lists each
repo's relation and access at every node it belongs to.*

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
  silently rewritten. Every edit snapshots the previous version
  (`memory history <id>`), so a change is diffable and reversible.

![A repo's digest and feature ledger](img/memory.png)

*Club history (`#/memory`) for `taskflow-mini`: the Repo Digest (the scouting
report) with overview, structure, conventions and stack, its freshness line and
the "verify against the code" caveat; the feature ledger (the honours board) as
shipped, building and backlog; and the lore, two drafts awaiting a human
signature above the approved records.*

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
| `MEMORY_AUTO_APPROVE` | Let the memory the runner itself files (the requirement distilled from each delivered ticket, onboarding induction lore, CLI `memory suggest`) go live without a human review step. Lore a delivery agent suggests over MCP always stays a draft. |

The same panel controls the **idle loops** (background work the factory mines
between real tickets) and the **planning-debate** depth. Every knob the factory
reads — its default, whether the panel can edit it, which component consumes it
— is listed in the generated [`CONFIG.md`](CONFIG.md).

**Maintenance when idle.** With the queue empty, an idle tick can run one scan
lane (security hotspots, coverage, test quality, type quality, tech debt,
documentation, dependencies) chosen by a deterministic priority-and-rotation
scheduler, no model in the choice. Each finding becomes a draft ticket that
carries a behaviour-preserving acceptance criterion with the repo's own test
command as its check, so the runner verifies the fix mechanically. The **Idle
loops** panel holds the master switch, the lane toggles, a recommended set, and
the **self-improve** gate: opted-in repos, a risk ceiling and a per-tick cap
under which the tick promotes its own drafts to ready so the delivery loop fixes
them without a human in the promote step. Off by default; the panel's status
line says exactly what the next idle tick will do. Repos onboarded from the
dashboard are scanned without editing `crew.yaml`.

Enabling autonomy **requires containment**: any agent ship or mutate flag turns
on the OS sandbox requirement, and a required-but-unavailable sandbox refuses to
launch the agent rather than run it uncontained. The provider is auto-detected
(`sandbox-exec` on macOS, `docker` where a Docker CLI exists).

![The Settings panel](img/settings.png)

*The boot room (`#/settings`): the Team instructions dial on Supervised and the
Autonomy flags, all opt-in and shown off, with Planning debate, Idle loops and
the other groups folded below. Nothing here is enabled by default — full
hands-off autonomy is a deliberate choice you make, not the starting state.*

---

## Where to go next

- [`../README.md`](../README.md) — the overview, architecture, install and safety
  model.
- [`../quickstart.md`](../quickstart.md) — a guided first run.
- [`../SECURITY.md`](../SECURITY.md) — the full threat model and honest residual
  limits.
- [`../runner/README.md`](../runner/README.md) — the runner runbook.
