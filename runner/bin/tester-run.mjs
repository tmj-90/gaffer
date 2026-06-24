#!/usr/bin/env node
// Gaffer factory — the `tester-run` runner (BBT-001 independent black-box testing).
//
// This is the testing analog of the merge runner. When a ticket is APPROVED at
// review AND the GAFFER_TESTING lane is on AND the ticket is `can_be_tested`, the
// dispatch state machine routes it `in_review -> in_testing` (see core.ts
// approveReview). THIS runner is the seam that, for an `in_testing` ticket, would
// spawn an INDEPENDENT tester agent to write automated tests from the
// test_contract + acceptance criteria ONLY — never the implementation diff — and
// then records the verdict (pass -> ready_for_merge, fail -> refining) back through
// dispatch.
//
// THE CENTERPIECE INVARIANT: the context packet this runner assembles for the
// tester EXCLUDES the diff/implementation. The tester is told WHAT changed at the
// boundary (changed_surfaces), HOW to stand the system up (runtime_deps, env_vars,
// run_command, harness_ready) and the acceptance criteria to assert against — and
// nothing about HOW the change was implemented. That is what makes the test
// independent: it catches "impl passes its own tests but doesn't satisfy the AC".
//
// This pass implements the REAL, TESTED pieces: the context assembly (proven to
// omit the diff), the DISPATCH_TESTER_CMD seam, and the pass/fail -> transition
// wiring (stubbable so it is exercised without a live model). The live `claude -p`
// tester invocation is the documented follow-up: with --dry-run (or no
// DISPATCH_TESTER_VERDICT_CMD configured) this runner reports the planned context
// WITHOUT spawning a model, exactly like merge-ticket.mjs --dry-run.
//
// =====================================================================
// CLI CONTRACT
// ---------------------------------------------------------------------
// INVOCATION:
//   node bin/tester-run.mjs --ticket <number> [--dry-run] [--verdict pass|fail]
//                           [--summary <text>]
//
// ENV IN (defaults mirror factory.config.sh / merge-ticket.mjs):
//   DISPATCH_DB   dispatch sqlite — ticket → AC + test_contract resolution
//                  (read-only node:sqlite). Defaults to the factory.config.sh path.
//   DISPATCH_TESTER_VERDICT_CMD  the operator/test seam used to RECORD the verdict
//                  back through dispatch (mirrors how the runner shells to `wg`).
//                  It is invoked as: <cmd...> <ticket> <verdict> <summary>. When
//                  unset, the runner falls back to the bundled `wg` CLI tester-pass
//                  / tester-fail. A STUB command here makes the verdict→transition
//                  wiring fully testable with no live model.
//
// FLAGS:
//   --ticket <number>   (required) the in_testing ticket to test.
//   --dry-run           assemble + print the CONTRACT-ONLY context as JSON and
//                       STOP — never spawn a model, never record a verdict (the
//                       test seam that asserts the diff is absent).
//   --verdict pass|fail when given (the stubbed-tester path), record this verdict
//                       through the seam instead of running a live tester.
//   --summary <text>    the verdict summary (the passing/failing test result).
//
// OUTPUT (stdout, exactly ONE JSON object):
//   dry-run:  { "phase":"dry-run", ticket, context }
//   verdict:  { "phase":"verdict", ticket, verdict, recorded }
//   error:    { "phase":"error", error }   (exit 1)
//
// EXIT: 0 on dry-run / verdict; 1 on a hard failure (no ticket, unresolvable,
//   record failure).
// =====================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite is only reachable via createRequire in an ESM module.
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");
const GAFFER_DATA = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");

const CONFIG = {
  dispatchDb: process.env.DISPATCH_DB || resolve(GAFFER_DATA, "dispatch.sqlite"),
};

function log(msg) {
  process.stderr.write(`[tester-run] ${msg}\n`);
}

/** Emit a single JSON object on stdout (for the detached log) and exit. */
function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}
function fail(reason, code = 1) {
  log(`ERROR: ${reason}`);
  emit({ phase: "error", error: reason }, code);
}

function parseArgs(argv) {
  const opts = { ticket: "", dryRun: false, verdict: "", summary: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--ticket":
        opts.ticket = next() ?? "";
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--verdict":
        opts.verdict = next() ?? "";
        break;
      case "--summary":
        opts.summary = next() ?? "";
        break;
      default:
        break;
    }
  }
  return opts;
}

/** Parse the JSON test_contract column into a plain object (tolerant of nulls). */
function parseContract(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return {
      changed_surfaces: list(o.changed_surfaces),
      runtime_deps: list(o.runtime_deps),
      env_vars: list(o.env_vars),
      run_command: typeof o.run_command === "string" ? o.run_command : "",
      harness_ready: o.harness_ready === true,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a ticket NUMBER → the CONTRACT-ONLY testing context, via the dispatch
 * sqlite DB (read-only, zero deps). It reads the ticket's title/description/status,
 * its acceptance criteria, and its test_contract — and DELIBERATELY NOT its
 * branch_name, pr_url, or any per-repo delivery branch, so the assembled context
 * can never carry a pointer to the implementation diff. Importable + side-effect-free
 * so a test can assert the diff is absent.
 *
 * Returns { ticketId, number, title, description, status, acceptanceCriteria[],
 * testContract, mode } or null when the ticket can't be resolved or isn't in
 * `in_testing`. `mode` is "harness" when the contract's harness_ready is false (the
 * tester stands the rig up once), else "black-box".
 */
export function assembleContext(dbPath, number) {
  const num = parseInt(String(number ?? "").trim(), 10);
  if (!Number.isInteger(num) || num <= 0) return null;
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // NOTE: branch_name / pr_url are intentionally NOT selected — the tester must
    // never receive a pointer to the implementation. Only the operational contract
    // + the acceptance criteria reach it.
    const ticket = db
      .prepare(
        "SELECT id, number, title, description, status, can_be_tested AS canBeTested, " +
          "test_contract AS testContract FROM tickets WHERE number = ?",
      )
      .get(num);
    if (!ticket || !ticket.id) return null;
    if (String(ticket.status) !== "in_testing") return null;

    const acs = db
      .prepare(
        "SELECT id, text, status FROM acceptance_criteria WHERE ticket_id = ? ORDER BY sort_order ASC",
      )
      .all(ticket.id);

    const testContract = parseContract(ticket.testContract);
    const harnessReady = testContract ? testContract.harness_ready === true : false;
    // SAFETY: run_command (inside testContract) is CONTRACT TEXT ONLY. This seam
    // assembles it into the context but NEVER executes it. When a live tester is
    // implemented it must NOT spawn this contract-authored string directly — it has
    // to go through the safety hook + the worktree write-root/read-root boundary and
    // be a JSON argv (not a shell string) or a human-approved harness file.

    return {
      ticketId: String(ticket.id),
      number: ticket.number,
      title: String(ticket.title || ""),
      description: String(ticket.description || ""),
      status: String(ticket.status),
      acceptanceCriteria: acs.map((a) => ({
        id: String(a.id),
        text: String(a.text || ""),
        status: String(a.status || ""),
      })),
      testContract,
      // The two modes from the skill: a harness has to be stood up first (one-time),
      // or it already exists and the tester extends tests against it.
      mode: harnessReady ? "black-box" : "harness",
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Record a tester verdict back through dispatch. Uses DISPATCH_TESTER_VERDICT_CMD
 * (parsed into argv, no shell) when configured — the stub seam tests drive — invoked
 * as `<cmd...> <ticket> <verdict> <summary>`. The override is read as a JSON argv
 * array (preferred — space-safe, matching the other DISPATCH_*_CMD seams) and falls
 * back to whitespace-splitting a plain string for back-compat. Otherwise it shells to
 * the bundled `wg` CLI: `wg ticket tester-pass|tester-fail <ticket> --summary <text>
 * --as agent`. Returns { ok, code } and never throws on a spawn failure.
 */
export function recordVerdict(ticketNumber, verdict, summary, env = process.env) {
  const action = verdict === "pass" ? "tester-pass" : "tester-fail";
  const override = (env.DISPATCH_TESTER_VERDICT_CMD ?? "").trim();
  let argv;
  if (override) {
    // JSON argv (e.g. ["node","/path with spaces/x.mjs"]) keeps a path with spaces a
    // single token; a plain string falls back to whitespace-splitting.
    let tokens;
    try {
      const parsed = JSON.parse(override);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((t) => typeof t === "string")
      ) {
        tokens = parsed;
      }
    } catch {
      // not JSON — treat as a plain whitespace-separated command below
    }
    tokens ??= override.split(/\s+/).filter((t) => t.length > 0);
    const [bin, ...rest] = tokens;
    argv = [bin, [...rest, String(ticketNumber), verdict, summary]];
  } else {
    argv = ["wg", ["ticket", action, String(ticketNumber), "--summary", summary, "--as", "agent"]];
  }
  const res = spawnSync(argv[0], argv[1], { encoding: "utf8" });
  if (res.error) return { ok: false, code: null, error: String(res.error.message ?? res.error) };
  return { ok: (res.status ?? 1) === 0, code: res.status ?? null };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!String(opts.ticket).trim()) {
    fail("--ticket <number> is required");
    return;
  }

  const context = assembleContext(CONFIG.dispatchDb, opts.ticket);
  if (!context) {
    fail(
      `could not assemble a testing context for ticket "${opts.ticket}" — not found, ` +
        `not in_testing, or DB unreadable (db: ${CONFIG.dispatchDb})`,
    );
    return;
  }

  // Defence-in-depth: assert the assembled context carries NO implementation
  // pointer. This is the centerpiece invariant — if it ever regresses, fail loudly
  // rather than silently leak the diff to the tester.
  const serialised = JSON.stringify(context);
  if (/branch_name|pr_url|\bdiff\b/i.test(serialised)) {
    fail("assembled tester context unexpectedly contains an implementation pointer — refusing");
    return;
  }

  // DRY-RUN (the test seam + the documented live-claude follow-up): report the
  // CONTRACT-ONLY context and STOP. The live `claude -p` tester that consumes this
  // context is the documented next step; everything up to and including this packet
  // is real + tested here.
  if (opts.dryRun) {
    emit({ phase: "dry-run", ticket: context.number, context }, 0);
    return;
  }

  // VERDICT path (the stubbed tester): record the supplied verdict through the seam.
  // A real end-to-end run would derive the verdict from the live tester's results;
  // here the verdict is provided so the transition wiring is exercised deterministically.
  if (opts.verdict === "pass" || opts.verdict === "fail") {
    const summary =
      String(opts.summary).trim() ||
      (opts.verdict === "pass"
        ? "black-box tests pass against the contract"
        : "a black-box test fails against the acceptance criteria");
    const recorded = recordVerdict(context.number, opts.verdict, summary);
    if (!recorded.ok) {
      fail(`failed to record the '${opts.verdict}' verdict (exit ${recorded.code ?? "?"})`);
      return;
    }
    emit({ phase: "verdict", ticket: context.number, verdict: opts.verdict, recorded }, 0);
    return;
  }

  // No --dry-run and no --verdict: nothing to do but report the assembled context
  // for the (detached) log. The live tester invocation is the documented follow-up.
  emit({ phase: "dry-run", ticket: context.number, context }, 0);
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
