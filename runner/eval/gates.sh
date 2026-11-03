# runner/eval/gates.sh: the post-delivery GATE PIPELINE the offline harnesses replay:
# the same library functions tick.sh runs, in tick order, over a committed delivery branch
# (hygiene, minimalism, Definition of Done, acceptance checks), and the outcome tick.sh
# would take (submit / rework:<gate>) with the review flags it would carry. Sourced by
# replay.sh (the golden gate fixtures) and experiment.sh (the matched experiment runner);
# the caller sources lib/dod.sh, hygiene.sh, minimalism.sh and ac-checks.sh first, defines
# the `wg` recorder and sets FX (fixture.mjs).
# shellcheck shell=bash
#
#   eval_gate_pipeline <fixture.json> <repo> <work-dir> <note>
#     → 0, with <work>/verdict.tsv (hygiene minimalism dod ac outcome flags dod_failed) and
#       <work>/gate-rows.tsv; non-zero when the pipeline itself errored.
eval_gate_pipeline() {
  local json="$1" repo="$2" work="$3" note="${4:-}"
  # Fixture-scoped policy knobs (MINIMALISM_REQUIRE_NOTE, GAFFER_ALLOW_NO_DOD,
  # OVERSIZED_MAX_LINES …) apply in a subshell so fixtures cannot leak into each other.
  (
    set -uo pipefail
    while IFS= read -r kv; do [ -n "$kv" ] && export "${kv?}"; done < <(node "$FX" env "$json")
    export REPLAY_WG_LOG="$work/wg-calls.log"; : > "$REPLAY_WG_LOG"
    base_branch=main
    # 1 · hygiene: same call and same base...HEAD diff as tick.sh.
    if gaffer_assert_clean_delivery "$repo" "$base_branch" > "$work/hygiene.txt"; then hygiene=ok; else hygiene=violation; fi
    # 2 · minimalism: stats from the branch diff, the note from the fixture (in the
    #     factory it is the agent's recorded smallest-change evidence).
    read -r mz_files mz_lines <<< "$(gaffer_diff_stats "$repo" "$base_branch")"
    mz_note="$note"
    mz_changed="$(git -C "$repo" diff --name-only "$base_branch"...HEAD 2>/dev/null | tr '\n' ' ')"
    GAFFER_MINIMALISM_REASON=""
    # In THIS shell (stdout → file, not a $() subshell) so the reason global survives: as tick.sh does.
    gaffer_check_minimalism "${mz_files:-0}" "${mz_lines:-0}" "$mz_note" "$mz_changed" > "$work/.mz-verdict" 2>/dev/null || true
    minimalism="$(tr -d '\n' < "$work/.mz-verdict")"; rm -f "$work/.mz-verdict"
    printf 'files=%s lines=%s verdict=%s reason=%s\n' "$mz_files" "$mz_lines" "$minimalism" "${GAFFER_MINIMALISM_REASON:-}" > "$work/minimalism.txt"
    # 3 · Definition of Done: the TAB-row contract, in the delivery worktree.
    dod_results="$work/dod.results"
    #     typecheck with no configured command falls back to the package.json
    #     detection tick.sh uses (gaffer_dod_typecheck_cmd, base branch first).
    tc_detected="$(GAFFER_DOD_TYPECHECK_CMD="" gaffer_dod_typecheck_cmd "$repo" "$base_branch")"
    if node "$FX" gate-row "$json" "$repo" "$tc_detected" | gaffer_run_dod_gates "$dod_results"; then dod=PASS; else dod=FAIL; fi
    dod_failed_csv="$(awk -F'\t' '$1=="GATE" && $4=="FAIL" {print $2}' "$dod_results" | paste -sd, -)"
    executed="$(gaffer_dod_executed_count "$dod_results")"
    # 4 · acceptance checks: the ticket payload the library parses, `wg` recording.
    ticket_json="$(node "$FX" ticket-json "$json")"
    ac_results="$work/ac.results"; : > "$ac_results"
    if [ "$(gaffer_ac_check_count "$ticket_json")" -gt 0 ]; then
      if gaffer_run_ac_checks 1 "$ticket_json" "$repo" "$ac_results"; then ac=PASS; else ac=FAIL; fi
    else
      ac=none
    fi
    # ── outcome: tick.sh's policy, first failure in tick order ──
    flags_csv=""
    outcome=submit
    if [ "$hygiene" = violation ]; then outcome="rework:hygiene"; fi
    case "$minimalism" in
      missing_note)
        if [ "${MINIMALISM_REQUIRE_NOTE:-0}" = "1" ]; then
          [ "$outcome" = submit ] && outcome="rework:minimalism"
        else flags_csv="${flags_csv}missing_note,"; fi ;;
      oversized_diff) flags_csv="${flags_csv}oversized_diff," ;;
      unverified_note) flags_csv="${flags_csv}unverified_note," ;;
    esac
    # Size is judged on its own (tick.sh attaches the oversized flag next to a note flag).
    case "$minimalism" in
      missing_note|unverified_note)
        if [ -n "${GAFFER_MINIMALISM_OVERSIZED:-}" ] && { [ "${MINIMALISM_REQUIRE_NOTE:-0}" != "1" ] || [ "$minimalism" = unverified_note ]; }; then
          flags_csv="${flags_csv}oversized_diff,"
        fi ;;
    esac
    if gaffer_dod_enabled; then
      if [ "$dod" = FAIL ]; then
        [ "$outcome" = submit ] && outcome="rework:definition-of-done"
      elif [ "${executed:-0}" -eq 0 ]; then
        if [ "${GAFFER_ALLOW_NO_DOD:-0}" = "1" ]; then flags_csv="${flags_csv}zero_gates_waived,"
        else flags_csv="${flags_csv}zero_gates,"; [ "$outcome" = submit ] && outcome="rework:definition-of-done"; fi
      fi
    else
      flags_csv="${flags_csv}dod_disabled,"
    fi
    if [ "$ac" = FAIL ] && [ "$outcome" = submit ]; then outcome="rework:acceptance-check"; fi
    # Hand the verdicts back to the parent shell as a TAB record.
    # `-` for an empty column: TAB is IFS whitespace, so an empty field would collapse on read.
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$hygiene" "$minimalism" "$dod" "$ac" "$outcome" "${flags_csv%,}" "$dod_failed_csv" \
      | sed 's/\t\t/\t-\t/g; s/\t\t/\t-\t/g; s/\t$/\t-/' > "$work/verdict.tsv"
    { cat "$dod_results"; cat "$ac_results"; } | awk -F'\t' '$1=="GATE"' > "$work/gate-rows.tsv"
  )
}
