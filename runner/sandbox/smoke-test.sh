#!/usr/bin/env bash
# One-command proof that Mode 2 (docker sandbox) delivers with a live model credential.
#
# PREREQ — provide a model credential the wrapper can forward (the runner never reads it):
#   claude setup-token          # on your Mac; needs your Max subscription; prints a token
#   export CLAUDE_CODE_OAUTH_TOKEN=<that token>
# (or `export ANTHROPIC_API_KEY=...`, or point GAFFER_SANDBOX_CLAUDE_CREDENTIALS at a file.)
#
# Then:  bash runner/sandbox/smoke-test.sh
#
# It runs a minimal `claude -p` INSIDE the read/egress-isolated container and checks the
# file it was asked to write landed on the host worktree. Proves, end to end: the
# credential authenticates from the container, claude runs, and its writes round-trip to
# the mounted worktree — the whole Mode-2 delivery path minus the full factory wiring.
set -euo pipefail

cd "$(dirname "$0")/../.."                 # repo root
RUNNER_DIR="$PWD/runner"; export RUNNER_DIR

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] \
   && [ ! -f "${GAFFER_SANDBOX_CLAUDE_CREDENTIALS:-/nonexistent}" ]; then
  echo "No model credential. Run 'claude setup-token' and 'export CLAUDE_CODE_OAUTH_TOKEN=...' first." >&2
  exit 1
fi

docker image inspect gaffer-sandbox:latest >/dev/null 2>&1 \
  || docker build -t gaffer-sandbox:latest runner/sandbox

WORK="$(mktemp -d)"; GD="$WORK/data"; WT="$WORK/wt"
mkdir -p "$GD" "$WT"; git -C "$WT" init -q
printf '%s\n' "$WT" > "$GD/wr"; : > "$GD/rr"
export GAFFER_DATA="$GD" GAFFER_SANDBOX_IMAGE="gaffer-sandbox:latest"

echo "== running claude -p inside the docker sandbox (read+egress isolated) =="
bash runner/lib/sandbox-docker.sh "$GD/wr" "$GD/rr" -- \
  claude -p 'Create a file named hello.txt whose contents are exactly: hi from the sandbox. Then stop.' \
  --permission-mode acceptEdits || echo "  (claude exited non-zero — see output; a token that won't auth from Linux looks like an auth error here)"

echo "== result =="
if [ -f "$WT/hello.txt" ]; then
  echo "  PASS — claude wrote inside the sandbox: $(cat "$WT/hello.txt")"
  echo "  (and it landed on the HOST worktree, proving the rw mount round-trips)"
else
  echo "  hello.txt not found — check the claude output above (likely an auth error if the token is device-bound)"
fi
rm -rf "$WORK"
