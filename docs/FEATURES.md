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
4. **What you agreed is checked.** Every answer you gave the planner is a
   requirement. The proposal lists them under *Agreed while planning* and flags
   any that no proposed ticket's criteria cover (a "30-minute expiry" with no
   criterion mentioning 30 minutes). Each one you keep becomes a criterion of the
   Final (the epic's acceptance ticket), so the independent tester checks it even
   when the planner's tickets left it out. `POST /epics` takes them as
   `epic.agreed_requirements`, or reads them from `plan_session_id`.

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
repo page holds the Definition-of-Done gate commands (test / lint), auto-detected
at onboarding and editable there, because a wrong gate command is the commonest
reason a delivery bounces or ships unverified. The typecheck gate runs the repo's
package.json typecheck script (a `typecheck`-style script or a bare
`tsc --noEmit`), read from the base branch so a delivery cannot delete it away;
`GAFFER_DOD_TYPECHECK_CMD` overrides it. The repo's coverage command is stored on
the same page but is **not** a Definition-of-Done gate (coverage-did-not-decrease
needs a stored baseline and is deferred): it feeds the idle coverage scan below.

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
- **Your approval is bound to the commit you read.** Approving (the dashboard,
  `gaffer approve`, `wg review approve`) pins the delivery branch's head as the
  reviewed commit, exactly as the factory's own agent review does; every landing
  path (the Merge button, `gaffer merge`, the runner's merge lane) merges only
  that commit and **holds** a branch that moved past it ("moved since the review
  approved it") until it is re-reviewed. A tester PASS of a commit nobody
  reviewed holds the same way.
- **Approve does not merge unless you ask it to.** With `AUTO_MERGE` off (the
  default) an approved ticket waits in *Ready for merge* for **Merge now**; with
  it on, a human approval lands on its own (an agent's approval also needs
  `MERGE_ON_AGENT_REVIEW`, or an earned per-repo grant).
- **"Done" means the combined code passed the gates on the target.** A branch
  that passed its gates and a default branch that passed its gates can still
  merge cleanly into something that fails (one side renames the field the other
  side starts reading). So before anything lands — the merge lane, **Merge now**,
  `gaffer merge`, the agent review's ship — the factory builds the merge of the
  approved commit onto the *current* default branch in a scratch worktree and
  runs the repo's Definition-of-Done gates on **that** merge — the same gates the
  delivery ran: its test and lint commands and the typecheck script detected from
  its package.json (read from the default branch first). It lands exactly
  the gated merge commit, and only while the default branch is still the commit
  it gated (compare-and-land; a branch that moved meanwhile is gated again). A
  red combination never lands: the default branch is untouched and the ticket
  waits in your queue (*blocked*, `merge_gate_red`) with the failing gate output
  as evidence. In PR mode the gate runs on the merge onto the freshly fetched
  remote default branch before `gh pr merge` is asked; GitHub's branch
  protection ("require branches to be up to date" plus required checks) is the
  compare-and-land upstream.
- **Required CI is required.** With *Require CI green before review* on, the
  runner records the CI result for the exact commit under review; approval (and
  a tester PASS) is refused until that commit's CI has passed, a red result for an
  approved ticket holds it for you (*blocked*, `ci_red`), and the merge lane reads
  CI again before landing. The CI gate asks `gh` only for the fields the real CLI
  exposes (`gh pr checks --json name,state,bucket,link`).
- **A merge conflict is never force-resolved.** The resolver agent merges the
  default branch into the delivery branch, and the runner **re-gates the
  resolution** — no conflict markers, and the repo's Definition-of-Done gates
  (tests · typecheck · lint) green on a clean checkout of the committed
  resolution (what would land; anything the resolver left uncommitted is
  discarded, never gated), recorded as fresh evidence — before the ticket goes
  back to review. A resolution that fails is
  moved off the branch (`refs/gaffer/conflict-resolved/<n>`) and held for a
  human.
- **Reject** loops the ticket back for rework (or abandons it), with your reason
  recorded and its acceptance criteria reset. A **won't-do** on delivered work
  keeps its branch as a record, and that branch no longer counts against the
  repo's open-branch cap, so abandoning work never starves the queue.
- The **reviewer is never the author**, even when agent approval is allowed: the
  server refuses an approval from the agent that delivered the ticket, and the
  factory's own review pass approves as a distinct, registered reviewer agent (a bare reviewer string is refused).
- The **event log is tamper-evident.** Every event is chained by a SHA-256 hash,
  so a row rewritten, deleted or re-ordered after the fact breaks every hash
  after it; `dispatch events verify`, `dispatch doctor` and the Health view's
  "Event log" card re-derive the chain. Each event also carries the **runner
  tick** that wrote it (the ticket timeline shows a `tick …` chip), so one tick's
  whole trail — the runner's calls and the agent's MCP writes — reads as one.
- **A flaky test does not burn an attempt.** With a worker pool
  (`GAFFER_CONCURRENCY` above 1) a red tests gate is rerun once at concurrency 1
  (one rerun at a time across the pool, after the other workers' gate runs finish)
  before the attempt counts. Only the tests gate, only once. A pass on the rerun is
  a green gate marked **Flaky suspected** on the Review card, its note naming both
  runs, with the first run's output kept in the DoD evidence and a
  `needs_human_review` note on the ticket; a second red is the failure, naming both
  exit codes. `GAFFER_DOD_FLAKY_RERUN=0` turns it off.
- **The merge commit says where it came from.** Every landing path (the Merge
  button, `gaffer merge`, the merge lane, the AFK review pass, a PR merge) writes git
  trailers into the merge commit, read from the dispatch DB:
  `Gaffer-Ticket: #12`, `Gaffer-Reviewed-By: human:tom` (or `agent:<id>`) and
  `Gaffer-Gates: DoD PASS (tests pass, lint skip); AC 3/3 satisfied; tester PASS`.
  The tester part comes from the tester's own verdict transition since the latest
  approval, never from evidence an agent could record.
  The merge gate's gated merge commit, which is the commit that lands, carries
  them, and it is then `--no-ff`, so there is a merge commit to carry them. No
  model name is written (the usage ledger records that), and the trailers are not
  signed. `GAFFER_PROVENANCE_TRAILERS=0` turns them off.
- **Every attempt names its model and its CLI.** The runner records, per delivery
  attempt, the model that served the call (and the one it asked for) and the
  Claude Code CLI version that ran it — on the usage-ledger row (`attempt`,
  `model_requested`, `claude_version`) and as agent-run evidence on the ticket. The
  ticket page's **Attempts** history shows "Model … · CLI …" on each attempt: a
  failure names the run of the attempt that failed (none when the agent never ran,
  as when its environment could not be installed) and carries that attempt's number,
  every other run (the attempt that passed after a failure) follows the failures on
  its own row, and only the runner's own rows count, so an agent cannot name its own
  model. The attempt that used up the cap is on the history as a failure too
  ("Attempt 3/3 · definition-of-done failed"), recorded before the ticket parks.

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

Scoping a ticket to a node turns the node's repos into **suggestions** on the
ticket (ranked by relation, with the node's default access). A human confirms
which ones the ticket gets, one click per repo on the ticket panel; until at
least one is confirmed at `write`, `ready` refuses the ticket
(`SCOPE_REPO_UNCONFIRMED`) rather than queueing work the runner cannot deliver.
Once confirmed, the access is a boundary the runner enforces, not a suggestion:
the agent can write only to the `write` repos and read the `read` ones. Repos
with no mapping behave as standalone single-repo scopes, so nothing has to be
mapped to start working.

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
| `AUTO_MERGE` | Land a human-approved ticket on the default branch without a second click (off: it waits for Merge now). |
| `MERGE_ON_AGENT_REVIEW` | Extend `AUTO_MERGE` to approvals made on an agent reviewer's verdict. Needs `AUTO_MERGE` too — alone it merges nothing (the run says so). |
| `REVIEW_MODE=both` | The agent screens first (a CHANGES verdict can bounce the delivery to rework) but a human still confirms every approval. |
| `MEMORY_AUTO_APPROVE` | Let the memory the runner itself files (the requirement distilled from each delivered ticket, onboarding induction lore, CLI `memory suggest`) go live without a human review step. Lore a delivery agent suggests over MCP always stays a draft. |

**A dollar cap before the first live run.** A live run (`gaffer run`, `loop.sh`,
the Work view's **Poll for work**) refuses to start until `GAFFER_DAILY_BUDGET_USD`
or `GAFFER_BUDGET_USD` is set, and says how to set one. In the dashboard the first
Poll asks for a daily budget, prefilled at $5, saves it under **Budget & caps** and
then polls. Dry runs are never refused; `GAFFER_ALLOW_UNCAPPED=1` in the environment
opts out (a value in `settings.json` is ignored).

The same panel controls the **idle loops** (background work the factory mines
between real tickets) and the **planning-debate** depth. Every knob the factory
reads — its default, whether the panel can edit it, which component consumes it
— is listed in the generated [`CONFIG.md`](CONFIG.md).

**Maintenance when idle.** With the queue empty, an idle tick can run one scan
lane (security hotspots, coverage, test quality, type quality, tech debt,
documentation, dependencies) chosen by a deterministic priority-and-rotation
scheduler, no model in the choice. Each finding becomes a draft ticket that
carries a behaviour-preserving acceptance criterion with the repo's own test
command as its check, so the runner verifies the fix mechanically. The coverage
lane files a draft only when the coverage command succeeds and reports a total
**below** the `minimum_gap_threshold` target (a percentage); a repo at or above
it, a run that exits non-zero, or a report with no recognisable total
(coverage.py `TOTAL`, istanbul `All files`, Node's built-in `# all files`
report) files nothing. The same tick ingests labelled GitHub/Jira issues and
runs the lore-gap loop when it is on; the feature backlog runs just before the
lane, on its own switch. The scans cost nothing, so a tick that finds nothing
new is an empty poll (it drains the run and stays off the day cap); only the
feature backlog spends a model call, and it stops claiming a feature whose plan
failed twice in a row (`max_plan_failures`). The **Idle loops** panel holds the master
switch, the lane toggles, a recommended set, the dependency lane's audit
command, and the **self-improve** gate: opted-in repos, a risk ceiling and a
per-tick cap under which the tick promotes its own drafts to ready so the
delivery loop fixes them without a human in the promote step. Off by default;
the panel's status line says what the next idle tick will do — one lane per
tick, rotating — reading the runner's `GAFFER_MAINTENANCE`, `GAFFER_IDLE_MODE`
and `IDLE_DRAFT_WHEN_IDLE` overrides and each lane's prerequisites (the
coverage lane needs a repo coverage command and files only below its target).
Repos onboarded from the dashboard are scanned without editing `crew.yaml`.

**Feature backlog when idle.** With the **Feature backlog** toggle on, an idle tick
(before the maintenance lane) takes one `backlog` feature from the memory feature
ledger, moves it to `building`, plans it with one model call and files the epic as
draft tickets on that feature's repo, behind the usual human gate. A plan that fails
hands the feature back to `backlog`; after two failed plans in a row it is left there
for you. Off by default.
Confirming a brownfield epic yourself (every ticket on one existing repo) moves that
feature to `building` too.

**Usage limits pause the factory, they do not fail tickets.** When the model
refuses a delivery call because the plan's usage window ran out or a rate limit
hit, the ticket goes back to Ready without counting an attempt (any work the agent
had committed stays on its branch) and the factory pauses until the window resets:
the reset time Claude Code printed plus a minute (a 5-hour, weekly or per-model
limit alike, in both the older and the current CLI wording), or the **Usage-limit pause**
setting (`GAFFER_USAGE_PAUSE_DEFAULT_MIN`, default 60 minutes, never below 10) when
it printed none. No tick claims work meanwhile; `gaffer run --daemon`, the loop and
a worker pool sleep instead of spinning. `gaffer status` and the **Health** view
show "Paused until <time>: usage limit", and the ticket's timeline records the
refusal. The pause lifts on its own. An overnight run that hits its window no longer
parks good tickets. The same holds when the refused call was a new repo's
scaffold, the independent tester or the agent reviewer: the factory pauses and the
ticket waits where it was, rather than being parked or held for a person. A spend
cap or an admin switch is not a pause: it needs someone to raise the cap, so those
tickets are parked for a person as before.

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
