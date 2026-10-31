# shellcheck shell=bash
# Shared setup for the GATE INTEGRITY end-to-end tests (gate-integrity-e2e.test.sh,
# gate-integrity-e2e-retry.test.sh): checks the deps, sources lib/stub-tick.sh (a real
# repo, the real dispatch + memory CLIs and tick.sh, a stub `claude`) and defines the
# evidence helpers. Sourced after the caller set HERE/RUNNER_DIR/ROOT. Split in two
# files so each stays well inside run.sh's per-test cap under CI's -j load.
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }
command -v perl >/dev/null 2>&1 || { echo "SKIP: perl required (timeout primitive)"; exit 0; }
for f in packages/dispatch/dist/cli/index.js packages/memory/dist/bin/memory.js packages/crew/dist/cli/index.js \
         packages/crew/dist/runtime/dod/gateIntegrityCli.js; do
  [ -f "$ROOT/$f" ] || { echo "SKIP: $f not built (run pnpm -r build)"; exit 0; }
done

STUB_TICK_NAME="${STUB_TICK_NAME:-gate-integrity-e2e}"
# shellcheck source=lib/stub-tick.sh
source "$HERE/lib/stub-tick.sh"
export GAFFER_MAX_DELIVERY_ATTEMPTS=1   # one attempt per case: the stub repeats itself

# The DoD evidence JSON line (`{"dod":…,"gates":[…]}`) most recently recorded on a ticket.
dod_json() {
  wg ticket show "$1" 2>/dev/null | jget '(() => {
    const ev = (d.evidence || []).filter((e) => e.evidence_type === "test_output" && /^DoD: /.test(e.summary || ""));
    const last = ev[ev.length - 1];
    return last ? last.summary.split("\n")[1] : "";
  })()'
}
gate_field() {  # <json> <gate> <field>
  node -e 'const j=JSON.parse(process.argv[1]||"{}");const g=(j.gates||[]).find(x=>x.gate===process.argv[2]);process.stdout.write(g?String(g[process.argv[3]]??""):"")' "$1" "$2" "$3"
}
ticket_events() { wg ticket show "$1" 2>/dev/null | jget 'JSON.stringify(d.events || [])'; }
