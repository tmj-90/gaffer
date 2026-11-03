#!/usr/bin/env bash
# runner/eval/experiment-stub-agent.sh: the STUB AGENT of the matched experiment runner
# (experiment.sh, stub mode; the default). It stands where `claude -p` stands: the worker
# seam spawns it in the run's repo with the scrubbed env, and it prints the same JSON
# result envelope. It makes no model call and spends nothing, so the experiment pipeline
# (worker seam, gates, pairing, report) runs in CI for free. What it does is the arm's
# `stub` setting, handed over by the runner in XP_STUB:
#   apply (default)   apply the ticket's recorded change (a fixture's delivery patch, or
#                     a manifest's base..head) and commit it; a later attempt finds it
#                     applied and commits nothing more
#   noop              commit nothing (an arm that never submits)
#   patch:<file>      apply that patch from the fixture's directory instead
# It never reads the prompt beyond the -p argument and never touches anything outside its
# working directory.
set -uo pipefail
case "${1:-}" in --version) echo "experiment-stub-agent (no model)"; exit 0 ;; esac
mode="${XP_STUB:-apply}"
note="${XP_NOTE:-}"
envelope() {
  node -e 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,num_turns:1,
    result:process.argv[1], total_cost_usd:0, usage:{input_tokens:0,output_tokens:0},
    modelUsage:{"experiment-stub":{inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0}}})+"\n")' "$1"
}
commit() {
  git -c user.name=gaffer-experiment -c user.email=experiment@gaffer.invalid -c commit.gpgsign=false \
    commit -q -m "experiment stub: $1" >/dev/null 2>&1
}
patch=""
case "$mode" in
  noop) envelope "Made no change (stub arm: noop)."; exit 0 ;;
  patch:*) patch="${XP_FIXTURE_DIR:-}/${mode#patch:}" ;;
  *) patch="${XP_PATCH:-}" ;;
esac
if [ -n "$patch" ] && [ -f "$patch" ]; then
  if git apply --index --whitespace=nowarn "$patch" 2>/dev/null; then
    commit "apply $(basename "$patch")"
  fi
elif [ -n "${XP_REPLAY_RANGE:-}" ]; then
  # A manifest's recorded change: the objects are reachable through the clone's alternates.
  if git diff --binary "$XP_REPLAY_RANGE" 2>/dev/null | git apply --index --whitespace=nowarn 2>/dev/null; then
    commit "replay $XP_REPLAY_RANGE"
  fi
fi
envelope "Applied the recorded change.

Smallest-change note: ${note:-the recorded change}"
