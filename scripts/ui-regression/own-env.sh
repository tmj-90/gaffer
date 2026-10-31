# shellcheck shell=bash
# =====================================================================
# Named fixtures for the OWN-SERVER scenario suites (run-suites.sh sources this).
# A suite that exports `server = { env, fixtures }` (see suite-plan.mjs) runs in its
# own world: setup.sh builds a fresh data dir, sample repo and dashboard for it, and
# each fixture it names runs in two halves:
#
#   ui_fixture_<name>         BEFORE the dashboard starts (the sample repo exists, the
#                             factory env is not sourced yet): PATH, remotes, dirs —
#                             what it exports is operator env the dashboard keeps;
#   ui_fixture_<name>_after   AFTER the dashboard is up (crew.yaml exists), optional.
#
# Fixtures (dashes in a name become underscores in the function):
#   fake-gh        a recording `gh` (suites/bin/fake-gh.mjs) FIRST on PATH; its state
#                  dir is $FAKE_GH_STATE (calls.jsonl, prs.json, ci-state, issues.json).
#   pr-remote      origin = a local bare repo (pushes and PR merges land there) plus a
#                  github.com `upstream` remote, so PR mode and the CI gate apply.
#   github-origin  origin = https://github.com/acme/taskflow-mini.git (never fetched):
#                  onboarding records it, so GitHub ingest resolves the slug.
#   ingest-on      crew.yaml ingest.github.enabled: true (label agent-ok). The
#                  Settings → Idle loops panel has no ingest switch, so this is the
#                  operator's crew.yaml edit.
#   bootstrap-root GAFFER_BOOTSTRAP_ROOT = $OUT/greenfield (new repos are made there),
#                  GAFFER_REGISTRY_PROBE=0 (the bootstrap's registry probe needs the
#                  network; the stub installs nothing).
# Relies on setup.sh's globals: HERE OUT R.
# =====================================================================

ui_fixture_fake_gh() {
  export FAKE_GH_STATE="$OUT/gh-state"
  mkdir -p "$FAKE_GH_STATE" "$OUT/bin-gh"
  printf '#!/usr/bin/env bash\nexec node %q %q "$@"\n' "$HERE/suites/bin/fake-gh.mjs" "$FAKE_GH_STATE" > "$OUT/bin-gh/gh"
  chmod +x "$OUT/bin-gh/gh"
  export PATH="$OUT/bin-gh:$PATH"
}

ui_fixture_pr_remote() {
  git init -q --bare -b main "$OUT/remote.git" || return 1
  git -C "$R" remote add origin "$OUT/remote.git" || return 1
  git -C "$R" push -q origin main >/dev/null 2>&1 || return 1
  git -C "$R" remote add upstream https://github.com/acme/taskflow-mini.git
}

ui_fixture_github_origin() {
  git -C "$R" remote add origin https://github.com/acme/taskflow-mini.git
}

ui_fixture_ingest_on() { :; }
ui_fixture_ingest_on_after() {
  [ -f "$CREW_CONFIG" ] || return 1
  # The first `enabled:` under `ingest:` → `github:` is the GitHub switch (template.ts).
  sed -i.bak '/^ingest:/,/^  jira:/ s/^    enabled: false/    enabled: true/' "$CREW_CONFIG" && rm -f "$CREW_CONFIG.bak"
  grep -A3 '^ingest:' "$CREW_CONFIG" | grep -q 'enabled: true'
}

ui_fixture_bootstrap_root() {
  export GAFFER_BOOTSTRAP_ROOT="$OUT/greenfield" GAFFER_REGISTRY_PROBE=0
  mkdir -p "$GAFFER_BOOTSTRAP_ROOT"
}

# Run every named fixture's half: ui_run_fixtures <before|after> <name>…
ui_run_fixtures() {
  local phase="$1" f fn
  shift
  for f in "$@"; do
    fn="ui_fixture_${f//-/_}"
    [ "$phase" = after ] && fn="${fn}_after"
    if declare -F "$fn" >/dev/null; then
      "$fn" || { echo "fixture '$f' ($phase) failed"; return 1; }
    elif [ "$phase" = before ]; then
      echo "unknown fixture '$f' (see own-env.sh)"; return 1
    fi
  done
}
