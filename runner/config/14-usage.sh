# shellcheck shell=bash
# runner/config/14-usage.sh: usage: the usage ledger path, the killed-call estimate and the helpers that
# book every agent call and lane verdict.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Honest USAGE LEDGER (per agent invocation) ------------------------------
# Every headless `claude -p` call is switched to `--output-format json` and its
# real usage (tokens verbatim, dollars RELAYED from Claude Code's own
# total_cost_usd / modelUsage[*].costUSD — never computed from a price table) is
# appended as one JSONL record to the usage ledger. Mirrors the safety-block
# ledger: best-effort, gated on GAFFER_DATA, fully swallowed — a ledger failure
# NEVER fails or alters a tick. A call that can't be measured (timeout / crash /
# missing/unparseable JSON / no usage field) is recorded as "unknown", never 0,
# so a partial run can't read as "cheap". Each record also names the call: the
# delivery `attempt`, the `model_requested` (`default` = the CLI's own) beside the
# measured `models` map, and the `claude_version` that ran it (lib/worker.sh), and
# every delivery attempt gets matching agent-run evidence on its ticket.
# run-summary.sh renders the run-scoped Usage section. Override the ledger PATH here (mirrors GAFFER_BLOCK_LEDGER's
# run-summary default); empty/unset → $GAFFER_DATA/usage-ledger.jsonl.
GAFFER_USAGE_LEDGER="${GAFFER_USAGE_LEDGER:-$GAFFER_DATA/usage-ledger.jsonl}"
export GAFFER_USAGE_LEDGER

# GAFFER_KILL_ESTIMATE_USD — budget honesty for a KILLED / TIMED-OUT `claude -p`
# call (Part A). Such a call emits no clean result envelope, so today its cost is
# recorded "unknown" and every spend summation skips it — i.e. it books $0, and an
# unattended run that keeps timing out looks FREE while it is really burning tokens.
# When the ledger CLI hits a killed/timeout branch it instead records a CONSERVATIVE
# ESTIMATE (measured:false, total_cost_usd stays "unknown", but a labelled
# estimated_cost_usd that DOES count toward windowed spend). The estimate prefers the
# factory's OWN measured history for that kind: the median $/ms rate times how long the
# killed call ran (capped at the kind's P90 cost), else the P10 when the run time is
# unknown; this value is the FLAT FLOOR under it and the fallback when there isn't
# enough history (a floor, NOT precision). The .mjs helpers (planner, spec author,
# product owner, tester, onboarding, merge resolver) read it too (default 0.05 when
# run outside this config). The same estimate is booked for a call that exited 0 but
# whose envelope reported no dollar total (its tokens are kept; dollars are never
# worked out from them). 0 with no usable history leaves such rows "unknown", and
# with a dollar cap set an unknown row booked today refuses every paid launch until
# the operator books the cost (`node lib/usage-ledger.mjs --reconcile --usd <amount>`)
# or the UTC day turns over. Measured calls ignore it.
: "${GAFFER_KILL_ESTIMATE_USD:=0.05}"   # USD booked for a call killed or timed out before it reported its cost, or that reported no dollar total (the budget gates count it)
export GAFFER_KILL_ESTIMATE_USD

# gaffer_usage_record <kind> <ticket-or-empty> <rc> <captured-json-file>
# Hands the captured `--output-format json` stdout to the usage-ledger CLI, which
# PRINTS the agent's `.result` text to stdout (so the caller keeps a
# human-readable log) and appends one ledger record. Fully swallowed: a missing
# module / node error must never affect the tick (we still emit nothing and
# return 0). Stdout of this function is the agent's text only.
#
# A-1 (parallel execution): the ledger is a SHARED append-only JSONL file. Under
# GAFFER_CONCURRENCY>1 several workers record usage concurrently; a record can
# exceed the OS atomic-append size (PIPE_BUF), so two appends could interleave and
# corrupt a line. We serialise the whole record call under .ledger.lock when
# gaffer_with_lock is defined (always, via this file). gaffer_with_lock runs the
# command in-process with inherited stdout, so the agent's `.result` passthrough is
# preserved. At concurrency 1 the lock is uncontended → behaviour is unchanged.
gaffer_usage_record() {
  local kind="$1" ticket="${2:-}" rc="${3:-0}" jsonfile="$4"
  # [elapsed-ms] — how long the call ran; defaults to the last worker_deliver's
  # figure (consumed here so a later record never reuses it). It scales a killed
  # call's estimate (usage-ledger.mjs deriveKillEstimate); a measured call ignores it.
  local elapsed="${5:-${WORKER_LAST_ELAPSED_MS:-}}"
  WORKER_LAST_ELAPSED_MS=""
  # [attempt] — the delivery attempt this call was (tick.sh passes it). The model the
  # call asked for and the CLI version that ran it come from the last worker_deliver
  # (lib/worker.sh) and are consumed here like the elapsed time.
  local attempt_n="${6:-}" model="${WORKER_LAST_MODEL:-}" cliver="${WORKER_LAST_CLAUDE_VERSION:-}"
  local wprov="${WORKER_LAST_PROVIDER:-}"
  WORKER_LAST_MODEL=""; WORKER_LAST_CLAUDE_VERSION=""; WORKER_LAST_PROVIDER=""
  local -a prov=()
  [ -n "$attempt_n" ] && prov+=(--attempt "$attempt_n")
  [ -n "$model" ] && prov+=(--model "$model")
  [ -n "$cliver" ] && prov+=(--claude-version "$cliver")
  # The worker provider that ran the call; the ledger names it only when it is not
  # claude-code, so a claude-code factory's rows are unchanged.
  [ -n "$wprov" ] && [ "$wprov" != claude-code ] && prov+=(--worker-provider "$wprov")
  local mod="$RUNNER_DIR/lib/usage-ledger.mjs"
  [ -f "$mod" ] || return 0
  # R-4: an append failure used to be doubly hidden — node stderr went to /dev/null
  # here AND the tick.sh call sites discard stderr too. The ledger module now emits a
  # WARNING line on a real append failure (a measurement gap), so route the module's
  # stderr to the factory log ($GAFFER_LOG) instead of dropping it. The append itself
  # stays best-effort (the trailing `|| true` keeps a ledger problem from failing the
  # tick), but the WARNING is now VISIBLE in the log.
  # [attempt] — a DELIVERY record also carries its attempt id (GAFFER_USAGE_ATTEMPT_ID: a
  # hash of the claim + the attempt number) and spawn time (GAFFER_USAGE_STARTED_AT), set
  # by tick.sh around the delivery spawn, so the Health report can tell the first attempt
  # from the correction that followed a send-back. Other kinds never carry them.
  local attempt="" started=""
  if [ "$kind" = delivery ]; then attempt="${GAFFER_USAGE_ATTEMPT_ID:-}"; started="${GAFFER_USAGE_STARTED_AT:-}"; fi
  # JOIN KEYS (MF4): the repo and the ticket's risk at call time, set by the call site
  # (GAFFER_USAGE_REPO / GAFFER_USAGE_RISK); a judging kind's row also gets the attempt
  # it judged from the ledger itself (usage-ledger.mjs withJoinKeys). MF3: the router's
  # decision for this ticket and phase (gaffer_route_record).
  [ -n "${GAFFER_USAGE_REPO:-}" ] && prov+=(--repo "$GAFFER_USAGE_REPO")
  [ -n "${GAFFER_USAGE_RISK:-}" ] && prov+=(--risk "$GAFFER_USAGE_RISK")
  local _rphase; _rphase="$(gaffer_route_phase_of "$kind")"
  if [ -n "$ticket" ] && [ -n "$_rphase" ] && [ -f "${GAFFER_DATA:-}/.route/$ticket.$_rphase.json" ]; then
    prov+=(--route-file "$GAFFER_DATA/.route/$ticket.$_rphase.json")
  fi
  if declare -F gaffer_with_lock >/dev/null 2>&1; then
    gaffer_with_lock "$GAFFER_DATA/.ledger.lock" \
      node "$mod" --kind "$kind" ${ticket:+--ticket "$ticket"} --rc "$rc" --kill-estimate "${GAFFER_KILL_ESTIMATE_USD:-0}" ${elapsed:+--elapsed-ms "$elapsed"} ${prov[@]+"${prov[@]}"} ${attempt:+--attempt-id "$attempt"} ${started:+--started-at "$started"} --json-file "$jsonfile" 2>>"$GAFFER_LOG" || true
  else
    node "$mod" --kind "$kind" ${ticket:+--ticket "$ticket"} --rc "$rc" --kill-estimate "${GAFFER_KILL_ESTIMATE_USD:-0}" ${elapsed:+--elapsed-ms "$elapsed"} ${prov[@]+"${prov[@]}"} ${attempt:+--attempt-id "$attempt"} ${started:+--started-at "$started"} --json-file "$jsonfile" 2>>"$GAFFER_LOG" || true
  fi
}

# gaffer_record_agent_run <ticket> <usage-json> <rc> <attempt> <max-attempts> [role]
# Attach the per-attempt AGENT-RUN evidence: the model that served the call (the
# measured modelUsage ids, else the one it asked for), the Claude Code CLI version
# and the attempt number (usage-ledger.mjs agentRunEvidence). Reads the model/version
# the last worker_deliver recorded WITHOUT consuming them — gaffer_usage_record does
# that. Best-effort: a failure here never touches the delivery.
gaffer_record_agent_run() {
  local ticket="$1" jsonfile="$2" rc="${3:-}" attempt="${4:-}" max="${5:-}" role="${6:-delivery}"
  local mod="$RUNNER_DIR/lib/usage-ledger.mjs" out summary payload
  [ -n "$ticket" ] && [ -f "$mod" ] || return 0
  out="$(node "$mod" --agent-run-evidence --json-file "$jsonfile" --role "$role" \
    ${rc:+--rc "$rc"} ${attempt:+--attempt "$attempt"} ${max:+--max-attempts "$max"} \
    --model "${WORKER_LAST_MODEL:-default}" --claude-version "${WORKER_LAST_CLAUDE_VERSION:-unknown}" 2>/dev/null)" || return 0
  { IFS= read -r summary; IFS= read -r payload; } <<<"$out"
  [ -n "$summary" ] && [ -n "$payload" ] || return 0
  wg attach-evidence "$ticket" --type log --summary "$summary" --payload-json "$payload" >/dev/null 2>&1 || true
  return 0
}

# gaffer_lane_verdict <ticket> <lane> <verdict> [commit] [held-reason] [model]
# MF2: record what a judging lane (agent-review, security-review, tester, eval-judge)
# concluded about the candidate as a SYSTEM `ticket.lane_verdict` event, with the attempt
# it judged (the ticket's latest delivery row in the usage ledger). A measurement: no gate
# reads it. Fail-soft: a refusal or an unreachable dispatch only loses the measurement.
gaffer_lane_verdict() {
  local ticket="${1:-}" lane="${2:-}" verdict="${3:-}" commit="${4:-}" held="${5:-}" model="${6:-}"
  [ -n "$ticket" ] && [ -n "$lane" ] && [ -n "$verdict" ] || return 0
  type wg >/dev/null 2>&1 || return 0
  local mod="$RUNNER_DIR/lib/usage-ledger.mjs" attempt=""
  [ -f "$mod" ] && attempt="$(node "$mod" --latest-delivery-attempt --ticket "$ticket" 2>/dev/null || true)"
  model="${model#--model }"; model="${model#--model=}"
  # REPLAY MANIFEST: the verdict also goes on the ticket's latest attempt manifest.
  declare -F gaffer_manifest_annotate >/dev/null 2>&1 && gaffer_manifest_annotate "$ticket" "$lane" "$verdict"
  wg ticket lane-verdict "$ticket" --lane "$lane" --verdict "$verdict" ${commit:+--commit "$commit"} \
    ${attempt:+--attempt-id "$attempt" --attempt-id-basis latest_delivery_row} ${held:+--held-reason "$(printf '%s' "$held" | tr '\n' ' ' | cut -c1-300)"} \
    ${model:+--model "$model"} --as system >/dev/null 2>&1 \
    || { type log >/dev/null 2>&1 && log "LANE-VERDICT: could not record the $lane verdict on #$ticket (a measurement only)" || true; }
  return 0
}

# gaffer_delivery_attempt_stamp <attempt-n> — print "<attempt-id> <iso-now-ms>" for the
# delivery spawn about to start. The id is "c" + 12 hex of sha256(claim token) + "/<n>":
# stable across one claim's in-tick retries, different for the next claim, and never
# the token itself (it is read from stdin, so it is not on any argv). Tokenless (a
# DRY_RUN or a tokenless resume): "t<ticket>-nolease/<n>". Millisecond time, because
# a send-back and the next spawn can land in the same second.
gaffer_delivery_attempt_stamp() {
  printf '%s' "${CLAIM_TOKEN:-}" | node -e '
    let tok = ""; process.stdin.on("data", (d) => (tok += d)).on("end", () => {
      const n = process.argv[1] || "1", t = process.argv[2] || "0";
      const key = tok ? "c" + require("crypto").createHash("sha256").update(tok).digest("hex").slice(0, 12) : `t${t}-nolease`;
      process.stdout.write(`${key}/${n} ${new Date().toISOString()}`);
    });' "${1:-1}" "${NUM:-0}" 2>/dev/null || true
}

_GAFFER_CONFIG_PART=14-usage
