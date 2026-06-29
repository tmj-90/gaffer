#!/usr/bin/env node
// Gaffer factory — the headless `product-owner` runner (the dashboard's "Suggest
// work" button calls this).
//
// The Dispatch dashboard exposes POST /product-owner/runs. When clicked it
// spawns DISPATCH_PRODUCT_OWNER_CMD (a fixed operator command, shell + detached)
// with DISPATCH_PRODUCT_OWNER_REPO in the child env naming the repo to suggest
// work for. THIS script is that command: it runs the `product-owner` skill
// headlessly against that repo via `claude -p`, reusing decompose.mjs / tick.sh's
// exact claude-invocation pattern (CLAUDE_BIN/CLAUDE_FLAGS, the dispatch MCP, the
// project-local safety hook), and instructs the skill to analyse the repo, propose
// 3–5 high-leverage tickets, and FILE THEM AS DRAFTS via the dispatch MCP
// (create_ticket + add_acceptance_criterion).
//
// It is fire-and-gaffert (the endpoint spawns it detached) — it logs progress and
// exits cleanly. It is bounded (timeout + max-tickets) and headless: the skill
// must use judgement and NEVER block on AskUserQuestion. It DRAFTS ONLY — never
// marks a ticket ready, never self-approves, never implements. A human triages the
// drafts on the board.
//
// =====================================================================
// CONTRACT (the dashboard endpoint builds to this)
// ---------------------------------------------------------------------
// ENV IN:
//   DISPATCH_PRODUCT_OWNER_REPO   (required) repo NAME to suggest work for; the
//                                  runner resolves it to a local_path via DISPATCH_DB.
//   DISPATCH_DB                   path to the dispatch sqlite (name→path resolution
//                                  + the MCP server's data plane). Defaults to the
//                                  factory.config.sh location relative to this file.
//   MEMORY_DB                   path to the memory sqlite (the skill consults
//                                  product direction via the memory MCP).
//   CLAUDE_BIN / CLAUDE_FLAGS      same headless invocation knobs as tick.sh.
//   MCP_CONFIG / CLAUDE_SETTINGS / SKILLS_DIR   project-local wiring (defaults next
//                                  to this checkout, matching factory.config.sh).
//
// FLAGS (all bound overridable via flag or env):
//   --repo <name>        override DISPATCH_PRODUCT_OWNER_REPO
//   --max-tickets N      (GAFFER_PO_MAX_TICKETS,  default 5)   ticket cap fed to the skill
//   --timeout-ms N       (GAFFER_PO_TIMEOUT_MS,  default 600000) kill claude after this
//   --dry-run            do NOT spawn claude; print the planned invocation as JSON
//                        (used by tests to assert the argv/prompt offline)
//
// WHAT IT FILES: 3–5 DRAFT dispatch tickets against the named repo, each with a
//   Problem/Proposed solution/Out-of-scope/Provenance description and 2–4 observable
//   acceptance criteria. Nothing reaches `ready`; a human promotes.
//
// EXIT: 0 on a clean run (claude spawned + exited), non-zero on a hard failure
//   (missing/unknown repo, missing safety hook, spawn error, timeout). On a hard
//   failure it emits a single JSON line {"phase":"error","error":...} to stdout for
//   the (detached) log and exits non-zero.
// =====================================================================

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendUsageRecord,
  buildUsageRecord,
  extractResultText,
  parseClaudeJson,
  unknownRecord,
} from "../lib/usage-ledger.mjs";

// node:sqlite is only reachable via createRequire in an ESM module.
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");
const GAFFER_DATA = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");

// Defaults mirror factory.config.sh so a bare invocation (no env) resolves the same
// wiring the rest of the factory uses.
const CONFIG = {
  dispatchDb: process.env.DISPATCH_DB || resolve(GAFFER_DATA, "dispatch.sqlite"),
  memoryDb: process.env.MEMORY_DB || resolve(GAFFER_DATA, "memory.sqlite"),
  mcpConfig: process.env.MCP_CONFIG || resolve(RUNNER_DIR, ".mcp.json"),
  // The built MCP server bins. The .mcp.json template references these as
  // ${DISPATCH_MCP_BIN}/${MEMORY_MCP_BIN}; they MUST be substituted (exactly as
  // tick.sh does) or the dispatch MCP server never starts and the agent has no
  // create_ticket tool — it drafts into the void. Default to the dist bins.
  dispatchMcpBin:
    process.env.DISPATCH_MCP_BIN || resolve(GAFFER_HOME, "packages/dispatch/dist/mcp/bin.js"),
  memoryMcpBin:
    process.env.MEMORY_MCP_BIN || resolve(GAFFER_HOME, "packages/memory/dist/mcp/bin.js"),
  claudeSettings: process.env.CLAUDE_SETTINGS || resolve(RUNNER_DIR, "claude", "settings.json"),
  skillsDir: process.env.SKILLS_DIR || resolve(RUNNER_DIR, "skills"),
  claudeBin: process.env.CLAUDE_BIN || "claude",
  // Product-owner suggestion is a PLAN step → prepend the planning model when set.
  claudeFlags: (() => {
    const f = (process.env.CLAUDE_FLAGS || "--permission-mode acceptEdits")
      .split(/\s+/)
      .filter(Boolean);
    const m = (process.env.GAFFER_PLAN_MODEL || "").trim();
    return m ? ["--model", m, ...f] : f;
  })(),
};

const DEFAULTS = {
  maxTickets: intEnv("GAFFER_PO_MAX_TICKETS", 5),
  timeoutMs: intEnv("GAFFER_PO_TIMEOUT_MS", 600000),
};

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseArgs(argv) {
  const opts = {
    repo: process.env.DISPATCH_PRODUCT_OWNER_REPO || "",
    maxTickets: DEFAULTS.maxTickets,
    timeoutMs: DEFAULTS.timeoutMs,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--repo":
        opts.repo = next() ?? "";
        break;
      case "--max-tickets":
        opts.maxTickets = Math.max(1, parseInt(next() ?? "", 10) || DEFAULTS.maxTickets);
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
  process.stderr.write(`[product-owner-run] ${msg}\n`);
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
 * Resolve a repo NAME to its registered local_path via the dispatch sqlite DB
 * (read-only, zero deps — node:sqlite ships with Node 22+). Returns
 * { name, localPath, defaultBranch } or null when the repo is unknown / has no
 * on-disk path. Kept import()-able and side-effect-free so tests can exercise it.
 */
export function resolveRepo(dbPath, name) {
  const repoName = String(name ?? "").trim();
  if (!repoName) return null;
  if (!existsSync(dbPath)) return null;
  // Lazy-require so the module imports even on runtimes without node:sqlite (the
  // dry-run/test paths never touch the DB).
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT name, local_path AS localPath, default_branch AS defaultBranch FROM repositories WHERE name = ?",
      )
      .get(repoName);
    if (!row || !row.localPath) return null;
    return {
      name: row.name,
      localPath: String(row.localPath),
      defaultBranch: String(row.defaultBranch || "main"),
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
 * Count the DRAFT tickets linked to a repo NAME via the dispatch sqlite (read-only,
 * zero deps). Used by the draft-count guard to compare a before/after snapshot so a
 * run that files NOTHING is loud rather than a silent exit-0. Returns the integer
 * count, or `null` when the count is UNMEASURABLE (db missing / node:sqlite absent /
 * query error) — the caller skips the guard on null so a transient read error can't
 * raise a false "filed 0" alarm. Importable + side-effect-free for tests.
 */
export function countDraftTickets(dbPath, repoName) {
  const name = String(repoName ?? "").trim();
  if (!name) return null;
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
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tickets t " +
          "JOIN ticket_repos tr ON tr.ticket_id = t.id " +
          "JOIN repositories r ON r.id = tr.repo_id " +
          "WHERE t.status = 'draft' AND r.name = ?",
      )
      .get(name);
    const n = Number(row?.n ?? 0);
    return Number.isFinite(n) ? n : null;
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
 * Build the headless prompt fed to `claude -p`. It pins the product-owner skill,
 * the draft-only / no-questions discipline, and the ticket-count bound. `repoName`
 * is what the dispatch MCP create_ticket links by; `repoPath` is where the skill
 * inspects the repo from.
 */
export function buildPrompt({ repoName, repoPath, maxTickets }) {
  return [
    `Use the product-owner skill to propose the next product work for the repo "${repoName}"`,
    `(checked out at ${repoPath} — inspect it there: README, docs, package manifest, brand`,
    `files, and \`git log\`).`,
    "",
    "You are running HEADLESS with NO human in the loop. Use your judgement and NEVER ask",
    "the user anything — do NOT call AskUserQuestion or block on a question. If a decision",
    "is genuinely unknowable from the repo + lore, say so inside the ticket and let a human",
    "decide later, rather than stopping.",
    "",
    `Propose a SMALL, high-leverage batch: 3 to ${maxTickets} tickets, each anchored to a`,
    "specific lore line, brand promise, observed gap, or recent-commit thread — no generic",
    "SaaS filler. File each survivor as a DRAFT via the dispatch MCP: create_ticket (with a",
    "Problem / Proposed solution / Out of scope / Provenance description) followed by",
    "add_acceptance_criterion for each of its 2–4 observable acceptance criteria.",
    "",
    "DRAFT ONLY. Do NOT mark_ticket_ready, do NOT claim, do NOT implement, do NOT edit the",
    "repo. Drafts surface on the board for a human to triage. When done, print a one-line",
    "summary: candidates considered, tickets filed, their ids/titles.",
  ].join("\n");
}

/**
 * Install the project-local .claude wiring (settings+safety hook, skills symlink)
 * into a **throwaway agent-home directory** under GAFFER_DATA, and write the MCP
 * runtime config alongside it. Returns `{ agentHome, mcpRuntime }`.
 *
 * The registered repo checkout is NEVER touched: writing `.claude/` there would
 * dirty the operator's working tree and expose it as a write-root even though the
 * PO run is draft-only (all writes go through the dispatch MCP).  Instead:
 *
 *   agentHome  — ephemeral per-run dir (e.g. <GAFFER_DATA>/po-runtime-XXXXXX).
 *                Claude's cwd + GAFFER_WRITE_ROOTS are set to this dir.
 *   repoPath   — the registered checkout.  Only GAFFER_READ_ROOTS points here so
 *                the agent can inspect README/manifest/git log, nothing more.
 */
function installProjectLocalWiring() {
  mkdirSync(GAFFER_DATA, { recursive: true });
  const agentHome = mkdtempSync(resolve(GAFFER_DATA, "po-runtime-"));
  const claudeDir = resolve(agentHome, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Skills symlink → the factory's skills dir (so `product-owner` resolves).
  const skillsLink = resolve(claudeDir, "skills");
  try {
    rmSync(skillsLink, { force: true });
  } catch {
    /* nothing to remove */
  }
  symlinkSync(CONFIG.skillsDir, skillsLink, "dir");

  // settings.json with the safety hook path resolved for THIS checkout (the shipped
  // file carries a ${RUNNER_DIR} placeholder; copying it verbatim would point the
  // hook at the author's machine and fail open elsewhere).
  const settings = readFileSync(CONFIG.claudeSettings, "utf8")
    .split("${RUNNER_DIR}")
    .join(RUNNER_DIR);
  writeFileSync(resolve(claudeDir, "settings.json"), settings);

  // MCP runtime config with the DB paths AND the MCP server bins substituted to
  // this run's wiring — all four placeholders, or the dispatch MCP won't start.
  const mcpRuntime = resolve(GAFFER_DATA, "mcp-product-owner-runtime.json");
  const mcp = readFileSync(CONFIG.mcpConfig, "utf8")
    .split("${DISPATCH_DB}")
    .join(CONFIG.dispatchDb)
    .split("${MEMORY_DB}")
    .join(CONFIG.memoryDb)
    .split("${DISPATCH_MCP_BIN}")
    .join(CONFIG.dispatchMcpBin)
    .split("${MEMORY_MCP_BIN}")
    .join(CONFIG.memoryMcpBin);
  writeFileSync(mcpRuntime, mcp);
  return { agentHome, mcpRuntime };
}

/**
 * Build the full `claude -p` argv (the same shape decompose.mjs / tick.sh produce):
 * [-p, prompt, --mcp-config, <runtime>, ...CLAUDE_FLAGS]. Pulled out so the dry-run
 * path and tests can assert it without spawning anything.
 */
export function buildClaudeArgv({ prompt, mcpConfig, flags }) {
  // USAGE LEDGER: --output-format json makes stdout a JSON result object carrying
  // the real usage and the agent's text in `.result`. The product-owner run never
  // parses this stdout for control flow (it only logs it), so the json envelope is
  // non-breaking; we ledger the usage and log the unwrapped `.result` text below.
  const args = ["-p", prompt, "--output-format", "json"];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  // Explicitly grant the factory's two MCP servers for THIS headless call. Claude
  // Code 2.1.x ignores the settings.json `permissions.allow` list on a workspace that
  // hasn't been interactively trusted — and a headless `claude -p` can't accept that
  // trust dialog — so without this the dispatch MCP's create_ticket is denied and the
  // PO files 0. `--allowedTools` is a per-invocation, scoped grant honored regardless
  // of workspace trust; the safety hook + acceptEdits still apply. Scoped to our own
  // dispatch+memory servers only — no global config is touched.
  return args.concat(flags, ["--allowedTools", "mcp__dispatch", "mcp__memory"]);
}

/**
 * Build the child env for the headless agent (P2-A). The product-owner run only
 * needs the MCP DB paths + repo-access wiring; it must NEVER inherit Dispatch's
 * bearer token or any other ambient credential. We start from a COPY of `base`
 * and DELETE DISPATCH_API_TOKEN plus any *_TOKEN / *_SECRET the agent doesn't
 * need, so a misbehaving (or prompt-injected) skill can't read a credential out
 * of its environment and echo it back. The explicit run vars are layered on top
 * by the caller.
 */
export function agentChildEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    // M2: broaden the credential denylist beyond *_TOKEN/*_SECRET to also catch
    // *_KEY (AWS_ACCESS_KEY_ID etc.), *_PASSWORD/*_PASSWD and AWS session tokens.
    // ANTHROPIC_API_KEY is the ONE *_KEY the spawned `claude` needs for auth, so
    // it is explicitly preserved.
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") continue;
    if (
      key === "DISPATCH_API_TOKEN" ||
      key === "AWS_ACCESS_KEY_ID" || // ends in _ID, so name it explicitly
      /(_TOKEN|_SECRET|_KEY|_PASSWORD|_PASSWD)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.repo.trim()) {
    fail("DISPATCH_PRODUCT_OWNER_REPO is required (the repo name to suggest work for)");
    return;
  }

  // Resolve the repo NAME → on-disk path. Refuse when unknown (don't run the skill
  // against nothing).
  const resolved = resolveRepo(CONFIG.dispatchDb, opts.repo);
  if (!resolved) {
    fail(`unknown repo "${opts.repo}" — not registered in dispatch (db: ${CONFIG.dispatchDb})`);
    return;
  }
  if (!opts.dryRun && !existsSync(resolved.localPath)) {
    fail(`repo "${opts.repo}" resolves to ${resolved.localPath}, which is not on disk`);
    return;
  }

  const prompt = buildPrompt({
    repoName: resolved.name,
    repoPath: resolved.localPath,
    maxTickets: opts.maxTickets,
  });

  if (opts.dryRun) {
    // Test/inspection path: report the planned invocation WITHOUT touching the repo
    // (no wiring install) or spawning claude.
    const argv = buildClaudeArgv({
      prompt,
      mcpConfig: resolve(GAFFER_DATA, "mcp-product-owner-runtime.json"),
      flags: CONFIG.claudeFlags,
    });
    // P2-A: surface whether the (token-stripped) child env would still carry the
    // bearer token, so a dry-run can assert the strip without spawning a child.
    const childEnv = agentChildEnv();
    emit(
      {
        phase: "dry-run",
        repo: resolved.name,
        repoPath: resolved.localPath,
        maxTickets: opts.maxTickets,
        timeoutMs: opts.timeoutMs,
        claudeBin: CONFIG.claudeBin,
        argv,
        childEnvHasApiToken: Object.prototype.hasOwnProperty.call(childEnv, "DISPATCH_API_TOKEN"),
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

  log(
    `proposing work for "${resolved.name}" (${resolved.localPath}); max ${opts.maxTickets} drafts, timeout ${opts.timeoutMs}ms`,
  );

  // Throwaway agent-home dir (populated by installProjectLocalWiring). Cleaned up
  // on process exit via the 'exit' handler below — including when emit()/fail()
  // call process.exit(), because the 'exit' event fires synchronously on exit.
  let agentHome = null;
  process.on("exit", () => {
    if (agentHome) {
      try {
        rmSync(agentHome, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  let mcpRuntime;
  try {
    ({ agentHome, mcpRuntime } = installProjectLocalWiring());
  } catch (e) {
    fail(`failed to install project-local wiring: ${e?.message ?? e}`);
    return;
  }

  // DRAFT-COUNT GUARD: snapshot the repo's draft count BEFORE the run so we can tell
  // whether the agent actually filed anything. `null` = unmeasurable (guard skipped).
  const draftsBefore = countDraftTickets(CONFIG.dispatchDb, resolved.name);

  const argv = buildClaudeArgv({ prompt, mcpConfig: mcpRuntime, flags: CONFIG.claudeFlags });
  const res = spawnSync(CONFIG.claudeBin, argv, {
    // Run in the throwaway agent-home dir, NOT the registered repo. The agent
    // writes only via the dispatch MCP; the repo is read-only (GAFFER_READ_ROOTS).
    cwd: agentHome,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      // P2-A: start from a token-stripped copy of the parent env so the agent
      // never inherits DISPATCH_API_TOKEN (or any *_TOKEN/*_SECRET).
      ...agentChildEnv(),
      DISPATCH_DB: CONFIG.dispatchDb,
      MEMORY_DB: CONFIG.memoryDb,
      // FG-007 (revised): the write-root is the throwaway agent-home, NOT the
      // registered repo. The repo is exposed as a READ root so the safety hook
      // allows the agent to inspect it (README/manifest/git log) without ever
      // being able to write to it.
      GAFFER_WRITE_ROOTS: agentHome,
      GAFFER_READ_ROOTS: resolved.localPath,
    },
  });

  if (res.error) {
    if (res.error.code === "ETIMEDOUT") {
      // Ledger the unmeasurable call as "unknown" (honesty rule 3: never 0).
      appendUsageRecord(
        unknownRecord({ kind: "product-owner", reason: "product-owner claude call timed out" }),
      );
      fail(`product-owner run timed out after ${opts.timeoutMs}ms`);
      return;
    }
    fail(`failed to spawn claude: ${res.error.message ?? res.error}`);
    return;
  }
  // USAGE LEDGER: parse the JSON envelope, ledger the usage (best-effort,
  // swallowed), and log the agent's unwrapped `.result` text (preserves the log).
  const json = parseClaudeJson(res.stdout || "");
  if (json === null) {
    appendUsageRecord(
      unknownRecord({
        kind: "product-owner",
        reason: "no parseable --output-format json on stdout",
      }),
    );
    if (res.stdout) log(res.stdout.trim());
  } else {
    appendUsageRecord(buildUsageRecord({ json, kind: "product-owner" }));
    const text = extractResultText(json);
    if (text) log(text.trim());
  }
  log(`product-owner run for "${resolved.name}" finished (exit ${res.status ?? 0})`);

  // DRAFT-COUNT GUARD: a clean `claude` exit does NOT mean tickets were filed — a
  // denied MCP (no create_ticket tool) or an agent that decided to file nothing both
  // exit 0. Compare the after-snapshot to the before-snapshot: when we CAN measure
  // (both non-null) and the net new drafts is ≤ 0, fail LOUD (non-zero, with a
  // reason) instead of reporting a misleading "done". When unmeasurable, we don't
  // raise a false alarm — we just report `filed: null`.
  const draftsAfter = countDraftTickets(CONFIG.dispatchDb, resolved.name);
  const filed = draftsBefore !== null && draftsAfter !== null ? draftsAfter - draftsBefore : null;

  if (filed !== null && filed <= 0) {
    log(
      `ERROR: filed 0 drafts for "${resolved.name}" (drafts ${draftsBefore} → ${draftsAfter}) — MCP create_ticket likely denied or the run proposed nothing`,
    );
    emit(
      {
        phase: "error",
        repo: resolved.name,
        filed: 0,
        exit: res.status ?? 0,
        reason: "filed 0 drafts — MCP create_ticket likely denied",
      },
      1,
    );
    return;
  }

  log(`filed ${filed === null ? "unknown (unmeasurable)" : filed} draft(s) for "${resolved.name}"`);
  emit({ phase: "done", repo: resolved.name, exit: res.status ?? 0, filed }, res.status ?? 0);
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
