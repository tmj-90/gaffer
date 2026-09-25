# UI regression (opt-in, browser-driven)

Drives the **real dashboard** end to end with a stub worker standing in for
`claude`, so the whole loop runs without a model key:

onboard a sample repo → create a ticket → add a machine-checkable AC → mark ready →
Poll for work (a live tick: worktree, delivery, DoD gate, AC check, hygiene,
minimalism, submit) → Review (server diff, arm + confirm Approve) → merge → done →
Suggest work (product-owner run) → every view renders with no console errors →
the board refreshes itself over the live event stream.

```bash
pnpm -r build
npx playwright install chromium        # once (or PLAYWRIGHT_CHROMIUM=/path/to/chromium)
bash scripts/ui-regression/run.sh      # ~2 minutes
```

Output: `/tmp/gaffer-ui-regression/shots/` (one screenshot per step) and
`results.json` (every check, console errors, failed requests). Exit code 1 on any
hard failure. `KEEP_DASHBOARD=1` leaves the dashboard up with its token printed.

Not wired into CI: it needs a browser and takes minutes. Run it before a release or
after touching `app.js`, the runner's delivery loop, or the review gate.
