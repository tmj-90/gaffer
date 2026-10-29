# Onboarding a repo

Getting a repo into the factory so it can be worked on. **One command, one place.**

## TL;DR

```bash
cd <repo-root>
runner/gaffer onboard /path/to/your/repo
```

That's it. The repo is now registered, scanned, and ready to take tickets. Example:

```
gaffer onboarding /Users/you/git/payments-service …
  registered in Dispatch
    stack:    node
    test:     pnpm test
    branch:   main    (secret files always excluded from scan + context)
    context:  <repo-root>/.gaffer/factories/gaffer/repos/payments-service
  next: map it to a scope in the Factory Map tab, or create a ticket against it.
```

## The mental model (why it's one command)

A repo is registered in **exactly one place — Dispatch** (the source of truth). Everything
else reads from there or builds on it; you never register it in more than one place:

- **Dispatch** — the registration. Repos, tickets, scope, access all live here.
- **The orchestrator** (`runner`) reads repos *from Dispatch* each tick. No extra step.
- **Crew** scans the repo (stack, test/build commands, important paths) and stores that
  context *outside* the repo — never any secrets.
- **Memory** accumulates *knowledge* about the repo over time (tagged); nothing to register.

`gaffer onboard` does the Dispatch registration + the Crew scan + seeds tags, together.

## Variations

```bash
runner/gaffer onboard /path/to/repo --standalone   # register as its own single-repo scope (default)
```

- **Single repo?** Just `gaffer onboard <path>` — done. Unmapped repos work as their own scope
  (mono-fallback), so you don't need the Factory Map at all for simple cases.
- **Part of a product/system?** Advanced scope mapping (attaching a repo under a Factory Map
  scope node, or overriding the display name) is configured via the **Factory Map** tab in the
  dashboard. The CLI only supports `--standalone` for the initial onboard step.

## After onboarding

1. **See it:** the **Factory Map → Unmapped repos** tab at <http://127.0.0.1:8787>
   (run `runner/gaffer dashboard` if it's not up — it prints a login URL; a running
   dashboard sees a CLI onboard straight away, no restart).
2. **Give it work:** create a ticket in the dashboard's PO flow, or (as in quickstart §4):
   ```bash
   runner/gaffer wg ticket create -t "Add health endpoint" -d "Expose GET /health returning {status:'ok'}"
   runner/gaffer wg ac add 1 -t "GET /health returns 200 with {status:'ok'}"
   runner/gaffer wg ticket repo-access set 1 <repo-name> --access write
   runner/gaffer wg ticket ready 1
   ```
   (`1` is the number `ticket create` printed; `<repo-name>` is the name `runner/gaffer status`
   lists under "repos (registered)".)
3. The factory delivers it in an **isolated worktree** when you run `runner/gaffer run`.

## Handy commands

```bash
runner/gaffer status               # what's registered + running + what needs you
runner/gaffer dashboard            # start the web UI (prints a login URL)
runner/gaffer demo                 # the Factory Map showcase (DRY_RUN)
runner/gaffer wg decisions resolve <id> --answer "…"   # answer a decision from the terminal
runner/gaffer help
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `registered in Dispatch` shows **"NOT registered"** | `crew.yaml`'s `dispatch.local.sqlite_path` must point at `<repo-root>/.gaffer/dispatch.sqlite`. |
| Repo doesn't appear in the dashboard | Check `runner/gaffer status` lists it under "repos (registered)"; if it does, reload the page (the dashboard reads the db on every request). |
| `not a git repo` warning | The factory branches per ticket; `git init` the repo first. |
| `CONFIG_NOT_FOUND: safety_policy.yaml` | Run from a normal shell so the factory config under `<repo-root>/.gaffer/` resolves (or use `runner/gaffer`, which handles it). |

See also: `RUNBOOK.md` (full build/run), `../README.md` (architecture).
