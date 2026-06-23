# Getting started — from nothing to onboarded (advanced)

> **Advanced reference.** The canonical first run is the root
> [`README.md`](../README.md) → [`quickstart.md`](../quickstart.md). This page is
> the older standalone walkthrough, kept for the by-hand view.

A clean machine to a running factory with your repos onboarded, in three steps.

## 0. Prerequisites

- **Node ≥ 20**, **pnpm**, **git** — required.
- **Claude Code CLI** (`claude`) — only needed to run the *live* factory (not for setup/dashboard).
- macOS or Linux. (Optional strict-mode containment is macOS-only — see `STRICT_MODE.md`.)

```bash
node --version && pnpm --version && git --version
```

## 1. Get Gaffer onto the machine

Gaffer is **one monorepo**. The components live side by side under a single root:

```
<repo-root>/
  packages/dispatch/  packages/crew/  packages/memory/  runner/
```

```bash
git clone https://github.com/tmj-90/gaffer gaffer && cd gaffer
```

The runner derives every path from its own location, so any checkout root works.

## 2. One command: build + init + open the UI

```bash
cd <repo-root>
runner/gaffer setup
```

That installs + builds all three TypeScript packages, initialises factory state
(databases + a correctly-wired `crew.yaml`) under `<repo-root>/.gaffer/`, and opens the
dashboard at **http://127.0.0.1:8787**. (Equivalent: `runner/setup.sh` then `runner/gaffer dashboard`.)

## 3. Onboard your repos

```bash
runner/gaffer onboard /path/to/your/repo --standalone   # registers + scans + tags, one step
```

Each repo is registered **once** (in Dispatch — the single source of truth); the
orchestrator reads it from there. Advanced scope mapping is configured via the **Factory Map**
tab in the dashboard. See `ONBOARDING.md` for the full picture.

```bash
runner/gaffer status     # what's registered + what's running
```

## That's it — you're onboarded

From here:

- **Browse** the Factory Map + board at <http://127.0.0.1:8787>.
- **Watch the whole loop** safely: `runner/gaffer demo` (dry-run — no agent, no changes).
- **Give a repo work:** create a ticket in the dashboard's PO flow (or `dispatch ticket …`).
- **Go live** when ready: `DRY_RUN=0 bash loop.sh` — real agent ticks, each delivered in an
  isolated worktree (your checkout is never touched). Review `preflight.sh` first, and run
  one supervised ticket before any unattended run. Add `STRICT_MODE=1` for OS-level
  containment.

## If something's off

`runner/gaffer status` shows the live picture. Common fixes are in `ONBOARDING.md`'s
troubleshooting table. Full reference: `RUNBOOK.md`. Architecture: `../README.md`.
