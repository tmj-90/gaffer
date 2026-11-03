/**
 * Gaffer factory — the DECISION of the Claude Code PreToolUse safety hook (the
 * deterministic bouncer).
 *
 * runner/safety-hook.mjs is the hook Claude Code runs. It is a thin wrapper: it
 * reads the tool call JSON on stdin, hands it to decideRaw() (re-exported below) and
 * exits 0 (allow) or 2 (BLOCK, the reason on stderr). Every rule is reached through
 * this module (the code lives in runner/lib/hook/, map below), so the tests can run
 * them in-process instead of paying a node start-up per check; the wrapper
 * adds no rule of its own and keeps the process contract (exit codes, stderr,
 * stdout flush, the fail-closed guards).
 *
 * Deny-by-default for the dangerous classes; everything else is allowed. The only
 * external dependency is the dangerous-command deny-list, loaded via a guarded
 * dynamic import that FAILS CLOSED (blocks) if the sibling is missing/broken — see
 * lib/hook/deny-list.mjs. Everything else is self-contained so a change elsewhere
 * can't weaken it.
 *
 * Mirrors Crew's safety classifiers (git/fs/command) but is intentionally
 * duplicated here: a security control should not depend on another build.
 *
 * SECRET BOUNDARY MODEL (the CONTENTS-LEAVING block in lib/hook/reads.mjs): the
 * secret-read guard is NOT a denylist of reader binaries. It treats the *secret
 * path* as the protected thing and over-blocks whenever a shell construct hides the
 * data flow. HONEST RESIDUAL LIMITATION: a fully-dynamic path (assembled at runtime,
 * never appearing literally and not routed through a read-ish tool or `$(...)`)
 * can still slip past a regex. This hook is defence-in-depth, not a jail — real
 * containment of a determined exfil needs an OS sandbox / permission boundary.
 *
 * INPUT-SIZE CAP (MAX_INSPECTED_FIELD_BYTES in lib/hook/decide.mjs): before
 * JSON.parse, and again before any rule or regex reads a field, an oversized input
 * BLOCKS with "unverifiable: tool input too large (…)" (ledger category
 * `oversized-input`).
 * Several rules are super-linear in the input length (a 100 KB deep path took
 * 60-70s), so the cap bounds the input every rule sees; it sits well above any
 * legitimate tool call seen. The caps are constants, never env-configurable: a
 * knob would only ever be a way to loosen the boundary.
 *
 * MODULE MAP (runner/lib/hook/). Each module imports only modules listed above it.
 * A rule module returns a reason (or null); only decide.mjs blocks or allows.
 *   shell.mjs          tokenizing, quoting, segments, redirects, variable substitution
 *   paths.mjs          canonicalize, write and read roots, the secret-path families,
 *                      tilde expansion and cd replay
 *   verbs.mjs          the effective verb: assignments, wrappers, package runners, the
 *                      privileged CLI names, sh -c bodies
 *   deny-list.mjs      lib/dangerous-commands.mjs, loaded so that a failure blocks
 *   interpreters.mjs   the inline-interpreter write and read boundary
 *   reads.mjs          secret reads and credentials, git secret ops, Bash read targets
 *   writes.mjs         Bash write targets
 *   installs.mjs       the bootstrap install allowance, --ignore-scripts
 *   git.mjs            branch creation, branch ref rewrites, the git execution surface
 *   factory.mjs        the factory front door (running the factory's own code)
 *   control-plane.mjs  control-plane verbs and CP_PAIRS, verb slots, normalised views
 *   decide.mjs         the input-size cap, HookVerdict / block / allow and their
 *                      telemetry, the per-tool checks, runDecision, decideRaw, decide
 * runner/test/safety-hook-golden-corpus.test.mjs pins the verdict for every tool call
 * the hook suites make, so a change that moves a verdict shows up there.
 */
export {
  MAX_INSPECTED_FIELD_BYTES,
  MAX_PAYLOAD_BYTES,
  decide,
  decideRaw,
} from "./lib/hook/decide.mjs";
