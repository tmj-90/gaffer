#!/usr/bin/env node
// Gaffer factory — the `merge-ticket` runner (the AUTO_MERGE conflict failure-mode).
//
// When the reviewer approves a ticket (→ done) and AUTO_MERGE=1, tick.sh merges the
// delivery branch into the repo's default branch via gaffer_auto_merge
// (lib/automerge.sh) — conflict-safe and force/push-free. On a CLEAN merge that is
// the whole story. On a CONFLICT, gaffer_auto_merge aborts and leaves the branch for
// a human. THAT is the gap this runner closes: instead of leaving a conflict for a
// human to resolve by hand, it spawns a RESOLVER AGENT that resolves the conflict on
// the delivery branch, then signals the ticket back for RE-APPROVAL with the resolved
// diff as evidence. A human re-reviews the resolution; a later merge lands cleanly.
// There is NEVER a silent force-merge: the resolver proposes ON THE BRANCH only, and
// re-approval gates the actual landing.
//
// This runner mirrors decompose.mjs / product-owner-run.mjs exactly:
//   • same env contract (CLAUDE_BIN / CLAUDE_FLAGS / --mcp-config / project-local
//     .claude settings + safety hook);
//   • a --dry-run seam that reports the PLANNED argv (merge target + resolver claude
//     argv) WITHOUT spawning claude or mutating git — the test seam;
//   • fail-closed if safety-hook.mjs is missing;
//   • spawns through the ONE worker seam (lib/worker.mjs Worker.deliver — provider
//     dispatch + the OS-sandbox containment decision) with the credential-and-
//     endpoint-stripped child env every Node spawn uses (agentChildEnv; the resolver
//     delivers through the dispatch MCP, never the privileged HTTP API);
//   • bounded by a timeout;
//   • emits exactly ONE JSON line on stdout.
//
// =====================================================================
// CLI CONTRACT (tick.sh / the dashboard build to this)
// ---------------------------------------------------------------------
// INVOCATION:
//   node bin/merge-ticket.mjs --ticket <number> [--dry-run] [--timeout-ms N] [--apply-digest-only]
//
// ENV IN (defaults mirror factory.config.sh / product-owner-run.mjs):
//   DISPATCH_DB                 dispatch sqlite — ticket→repo/branch/local_path
//                                resolution (read-only node:sqlite) + the MCP data
//                                plane. Defaults to the factory.config.sh location.
//   MEMORY_DB                 memory sqlite (resolver consults conventions).
//   CLAUDE_BIN / CLAUDE_FLAGS    same headless invocation knobs as tick.sh.
//   MCP_CONFIG / CLAUDE_SETTINGS / SKILLS_DIR   project-local wiring (defaults next to
//                                this checkout, matching factory.config.sh).
//   GAFFER_MERGE_TIMEOUT_MS       kill the resolver after this (default 600000).
//   GAFFER_GH_BIN                PR MODE: the `gh` binary (default `gh`). When the ticket
//                                carries a pr_url (GAFFER_CREATE_PR opened a PR) and gh is
//                                available, the merge lands THROUGH the PR (`gh pr merge
//                                <url> --<method> --delete-branch`) and the local default
//                                branch is fast-forwarded from GAFFER_PR_REMOTE (origin);
//                                a gh failure falls back to the local merge with a logged
//                                reason. No pr_url ⇒ the local merge, exactly as before.
//   GAFFER_PR_MERGE_METHOD       merge (default) | squash | rebase — the gh merge method.
//
// FLAGS:
//   --ticket <number>    (required) the approved ticket whose branch is being merged.
//                        Refused (exit 4, nothing touched) unless it is ready_for_merge
//                        (--apply-digest-only also accepts done) — see canLand.
//   --timeout-ms N       (GAFFER_MERGE_TIMEOUT_MS, default 600000) resolver kill-timer.
//   --apply-digest-only  the merge already landed (review.sh AFK path): skip git + claude
//                        and run only the post-merge memory step (digest + feature).
//   --dry-run            do NOT spawn claude or mutate git; print the planned merge
//                        target + resolver claude argv as JSON (the test seam).
//
// OUTPUT (stdout, exactly ONE JSON object; the phase is the outcome):
//   merged:    { "phase":"merged", ticket, repo, branch, defaultBranch, via, digest }
//              — the merge landed cleanly. `via` is "pr" (landed through the PR;
//                `prUrl` + `fastForwarded` are carried) or "local" (the in-process
//                merge). `digest` reports the POST-REVIEW,
//                DETERMINISTIC (no-agent) Repo-Digest refresh + feature→shipped:
//                { applied, prepared, jobs:[{kind,ok}], error? } — see applyDigestAndFeature.
//                It is best-effort + fully swallowed: it can never fail the merge.
//                When it FAILS, `applied:false` + `error` are carried here AND a
//                prominent WARNING is logged (R-3), so a stale digest / a feature
//                stuck at `building` is VISIBLE rather than silently swallowed.
//   partially_merged:
//              { "phase":"partially_merged", ticket, landed:[repo…], pending:[repo…], error }
//              (exit 4) — PER-REPOSITORY LANDING: a multi-repo ticket lands one merge per
//                write repo (each repo's approved commit). Some landed (recorded in
//                dispatch), at least one did not (conflict, dirty checkout, held check):
//                the ticket stays ready_for_merge, shown "Partly merged" in the human
//                queue, and NOT marked done; a re-run lands only the repos still pending.
//   conflict_resolved_pending_reapproval:
//              { "phase":"conflict_resolved_pending_reapproval", ticket, repo, branch,
//                defaultBranch, reapproval:{...} }
//              — the merge conflicted; the resolver committed a resolution ON THE
//                BRANCH, the resolution passed the re-gate (no conflict markers, the
//                DoD gates green on the resolved head — recorded as fresh evidence for
//                the re-review) and the ticket was signalled for re-approval. The
//                branch is NOT landed to the default branch.
//   conflict_resolved_reapproval_failed:
//              { "phase":"conflict_resolved_reapproval_failed", ticket, repo, branch,
//                defaultBranch, reapproval:{...}, sideRef, restored, error }   (exit 1)
//              — the resolver resolved, but the ticket could NOT be reopened for review
//                (after retries). The unreviewed resolution is moved to `sideRef` and
//                the branch is put back to its pre-resolution head (compare-and-swap),
//                so no later landing can ship it; the ticket waits for a human.
//   conflict_resolution_gate_failed:
//              { "phase":"conflict_resolution_gate_failed", ticket, repo, branch,
//                defaultBranch, regate:{ markers, dod, evidence }, sideRef, restored,
//                error }   (exit 1)
//              — the resolver committed a resolution, but the RE-GATE on the resolved
//                head failed: it left conflict markers in the tree, or the repo's
//                Definition-of-Done gates (tests · typecheck · lint, bin/dod-regate.sh)
//                fail on it. The ticket is NOT reopened; the resolution is moved to
//                `sideRef` and the branch restored (as above), the failing checklist is
//                recorded as evidence, and the ticket waits for a human.
//   conflict_resolver_failed:
//              { "phase":"conflict_resolver_failed", ticket, repo, branch, defaultBranch,
//                resolver_exit, resolver_stderr, error }   (exit 1)
//              — the resolver agent itself exited non-zero; re-approval is not signalled.
//   conflict_unresolved:
//              { "phase":"conflict_unresolved", ticket, repo, branch, defaultBranch,
//                reason, resolver_summary, error }   (exit 1)
//              — the resolver exited 0 but the default branch is not merged into the
//                branch's committed head (aborted, left in progress, unmerged paths);
//                re-approval is not signalled and the branch is left for a human.
//   dry-run:   { "phase":"dry-run", ticket, repo, branch, defaultBranch, timeoutMs,
//                claudeBin, mergeTarget, resolverArgv, status, refused? }
//              — `refused` carries the approval-gate refusal a live run would exit 4 on.
//   error:     { "phase":"error", error }   (exit 1)
//
// EXIT: 0 on merged / dry-run; 1 on any hard
//   failure (missing repo/branch/safety hook, spawn error, timeout, a re-approval that
//   could not be signalled, a REFUSED merge: the
//   live checkout has uncommitted changes, or the default branch could not be checked
//   out — neither is a conflict, so the resolver is never spawned for them); 4 when a
//   gate holds the merge: the ticket is not approved (not ready_for_merge), or the
//   landing check (tester binding) refuses — nothing is merged either way — and on
//   conflict_resolved_pending_reapproval (nothing landed: the resolution waits for a
//   re-review; stderr prints the `gaffer approve N --commit <repo>=<sha>` to run).
// =====================================================================

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildApplyCommands,
  buildFeatureShippedCommands,
  buildMinimalDigestStamp,
  selectPreparedDelta,
  featureIdFromView,
} from "../lib/feature-digest.mjs";
import { refreshFileCards, repoCanonical } from "../lib/onboard-analyze.mjs";
import { maxTurnsArgv, roleTurnCap, Worker } from "../lib/worker.mjs";
import { mountRoleSkills, writeAgentSettings } from "../lib/agent-home.mjs";
import { mountedNames, recordSkillUsage } from "./record-skill-usage.mjs";
import {
  appendUsageRecord,
  buildUsageRecord,
  extractResultText,
  parseClaudeJson,
  recordKilledCall,
} from "../lib/usage-ledger.mjs";
import { agentChildEnv, renderPoMcpRuntime } from "./product-owner-run.mjs";
import { branchHead, landingDecision } from "../lib/tester-binding.mjs";
import {
  applyTesterTests,
  prepareReplayProof,
  replayInvocation,
  replayPlan,
  replayProof,
} from "../lib/tester-replay.mjs";
import { mergeMessage, provenanceTrailers } from "../lib/provenance-trailers.mjs";

// node:sqlite is only reachable via createRequire in an ESM module.
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");
const GAFFER_DATA = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");

// The resolver agent runs the `resolve-merge-conflict` skill, mirroring how the other
// runners pin a specific skill in their prompt.
const RESOLVER_SKILL = "resolve-merge-conflict";

// Defaults mirror factory.config.sh / product-owner-run.mjs so a bare invocation
// resolves the same wiring the rest of the factory uses.
const CONFIG = {
  dispatchDb: process.env.DISPATCH_DB || resolve(GAFFER_DATA, "dispatch.sqlite"),
  memoryDb: process.env.MEMORY_DB || resolve(GAFFER_DATA, "memory.sqlite"),
  mcpConfig: process.env.MCP_CONFIG || resolve(RUNNER_DIR, ".mcp.json"),
  // The built MCP server bins the template's ${DISPATCH_MCP_BIN}/${MEMORY_MCP_BIN} resolve
  // to (the same defaults factory.config.sh / tester-run.mjs use).
  dispatchMcpBin:
    process.env.DISPATCH_MCP_BIN || resolve(GAFFER_HOME, "packages/dispatch/dist/mcp/bin.js"),
  memoryMcpBin:
    process.env.MEMORY_MCP_BIN || resolve(GAFFER_HOME, "packages/memory/dist/bin/memory-mcp.js"),
  claudeSettings: process.env.CLAUDE_SETTINGS || resolve(RUNNER_DIR, "claude", "settings.json"),
  skillsDir: process.env.SKILLS_DIR || resolve(RUNNER_DIR, "skills"),
  claudeBin: process.env.CLAUDE_BIN || "claude",
  // The merge-conflict resolver writes code → IMPL step; prepend the impl model when set.
  claudeFlags: (() => {
    const f = (process.env.CLAUDE_FLAGS || "--permission-mode acceptEdits")
      .split(/\s+/)
      .filter(Boolean);
    const m = (process.env.GAFFER_IMPL_MODEL || "").trim();
    return m ? ["--model", m, ...f] : f;
  })(),
};

const DEFAULTS = {
  timeoutMs: intEnv("GAFFER_MERGE_TIMEOUT_MS", 600000),
};

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseArgs(argv) {
  const opts = { ticket: "", timeoutMs: DEFAULTS.timeoutMs, dryRun: false, applyDigestOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--ticket":
        opts.ticket = next() ?? "";
        break;
      case "--timeout-ms":
        opts.timeoutMs = Math.max(1000, parseInt(next() ?? "", 10) || DEFAULTS.timeoutMs);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--apply-digest-only":
        // The merge ALREADY landed elsewhere (the runner's unattended AFK merge in
        // review.sh): skip git + claude and run only the post-merge memory work —
        // apply the prepared digest delta / freshness stamp + feature → shipped.
        opts.applyDigestOnly = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

function log(msg) {
  process.stderr.write(`[merge-ticket] ${msg}\n`);
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

/**
 * The bare status of ticket #number, for the refusal when resolveTicket finds no
 * landable delivery: `{ exists: false }` for no such ticket (or no readable db),
 * `{ exists: true, status }` otherwise. Read-only; never throws. Exported for tests.
 */
export function ticketStatusOf(dbPath, number) {
  const num = parseInt(String(number ?? "").trim(), 10);
  if (!Number.isInteger(num) || num <= 0 || !existsSync(dbPath)) return { exists: false };
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT status FROM tickets WHERE number = ?").get(num);
    return row ? { exists: true, status: row.status ?? null } : { exists: false };
  } catch {
    return { exists: false };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Why a ticket that is not ready_for_merge cannot be landed, in the operator's words:
 * a done ticket is already merged (approving it again is not a thing), anything
 * else needs an approval first. Pure; exported for tests.
 */
export function notLandableReason(number, status) {
  if (status === "done") return `ticket #${number} is already merged (done); nothing to merge`;
  return (
    `refusing to merge #${number}: ticket is ${status || "of unknown status"}, ` +
    `not ready_for_merge — approve it first (gaffer approve ${number}); nothing merged`
  );
}

/**
 * Resolve a ticket NUMBER → the repo it delivers into and the delivery branch, via
 * the dispatch sqlite DB (read-only, zero deps — node:sqlite ships with Node 22+).
 *
 * It joins tickets → ticket_repos → repositories, picking the WRITE-access repo (the
 * one the change lands in). The delivery branch is the per-repo `ticket_repos.branch_name`
 * when present, else the ticket-level `tickets.branch_name` (matching tick.sh, which
 * trusts the recorded branch_name over a git grep).
 *
 * Returns { ticketId, number, repo:{name,localPath,defaultBranch}, branch } or null
 * when the ticket / its repo / its branch can't be resolved. Side-effect-free and
 * import()-able so tests can exercise it.
 */
export function resolveTicket(dbPath, number) {
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
    // pr_url is the PR the delivery opened (GAFFER_CREATE_PR, recorded by
    // `wg delivery-artifact --pr`); a schema/fixture without the column resolves
    // without it, so a PR-less merge behaves exactly as before. status feeds the
    // approval gate (canLand); a schema without it resolves with status null, which
    // that gate refuses (fail closed) — it never reads as "approved".
    const ticketSql = (withPr, withStatus) =>
      "SELECT id, number, branch_name AS branchName" +
      (withPr ? ", pr_url AS prUrl" : "") +
      (withStatus ? ", status" : "") +
      " FROM tickets WHERE number = ?";
    let ticket;
    let ticketErr;
    for (const [withPr, withStatus] of [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ]) {
      try {
        ticket = db.prepare(ticketSql(withPr, withStatus)).get(num);
        ticketErr = undefined;
        break;
      } catch (e) {
        ticketErr = e;
      }
    }
    if (ticketErr) throw ticketErr;
    if (!ticket || !ticket.id) return null;

    // The write-access execution repo this ticket delivers into. Prefer access='write'
    // (the WG-002 boundary), falling back to the legacy role='primary' so older rows
    // still resolve. tr.branch_name is the per-repo delivery branch.
    const repoSql = (withStack, withPr) =>
      "SELECT r.id AS id, r.name AS name, r.local_path AS localPath, " +
      "r.default_branch AS defaultBranch, " +
      (withStack ? "r.stack AS stack, " : "") +
      (withPr ? "tr.pr_url AS repoPrUrl, " : "") +
      "tr.branch_name AS repoBranch " +
      "FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id " +
      "WHERE tr.ticket_id = ? " +
      "ORDER BY (tr.access = 'write') DESC, (tr.role = 'primary') DESC " +
      "LIMIT 1";
    // An older schema (or a minimal test fixture) may lack repositories.stack and/or
    // ticket_repos.pr_url independently: drop each optional column only when the
    // query with it fails, so a missing `stack` never hides a present `pr_url`.
    let repoRow;
    let lastErr;
    for (const [withStack, withPr] of [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ]) {
      try {
        repoRow = db.prepare(repoSql(withStack, withPr)).get(ticket.id);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    if (!repoRow || !repoRow.localPath) return null;

    // The per-repo delivery row (ticket_repo_delivery) is where the factory records the
    // branch for a multi-repo ticket; fall back to it the same way the review diff does.
    let deliveryBranch = "";
    try {
      const d = db
        .prepare(
          "SELECT branch_name AS b FROM ticket_repo_delivery WHERE ticket_id = ? AND repo_id = ?",
        )
        .get(ticket.id, repoRow.id);
      deliveryBranch = String(d?.b || "");
    } catch {
      deliveryBranch = ""; // pre-v4 schema / minimal fixture
    }
    const branch = String(repoRow.repoBranch || deliveryBranch || ticket.branchName || "").trim();
    if (!branch) return null;
    const prUrl = String(repoRow.repoPrUrl || ticket.prUrl || "").trim();

    // Every WRITE repo's name + stack (the tester mounts the union of their stacks). An
    // older schema without repositories.stack / ticket_repos.relation resolves to [].
    let writeRepos = [];
    for (const withRelation of [true, false]) {
      try {
        writeRepos = db
          .prepare(
            "SELECT r.name AS name, r.stack AS stack FROM ticket_repos tr " +
              "JOIN repositories r ON r.id = tr.repo_id WHERE tr.ticket_id = ? AND tr.access = 'write'" +
              (withRelation
                ? " AND (tr.relation IS NULL OR tr.relation IN ('confirmed', 'implicit_single_repo'))"
                : "") +
              " ORDER BY r.name",
          )
          .all(ticket.id)
          .map((r) => ({ name: String(r.name || ""), stack: r.stack ? String(r.stack) : "" }));
        break;
      } catch {
        writeRepos = [];
      }
    }

    return {
      ticketId: String(ticket.id),
      number: ticket.number,
      repo: {
        id: repoRow.id == null ? "" : String(repoRow.id),
        name: String(repoRow.name || ""),
        localPath: String(repoRow.localPath),
        defaultBranch: String(repoRow.defaultBranch || "main"),
        stack: repoRow.stack ? String(repoRow.stack) : "",
      },
      branch,
      prUrl,
      status: ticket.status == null ? null : String(ticket.status),
      writeRepos,
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
 * The approval gate: may a ticket in `status` be landed? Only `ready_for_merge` (a
 * human, or the AFK reviewer, approved the diff) — the SAME rule the dashboard's merge
 * route enforces (packages/dispatch/src/api/routes/tickets.ts). The route runs in a
 * different process, and `gaffer merge` execs this runner directly, so the runner
 * checks it itself. --apply-digest-only runs AFTER a landed merge, so it also accepts
 * `done` (mark-merged already ran). Anything else — including a missing/unreadable
 * status — is refused (fail closed). Pure; exported for tests.
 */
export function canLand(status, { applyDigestOnly = false } = {}) {
  if (status === "ready_for_merge") return true;
  return applyDigestOnly && status === "done";
}

/**
 * Attempt the conflict-safe merge, mirroring lib/automerge.sh's gaffer_auto_merge
 * semantics in JS so this runner is self-contained: checkout the default branch, then
 * a plain `git merge --no-edit <branch>`. NEVER --force, NEVER reset --hard, NEVER
 * push. On conflict it `git merge --abort`s (restoring the default branch) and reports
 * the conflict so the caller spawns the resolver.
 *
 * Returns { clean: true } on a landed merge, { clean: false } on a conflict (aborted,
 * branch left intact). A FAILED CHECKOUT of the default branch is NOT a conflict: it is
 * reported as { clean: false, checkoutFailed: true } so the caller refuses instead of
 * spawning the resolver (there is nothing on the branch to resolve). Honoured only on
 * the live path; --dry-run never calls this.
 */
export function attemptMerge(repoPath, branch, defaultBranch, pin = null) {
  const git = (...args) => spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  // ACCEPTANCE GATE: when the landing decision pinned a commit, refuse if the branch has
  // moved off it, and merge the pinned commit itself (not whatever the name resolves to).
  if (pin) {
    const now = git(
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ).stdout.trim();
    if (now !== pin) {
      return {
        clean: false,
        checkoutFailed: true,
        reason: `${branch} moved between the landing check and the merge (approved ${pin.slice(0, 12)}, now ${now.slice(0, 12) || "missing"})`,
      };
    }
  }
  const co = git("checkout", defaultBranch);
  if (co.status !== 0) {
    return {
      clean: false,
      checkoutFailed: true,
      reason: `could not checkout ${defaultBranch}: ${(co.stderr || co.stdout || "").trim().slice(0, 200)}`,
    };
  }
  const merge = pin
    ? git("merge", "--no-edit", "-m", `Merge branch '${branch}'`, pin)
    : git("merge", "--no-edit", branch);
  if (merge.status === 0) return { clean: true };
  // Conflict (or other merge failure): abort so the default branch is restored and the
  // delivery branch is left intact for the resolver.
  git("merge", "--abort");
  // An untracked file the merge would overwrite is a REFUSAL, not a conflict: git never
  // started the merge, and the resolver would be spawned (and its one pass spent) on a
  // branch with nothing to resolve.
  if (/untracked working tree files would be overwritten/i.test(merge.stderr || "")) {
    return {
      clean: false,
      checkoutFailed: true,
      reason: `an untracked file in the ${defaultBranch} checkout would be overwritten by the merge — move it aside and merge again`,
    };
  }
  return { clean: false, reason: "merge conflict" };
}

/**
 * The PR-merge knobs (mirrors lib/automerge.sh gaffer_pr_merge): which `gh` to call,
 * how to land the PR (`GAFFER_PR_MERGE_METHOD` — merge (default) | squash | rebase;
 * anything else falls back to merge so a typo can never pick an unintended method),
 * and which remote holds the PR's base branch for the local fast-forward.
 */
export const PR_MERGE_METHODS = ["merge", "squash", "rebase"];
export function resolvePrMergeMethod(raw) {
  const m = String(raw ?? "")
    .trim()
    .toLowerCase();
  return PR_MERGE_METHODS.includes(m) ? m : "merge";
}

/**
 * The exact `gh` argv the PR path runs: `pr merge <url> --<method> --delete-branch`, plus
 * `--body <trailers>` for the merge commit (not for a rebase, which makes none).
 */
export function buildPrMergeArgv({ prUrl, method, matchHeadCommit, body }) {
  const m = resolvePrMergeMethod(method);
  return [
    "pr",
    "merge",
    String(prUrl),
    `--${m}`,
    "--delete-branch",
    // ACCEPTANCE GATE: merge only if the PR head is still the commit the landing
    // decision approved — never silently merge a different PR head.
    ...(matchHeadCommit ? ["--match-head-commit", String(matchHeadCommit)] : []),
    ...(body && m !== "rebase" ? ["--body", String(body)] : []),
  ];
}

/** True when `bin` resolves to an executable (`gh` present + on PATH, or an absolute stub). */
export function ghAvailable(bin) {
  const b = String(bin || "").trim();
  if (!b) return false;
  const probe = spawnSync(b, ["--version"], { encoding: "utf8", stdio: "ignore" });
  return !probe.error;
}

/**
 * True when the live checkout has uncommitted changes to TRACKED files (staged or not).
 * The dashboard merge runs `git checkout <default>` + `git merge` IN the live repo, so it
 * must never do that over an operator's active edits (gaffer_auto_merge's rule). Untracked
 * files never block: git itself refuses a checkout that would clobber one, and that is
 * reported as a refusal, not a conflict. Returns { dirty, summary }.
 */
export function inspectWorkingTree(repoPath) {
  const st = spawnSync("git", ["-C", repoPath, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  });
  const lines = (st.stdout || "").split("\n").filter((l) => l.trim() !== "");
  return {
    dirty: st.status === 0 && lines.length > 0,
    summary: lines.slice(0, 5).join("; ") + (lines.length > 5 ? `; +${lines.length - 5} more` : ""),
  };
}

/**
 * PR MODE: land the delivery THROUGH its pull request. When the ticket carries a
 * `pr_url` (GAFFER_CREATE_PR opened one), the merge that a human approved must happen
 * where the PR is — `gh pr merge <url> --<method> --delete-branch` — and the local
 * default branch is then FAST-FORWARDED from the remote (`git fetch <remote> <def>`,
 * then `merge --ff-only` when <def> is checked out, else a plain ff ref update), so
 * the local checkout catches up without ever re-merging locally. A local merge in PR
 * mode left the PR open forever and the default branch unpushed — the Settings help
 * text promised the opposite.
 *
 * Returns { ok:true, fastForwarded } when gh merged the PR; { ok:false, reason } when
 * gh failed (the caller falls back to the local merge and LOGS why). A merged PR whose
 * local fast-forward failed is still ok:true (the change landed upstream) with
 * fastForwarded:false so the caller can log it.
 */
export function mergeViaPr({
  repoPath,
  prUrl,
  defaultBranch,
  ghBin,
  method,
  remote,
  matchHeadCommit,
  body,
}) {
  const argv = buildPrMergeArgv({ prUrl, method, matchHeadCommit, body });
  const gh = spawnSync(ghBin, argv, {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  if (gh.error || gh.status !== 0) {
    const detail = gh.error
      ? (gh.error.message ?? String(gh.error))
      : `exit ${gh.status}: ${(gh.stderr || gh.stdout || "").trim().slice(0, 300)}`;
    return { ok: false, reason: `${ghBin} ${argv.join(" ")} failed (${detail})`, argv };
  }
  // Fast-forward the local default branch from the remote the PR merged into.
  const rem = String(remote || "origin");
  const g = (...args) => spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  const head = g("symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();
  let ff;
  if (head === defaultBranch) {
    const fetch = g("fetch", rem, defaultBranch);
    ff = fetch.status === 0 ? g("merge", "--ff-only", "FETCH_HEAD") : fetch;
  } else {
    // Not checked out here: a plain (non-forced) refspec is fast-forward-only by construction.
    ff = g("fetch", rem, `${defaultBranch}:${defaultBranch}`);
  }
  const fastForwarded = ff.status === 0;
  return {
    ok: true,
    argv,
    fastForwarded,
    ...(fastForwarded
      ? {}
      : { ffReason: (ff.stderr || ff.stdout || "fast-forward failed").trim().slice(0, 300) }),
  };
}

/**
 * Build the prompt fed to the resolver `claude -p`. It pins the resolve-merge-conflict
 * skill, the throwaway worktree + branch it works in, the default branch to merge IN,
 * the BRANCH-ONLY discipline (never land to the default branch), and the re-approval
 * hand-off (record a resolution summary, do not self-approve). `worktree` is where the
 * agent runs; `branch` is the conflicting delivery branch checked out there.
 */
export function buildResolverPrompt({ ticketNumber, repoName, worktree, branch, defaultBranch }) {
  return [
    `Use the ${RESOLVER_SKILL} skill to resolve a merge conflict on the delivery branch`,
    `"${branch}" of repo "${repoName}" (ticket #${ticketNumber}). You are working in a`,
    `throwaway worktree at ${worktree}, with "${branch}" checked out.`,
    "",
    `Merge the default branch "${defaultBranch}" INTO "${branch}" (\`git merge ${defaultBranch}\`)`,
    "and resolve every conflict by PRESERVING BOTH INTENTS — the work already on this",
    "branch AND the changes that landed on the default branch since it forked. NEVER",
    "blindly discard a side to make the conflict go away.",
    "",
    "You are running HEADLESS with NO human in the loop. Use your judgement and NEVER ask",
    "the user anything — do NOT call AskUserQuestion or block on a question.",
    "",
    "After resolving: run the repo's tests to prove the resolution is sound, then commit",
    `the resolution ON "${branch}" (a normal merge commit). Do NOT check out, merge into,`,
    `or push the default branch "${defaultBranch}" — the resolution is PROPOSED on the`,
    "branch only; a human re-reviews and re-approves it before it ever lands.",
    "",
    "When done, END your message with a SHORT summary of what you resolved and why (which",
    "conflicts, how you preserved each side, test result): the runner records that final",
    "message as the ticket's resolution. Do not call record_ac_evidence (you hold no claim",
    "on this approved ticket, so it is refused). If you cannot resolve the conflict",
    "safely, abort the merge and say why — the runner checks that the default branch was",
    "really merged in and never signals re-approval otherwise.",
    "Do NOT approve the ticket yourself — re-approval is a human's call.",
  ].join("\n");
}

/**
 * Build the full resolver `claude -p` argv (the same shape decompose.mjs /
 * product-owner-run.mjs produce): [-p, prompt, --mcp-config, <runtime>, ...flags,
 * --max-turns N]. Pulled out so the dry-run path and tests can assert it without
 * spawning anything. The turn cap is GAFFER_MERGE_MAX_TURNS (default 60) clamped to
 * GAFFER_MAX_TURNS — without it the resolver was bounded only by its wall clock.
 */
export function buildClaudeArgv({ prompt, mcpConfig, flags, maxTurns = mergeMaxTurns() }) {
  const args = ["-p", prompt];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  return args.concat(flags, maxTurnsArgv(maxTurns));
}

/**
 * The resolver's turn cap: GAFFER_RESOLVER_MAX_TURNS (the lane-knob spelling), else
 * GAFFER_MERGE_MAX_TURNS, else 60 — clamped to the GAFFER_MAX_TURNS ceiling.
 */
export function mergeMaxTurns(env = process.env) {
  const pick = (v) => parseInt(v ?? "", 10) || 0;
  return roleTurnCap(
    pick(env.GAFFER_RESOLVER_MAX_TURNS) || pick(env.GAFFER_MERGE_MAX_TURNS) || 60,
    env,
  );
}

/**
 * Build the child env for the resolver: the run delivers through the dispatch MCP
 * (DB path), is bounded to the worktree as its sole write-root (FG-007), and — per the
 * runner contract — starts from the SAME credential-and-endpoint-stripped copy of the
 * parent env every other Node spawn uses (agentChildEnv: DISPATCH_API_TOKEN, every
 * *_TOKEN / *_SECRET / *_KEY / *_PASSWORD, AWS_ACCESS_KEY_ID, and the outbound
 * GAFFER_NOTIFY_* / *_WEBHOOK* / *_SLACK* / *_URL channels; ANTHROPIC_* auth kept).
 * This used to delete ONLY DISPATCH_API_TOKEN, so GitHub / AWS / webhook secrets
 * reached an agent that runs exactly when AUTO_MERGE is on. Exported so a test can
 * assert the strip without spawning.
 */
export function buildChildEnv(baseEnv, { dispatchDb, memoryDb, writeRoot }) {
  const env = agentChildEnv(baseEnv);
  delete env.DISPATCH_API_TOKEN;
  env.DISPATCH_DB = dispatchDb;
  env.MEMORY_DB = memoryDb;
  env.GAFFER_WRITE_ROOTS = writeRoot;
  return env;
}

/** The resolver's rendered MCP runtime config for ticket `n` (under GAFFER_DATA). */
export function mergeTicketMcpRuntimePath(n) {
  return resolve(
    GAFFER_DATA,
    `mcp-merge-ticket-${String(n).replace(/[^0-9A-Za-z_-]/g, "")}-runtime.json`,
  );
}

/**
 * Install the project-local .claude wiring (settings + safety hook, the MERGE role's
 * skill mount) and the MCP runtime config into the resolver's WORKTREE — exactly as
 * tick.sh / product-owner-run.mjs do — so the headless run gets the same safety boundary
 * and the dispatch/memory MCP servers. Returns the runtime MCP config path.
 *
 * Skills: the merge profile (select-skills --role merge: resolve-merge-conflict, the
 * test / lint mechanics, record-evidence, minimalism and the repo stack's conventions
 * pack), not a symlink to the whole library — the resolver used to see every skill in
 * the library, marketing and Terraform included. `stack` is the repo's registered stack
 * label. Falls back to the whole library only when nothing resolves (mountRoleSkills).
 */
export function installProjectLocalWiring(
  worktreePath,
  ticketNumber,
  repoName,
  { stack = "" } = {},
) {
  const claudeDir = resolve(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  mountRoleSkills(claudeDir, {
    role: "merge",
    stacks: stack ? [stack] : [],
    skillsDir: CONFIG.skillsDir,
  });

  // Render AND verify the safety-hook wiring: an unwired or unreadable template
  // throws "SAFETY: …" and the caller refuses the resolver spawn (fail closed).
  writeAgentSettings(claudeDir, CONFIG.claudeSettings);

  mkdirSync(GAFFER_DATA, { recursive: true });
  // One runtime file PER TICKET: two concurrent resolvers used to share (and rewrite)
  // a single mcp-merge-ticket-runtime.json, re-scoping each other's evidence writes.
  const mcpRuntime = mergeTicketMcpRuntimePath(ticketNumber);
  // Render the SAME way the tester and the product-owner run do (renderPoMcpRuntime:
  // every placeholder substituted, fail closed on a leftover). This used to replace only
  // ${DISPATCH_DB}/${MEMORY_DB}/${GAFFER_RECALL_TICKET}, so the server command was the
  // literal string "${DISPATCH_MCP_BIN}", both servers died at start-up
  // (CONNECTION_CLOSED) and the resolver could not record its resolution as evidence
  // (seen live). No claim token (the resolver holds no delivery claim); memory's
  // direct-apply scope is the ticket's repo; the recall ticket is empty (not a delivery).
  const rendered = renderPoMcpRuntime(readFileSync(CONFIG.mcpConfig, "utf8"), {
    dispatchDb: CONFIG.dispatchDb,
    memoryDb: CONFIG.memoryDb,
    dispatchMcpBin: CONFIG.dispatchMcpBin,
    memoryMcpBin: CONFIG.memoryMcpBin,
    repoName,
  });
  const mcp = JSON.parse(rendered);
  // The resolver holds no claim: scope its evidence writes to THIS ticket (the same
  // claimless path the reviewer and the tester use — dispatch accepts a note for that
  // ticket only; it never satisfies an AC). It creates no tickets: no default repo link.
  mcp.mcpServers.dispatch.env = {
    ...(mcp.mcpServers.dispatch.env || {}),
    GAFFER_REVIEW_TICKET: String(ticketNumber),
  };
  delete mcp.mcpServers.dispatch.env.GAFFER_DEFAULT_TICKET_REPO;
  writeFileSync(mcpRuntime, JSON.stringify(mcp, null, 2) + "\n", { mode: 0o600 });
  return mcpRuntime;
}

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/**
 * Did the resolver really merge `defaultBranch` into the branch checked out in
 * `worktree`? True only when no merge is in progress, nothing is left unmerged, and
 * the default branch's tip is an ancestor of the committed HEAD.
 */
export function resolutionLanded(worktree, defaultBranch) {
  if (git(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD").status === 0)
    return { ok: false, reason: "the merge was left in progress (not committed)" };
  const unmerged = git(worktree, "diff", "--name-only", "--diff-filter=U");
  if (unmerged.status !== 0) return { ok: false, reason: "the worktree could not be inspected" };
  if (unmerged.stdout.trim())
    return {
      ok: false,
      reason: `unmerged paths remain: ${unmerged.stdout.trim().split("\n").join(", ")}`,
    };
  const anc = git(worktree, "merge-base", "--is-ancestor", defaultBranch, "HEAD");
  if (anc.status === 1)
    return { ok: false, reason: `"${defaultBranch}" is not merged into the branch head` };
  if (anc.status !== 0)
    return { ok: false, reason: `could not compare "${defaultBranch}" with the branch head` };
  return { ok: true, reason: "" };
}

/**
 * Conflict markers the resolution INTRODUCED. `git diff --check <parent> HEAD` flags a
 * "leftover conflict marker" for each marker-shaped line HEAD adds relative to <parent>;
 * a line is the resolver's only when it is new relative to EVERY parent (the
 * pre-resolution branch head and the default-branch tip merged in) — a marker-shaped
 * line either side already had (a markdown `=======` underline on main) is not flagged.
 * Whitespace findings are ignored. Returns { ok, markers: ["path:line", …], error? };
 * ok:false (git could not compare) is a FAIL for the caller (fail closed).
 */
export function introducedConflictMarkers(worktree, parents) {
  const sets = [];
  for (const parent of (parents || []).filter(Boolean)) {
    const r = git(worktree, "diff", "--check", parent, "HEAD", "--");
    // --check exits 0 (clean) or 2 (findings); anything else is an error.
    if (r.error || (r.status !== 0 && r.status !== 2))
      return { ok: false, markers: [], error: `git diff --check against ${parent} failed` };
    sets.push(
      new Set(
        (r.stdout || "")
          .split("\n")
          .filter((l) => l.endsWith(": leftover conflict marker"))
          .map((l) => l.slice(0, -": leftover conflict marker".length)),
      ),
    );
  }
  if (sets.length === 0) return { ok: false, markers: [], error: "no parent commit to compare" };
  const [first, ...rest] = sets;
  return { ok: true, markers: [...first].filter((m) => rest.every((s) => s.has(m))) };
}

/**
 * The repo's DoD gate commands (repositories.test_command / lint_command) for the
 * ticket's write repo — the same fields tick.sh's delivery gate reads from `ticket
 * show`. A schema without the columns resolves to no commands (the zero-gates rule then
 * applies); an unreadable DB returns null (the caller fails closed).
 */
export function resolveGateCommands(dbPath, number, repoId = null) {
  const num = parseInt(String(number ?? "").trim(), 10);
  if (!Number.isInteger(num) || num <= 0 || !existsSync(dbPath)) return null;
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    let row;
    try {
      // PER-REPOSITORY: with a repo id, THAT repo's commands (a multi-repo ticket gates
      // each repo's merge with its own gates); otherwise the ticket's primary write repo.
      row = db
        .prepare(
          "SELECT r.test_command AS test, r.lint_command AS lint FROM tickets t " +
            "JOIN ticket_repos tr ON tr.ticket_id = t.id JOIN repositories r ON r.id = tr.repo_id " +
            "WHERE t.number = ? " +
            (repoId ? "AND r.id = ? " : "") +
            "ORDER BY (tr.access = 'write') DESC, (tr.role = 'primary') DESC LIMIT 1",
        )
        .get(...(repoId ? [num, String(repoId)] : [num]));
    } catch (e) {
      // An older / minimal schema without the columns (or tables) carries no commands;
      // the zero-gates rule then decides (fail closed unless GAFFER_ALLOW_NO_DOD=1).
      if (/no such (column|table)/i.test(String(e?.message ?? e))) return { test: "", lint: "" };
      throw e;
    }
    // A named repo that is not on the ticket: nothing says what its gates are — fail closed.
    if (repoId && !row) return null;
    // GATE INTEGRITY: a human's allow_test_changes (schema v29). Its own query, so a
    // schema without the column only loses the allowance (the integrity row FLAGs),
    // never the gate commands. Fails closed: anything unreadable means no allowance.
    let allow = false;
    try {
      allow =
        Number(
          db.prepare("SELECT allow_test_changes AS a FROM tickets WHERE number = ?").get(num)?.a,
        ) === 1;
    } catch {
      allow = false;
    }
    return { test: String(row?.test ?? "").trim(), lint: String(row?.lint ?? "").trim(), allow };
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
 * RE-GATE a committed conflict resolution before it goes back to review: (1) no
 * conflict markers introduced (introducedConflictMarkers), (2) the repo's DoD gates
 * pass on the resolved head (bin/dod-regate.sh: the delivery gate's runner, toggles,
 * install step, sandbox and zero-gates rule). Without it a resolution that failed the
 * tests (or committed raw `<<<<<<<` markers) was re-reviewed against the stale
 * pre-resolution DoD PASS and landed.
 *
 * Both checks run on a FRESH DETACHED CHECKOUT of `commit` (the branch's committed
 * head — the thing that lands), never on the resolver's worktree: the gates used to run
 * on that worktree's WORKING TREE, so a fix the resolver left uncommitted (or a new
 * file it never `git add`ed) made a broken committed resolution pass, the worktree was
 * then force-removed (discarding the fix) and the evidence said "green on the resolved
 * head" for a commit whose tests fail. `worktree` (the resolver's checkout) is only
 * used to confirm its HEAD IS `commit` (a resolver that committed on a detached HEAD or
 * another branch did not resolve the branch that lands) and to note residue it left,
 * which is discarded. Returns
 *   { ok, markers, dod: "PASS"|"FAIL"|"OFF"|"NOT_RUN", commit, evidence, reason }
 * evidence = the summary to record on the ticket. Fail CLOSED on anything unrunnable.
 * `base` (the default branch's tip) is the ref the typecheck script is auto-detected
 * from first, as the delivery gate reads its base branch (gaffer_dod_typecheck_cmd).
 */
export function regateResolution({
  repoPath,
  commit,
  worktree,
  parents,
  label,
  commands,
  gateDir,
  base,
  env = process.env,
}) {
  const failed = (reason, gate = "config", extra = {}) => ({
    ok: false,
    markers: [],
    dod: "FAIL",
    commit: commit || "",
    reason,
    evidence:
      "DoD: FAIL\n" +
      JSON.stringify({
        dod: "FAIL",
        gates: [{ gate, repo: label, status: "FAIL", rc: "-", note: reason }],
      }) +
      "\n\nconflict resolution re-gate: " +
      reason,
    ...extra,
  });
  if (!repoPath || !commit || !/^[0-9a-f]{7,64}$/i.test(String(commit)))
    return failed("the resolved branch head could not be read — nothing was gated", "config", {
      dod: "NOT_RUN",
    });
  if (worktree) {
    const head = git(worktree, "rev-parse", "-q", "--verify", "HEAD^{commit}");
    if (head.status !== 0 || head.stdout.trim() !== commit)
      return failed(
        `the resolver's checkout HEAD (${(head.stdout || "?").trim().slice(0, 12) || "?"}) is not the branch head ${commit.slice(0, 12)} — only the branch's committed head can land`,
        "config",
        { dod: "NOT_RUN" },
      );
  }
  // Residue the resolver left in its checkout (uncommitted edits, files never added).
  // It is NOT part of what lands and is NOT gated; the note tells the reviewer it was
  // discarded. The factory's own .claude wiring is not the resolver's.
  let residue = [];
  if (worktree) {
    const st = git(
      worktree,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).claude",
    );
    if (st.status === 0)
      residue = (st.stdout || "")
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
  }
  const residueNote = residue.length
    ? `\n\nnote: the resolver left ${residue.length} uncommitted/untracked path(s) in its checkout (${residue.slice(0, 10).join(", ")}${residue.length > 10 ? ", …" : ""}); they are NOT part of the resolution, were NOT gated and were discarded`
    : "";

  // The gate checkout: detached at `commit`, nothing but the committed tree.
  const gateWt =
    gateDir || resolve(GAFFER_DATA, "worktrees", `merge-regate-${process.pid}-${Date.now()}`);
  mkdirSync(dirname(gateWt), { recursive: true });
  git(repoPath, "worktree", "remove", "--force", gateWt);
  rmSync(gateWt, { recursive: true, force: true });
  const add = git(repoPath, "worktree", "add", "--detach", "--force", gateWt, commit);
  const cleanup = () => {
    git(repoPath, "worktree", "remove", "--force", gateWt);
    rmSync(gateWt, { recursive: true, force: true });
    git(repoPath, "worktree", "prune");
  };
  if (add.status !== 0) {
    cleanup();
    return failed(
      `a clean checkout of the resolved head could not be created (${(add.stderr || add.stdout || "").trim().slice(0, 200)}) — nothing was gated`,
      "config",
      { dod: "NOT_RUN" },
    );
  }
  try {
    const head = git(gateWt, "rev-parse", "HEAD").stdout.trim();
    if (head !== commit)
      return failed(
        `the gate checkout is at ${head.slice(0, 12)}, not the resolved head ${commit.slice(0, 12)}`,
        "config",
        { dod: "NOT_RUN" },
      );
    const r = gateCheckout({ gateWt, parents, label, commands, env, failed, base });
    if (residueNote) r.evidence = (r.evidence || "") + residueNote;
    return { ...r, commit, residue };
  } finally {
    cleanup();
  }
}

/**
 * MERGE GATE — the combined code is what lands, so the combined code is what is gated.
 * A branch that passed its gates and a target that passed its gates merged cleanly and
 * the result failed the same test (a field rename: one side changed which field is read,
 * the other removed it). Build the proposed merge of `pin` onto the CURRENT `targetRef` in
 * a scratch worktree detached at the target head, and run the repo's DoD gates on that
 * merge result through bin/dod-regate.sh (the conflict re-gate's runner, toggles, install
 * step, sandbox and zero-gates rule). Mirrors lib/land.sh _gaffer_merge_gate.
 * TESTER REPLAY (`testerReplay: { dbPath, ticketNumber }`, the primary repo): once the
 * repo's gates pass (or DoD is off), the independent tester's test files from
 * gaffer-tests/ticket-<n> are checked out into the same scratch merge and the repo's test
 * command runs there too (lib/tester-replay.mjs) — a failure is a red gate with
 * `code: "tester_replay_red"`, an unpreparable replay an "error" (fail closed).
 *   → { kind: "pass" | "off" | "conflict" | "red" | "error", target, merge, evidence, reason,
 *       code, replay: { record, files } }
 * `target` is the gated target head and `merge` the gated merge commit, which is exactly
 * what landGatedMerge may land (and only while the target is still `target`).
 */
export function gateProposedMerge({
  repoPath,
  branch,
  pin,
  targetRef,
  label,
  commands,
  gateDir,
  trailers = [],
  env = process.env,
  testerReplay = null,
}) {
  const out = (kind, extra = {}) => ({
    kind,
    target: "",
    merge: "",
    evidence: "",
    reason: "",
    code: kind === "red" ? "merge_gate_red" : "",
    replay: { record: false, files: [] },
    ...extra,
  });
  if (!pin) return out("error", { reason: "no pinned commit to gate" });
  const t = git(repoPath, "rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`);
  const target = (t.stdout || "").trim();
  if (t.status !== 0 || !target)
    return out("error", { reason: `the target ${targetRef} cannot be resolved` });
  if (commands === null)
    return out("error", {
      target,
      reason: "the repo's gate commands could not be read from the dispatch DB",
    });
  const wt =
    gateDir || resolve(GAFFER_DATA, "worktrees", `merge-gate-${process.pid}-${Date.now()}`);
  mkdirSync(dirname(wt), { recursive: true });
  git(repoPath, "worktree", "remove", "--force", wt);
  rmSync(wt, { recursive: true, force: true });
  const cleanup = () => {
    git(repoPath, "worktree", "remove", "--force", wt);
    rmSync(wt, { recursive: true, force: true });
    git(repoPath, "worktree", "prune");
  };
  const add = git(repoPath, "worktree", "add", "--quiet", "--detach", "--force", wt, target);
  if (add.status !== 0) {
    cleanup();
    return out("error", {
      target,
      reason: `a scratch checkout of the target could not be created (${(add.stderr || "").trim().slice(0, 200)})`,
    });
  }
  try {
    const hasIdentity = git(repoPath, "config", "user.email").status === 0;
    const ids = hasIdentity ? [] : ["-c", "user.name=gaffer", "-c", "user.email=gaffer@localhost"];
    // PROVENANCE TRAILERS (lib/provenance-trailers.mjs): the gated merge commit is the
    // commit that lands, so it carries them; with trailers it is --no-ff so a merge
    // commit exists to carry them (without, a fast-forward stays possible, as before).
    const withTrailers = Array.isArray(trailers) && trailers.length > 0;
    const m = spawnSync(
      "git",
      [
        "-C",
        wt,
        ...ids,
        "merge",
        "--quiet",
        "--no-edit",
        ...(withTrailers ? ["--no-ff"] : []),
        "-m",
        withTrailers
          ? mergeMessage(`Merge branch '${branch}'`, trailers)
          : `Merge branch '${branch}'`,
        pin,
      ],
      { encoding: "utf8" },
    );
    if (m.status !== 0) {
      git(wt, "merge", "--abort");
      return out("conflict", {
        target,
        reason: `the merge onto ${target.slice(0, 12)} conflicts`,
      });
    }
    const merge = git(wt, "rev-parse", "HEAD").stdout.trim();
    const perGate = Math.max(1, parseInt(env.GAFFER_DOD_TIMEOUT ?? "", 10) || 900);
    const r = spawnSync(
      "bash",
      [
        resolve(RUNNER_DIR, "bin", "dod-regate.sh"),
        wt,
        label,
        commands.test || "-",
        commands.lint || "-",
        // The gated target head: the typecheck script is auto-detected from it first,
        // exactly as the delivery gate reads its base branch (gaffer_dod_typecheck_cmd),
        // and it is the gate-integrity base (scripts read from it + an integrity row).
        target,
        commands.allow ? "1" : "0",
      ],
      { encoding: "utf8", env, timeout: (perGate * 4 + 60) * 1000, maxBuffer: 8 * 1024 * 1024 },
    );
    const evidence = (r.stdout || "").trim();
    if (!r.error && (r.status === 0 || r.status === 3)) {
      const kind = r.status === 0 ? "pass" : "off";
      const base = {
        target,
        merge,
        evidence,
        ...(kind === "off" ? { reason: "DoD is off (GAFFER_DOD=0)" } : {}),
      };
      if (!testerReplay) return out(kind, base);
      const rp = replayOnMergeCandidate({
        ...testerReplay,
        repoPath,
        wt,
        pin,
        target,
        merge,
        label,
        testCommand: commands.test || "",
        installed: r.status === 0,
        env,
      });
      if (rp.kind === "pass") return out(kind, { ...base, replay: rp.replay });
      return out(rp.kind, {
        target,
        merge,
        evidence: rp.evidence,
        reason: rp.reason,
        code: rp.code,
      });
    }
    return out(r.error ? "error" : "red", {
      target,
      merge,
      evidence,
      reason: r.error
        ? `the merge gate could not run (${r.error.code === "ETIMEDOUT" ? "timed out" : (r.error.message ?? r.error)})`
        : `the merge of ${pin.slice(0, 12)} onto ${target.slice(0, 12)} fails the Definition-of-Done gates`,
    });
  } finally {
    cleanup();
  }
}

/**
 * TESTER REPLAY on the merge candidate (gateProposedMerge's scratch worktree `wt`, detached
 * at the gated merge). Mirrors lib/land.sh _gaffer_merge_gate_tester_replay: the replay
 * plan (lib/tester-replay.mjs) reads the bound tester PASS and the tester's test files on
 * gaffer-tests/ticket-<n>; those files are checked out into the working tree (the gated
 * merge commit is unchanged — they run, they never land) and run through
 * bin/dod-regate.sh (tests only): by path with the stack's runner where that is well
 * defined, else the registered command; a file without the runner's own evidence that it
 * ran is "red" with `code: "tester_replay_unverified"` (the landing holds, no record).
 *   → { kind: "pass", replay: { record, files } } | { kind: "red" | "error", code, reason, evidence }
 */
function replayOnMergeCandidate({
  dbPath,
  ticketNumber,
  repoPath,
  wt,
  pin,
  target,
  merge,
  label,
  testCommand,
  installed,
  env,
}) {
  const plan = replayPlan({ dbPath, ticketNumber, repoPath, pin, env });
  if (!plan.ok)
    return {
      kind: "error",
      code: "",
      evidence: "",
      reason: `the tester's tests could not be prepared for a replay on the merge (${plan.reason})`,
    };
  if (!plan.record) {
    log(`#${ticketNumber}: TESTER REPLAY — nothing to replay (${plan.reason})`);
    return { kind: "pass", replay: { record: false, files: [], note: plan.reason } };
  }
  if (!plan.run) {
    log(
      `#${ticketNumber}: TESTER REPLAY — no tester test files to replay (${plan.reason}); the merge gate's suite is what the tester ran`,
    );
    return { kind: "pass", replay: { record: true, files: [], note: plan.reason } };
  }
  const list = plan.files.join(", ");
  const at = `the merge of ${pin.slice(0, 12)} onto ${target.slice(0, 12)}`;
  if (!String(testCommand || "").trim())
    return {
      kind: "red",
      code: "tester_replay_red",
      evidence: "DoD: FAIL (no test command to replay the tester's tests)",
      reason: `the independent tester's tests (${list}) cannot be replayed on ${at}: the repo has no test command`,
    };
  const a = applyTesterTests({ worktree: wt, testsHead: plan.tests_head, files: plan.files });
  if (!a.ok)
    return {
      kind: "error",
      code: "",
      evidence: "",
      reason: `the tester's tests could not be prepared for a replay on the merge (${a.reason})`,
    };
  // PROOF OF EXECUTION (external review #7): the tester's files run by path with the
  // stack's runner where that is well defined, else the registered command; then each
  // file must show the runner's own evidence that it ran (lib/tester-replay.mjs).
  const inv = replayInvocation({ worktree: wt, base: target, testCommand, files: plan.files });
  try {
    prepareReplayProof(inv);
  } catch (e) {
    return {
      kind: "error",
      code: "",
      evidence: "",
      reason: `the replay's proof directory could not be created (${e.message})`,
    };
  }
  const how = inv.mode === "files" ? `${inv.runner}, by path` : "the registered test command";
  log(
    `#${ticketNumber}: TESTER REPLAY — running the tester's ${plan.files.length} test file(s) (${list}) on the merge candidate ${merge.slice(0, 12)} (${how})`,
  );
  const perGate = Math.max(1, parseInt(env.GAFFER_DOD_TIMEOUT ?? "", 10) || 900);
  const r = spawnSync(
    "bash",
    [
      resolve(RUNNER_DIR, "bin", "dod-regate.sh"),
      wt,
      `${label}:tester-replay`,
      inv.command,
      "-",
      target,
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        ...inv.env,
        GAFFER_DOD: "1",
        GAFFER_DOD_TESTS: "1",
        GAFFER_DOD_TYPECHECK: "0",
        GAFFER_DOD_LINT: "0",
        GAFFER_DOD_TESTS_OUTPUT: inv.proof.output,
        ...(installed ? { GAFFER_DOD_INSTALL: "0" } : {}),
      },
      timeout: (perGate * 2 + 60) * 1000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const evidence = (r.stdout || "").trim();
  if (r.error)
    return {
      kind: "error",
      code: "",
      evidence,
      reason: `the tester replay could not run (${r.error.code === "ETIMEDOUT" ? "timed out" : (r.error.message ?? r.error)})`,
    };
  if (r.status !== 0)
    return {
      kind: "red",
      code: "tester_replay_red",
      evidence,
      reason: `the independent tester's tests (${list}) fail on ${at} (the repo's own gates pass)`,
    };
  const proof = replayProof({ inv, files: plan.files, worktree: wt });
  if (proof.unproven.length > 0)
    return {
      kind: "red",
      code: "tester_replay_unverified",
      evidence,
      unproven: proof.unproven,
      reason:
        `the independent tester's test file(s) did not run in the replay on ${at}: ${proof.unproven.join(", ")} ` +
        `(no evidence from the runner that they executed; replayed with ${how})`,
    };
  log(
    `#${ticketNumber}: TESTER REPLAY PASS — the tester's tests (${list}) ran and pass on the merge candidate ${merge.slice(0, 12)}`,
  );
  // The record lists only the files proven to have run (and the run passed).
  return { kind: "pass", replay: { record: true, files: proof.ran, note: plan.reason } };
}

/**
 * TESTER REPLAY: the revision that landed, for the replay record — `gatedMerge` itself for
 * a local landing (compare-and-land landed exactly it); for a PR landing, the local default
 * branch's head after the fast-forward, only when its tree equals the gated candidate's.
 *   → { ok: true, commit } | { ok: false, reason }
 */
export function testerReplayLandedRevision(repo, landed, gatedMerge) {
  if (landed.via === "local") return { ok: true, commit: gatedMerge };
  if (landed.via !== "pr" || !landed.fastForwarded)
    return {
      ok: false,
      reason: `the landed revision cannot be verified (via ${landed.via}${landed.via === "pr" ? ": the local default branch was not fast-forwarded" : ""})`,
    };
  const rev = (ref) => {
    const r = git(repo.localPath, "rev-parse", "--verify", "--quiet", ref);
    return r.status === 0 ? String(r.stdout || "").trim() : "";
  };
  const head = rev(`refs/heads/${repo.defaultBranch}^{commit}`);
  const tree = head ? rev(`${head}^{tree}`) : "";
  const want = rev(`${gatedMerge}^{tree}`);
  if (!head || !tree || tree !== want)
    return {
      ok: false,
      reason: `the PR landed ${repo.defaultBranch}@${head.slice(0, 12) || "?"}, whose tree is not the candidate ${String(gatedMerge).slice(0, 12)} the tester's tests passed on (the remote default moved, or the merge method changed the result)`,
    };
  return { ok: true, commit: head };
}

/** TESTER REPLAY: record which tester assertions passed on which landed revision (system). */
function recordTesterReplayCli(ticketNumber, repoId, landedSha, pin, files, via, note = "") {
  const r = runDispatch([
    "ticket",
    "record-tester-replay",
    String(ticketNumber),
    "--commit",
    String(landedSha),
    "--pin",
    String(pin),
    "--files-json",
    JSON.stringify(files || []),
    "--via",
    String(via || "local"),
    ...(note ? ["--note", String(note)] : []),
    ...(repoId ? ["--repo", String(repoId)] : []),
    "--as",
    "system",
  ]);
  if (r.error || r.status !== 0)
    log(
      `WARNING: #${ticketNumber} could not record the tester replay on ${String(landedSha).slice(0, 12)} ` +
        `(${(r.stderr || "").trim().slice(0, 160)}) — the epic is not counted as accepted until it is`,
    );
  else
    log(
      `#${ticketNumber}: recorded the tester replay — ${(files || []).length} tester test file(s) passed on the landed revision ${String(landedSha).slice(0, 12)}`,
    );
}

/**
 * COMPARE-AND-LAND the gated merge commit: only while the target still IS the gated
 * target head, and only as that exact commit. Mirrors lib/land.sh _gaffer_land_gated.
 *   → { ok: true } | { ok: false, code: "moved-target" | "moved-branch" | "refused", reason }
 * Never a checkout of the live repo: a checked-out target is fast-forwarded (clean tracked
 * tree only); a target checked out in another worktree is refused; otherwise the ref is
 * swapped atomically (`update-ref <ref> <merge> <target>`).
 */
export function landGatedMerge({ repoPath, defaultBranch, target, merge, branch, pin }) {
  const now = (ref) =>
    git(repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).stdout.trim();
  if (pin && now(`refs/heads/${branch}`) !== pin)
    return { ok: false, code: "moved-branch", reason: `${branch} moved off the approved commit` };
  const head = git(repoPath, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();
  if (head === defaultBranch) {
    const tree = inspectWorkingTree(repoPath);
    if (tree.dirty)
      return {
        ok: false,
        code: "refused",
        reason: `${defaultBranch} is checked out with uncommitted changes (${tree.summary})`,
      };
    if (now("HEAD") !== target)
      return { ok: false, code: "moved-target", reason: `${defaultBranch} moved` };
    if (git(repoPath, "merge", "--quiet", "--ff-only", merge).status === 0) return { ok: true };
    if (now("HEAD") !== target)
      return { ok: false, code: "moved-target", reason: `${defaultBranch} moved` };
    return {
      ok: false,
      code: "refused",
      reason: `an untracked file in the ${defaultBranch} checkout is in the merge's way`,
    };
  }
  const wtl = git(repoPath, "worktree", "list", "--porcelain").stdout || "";
  if (wtl.split("\n").includes(`branch refs/heads/${defaultBranch}`))
    return {
      ok: false,
      code: "refused",
      reason: `${defaultBranch} is checked out in another worktree`,
    };
  const u = git(
    repoPath,
    "update-ref",
    "-m",
    `gaffer: land the gated merge of ${branch}`,
    `refs/heads/${defaultBranch}`,
    merge,
    target,
  );
  if (u.status === 0) return { ok: true };
  return now(`refs/heads/${defaultBranch}`) === target
    ? { ok: false, code: "refused", reason: (u.stderr || "update-ref failed").trim().slice(0, 200) }
    : { ok: false, code: "moved-target", reason: `${defaultBranch} moved` };
}

/** The marker check + DoD gates on the clean gate checkout (regateResolution). */
function gateCheckout({ gateWt, parents, label, commands, env, failed, base }) {
  const mk = introducedConflictMarkers(gateWt, parents);
  if (!mk.ok || mk.markers.length > 0) {
    const reason = mk.ok
      ? `the resolution left conflict markers in ${mk.markers.slice(0, 10).join(", ")}`
      : `the resolution could not be checked for conflict markers (${mk.error})`;
    return failed(reason, "conflict-markers", { markers: mk.markers, dod: "NOT_RUN" });
  }
  if (commands === null) {
    const reason = "the repo's gate commands could not be read from the dispatch DB";
    return failed(reason);
  }
  // Each gate is bounded by GAFFER_DOD_TIMEOUT inside the script; this outer cap only
  // stops a wedged script (install + three gates + slack).
  const perGate = Math.max(1, parseInt(env.GAFFER_DOD_TIMEOUT ?? "", 10) || 900);
  const r = spawnSync(
    "bash",
    [
      resolve(RUNNER_DIR, "bin", "dod-regate.sh"),
      gateWt,
      label,
      commands.test || "-",
      commands.lint || "-",
      // The default branch's tip: the typecheck script is auto-detected from it first
      // (gaffer_dod_typecheck_cmd), so a resolution cannot drop that gate; it is also
      // the gate-integrity base (scripts read from it + an integrity row).
      base || "",
      commands.allow ? "1" : "0",
    ],
    { encoding: "utf8", env, timeout: (perGate * 4 + 60) * 1000, maxBuffer: 8 * 1024 * 1024 },
  );
  const out = (r.stdout || "").trim();
  if (!r.error && r.status === 3)
    return { ok: true, markers: [], dod: "OFF", reason: "DoD is off (GAFFER_DOD=0)", evidence: "" };
  if (!r.error && r.status === 0)
    return { ok: true, markers: [], dod: "PASS", reason: "", evidence: out };
  const reason = r.error
    ? `the DoD re-gate could not run (${r.error.code === "ETIMEDOUT" ? "timed out" : (r.error.message ?? r.error)})`
    : "the Definition-of-Done gates fail on the resolved head";
  if (out) return { ok: false, markers: [], dod: "FAIL", reason, evidence: out };
  return failed(reason);
}

/**
 * Take an unreviewable resolution OFF the delivery branch: park it on
 * refs/gaffer/conflict-resolved/<n> and put the branch back to its pre-resolution head
 * (compare-and-swap: only if it still points at the resolution). The ticket stays
 * ready_for_merge, its next landing conflicts again, and the .merge-conflict-resolved
 * marker holds it for a human — so the resolution can never land unreviewed.
 */
function setResolutionAside(repoPath, branch, preResolution, ticketNumber, why) {
  const resolvedHead = branchHead(repoPath, branch);
  const sideRef = `refs/gaffer/conflict-resolved/${ticketNumber}`;
  let restored = false;
  if (resolvedHead && preResolution && resolvedHead !== preResolution) {
    const side = spawnSync("git", ["-C", repoPath, "update-ref", sideRef, resolvedHead], {
      encoding: "utf8",
    });
    if (side.status === 0) {
      const reset = spawnSync(
        "git",
        [
          "-C",
          repoPath,
          "update-ref",
          "-m",
          `gaffer: undo unreviewed conflict resolution (${why})`,
          `refs/heads/${branch}`,
          preResolution,
          resolvedHead,
        ],
        { encoding: "utf8" },
      );
      restored = reset.status === 0;
    }
  }
  return { sideRef, restored };
}

/** Record runner evidence on the ticket (system actor). Best-effort: false on failure. */
function recordEvidence(ticketNumber, type, summary) {
  if (!summary) return false;
  const r = runDispatch([
    "attach-evidence",
    String(ticketNumber),
    "--type",
    type,
    "--summary",
    summary,
  ]);
  return !r.error && r.status === 0;
}

// Call the Dispatch CLI directly. `wg` is a bash FUNCTION (factory.config.sh), not a
// binary on PATH, so it does NOT resolve inside this Node runner — spawn the CLI here.
const DISPATCH_CLI =
  process.env.DISPATCH_CLI ||
  resolve(RUNNER_DIR, "..", "packages", "dispatch", "dist", "cli", "index.js");
function runDispatch(args) {
  return spawnSync(process.execPath, [DISPATCH_CLI, "--db", CONFIG.dispatchDb, ...args], {
    encoding: "utf8",
  });
}

// Call the MEMORY CLI (memory-mcp) directly. This is where digest + feature
// lifecycle live — the same product the onboard producer writes to via the memory MCP,
// NOT the dispatch control plane. Mirrors the `lg` bash helper in factory.config.sh:
// the DB is passed via the MEMORY_DB ENV VAR (no `--db` flag — that's the memory
// CLI's bin contract). MEMORY_CLI_BIN points at dist/bin/memory.js.
const MEMORY_CLI =
  process.env.MEMORY_CLI ||
  process.env.MEMORY_CLI_BIN ||
  resolve(RUNNER_DIR, "..", "packages", "memory", "dist", "bin", "memory.js");
function runMemoryCli(args) {
  return spawnSync(process.execPath, [MEMORY_CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_DB: CONFIG.memoryDb },
  });
}

/**
 * Parse `git diff --name-status -M <base>..HEAD` output into card-refresh work:
 *   - refresh:   paths whose card must be re-built (A added, M modified,
 *                C copied → the new copy, T type-changed, and the NEW path of an
 *                R rename).
 *   - deletions: paths whose card must be TOMBSTONED (D deleted, and the OLD
 *                path of an R rename — it no longer exists at that path).
 *
 * Each line is tab-separated. Rename/copy records carry a similarity score on
 * the status (e.g. `R097`) and THREE fields: `R097<TAB>old<TAB>new`. Everything
 * else is `X<TAB>path`. Unknown/blank statuses are ignored (best-effort).
 * Exported so a test can exercise the parsing without spawning git.
 *
 * Renames are also returned as `renames` ({from, to}) so the new path's card can
 * carry the old card's summary before the old card is tombstoned.
 *
 * @param {string} diffOut Raw stdout from the diff.
 * @returns {{ refresh: string[], deletions: string[], renames: {from: string, to: string}[] }}
 */
export function parseDiffStatus(diffOut) {
  const refresh = [];
  const deletions = [];
  const renames = [];
  if (!diffOut) return { refresh, deletions, renames };
  for (const raw of diffOut.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = (fields[0] ?? "").trim();
    if (!status) continue;
    const code = status[0].toUpperCase();
    if (code === "D") {
      const p = (fields[1] ?? "").trim();
      if (p) deletions.push(p);
    } else if (code === "R") {
      // Rename: old→new. Tombstone the old card, refresh the new path.
      const oldPath = (fields[1] ?? "").trim();
      const newPath = (fields[2] ?? "").trim();
      if (oldPath) deletions.push(oldPath);
      if (newPath) refresh.push(newPath);
      if (oldPath && newPath) renames.push({ from: oldPath, to: newPath });
    } else if (code === "C") {
      // Copy: old is unchanged, the NEW copy needs a card.
      const newPath = (fields[2] ?? "").trim();
      if (newPath) refresh.push(newPath);
    } else if (code === "A" || code === "M" || code === "T") {
      const p = (fields[1] ?? "").trim();
      if (p) refresh.push(p);
    }
    // U (unmerged), X, B and anything else: ignore — not a clean card target.
  }
  return { refresh, deletions, renames };
}

/**
 * Re-card a just-merged repo against the merged commit: diff the card watermark →
 * the default branch's tip with rename detection, check that commit out in a
 * throwaway detached worktree, refresh/tombstone the changed files there (a rename
 * carries the old card's summary), and let refreshFileCards verify every stored card
 * against the same tree before it advances the watermark. Skipped (logged) when the
 * repo was never carded, when the local default branch is stale after a PR merge, or
 * when the merged commit cannot be resolved or checked out. The diff is tree to tree
 * (`watermark..tip`), so it is the right change set even when the watermark is not an
 * ancestor of the tip (a rewritten main); the verification then catches any card the
 * diff did not reach.
 */
function refreshCardsForMergedCommit(repo, landed, log) {
  if (landed?.via === "pr" && landed.fastForwarded === false) {
    log(
      "card-refresh: local default branch is stale after the PR merge — skipped; the next merge re-cards it",
    );
    return;
  }
  const canonical = repoCanonical(repo.localPath);
  const syncedCommit = readCardWatermark(canonical, repo.name);
  if (!syncedCommit) {
    log(
      "card-refresh: no watermark recorded for this repo — skipping (run `gaffer onboard` to initialise)",
    );
    return;
  }
  const merged = git(repo.localPath, "rev-parse", "--verify", `refs/heads/${repo.defaultBranch}`);
  const target = merged.status === 0 ? String(merged.stdout ?? "").trim() : "";
  if (!target) {
    log(`card-refresh: cannot resolve ${repo.defaultBranch} — skipped`);
    return;
  }
  // -M turns a delete+add pair into a single R rename record (old→new), so the card
  // follows the file. --name-only would miss deletions and renames entirely.
  const diffOut = execFileSync(
    "git",
    ["-C", repo.localPath, "diff", "--name-status", "-M", `${syncedCommit}..${target}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  const { refresh, deletions, renames } = parseDiffStatus(diffOut);
  const wt = mkdtempSync(join(tmpdir(), "gaffer-cards-"));
  const add = git(repo.localPath, "worktree", "add", "--detach", "--quiet", wt, target);
  if (add.status !== 0) {
    rmSync(wt, { recursive: true, force: true });
    log(`card-refresh: could not check out ${target.slice(0, 8)} — skipped`);
    return;
  }
  try {
    const cfg = { cliBin: MEMORY_CLI, db: CONFIG.memoryDb };
    const rStats = refreshFileCards(wt, refresh, {
      cfg,
      deletions,
      renames,
      env: { ...process.env, MEMORY_DB: CONFIG.memoryDb },
      log: (m) => log(`card-refresh: ${m}`),
      repo: repo.name,
      canonical,
    });
    log(
      `card-refresh: refreshed=${rStats.refreshed} deleted=${rStats.deleted} ` +
        `skipped=${rStats.skipped} failed=${rStats.failed} ` +
        `watermark=${rStats.watermark ?? "held"}`,
    );
  } finally {
    git(repo.localPath, "worktree", "remove", "--force", wt);
    git(repo.localPath, "worktree", "prune");
    rmSync(wt, { recursive: true, force: true });
  }
}

/**
 * Read the card-set watermark (synced_commit) for a repo THROUGH the memory CLI
 * (`get-card-watermark`) — never by reading Memory's SQLite directly. Memory owns
 * its DB; the Runner is a client of the CLI (boundary rule). Read-only + best-effort:
 * returns null when the CLI is missing, errors, or reports no watermark yet.
 */
function readCardWatermark(canonical, repo) {
  const res = runMemoryCli([
    "get-card-watermark",
    "--canonical",
    canonical,
    "--repo",
    repo,
    "--json",
  ]);
  if (res.error || (res.status ?? 0) !== 0) return null;
  try {
    const out = JSON.parse(res.stdout ?? "");
    return out?.syncedCommit ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a ticket's view (which carries its evidence rows) via the Dispatch CLI,
 * so the merge can find a PREPARED digest-delta the delivery agent recorded. Pure
 * read — `wg ticket show <n>` prints `{ evidence:[…], … }` JSON on stdout. Returns
 * the parsed view object, or null on any failure (missing command, bad JSON, etc.).
 * Best-effort by contract: the apply path treats null as "no prepared delta" and
 * falls back to the minimal stamp.
 */
export function readTicketView(ticketNumber) {
  const res = runDispatch(["ticket", "show", String(ticketNumber)]);
  if (res.error || res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout || "");
  } catch {
    return null;
  }
}

/**
 * APPLY the digest freshness + feature → shipped on a CLEAN merge — deterministically,
 * with NO agent spawned. This is the merge half of the prepare-at-delivery /
 * apply-at-merge design (see lib/feature-digest.mjs):
 *
 *   1. read the ticket's prepared evidence (best-effort);
 *   2. if a GAFFER_DIGEST_DELTA_V1 payload is present → replay its section deltas
 *      (source=merge:#<n>) + ship the feature it names;
 *   3. else (no prepared delta) → MINIMAL fallback: stamp the digest freshness
 *      (source=merge:#<n>) + advance/add the linked feature → shipped.
 *
 * Every memory-CLI write is run best-effort: a non-zero exit (or a memory product
 * that hasn't shipped the `digest`/`feature` write verbs yet) is LOGGED, never
 * fatal — mirroring signalReapproval / the usage-ledger discipline. The merge has
 * already landed; nothing here can un-land it or fail it. Idempotent: re-running
 * re-stamps the same source and re-asserts `shipped` (a no-op). Returns a summary
 * `{ applied, prepared, jobs:[{kind, ok}] }` for the emitted JSON + the tests.
 *
 * GATED on GAFFER_DIGEST_DISABLE=1 (an explicit off-switch); a thrown error anywhere
 * is swallowed and reported as `{ applied:false, error }`.
 */
export function applyDigestAndFeature({ ticketNumber, repo, featureId } = {}) {
  if (process.env.GAFFER_DIGEST_DISABLE === "1") {
    return { applied: false, prepared: false, skipped: "GAFFER_DIGEST_DISABLE=1", jobs: [] };
  }
  try {
    const view = readTicketView(ticketNumber);
    const delta = selectPreparedDelta(view);
    // The ticket's own `Feature-Id:` line (stamped on every feature-epic ticket) is the
    // authoritative ledger row to advance; an explicit featureId still wins.
    if (!String(featureId ?? "").trim()) featureId = featureIdFromView(view) ?? undefined;
    let jobs;
    if (delta) {
      jobs = buildApplyCommands(delta, { ticketNumber, repo, featureId });
    } else {
      // Minimal deterministic fallback: stamp freshness + ship the linked feature
      // (only emits a feature job when an id is known — never invents one).
      jobs = [
        buildMinimalDigestStamp({ ticketNumber, repo }),
        ...buildFeatureShippedCommands({ ticketNumber, repo, featureId }),
      ];
    }
    const ran = [];
    for (const job of jobs) {
      let ok = false;
      try {
        // Digest + feature jobs target the MEMORY CLI (see lib/feature-digest.mjs):
        // job.command is MEMORY_CLI ("lg"), run via runMemoryCli (DB through env).
        const res = runMemoryCli(job.args);
        ok = !res.error && res.status === 0;
        if (!ok) {
          log(
            `digest/feature write skipped (\`${job.command} ${job.args.join(" ")}\` exit ` +
              `${res.status ?? "spawn-error"}) — memory not updated for this job; merge unaffected`,
          );
        }
      } catch (e) {
        log(`digest/feature write threw (${e?.message ?? e}) — swallowed; merge unaffected`);
      }
      ran.push({ kind: job.kind, ok });
    }
    return { applied: true, prepared: Boolean(delta), jobs: ran };
  } catch (e) {
    // A failure to even read/build must NEVER fail the merge.
    log(`digest/feature apply aborted (${e?.message ?? e}) — swallowed; merge already landed`);
    return { applied: false, prepared: false, error: String(e?.message ?? e), jobs: [] };
  }
}

/**
 * R-3: turn the applyDigestAndFeature() result into the single post-merge log line.
 * Pure (no I/O) so the merge path AND the tests share one decision:
 *   • applied            → an INFO line summarising the jobs that ran;
 *   • skipped (off-switch)→ an INFO line noting the deliberate skip;
 *   • applied:false       → a prominent WARNING (level "warning"). The apply threw,
 *                           so the feature can be stuck at `building` and the Repo
 *                           Digest has SILENTLY drifted while the merge still landed.
 *                           The emitted merge JSON also carries digest.applied:false
 *                           (+ digest.error) so the dashboard/operator can flag it.
 * Returns `{ level, message }`, or null when there's nothing to log.
 */
export function formatDigestApplyLog(digest, ticketNumber) {
  if (!digest || typeof digest !== "object") return null;
  if (digest.applied) {
    const jobs =
      (Array.isArray(digest.jobs) &&
        digest.jobs.map((j) => `${j.kind}:${j.ok ? "ok" : "skip"}`).join(", ")) ||
      "no-op";
    return {
      level: "info",
      message:
        `digest/feature: ${digest.prepared ? "applied prepared delta" : "minimal stamp (no prepared delta)"} ` +
        `for #${ticketNumber} [${jobs}]`,
    };
  }
  if (digest.skipped) {
    return {
      level: "info",
      message: `digest/feature: skipped for #${ticketNumber} (${digest.skipped})`,
    };
  }
  return {
    level: "warning",
    message:
      `WARNING: #${ticketNumber} merged but digest/feature apply FAILED ` +
      `(${digest.error ?? "unknown error"}) — Repo Digest is now STALE and the ` +
      `feature may be stuck at 'building'; re-run the digest apply manually`,
  };
}

/**
 * Create a throwaway worktree on the conflicting delivery branch so the resolver works
 * in isolation (the real checkout is left on the default branch). Returns the worktree
 * path, or throws on failure.
 */
function addWorktree(repoPath, branch, ticketNumber) {
  const worktree = resolve(GAFFER_DATA, "worktrees", `merge-ticket-${ticketNumber}`);
  mkdirSync(dirname(worktree), { recursive: true });
  // Remove a stale worktree from a previous failed run, ignoring errors.
  git(repoPath, "worktree", "remove", "--force", worktree);
  const add = git(repoPath, "worktree", "add", "--force", worktree, branch);
  if (add.status !== 0) {
    throw new Error(`git worktree add failed: ${(add.stderr || add.stdout || "").trim()}`);
  }
  return worktree;
}

function removeWorktree(repoPath, worktree) {
  git(repoPath, "worktree", "remove", "--force", worktree);
}

/**
 * Signal the ticket back for RE-APPROVAL after the resolver committed a resolution.
 * This is the SINGLE, clearly-isolated Dispatch call: a human re-reviews the resolved
 * diff and re-approves, after which a later merge lands cleanly.
 *
 * The call is `wg ticket reopen-for-review <number> --reason … --resolution … --as
 * system` (ready_for_merge|done → in_review). Returns { ok, command, args, attempts }
 * describing what was invoked; buildReapprovalCommand is exported
 * so tests can assert the argv shape without a real `wg`.
 */
export function buildReapprovalCommand({ ticketNumber, reason, resolution }) {
  return {
    command: "wg",
    args: [
      "ticket",
      "reopen-for-review",
      String(ticketNumber),
      "--reason",
      reason,
      "--resolution",
      resolution,
      "--as",
      "system",
    ],
  };
}

function signalReapproval(ticketNumber, resolution) {
  const reason = "auto-merge conflict resolved by the resolver agent — re-review the resolved diff";
  const { command, args } = buildReapprovalCommand({ ticketNumber, reason, resolution });
  // A failed reopen is usually transient (a locked DB): retry with a short backoff before
  // the caller undoes the resolution. GAFFER_REAPPROVAL_ATTEMPTS / _BACKOFF_MS tune it.
  const attempts = Math.max(1, parseInt(process.env.GAFFER_REAPPROVAL_ATTEMPTS ?? "", 10) || 3);
  const backoff = Math.max(0, parseInt(process.env.GAFFER_REAPPROVAL_BACKOFF_MS ?? "", 10) || 500);
  let ok = false;
  let res = null;
  let n = 0;
  while (!ok && n < attempts) {
    if (n > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff * n);
    n += 1;
    res = runDispatch(args); // call the CLI directly — `wg` is not on PATH in this Node runner
    ok = !res.error && res.status === 0;
  }
  if (!ok) {
    log(
      `re-approval signal did not land after ${n} attempt(s) (\`${command} ${args.join(" ")}\` exit ` +
        `${res?.status ?? "spawn-error"})`,
    );
  }
  return { ok, command, args, attempts: n };
}

/**
 * LOCAL LANDING through the MERGE GATE, compare-and-land — the one loop every local
 * landing runs (the primary repo and each secondary repo of a multi-repo ticket): gate the
 * merge of `pin` onto the CURRENT target (gateProposedMerge), then land exactly the gated
 * merge commit while the target still is the gated head (landGatedMerge); a moved target
 * is re-gated (GAFFER_MERGE_GATE_RETRIES, default 2).
 *   → { kind: "landed", gate } | { kind: "conflict" | "red" | "error", gate }
 *     | { kind: "refused", code, reason }  (never lands on anything but "landed")
 */
function landThroughMergeGate({
  ticketNumber,
  repoPath,
  repoName,
  branch,
  defaultBranch,
  pin,
  commands,
  gateDir,
  secondary = false,
  testerReplay = null,
  trailers = [],
}) {
  const maxTries = Math.max(0, parseInt(process.env.GAFFER_MERGE_GATE_RETRIES ?? "", 10) || 2);
  const where = secondary && repoName ? ` in ${repoName}` : "";
  for (let attempt = 0; ; attempt++) {
    const gate = gateProposedMerge({
      repoPath,
      branch,
      pin,
      targetRef: `refs/heads/${defaultBranch}`,
      label: repoName,
      commands,
      gateDir,
      testerReplay: secondary ? null : testerReplay,
      // The gated merge commit is the commit that lands: it carries the trailers.
      trailers,
    });
    if (gate.kind === "conflict" || gate.kind === "red" || gate.kind === "error")
      return { kind: gate.kind, gate };
    log(
      gate.kind === "off"
        ? `#${ticketNumber}: MERGE GATE OFF (GAFFER_DOD=0) — the combination was not gated`
        : `#${ticketNumber}: MERGE GATE PASS — the merge of ${pin.slice(0, 12)} onto ${defaultBranch}@${gate.target.slice(0, 12)}${where} passes the gates`,
    );
    const l = landGatedMerge({
      repoPath,
      defaultBranch,
      target: gate.target,
      merge: gate.merge,
      branch,
      pin,
    });
    if (l.ok) return { kind: "landed", gate };
    if (l.code === "moved-target" && attempt < maxTries) {
      log(
        `#${ticketNumber}: ${defaultBranch} moved after the merge gate${where} — re-gating (${attempt + 1}/${maxTries})`,
      );
      continue;
    }
    return { kind: "refused", code: l.code, reason: l.reason };
  }
}

/** The evidence headline of a held gate (lib/land.sh _gaffer_merge_gate_hold's words). */
function holdHeadline(code) {
  if (code === "tester_replay_red") return "TESTER REPLAY FAILED";
  if (code === "tester_replay_unverified") return "TESTER REPLAY UNVERIFIED";
  return "MERGE GATE FAILED";
}

/**
 * The red merge gate's HOLD: the gate output becomes evidence on the ticket and the ticket
 * leaves the merge lane for the human queue (`wg ticket hold` → blocked, merge_gate_red).
 * The target was never touched. → { held, recorded }.
 */
function holdMergeGateRed(ticketNumber, gate, { branch, defaultBranch, repoName = "" }) {
  const where = repoName ? ` in ${repoName}` : "";
  // TESTER REPLAY: a red replay of the tester's tests holds exactly like a red gate, under
  // its own reason code, naming the files.
  const code = ["tester_replay_red", "tester_replay_unverified"].includes(gate.code)
    ? gate.code
    : "merge_gate_red";
  const recorded = recordEvidence(
    ticketNumber,
    "test_output",
    `${holdHeadline(code)}${where}: ${gate.reason}\n\n${gate.evidence || "DoD: FAIL"}`,
  );
  const r = runDispatch([
    "ticket",
    "hold",
    String(ticketNumber),
    "--reason-code",
    code,
    "--reason",
    code === "tester_replay_unverified"
      ? `Tester replay unverified: ${gate.reason}. Nothing landed and no replay record was written; ` +
        `${defaultBranch} was not touched. Make the repo's test command run the tester's files ` +
        `(or register one whose runner gaffer can run by path), then re-approve.`
      : (code === "tester_replay_red"
          ? `The independent tester's tests fail on the merge of ${branch} onto ${defaultBranch}@${gate.target.slice(0, 12)}${where} ` +
            `(${gate.reason}); ${defaultBranch} was not touched — see the tester-replay evidence. `
          : `The merge of ${branch} onto ${defaultBranch}@${gate.target.slice(0, 12)}${where} fails its gates ` +
            `(each side passed alone); ${defaultBranch} was not touched — see the merge-gate evidence. `) +
        `Rework the branch on the current ${defaultBranch}, then re-approve.`,
    "--as",
    "system",
  ]);
  return { held: !r.error && r.status === 0, recorded, code };
}

/** PER-REPOSITORY LANDING: the ticket's approved revisions (`wg ticket landing`). */
export function readLandingPlan(ticketNumber) {
  const r = runDispatch(["ticket", "landing", String(ticketNumber)]);
  if (r.error || r.status !== 0) return null;
  try {
    const j = JSON.parse(String(r.stdout || "").trim());
    return Array.isArray(j.repos) ? j.repos : null;
  } catch {
    return null;
  }
}

/** Record one repo's landing as the system actor (idempotent; logged, never fatal). */
function recordLandingCli(ticketNumber, repoId, sha, via) {
  if (!repoId || !sha) return;
  const r = runDispatch([
    "ticket",
    "record-landing",
    String(ticketNumber),
    "--repo",
    String(repoId),
    "--commit",
    String(sha),
    "--via",
    String(via || "local"),
    "--as",
    "system",
  ]);
  if (r.error || r.status !== 0)
    log(
      `WARNING: #${ticketNumber} could not record the landing of ${String(sha).slice(0, 12)} ` +
        `(${(r.stderr || "").trim().slice(0, 160)}) — the done gate re-checks git`,
    );
}

/**
 * Land every write repo OTHER than the primary: each lands only its pinned (approved)
 * commit, through the same landing check (`--secondary`: the tester verdict describes the
 * primary) and the same MERGE GATE + compare-and-land as the primary (landThroughMergeGate:
 * that repo's own gates on the merge onto its current target). A conflict, a dirty
 * checkout, a held check or a gate that could not run stops here — the ticket stays
 * ready_for_merge, partly merged, for a human (no resolver is spawned for a secondary
 * repo); a RED merge gate also holds the ticket (blocked, merge_gate_red) with the gate
 * output as evidence. Returns { ok, merged, landed, pending, reason }.
 */
function landSecondaryRepos(ticketNumber, primaryRepoId) {
  const plan = readLandingPlan(ticketNumber);
  const out = { ok: true, merged: [], landed: [], pending: [], reason: "" };
  if (!plan) return out; // legacy approval (no per-repo pins): the primary was the change
  // PROVENANCE TRAILERS — the same block the primary's merge commit carries.
  const trailers = provenanceTrailers({ dbPath: CONFIG.dispatchDb, ticketNumber });
  for (const r of plan) {
    if (r.repoId === primaryRepoId) {
      out.landed.push(r.repo);
      continue;
    }
    if (r.landed) {
      out.landed.push(r.repo);
      continue;
    }
    const why = (reason) => {
      out.ok = false;
      out.pending.push(r.repo);
      out.reason = `${r.repo}: ${reason}`;
      log(`#${ticketNumber} PARTLY MERGED — ${r.repo} did not land: ${reason}; held for a human`);
    };
    if (out.ok === false) {
      out.pending.push(r.repo);
      continue;
    }
    if (!r.localPath || !existsSync(r.localPath) || !r.branch) {
      why("its checkout or delivery branch is not available");
      continue;
    }
    const tree = inspectWorkingTree(r.localPath);
    if (tree.dirty) {
      why(`the live checkout has uncommitted changes (${tree.summary})`);
      continue;
    }
    const d = landingDecision({
      dbPath: CONFIG.dispatchDb,
      ticketNumber,
      repoPath: r.localPath,
      branch: r.branch,
      repoId: r.repoId,
      secondary: true,
    });
    if (!d.ok) {
      why(`landing check ${d.kind}: ${d.reason}`);
      continue;
    }
    if (d.kind === "already-landed") {
      out.landed.push(r.repo);
      continue;
    }
    const defaultBranch = r.defaultBranch || "main";
    const res = landThroughMergeGate({
      ticketNumber,
      repoPath: r.localPath,
      repoName: r.repo,
      branch: r.branch,
      defaultBranch,
      pin: d.pin,
      commands: resolveGateCommands(CONFIG.dispatchDb, ticketNumber, r.repoId),
      gateDir: resolve(GAFFER_DATA, "worktrees", `merge-gate-${ticketNumber}-${r.repoId}`),
      secondary: true,
      // Each repo's gated merge commit is the commit that lands there: it carries them too.
      trailers,
    });
    if (res.kind === "conflict") {
      why(`${res.gate.reason} (merge conflict)`);
      continue;
    }
    if (res.kind === "red") {
      const h = holdMergeGateRed(ticketNumber, res.gate, {
        branch: r.branch,
        defaultBranch,
        repoName: r.repo,
      });
      why(
        `MERGE GATE FAILED — ${res.gate.reason}; ${defaultBranch} untouched; ` +
          (h.held
            ? `ticket held for a human (blocked, ${h.code})`
            : "ticket left ready_for_merge (the hold could not be recorded)") +
          (h.recorded ? "; the gate output is on the ticket as evidence" : ""),
      );
      continue;
    }
    if (res.kind === "error") {
      why(`the merge gate could not run (${res.gate.reason}); nothing merged`);
      continue;
    }
    if (res.kind !== "landed") {
      why(`${res.reason}${res.code === "moved-target" ? " (kept moving while gated)" : ""}`);
      continue;
    }
    log(
      `merged #${ticketNumber} in ${r.repo} (${r.branch} → ${defaultBranch}) — landed the gated merge ${res.gate.merge.slice(0, 12)}`,
    );
    recordLandingCli(ticketNumber, r.repoId, d.pin, "local");
    out.landed.push(r.repo);
    out.merged.push({
      repo: r.repo,
      localPath: r.localPath,
      branch: r.branch,
      defaultBranch,
      pin: d.pin,
    });
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!String(opts.ticket).trim()) {
    fail("--ticket <number> is required (the approved ticket whose branch is being merged)");
    return;
  }

  const resolved = resolveTicket(CONFIG.dispatchDb, opts.ticket);
  if (!resolved && !opts.applyDigestOnly) {
    // No landable delivery. An unknown ticket, or one that is not approved yet (ready,
    // blocked: no delivery branch recorded), is the "not approved" refusal the help
    // promises (exit 4), not an internal resolution error; a done one is already merged.
    const st = ticketStatusOf(CONFIG.dispatchDb, opts.ticket);
    if (!st.exists) {
      fail(
        `no ticket #${opts.ticket} in this factory (db: ${CONFIG.dispatchDb}); nothing merged`,
        4,
      );
      return;
    }
    if (st.status === "done") {
      log(notLandableReason(opts.ticket, "done"));
      emit({ phase: "already_merged", ticket: Number(opts.ticket) }, 0);
      return;
    }
    if (st.status !== "ready_for_merge") {
      fail(notLandableReason(opts.ticket, st.status), 4);
      return;
    }
  }
  if (!resolved) {
    fail(
      `could not resolve ticket #${opts.ticket} to a repo + delivery branch in dispatch ` +
        `(db: ${CONFIG.dispatchDb}) — unknown ticket, no write repo, or no recorded branch`,
    );
    return;
  }
  const { repo, branch } = resolved;

  // APPROVAL GATE, before anything touches git, memory or claude: only an approved
  // (ready_for_merge) ticket lands. `gaffer merge <n>` on an in_review ticket used to
  // merge the unreviewed branch, delete it, and leave the board reading in_review.
  // --dry-run still reports the plan (inspection), with the refusal flagged.
  const landable = canLand(resolved.status, { applyDigestOnly: opts.applyDigestOnly });
  const notApproved = notLandableReason(resolved.number, resolved.status);
  if (!landable && resolved.status === "done" && !opts.dryRun && !opts.applyDigestOnly) {
    log(notApproved);
    emit({ phase: "already_merged", ticket: resolved.number }, 0);
    return;
  }
  if (!landable && (!opts.dryRun || opts.applyDigestOnly)) {
    fail(notApproved, 4);
    return;
  }

  if (opts.applyDigestOnly) {
    // review.sh's AFK path merged + mark-merged already; this is the SAME post-merge
    // memory step the dashboard merge runs below (digest delta / stamp + feature →
    // shipped), so an unattended merge no longer skips the memory work. Best-effort
    // and fully swallowed inside applyDigestAndFeature; exit 0 unless the apply itself
    // reports it could not run (then 2, so the caller can log it).
    const digest = applyDigestAndFeature({ ticketNumber: resolved.number, repo: repo.name });
    const digestLog = formatDigestApplyLog(digest, resolved.number);
    if (digestLog) log(digestLog.message);
    emit(
      { phase: "digest-applied", ticket: resolved.number, repo: repo.name, branch, digest },
      digest.applied || digest.skipped ? 0 : 2,
    );
    return;
  }

  if (!opts.dryRun && !existsSync(repo.localPath)) {
    fail(
      `ticket #${resolved.number} repo "${repo.name}" resolves to ${repo.localPath}, which is not on disk`,
    );
    return;
  }

  // The worktree the resolver WOULD use (deterministic so the dry-run argv matches the
  // live one).
  const plannedWorktree = resolve(GAFFER_DATA, "worktrees", `merge-ticket-${resolved.number}`);
  const resolverPrompt = buildResolverPrompt({
    ticketNumber: resolved.number,
    repoName: repo.name,
    worktree: plannedWorktree,
    branch,
    defaultBranch: repo.defaultBranch,
  });

  if (opts.dryRun) {
    // Test/inspection path: report the planned merge target + resolver argv WITHOUT
    // touching git or spawning claude.
    const resolverArgv = buildClaudeArgv({
      prompt: resolverPrompt,
      mcpConfig: mergeTicketMcpRuntimePath(resolved.number),
      flags: CONFIG.claudeFlags,
      maxTurns: mergeMaxTurns(),
    });
    emit(
      {
        phase: "dry-run",
        ticket: resolved.number,
        repo: repo.name,
        repoPath: repo.localPath,
        branch,
        defaultBranch: repo.defaultBranch,
        timeoutMs: opts.timeoutMs,
        claudeBin: CONFIG.claudeBin,
        mergeTarget: { repo: repo.localPath, branch, defaultBranch: repo.defaultBranch },
        worktree: plannedWorktree,
        resolverArgv,
        status: resolved.status,
        ...(landable ? {} : { refused: notApproved }),
      },
      0,
    );
    return;
  }

  // Fail CLOSED: never run a live agent without the deterministic safety hook.
  if (!existsSync(resolve(RUNNER_DIR, "safety-hook.mjs"))) {
    fail(
      `safety hook missing at ${resolve(RUNNER_DIR, "safety-hook.mjs")} — refusing live run (fail closed)`,
    );
    return;
  }

  // 0. Never touch a DIRTY live checkout. Both landing paths below operate in the real
  //    repo (checkout + merge, or a fast-forward); an operator's uncommitted edits there
  //    used to be carried across the checkout — or the checkout failed and was read as a
  //    CONFLICT, spawning the resolver on a branch with nothing to resolve. Refuse, leave
  //    the ticket at ready_for_merge and the tree exactly as it was.
  const tree = inspectWorkingTree(repo.localPath);
  if (tree.dirty) {
    fail(
      `refusing to merge #${resolved.number}: the live checkout ${repo.localPath} has uncommitted ` +
        `changes (${tree.summary}) — commit or stash them, then re-run the merge; ticket left ` +
        `ready_for_merge, working tree untouched`,
    );
    return;
  }

  // 0b. ACCEPTANCE GATE — the SAME landing decision lib/land.sh applies (one module,
  //     lib/tester-binding.mjs): never land code the tester did not run; an acceptance
  //     ticket needs a bound tester PASS (or a human waiver); fail closed. The decision
  //     names the exact commit to land, which both merge routes below are pinned to.
  const decision = landingDecision({
    dbPath: CONFIG.dispatchDb,
    ticketNumber: resolved.number,
    repoPath: repo.localPath,
    branch,
    repoId: repo.id || null,
  });
  if (!decision.ok) {
    fail(
      `refusing to merge #${resolved.number}: landing check ${decision.kind}: ${decision.reason}` +
        (decision.kind === "moved"
          ? ` (tested ${String(decision.tested).slice(0, 12)}, head is now ${String(decision.head).slice(0, 12)}) — re-test the branch or record a human verdict`
          : decision.kind === "moved-since-review"
            ? ` (reviewed ${String(decision.reviewed).slice(0, 12)}, head is now ${String(decision.head).slice(0, 12)}) — move it back to in_review for a re-review`
            : "") +
        `; ticket left ready_for_merge, nothing merged`,
      4,
    );
    return;
  }
  if (decision.kind === "waived") log(`#${resolved.number}: landing on a HUMAN tester waiver`);
  const pin = decision.pin;
  // PROVENANCE TRAILERS for the merge commit — the same block lib/land.sh writes.
  const trailers = provenanceTrailers({ dbPath: CONFIG.dispatchDb, ticketNumber: resolved.number });
  // PER-REPOSITORY LANDING: the primary repo's approved commit already landed (a retry
  // after a partial landing) — never merge it again; land the repos still pending.
  let landed =
    decision.kind === "already-landed"
      ? (log(
          `#${resolved.number}: ${repo.name} already landed ${String(pin).slice(0, 12)} — not merged again`,
        ),
        { via: "earlier" })
      : null;

  // 1. Land the delivery. PR MODE first: when the ticket carries a pr_url (the runner
  //    opened a PR under GAFFER_CREATE_PR) and `gh` is available, merge THROUGH the PR
  //    and fast-forward the local default branch from the remote — a local merge here
  //    left the PR open and the default branch unpushed. If gh fails, fall back to the
  //    local conflict-safe merge (gaffer_auto_merge semantics) and say why.
  const ghBin = process.env.GAFFER_GH_BIN || "gh";
  // GAFFER_PR_LOCAL_FALLBACK=1: the operator's explicit choice to land a PR-mode ticket
  // LOCALLY when the PR merge cannot run. Off by default — a failed PR merge holds.
  const prLocalFallback = /^(1|true|yes|on)$/i.test(process.env.GAFFER_PR_LOCAL_FALLBACK || "");
  // MERGE GATE (every landing route): the combination of the pin and the CURRENT target
  // is what lands, so it is what is gated; a red combination is held for a human.
  let conflict = false;
  const gateCommands = resolveGateCommands(CONFIG.dispatchDb, resolved.number, repo.id || null);
  const gateDir = resolve(GAFFER_DATA, "worktrees", `merge-gate-${resolved.number}`);
  // TESTER REPLAY: the primary repo's gate also replays the tester's tests on the candidate.
  const testerReplay = { dbPath: CONFIG.dispatchDb, ticketNumber: resolved.number };
  let replayed = null; // { merge, files } of the gate whose candidate lands
  const holdRed = (gate) => {
    const h = holdMergeGateRed(resolved.number, gate, {
      branch,
      defaultBranch: repo.defaultBranch,
    });
    fail(
      `refusing to merge #${resolved.number}: ${holdHeadline(h.code)} — ${gate.reason}; ` +
        `${repo.defaultBranch} untouched; ` +
        (h.held
          ? `ticket held for a human (blocked, ${h.code})`
          : "ticket left ready_for_merge (the hold could not be recorded)") +
        (h.recorded ? "; the gate output is on the ticket as evidence" : ""),
      4,
    );
  };
  if (!landed && resolved.prUrl) {
    if (ghAvailable(ghBin)) {
      // PR MODE: gate against the remote target as just fetched (the local default when
      // the fetch fails). GitHub merges the PR; its branch protection ("require branches
      // to be up to date" + required checks) is the compare-and-land upstream.
      const remote = String(process.env.GAFFER_PR_REMOTE || "origin");
      const fetched = git(repo.localPath, "fetch", "--quiet", remote, repo.defaultBranch);
      const gate = gateProposedMerge({
        repoPath: repo.localPath,
        branch,
        pin,
        targetRef: fetched.status === 0 ? "FETCH_HEAD" : `refs/heads/${repo.defaultBranch}`,
        label: repo.name,
        commands: gateCommands,
        gateDir,
        testerReplay,
      });
      if (gate.kind === "red") return holdRed(gate);
      if (gate.replay?.record)
        replayed = { merge: gate.merge, files: gate.replay.files, note: gate.replay.note || "" };
      if (gate.kind === "error") {
        fail(
          `refusing to merge #${resolved.number}: the merge gate could not run (${gate.reason}); nothing merged, ticket stays ready_for_merge`,
        );
        return;
      }
      if (gate.kind === "conflict") conflict = true;
    }
  }
  if (!landed && resolved.prUrl && !conflict) {
    if (ghAvailable(ghBin)) {
      const pr = mergeViaPr({
        repoPath: repo.localPath,
        prUrl: resolved.prUrl,
        defaultBranch: repo.defaultBranch,
        ghBin,
        method: process.env.GAFFER_PR_MERGE_METHOD,
        remote: process.env.GAFFER_PR_REMOTE,
        matchHeadCommit: pin,
        body: trailers.join("\n"),
      });
      if (pr.ok) {
        landed = { via: "pr", prUrl: resolved.prUrl, fastForwarded: pr.fastForwarded };
        log(
          `merged #${resolved.number} through its PR ${resolved.prUrl} (${pr.argv.join(" ")})` +
            (pr.fastForwarded
              ? `; local ${repo.defaultBranch} fast-forwarded from the remote`
              : ""),
        );
        if (!pr.fastForwarded) {
          log(
            `WARNING: #${resolved.number} PR merged but the local ${repo.defaultBranch} could not be ` +
              `fast-forwarded (${pr.ffReason}) — pull it by hand`,
          );
        }
      } else if (prLocalFallback) {
        log(
          `PR merge for #${resolved.number} failed — ${pr.reason}; GAFFER_PR_LOCAL_FALLBACK=1: falling back to a ` +
            `LOCAL merge of ${branch} (the PR ${resolved.prUrl} stays open — close it by hand)`,
        );
      } else {
        // PR MODE means "done = the PR merged upstream". Do not redefine a failed PR
        // merge as success by landing locally: the ticket would read done while the PR
        // sits open and the remote default branch never gets the change. Hold.
        fail(
          `PR merge for #${resolved.number} failed — ${pr.reason}; ticket HELD in ready_for_merge for a human ` +
            `(merge ${resolved.prUrl} by hand, or set GAFFER_PR_LOCAL_FALLBACK=1 to land locally instead)`,
        );
        return;
      }
    } else if (prLocalFallback) {
      log(
        `#${resolved.number} has PR ${resolved.prUrl} but '${ghBin}' is not available (GAFFER_GH_BIN) — ` +
          `GAFFER_PR_LOCAL_FALLBACK=1: falling back to a LOCAL merge of ${branch} (the PR stays open — close it by hand)`,
      );
    } else {
      fail(
        `#${resolved.number} has PR ${resolved.prUrl} but '${ghBin}' is not available (GAFFER_GH_BIN) — ` +
          `ticket HELD in ready_for_merge for a human (install/authenticate gh and merge the PR, or set ` +
          `GAFFER_PR_LOCAL_FALLBACK=1 to land locally instead)`,
      );
      return;
    }
  }
  if (!landed && !conflict) {
    // LOCAL LANDING through the merge gate, compare-and-land: the gated merge commit
    // lands only while the target still is the gated target head; a moved target is
    // re-gated (GAFFER_MERGE_GATE_RETRIES, default 2), then left for the next run.
    const res = landThroughMergeGate({
      ticketNumber: resolved.number,
      repoPath: repo.localPath,
      repoName: repo.name,
      branch,
      defaultBranch: repo.defaultBranch,
      pin,
      commands: gateCommands,
      gateDir,
      testerReplay,
      // The gated merge commit is the commit that lands: it carries the trailers.
      trailers,
    });
    // A conflict falls through to the resolver below (landed stays null).
    if (res.kind === "red") return holdRed(res.gate);
    if (res.kind === "error") {
      fail(
        `refusing to merge #${resolved.number}: the merge gate could not run (${res.gate.reason}); nothing merged, ticket stays ready_for_merge`,
      );
      return;
    }
    if (res.kind === "landed") {
      landed = { via: "local", gatedMerge: res.gate.merge, gatedTarget: res.gate.target };
      replayed = res.gate.replay?.record
        ? { merge: res.gate.merge, files: res.gate.replay.files, note: res.gate.replay.note || "" }
        : null;
      log(
        `merged #${resolved.number} (${branch} → ${repo.defaultBranch}) — landed the gated merge ${res.gate.merge.slice(0, 12)}`,
      );
    } else if (res.kind === "refused") {
      // Not a conflict — nothing on the branch to resolve. Refuse, leave the ticket at
      // ready_for_merge and the live checkout as it was (never spawn the resolver).
      fail(
        `refusing to merge #${resolved.number}: ${res.reason}${res.code === "moved-target" ? " (kept moving while gated)" : ""} — ` +
          `live checkout left untouched; ticket stays ready_for_merge for a human`,
        res.code === "moved-branch" ? 4 : 1,
      );
      return;
    }
  }
  if (landed) {
    // PER-REPOSITORY LANDING: record the primary repo's landing, then land every OTHER
    // write repo's approved commit. A ticket is done only when all of them landed; one
    // that does not land leaves the ticket HELD (ready_for_merge, "Partly merged" in the
    // human queue) with what did land recorded, so a retry lands only the rest.
    if (landed.via !== "earlier" && repo.id)
      recordLandingCli(resolved.number, repo.id, pin, landed.via);
    // TESTER REPLAY: which tester assertions passed on which landed revision. A local
    // landing lands exactly the gated merge. A PR landing lands what GitHub made of the PR
    // (merge, squash or rebase, on the remote default as it stood then): the record names
    // the fast-forwarded local default's head, and only when its tree is the candidate's
    // the replay passed on; otherwise (or not fast-forwarded) nothing shows the replay ran
    // on what landed, so no record is written and the epic is not counted as accepted.
    if (landed.via !== "earlier" && replayed) {
      const landedRev = testerReplayLandedRevision(repo, landed, replayed.merge);
      if (landedRev.ok)
        recordTesterReplayCli(
          resolved.number,
          repo.id || null,
          landedRev.commit,
          pin,
          replayed.files,
          landed.via,
          replayed.note,
        );
      else
        log(
          `#${resolved.number}: NO tester replay record — ${landedRev.reason}; the epic is not counted as accepted`,
        );
    }
    const others = landSecondaryRepos(resolved.number, repo.id);
    if (!others.ok) {
      emit(
        {
          phase: "partially_merged",
          ticket: resolved.number,
          landed: others.landed,
          pending: others.pending,
          error: others.reason,
        },
        4,
      );
      return;
    }
    // Flip the ticket ready_for_merge → done now that the branch is actually merged.
    // Non-fatal: the merge already landed; a failure just leaves it in ready_for_merge
    // (a human can run `wg ticket mark-merged <n> --as system`).
    const mm = runDispatch(["ticket", "mark-merged", String(resolved.number), "--as", "system"]);
    if (mm.error || mm.status !== 0) {
      log(
        `WARNING: #${resolved.number} merged but mark-merged failed (exit ${mm.status ?? "spawn-error"}` +
          `${mm.stderr ? ": " + mm.stderr.trim().slice(0, 120) : ""}) — flip to done manually`,
      );
    } else {
      log(`marked #${resolved.number} merged → done`);
    }
    // POST-REVIEW digest refresh + feature → shipped — deterministic, NO agent.
    // The delivery agent PREPARED the delta as recorded evidence; we APPLY it here
    // (or fall back to a minimal stamp). Best-effort + fully swallowed: this can
    // NEVER fail or un-land the merge that already happened above.
    const digest = applyDigestAndFeature({ ticketNumber: resolved.number, repo: repo.name });
    const digestLog = formatDigestApplyLog(digest, resolved.number);
    if (digestLog) log(digestLog.message);
    // Clean up the now-merged delivery branch so they don't pile up. `-d` is safe:
    // it only deletes a branch fully merged into the current HEAD (the default branch
    // we just merged into), so an unmerged branch is never lost.
    // `branch -d` checks "merged into HEAD"; with the target not checked out the gated
    // landing moved only its ref — then delete the branch only while it still points at
    // the landed pin, which is in the target's history now (nothing can be lost).
    let del = git(repo.localPath, "branch", "-d", branch);
    if (
      del.status !== 0 &&
      git(repo.localPath, "merge-base", "--is-ancestor", pin, repo.defaultBranch).status === 0
    )
      del = git(repo.localPath, "update-ref", "-d", `refs/heads/${branch}`, pin);
    if (del.status === 0) log(`deleted merged branch ${branch}`);
    for (const o of others.merged) {
      let d2 = git(o.localPath, "branch", "-d", o.branch);
      if (
        d2.status !== 0 &&
        git(o.localPath, "merge-base", "--is-ancestor", o.pin, o.defaultBranch).status === 0
      )
        d2 = git(o.localPath, "update-ref", "-d", `refs/heads/${o.branch}`, o.pin);
      if (d2.status === 0) log(`deleted merged branch ${o.branch} in ${o.repo}`);
    }
    // Self-hosting seam: if we just merged into the repo that RUNS the dashboard
    // (dispatch — where DISPATCH_CLI lives), its served dist/ is now stale. Rebuild
    // it so merged UI changes show up immediately — static web assets are served from
    // dist on each request, so UI changes need no restart (API changes still do).
    // Best-effort + logged; a no-op for any other repo the factory delivers to.
    if (resolve(repo.localPath) === resolve(DISPATCH_CLI, "..", "..", "..")) {
      log(`rebuilding the dashboard repo (${repo.name}) so the merged change is served…`);
      const b = spawnSync("pnpm", ["-s", "build"], { cwd: repo.localPath, encoding: "utf8" });
      log(
        b.status === 0
          ? `dashboard repo rebuilt — UI is current`
          : `dashboard rebuild failed (exit ${b.status ?? "spawn-error"}) — run \`pnpm build\` in ${repo.name} to refresh the UI`,
      );
    }
    // Incremental card refresh: bring the cards in line with the MERGED COMMIT (the
    // default branch's new tip), read from a throwaway worktree of that commit — never
    // the live checkout (it can carry uncommitted edits) and never the delivery
    // branch's own view (an overlapping ticket's rename merged since it forked would be
    // invisible to it). refreshFileCards then verifies EVERY stored card against that
    // tree before it records the watermark. Fail-soft: any error here is swallowed and
    // NEVER affects the merge outcome (already landed above).
    try {
      refreshCardsForMergedCommit(repo, landed, log);
    } catch (err) {
      log(`card-refresh: failed (${err?.message ?? err}) — skipped; merge unaffected`);
    }
    emit(
      {
        phase: "merged",
        ticket: resolved.number,
        repo: repo.name,
        branch,
        defaultBranch: repo.defaultBranch,
        ...landed,
        digest,
      },
      0,
    );
    return;
  }

  // 2. Conflict → resolver agent on a throwaway worktree of the delivery branch.
  log(
    `#${resolved.number} (${branch} → ${repo.defaultBranch}) conflicted — spawning the resolver agent`,
  );

  // The branch head BEFORE the resolver touches it: if the ticket cannot be sent back for
  // review afterwards, the resolution is undone to exactly this commit.
  const preResolution = branchHead(repo.localPath, branch);
  // …and the default-branch tip it merges in: the conflict-marker check compares the
  // resolution against BOTH sides.
  const defaultTip = branchHead(repo.localPath, repo.defaultBranch);
  let worktree;
  try {
    worktree = addWorktree(repo.localPath, branch, resolved.number);
  } catch (e) {
    fail(`failed to create resolver worktree: ${e?.message ?? e}`);
    return;
  }

  let mcpRuntime;
  try {
    mcpRuntime = installProjectLocalWiring(worktree, resolved.number, repo.name, {
      stack: repo.stack,
    });
  } catch (e) {
    rmSync(mergeTicketMcpRuntimePath(resolved.number), { force: true });
    removeWorktree(repo.localPath, worktree);
    fail(`failed to install project-local wiring: ${e?.message ?? e}`);
    return;
  }

  // USAGE LEDGER: ask for the JSON envelope so the resolver's spend is measured like
  // every other agent turn (it used to be the one paid call the ledger never saw); the
  // agent's text summary is taken from `.result` below.
  const argv = buildClaudeArgv({
    prompt: resolverPrompt,
    mcpConfig: mcpRuntime,
    flags: CONFIG.claudeFlags,
    maxTurns: mergeMaxTurns(),
  }).concat(["--output-format", "json"]);
  // Route through the ONE worker spawn seam (lib/worker.mjs): it applies the same
  // containment decision as the bash seam (OS-sandbox wrap under STRICT_MODE /
  // GAFFER_STRICT_REQUIRE, fail closed when the host cannot supply one) and the
  // provider dispatch. This spawn used to be a bare spawnSync — the one agent that
  // runs exactly when AUTO_MERGE is on ran outside the containment seam.
  const t0 = Date.now();
  const res = Worker.deliver({
    kind: "merge-resolver",
    bin: CONFIG.claudeBin,
    argv,
    cwd: worktree,
    timeoutMs: opts.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: buildChildEnv(process.env, {
      dispatchDb: CONFIG.dispatchDb,
      memoryDb: CONFIG.memoryDb,
      writeRoot: worktree,
    }),
  });
  // The rendered runtime served this one spawn: drop it whatever the outcome, so
  // GAFFER_DATA does not collect one mcp-merge-ticket-<n>-runtime.json per ticket.
  rmSync(mcpRuntime, { force: true });
  // SKILL TELEMETRY (fail-soft): the merge role's mount and, best-effort, what was used.
  recordSkillUsage({
    ticket: resolved.number,
    role: "merge",
    stack: repo.stack,
    selected: mountedNames(resolve(worktree, ".claude", "skills-mount")),
    output: res.stdout || "",
    agentDir: worktree,
    since: new Date(t0).toISOString(),
  });

  if (res.error) {
    removeWorktree(repo.localPath, worktree);
    if (res.error.code === "ETIMEDOUT") {
      recordKilledCall({
        ticket: resolved.number,
        kind: "merge-resolver",
        reason: "resolver claude call timed out",
        elapsedMs: Date.now() - t0,
      });
      fail(`resolver agent timed out after ${opts.timeoutMs}ms`);
      return;
    }
    fail(`failed to spawn resolver claude: ${res.error.message ?? res.error}`);
    return;
  }

  // R-7: check the resolver's exit code BEFORE treating the run as successful.
  // spawnSync sets res.error for spawn failures but res.status for process exits.
  // A non-zero exit means the resolver agent itself failed (crash, MCP error, etc.);
  // firing re-approval with an empty or garbage summary in that case produces a
  // misleading "conflict_resolved_pending_reapproval" event with no real fix on the
  // branch. Soft-fail with a descriptive JSON output so the operator can investigate.
  if (res.status !== 0 && res.status !== null) {
    removeWorktree(repo.localPath, worktree);
    // The failed resolver still did paid work: ledger it (measured when its envelope
    // parses, else the labelled kill estimate) — this branch used to write no row.
    const failedJson = parseClaudeJson(res.stdout || "");
    if (failedJson === null) {
      recordKilledCall({
        ticket: resolved.number,
        kind: "merge-resolver",
        reason: `resolver claude exited ${res.status}`,
        elapsedMs: Date.now() - t0,
      });
    } else {
      appendUsageRecord(
        buildUsageRecord({ json: failedJson, ticket: resolved.number, kind: "merge-resolver" }),
      );
    }
    emit(
      {
        phase: "conflict_resolver_failed",
        ticket: resolved.number,
        repo: repo.name,
        branch,
        defaultBranch: repo.defaultBranch,
        resolver_exit: res.status,
        resolver_stderr: (res.stderr || "").trim().slice(0, 500),
        error: `resolver agent exited ${res.status} — re-approval suppressed; branch ${branch} preserved for manual resolution`,
      },
      1,
    );
    return;
  }

  // Ledger the turn (measured when the envelope parses; the labelled kill estimate
  // otherwise) and reduce the envelope to the agent's text for the re-approval summary.
  const resolverJson = parseClaudeJson(res.stdout || "");
  if (resolverJson === null) {
    recordKilledCall({
      ticket: resolved.number,
      kind: "merge-resolver",
      reason: "no parseable --output-format json on stdout",
      elapsedMs: Date.now() - t0,
    });
  } else {
    appendUsageRecord(
      buildUsageRecord({ json: resolverJson, ticket: resolved.number, kind: "merge-resolver" }),
    );
  }
  const summary = (
    resolverJson === null ? res.stdout || "" : extractResultText(resolverJson)
  ).trim();
  if (summary) log(summary);

  // A resolver that aborted, gave up, or left the merge uncommitted still exits 0.
  // Re-approval is signalled only when the default branch really is merged into the
  // branch's committed head; otherwise a human would re-approve an unchanged branch
  // that conflicts again at the next merge.
  const resolution = resolutionLanded(worktree, repo.defaultBranch);
  if (!resolution.ok) {
    removeWorktree(repo.localPath, worktree);
    emit(
      {
        phase: "conflict_unresolved",
        ticket: resolved.number,
        repo: repo.name,
        branch,
        defaultBranch: repo.defaultBranch,
        reason: resolution.reason,
        resolver_summary: summary.slice(0, 500),
        error: `resolver finished without resolving: ${resolution.reason} — re-approval suppressed; branch ${branch} preserved for manual resolution`,
      },
      1,
    );
    return;
  }

  // RE-GATE the resolved head BEFORE it goes back to review: the DoD gates ran once, on
  // the delivery, and the reviewer is told to trust that evidence — a resolution is new
  // code nobody had tested. The gates run on a clean detached checkout of the branch's COMMITTED head (what
  // lands), not on this worktree: anything the resolver left uncommitted is discarded.
  const resolvedHead = branchHead(repo.localPath, branch);
  const regate = regateResolution({
    repoPath: repo.localPath,
    commit: resolvedHead,
    worktree,
    gateDir: resolve(GAFFER_DATA, "worktrees", `merge-ticket-${resolved.number}-regate`),
    parents: [preResolution, defaultTip],
    base: defaultTip || `refs/heads/${repo.defaultBranch}`,
    label: repo.name || "repo",
    commands: resolveGateCommands(CONFIG.dispatchDb, resolved.number),
  });

  // The resolution lives on the branch (the resolver committed to it in the worktree).
  // Tear the worktree down — the branch ref keeps the commits.
  removeWorktree(repo.localPath, worktree);

  if (!regate.ok) {
    const aside = setResolutionAside(
      repo.localPath,
      branch,
      preResolution,
      resolved.number,
      "re-gate failed",
    );
    const recorded = recordEvidence(
      resolved.number,
      "test_output",
      `${regate.evidence}\n\nconflict resolution re-gate FAILED: ${regate.reason} — the resolution was NOT sent to review` +
        (aside.restored ? ` (kept on ${aside.sideRef}; ${branch} restored)` : ""),
    );
    emit(
      {
        phase: "conflict_resolution_gate_failed",
        ticket: resolved.number,
        repo: repo.name,
        branch,
        defaultBranch: repo.defaultBranch,
        regate: { markers: regate.markers, dod: regate.dod, evidence_recorded: recorded },
        sideRef: aside.restored ? aside.sideRef : null,
        restored: aside.restored,
        error:
          `${regate.reason} — the ticket was NOT reopened for review; ` +
          (aside.restored
            ? `the resolution was moved to ${aside.sideRef} and ${branch} restored to ${preResolution.slice(0, 12)}`
            : `the resolution could NOT be moved off ${branch}; do not merge it`) +
          `; held for a human`,
      },
      1,
    );
    return;
  }

  // 3. Signal the ticket back for re-approval (single isolated Dispatch call).
  const reapproval = signalReapproval(
    resolved.number,
    summary || "merge conflict resolved on the branch",
  );
  if (!reapproval.ok) {
    // The ticket is still ready_for_merge, so the NEXT landing (a clean merge now: the
    // default branch is already merged in) would ship the resolver's unreviewed commit —
    // while the log said it had gone back for review. Move the resolution aside and put
    // the branch back (compare-and-swap: only if it still points at the resolution). It
    // conflicts again, and the .merge-conflict-resolved marker holds it for a human.
    const { sideRef, restored } = setResolutionAside(
      repo.localPath,
      branch,
      preResolution,
      resolved.number,
      "re-approval failed",
    );
    emit(
      {
        phase: "conflict_resolved_reapproval_failed",
        ticket: resolved.number,
        repo: repo.name,
        branch,
        defaultBranch: repo.defaultBranch,
        reapproval,
        sideRef: restored ? sideRef : null,
        restored,
        error:
          `the ticket could not be reopened for re-review after the resolver's merge — ` +
          (restored
            ? `the resolution was moved to ${sideRef} and ${branch} restored to ${preResolution.slice(0, 12)}`
            : `the resolution could NOT be moved off ${branch}; do not merge it before a re-review`) +
          `; held for a human`,
      },
      1,
    );
    return;
  }

  // Fresh evidence for the re-review: the DoD verdict on the RESOLVED head, recorded
  // after the reopen so it is the newest checklist the reviewer reads.
  const regateRecorded =
    regate.dod === "PASS"
      ? recordEvidence(
          resolved.number,
          "test_output",
          `${regate.evidence}\n\nconflict resolution re-gate: the DoD gates were re-run on a clean checkout of the resolved head ${(regate.commit || "").slice(0, 12)} (no conflict markers)`,
        )
      : false;
  // NOT LANDED (exploratory finding cli-runner/F-10): the resolution sits on the branch
  // waiting for a re-review, so `gaffer merge` must not exit 0 as if it had merged.
  // Exit 4 (held, nothing landed) with the exact re-approval command.
  process.stderr.write(
    `not merged: conflict resolved on ${branch} and sent back for re-review; ` +
      `re-approve with \`gaffer approve ${resolved.number} --commit ${repo.name}=${String(regate.commit || resolvedHead || "<resolved-head>")}\`, ` +
      "then merge again\n",
  );
  emit(
    {
      phase: "conflict_resolved_pending_reapproval",
      ticket: resolved.number,
      repo: repo.name,
      branch,
      defaultBranch: repo.defaultBranch,
      reapproval,
      regate: { markers: [], dod: regate.dod, evidence_recorded: regateRecorded },
    },
    4,
  );
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
