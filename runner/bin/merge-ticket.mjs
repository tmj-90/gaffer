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
//   • strips DISPATCH_API_TOKEN from the child env (the resolver delivers through the
//     dispatch MCP, never the privileged HTTP API);
//   • bounded by a timeout;
//   • emits exactly ONE JSON line on stdout.
//
// =====================================================================
// CLI CONTRACT (tick.sh / the dashboard build to this)
// ---------------------------------------------------------------------
// INVOCATION:
//   node bin/merge-ticket.mjs --ticket <number> [--dry-run] [--timeout-ms N]
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
//
// FLAGS:
//   --ticket <number>    (required) the approved ticket whose branch is being merged.
//   --timeout-ms N       (GAFFER_MERGE_TIMEOUT_MS, default 600000) resolver kill-timer.
//   --dry-run            do NOT spawn claude or mutate git; print the planned merge
//                        target + resolver claude argv as JSON (the test seam).
//
// OUTPUT (stdout, exactly ONE JSON object; the phase is the outcome):
//   merged:    { "phase":"merged", ticket, repo, branch, defaultBranch, digest }
//              — the merge landed cleanly. `digest` reports the POST-REVIEW,
//                DETERMINISTIC (no-agent) Repo-Digest refresh + feature→shipped:
//                { applied, prepared, jobs:[{kind,ok}], error? } — see applyDigestAndFeature.
//                It is best-effort + fully swallowed: it can never fail the merge.
//                When it FAILS, `applied:false` + `error` are carried here AND a
//                prominent WARNING is logged (R-3), so a stale digest / a feature
//                stuck at `building` is VISIBLE rather than silently swallowed.
//   conflict_resolved_pending_reapproval:
//              { "phase":"conflict_resolved_pending_reapproval", ticket, repo, branch,
//                defaultBranch, reapproval:{...} }
//              — the merge conflicted; the resolver committed a resolution ON THE
//                BRANCH and the ticket was signalled for re-approval. The branch is
//                NOT landed to the default branch.
//   dry-run:   { "phase":"dry-run", ticket, repo, branch, defaultBranch, timeoutMs,
//                claudeBin, mergeTarget, resolverArgv }
//   error:     { "phase":"error", error }   (exit 1)
//
// EXIT: 0 on merged / conflict_resolved_pending_reapproval / dry-run; 1 on any hard
//   failure (missing repo/branch/safety hook, spawn error, timeout).
// =====================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildApplyCommands,
  buildFeatureShippedCommands,
  buildMinimalDigestStamp,
  selectPreparedDelta,
} from "../lib/feature-digest.mjs";

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
  const opts = { ticket: "", timeoutMs: DEFAULTS.timeoutMs, dryRun: false };
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
    const ticket = db
      .prepare("SELECT id, number, branch_name AS branchName FROM tickets WHERE number = ?")
      .get(num);
    if (!ticket || !ticket.id) return null;

    // The write-access execution repo this ticket delivers into. Prefer access='write'
    // (the WG-002 boundary), falling back to the legacy role='primary' so older rows
    // still resolve. tr.branch_name is the per-repo delivery branch.
    const repoRow = db
      .prepare(
        "SELECT r.name AS name, r.local_path AS localPath, " +
          "r.default_branch AS defaultBranch, tr.branch_name AS repoBranch " +
          "FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id " +
          "WHERE tr.ticket_id = ? " +
          "ORDER BY (tr.access = 'write') DESC, (tr.role = 'primary') DESC " +
          "LIMIT 1",
      )
      .get(ticket.id);
    if (!repoRow || !repoRow.localPath) return null;

    const branch = String(repoRow.repoBranch || ticket.branchName || "").trim();
    if (!branch) return null;

    return {
      ticketId: String(ticket.id),
      number: ticket.number,
      repo: {
        name: String(repoRow.name || ""),
        localPath: String(repoRow.localPath),
        defaultBranch: String(repoRow.defaultBranch || "main"),
      },
      branch,
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
 * Attempt the conflict-safe merge, mirroring lib/automerge.sh's gaffer_auto_merge
 * semantics in JS so this runner is self-contained: checkout the default branch, then
 * a plain `git merge --no-edit <branch>`. NEVER --force, NEVER reset --hard, NEVER
 * push. On conflict it `git merge --abort`s (restoring the default branch) and reports
 * the conflict so the caller spawns the resolver.
 *
 * Returns { clean: true } on a landed merge, { clean: false } on a conflict (aborted,
 * branch left intact). Honoured only on the live path; --dry-run never calls this.
 */
export function attemptMerge(repoPath, branch, defaultBranch) {
  const git = (...args) => spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  const co = git("checkout", defaultBranch);
  if (co.status !== 0) return { clean: false, reason: `could not checkout ${defaultBranch}` };
  const merge = git("merge", "--no-edit", branch);
  if (merge.status === 0) return { clean: true };
  // Conflict (or other merge failure): abort so the default branch is restored and the
  // delivery branch is left intact for the resolver.
  git("merge", "--abort");
  return { clean: false, reason: "merge conflict" };
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
    "When done, record a SHORT summary of what you resolved and why (which conflicts, how",
    "you preserved each side, test result) as the ticket's resolution evidence via the",
    "dispatch MCP, and print that summary as the last line of your message. Do NOT",
    "approve the ticket yourself — re-approval is a human's call.",
  ].join("\n");
}

/**
 * Build the full resolver `claude -p` argv (the same shape decompose.mjs /
 * product-owner-run.mjs produce): [-p, prompt, --mcp-config, <runtime>, ...flags].
 * Pulled out so the dry-run path and tests can assert it without spawning anything.
 */
export function buildClaudeArgv({ prompt, mcpConfig, flags }) {
  const args = ["-p", prompt];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  return args.concat(flags);
}

/**
 * Build the child env for the resolver: the run delivers through the dispatch MCP
 * (DB path), is bounded to the worktree as its sole write-root (FG-007), and — per the
 * runner contract — STRIPS DISPATCH_API_TOKEN so a headless agent can never reach the
 * privileged Dispatch HTTP API; it only has the scoped MCP data plane. Exported so a
 * test can assert the strip without spawning.
 */
export function buildChildEnv(baseEnv, { dispatchDb, memoryDb, writeRoot }) {
  const env = { ...baseEnv };
  delete env.DISPATCH_API_TOKEN;
  env.DISPATCH_DB = dispatchDb;
  env.MEMORY_DB = memoryDb;
  env.GAFFER_WRITE_ROOTS = writeRoot;
  return env;
}

/**
 * Install the project-local .claude wiring (settings + safety hook, skills symlink)
 * and the MCP runtime config into the resolver's WORKTREE — exactly as tick.sh /
 * product-owner-run.mjs do — so the headless run gets the same safety boundary and the
 * dispatch/memory MCP servers. Returns the runtime MCP config path.
 */
function installProjectLocalWiring(worktreePath) {
  const claudeDir = resolve(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const skillsLink = resolve(claudeDir, "skills");
  try {
    rmSync(skillsLink, { force: true });
  } catch {
    /* nothing to remove */
  }
  symlinkSync(CONFIG.skillsDir, skillsLink, "dir");

  const settings = readFileSync(CONFIG.claudeSettings, "utf8")
    .split("${RUNNER_DIR}")
    .join(RUNNER_DIR);
  writeFileSync(resolve(claudeDir, "settings.json"), settings);

  mkdirSync(GAFFER_DATA, { recursive: true });
  const mcpRuntime = resolve(GAFFER_DATA, "mcp-merge-ticket-runtime.json");
  const mcp = readFileSync(CONFIG.mcpConfig, "utf8")
    .split("${DISPATCH_DB}")
    .join(CONFIG.dispatchDb)
    .split("${MEMORY_DB}")
    .join(CONFIG.memoryDb);
  writeFileSync(mcpRuntime, mcp);
  return mcpRuntime;
}

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

// Call the Dispatch CLI directly. `wg` is a bash FUNCTION (factory.config.sh), not a
// binary on PATH, so it does NOT resolve inside this Node runner — spawn the CLI here.
const DISPATCH_CLI =
  process.env.DISPATCH_CLI || resolve(RUNNER_DIR, "..", "dispatch", "dist", "cli", "index.js");
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
 * Dispatch does NOT yet expose a `done → in_review` reopen transition (only
 * in_review → done|ready|refining). The exact interface this runner expects is
 * documented at the bottom of this file:
 *
 *     wg ticket reopen-for-review <number> \
 *        --reason "<short why>" \
 *        --resolution "<resolver summary>" \
 *        --as system
 *
 * Until that command exists, this stays a best-effort call: a non-zero exit is logged,
 * NOT fatal (the branch already carries the resolution; the worst case is a human picks
 * it up manually). Returns { ok, command, args } describing what was invoked. Exported
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
  const res = runDispatch(args); // call the CLI directly — `wg` is not on PATH in this Node runner
  const ok = !res.error && res.status === 0;
  if (!ok) {
    log(
      `re-approval signal did not land (\`${command} ${args.join(" ")}\` exit ` +
        `${res.status ?? "spawn-error"}) — resolution is on the branch; a human can re-review manually`,
    );
  }
  return { ok, command, args };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!String(opts.ticket).trim()) {
    fail("--ticket <number> is required (the approved ticket whose branch is being merged)");
    return;
  }

  const resolved = resolveTicket(CONFIG.dispatchDb, opts.ticket);
  if (!resolved) {
    fail(
      `could not resolve ticket #${opts.ticket} to a repo + delivery branch in dispatch ` +
        `(db: ${CONFIG.dispatchDb}) — unknown ticket, no write repo, or no recorded branch`,
    );
    return;
  }
  const { repo, branch } = resolved;

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
      mcpConfig: resolve(GAFFER_DATA, "mcp-merge-ticket-runtime.json"),
      flags: CONFIG.claudeFlags,
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

  // 1. Try the clean merge first (gaffer_auto_merge semantics, in-process).
  const merge = attemptMerge(repo.localPath, branch, repo.defaultBranch);
  if (merge.clean) {
    log(`merged #${resolved.number} (${branch} → ${repo.defaultBranch}) cleanly`);
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
    const del = git(repo.localPath, "branch", "-d", branch);
    if (del.status === 0) log(`deleted merged branch ${branch}`);
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
    emit(
      {
        phase: "merged",
        ticket: resolved.number,
        repo: repo.name,
        branch,
        defaultBranch: repo.defaultBranch,
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

  let worktree;
  try {
    worktree = addWorktree(repo.localPath, branch, resolved.number);
  } catch (e) {
    fail(`failed to create resolver worktree: ${e?.message ?? e}`);
    return;
  }

  let mcpRuntime;
  try {
    mcpRuntime = installProjectLocalWiring(worktree);
  } catch (e) {
    removeWorktree(repo.localPath, worktree);
    fail(`failed to install project-local wiring: ${e?.message ?? e}`);
    return;
  }

  const argv = buildClaudeArgv({
    prompt: resolverPrompt,
    mcpConfig: mcpRuntime,
    flags: CONFIG.claudeFlags,
  });
  const res = spawnSync(CONFIG.claudeBin, argv, {
    cwd: worktree,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: buildChildEnv(process.env, {
      dispatchDb: CONFIG.dispatchDb,
      memoryDb: CONFIG.memoryDb,
      writeRoot: worktree,
    }),
  });

  if (res.error) {
    removeWorktree(repo.localPath, worktree);
    if (res.error.code === "ETIMEDOUT") {
      fail(`resolver agent timed out after ${opts.timeoutMs}ms`);
      return;
    }
    fail(`failed to spawn resolver claude: ${res.error.message ?? res.error}`);
    return;
  }

  const summary = (res.stdout || "").trim();
  if (summary) log(summary);

  // The resolution lives on the branch (the resolver committed to it in the worktree).
  // Tear the worktree down — the branch ref keeps the commits.
  removeWorktree(repo.localPath, worktree);

  // 3. Signal the ticket back for re-approval (single isolated Dispatch call).
  const reapproval = signalReapproval(
    resolved.number,
    summary || "merge conflict resolved on the branch",
  );

  emit(
    {
      phase: "conflict_resolved_pending_reapproval",
      ticket: resolved.number,
      repo: repo.name,
      branch,
      defaultBranch: repo.defaultBranch,
      reapproval,
    },
    0,
  );
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
