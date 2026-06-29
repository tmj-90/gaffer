#!/usr/bin/env node
// Gaffer factory — the headless repo-onboarding runner (the dashboard's Memory
// view "Onboard a repo" button calls this).
//
// The Dispatch dashboard exposes POST /repos/onboard. When clicked it spawns
// DISPATCH_ONBOARD_CMD (a fixed operator command, no shell, detached) with
// DISPATCH_ONBOARD_REPO in the child env naming the repo to onboard — EITHER a
// registered repo name/id OR a local filesystem path. THIS script is that command:
// it resolves the target to an on-disk repo path and runs crew's real onboard
// entrypoint against it:
//
//     node $CREW_DIR/dist/cli/index.js -c $CREW_CONFIG repo onboard <path> --standalone
//
// — the SAME invocation `gaffer onboard <path>` uses. Onboarding scans the repo,
// registers it in Dispatch, and (via the onboard producer) builds the repo's
// Memory digest + inventories its shipped features into the memory store — the
// SAME store the Memory views read (MEMORY_DB / GAFFER_DATA reach it via the
// child env the dashboard passes through). It is fire-and-gaffert: it logs progress
// and exits.
//
// =====================================================================
// CONTRACT (the dashboard endpoint builds to this)
// ---------------------------------------------------------------------
// ENV IN:
//   DISPATCH_ONBOARD_REPO   (required) repo name/id OR local path to onboard.
//   DISPATCH_DB             dispatch sqlite — used to resolve a registered repo
//                            NAME → its local_path (when the target isn't a path).
//   CREW_DIR / CREW_CONFIG   crew CLI + config (the onboard impl).
//   GAFFER_DATA               factory state dir (crew reads it as GAFFER_DATA_DIR).
//   MEMORY_DB             where the digest/feature inventory lands (so it matches
//                            the Memory views' store).
//
// FLAGS:
//   --repo <name|path>   override DISPATCH_ONBOARD_REPO
//   --dry-run            do NOT spawn crew; print the planned invocation as JSON
//                        (used by tests to assert the argv offline)
//
// EXIT: 0 on a clean run (crew spawned + exited 0), non-zero on a hard failure
//   (no target, unresolvable target, spawn error). On a hard failure it emits a single
//   JSON line {"phase":"error","error":...} to stdout for the (detached) log.
// =====================================================================

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAndWrite } from "../lib/onboard-analyze.mjs";

// node:sqlite is only reachable via createRequire in an ESM module.
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");
const GAFFER_DATA = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");

// Defaults mirror factory.config.sh so a bare invocation resolves the same wiring.
const CONFIG = {
  dispatchDb: process.env.DISPATCH_DB || resolve(GAFFER_DATA, "dispatch.sqlite"),
  crewDir: process.env.CREW_DIR || resolve(GAFFER_HOME, "crew"),
  crewConfig: process.env.CREW_CONFIG || resolve(GAFFER_DATA, "crew.yaml"),
};

function log(msg) {
  process.stderr.write(`[onboard-run] ${msg}\n`);
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
  const opts = { repo: process.env.DISPATCH_ONBOARD_REPO || "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--repo":
        opts.repo = next() ?? "";
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

/** True when `target` points at an existing directory on disk (a path target). */
function isExistingDir(target) {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a registered repo NAME (or id) to its local_path via the dispatch sqlite
 * (read-only, zero deps — node:sqlite ships with Node 22+). Returns the path or null
 * when the name is unknown / has no on-disk path. Importable + side-effect-free.
 */
export function resolveRepoPath(dbPath, nameOrId) {
  const key = String(nameOrId ?? "").trim();
  if (!key) return null;
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
      .prepare("SELECT local_path AS localPath FROM repositories WHERE name = ? OR id = ?")
      .get(key, key);
    if (!row || !row.localPath) return null;
    return String(row.localPath);
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
 * Resolve the onboard TARGET (name/id or path) to an absolute on-disk repo path.
 * A target that already names an existing directory is taken as a path; otherwise
 * it's looked up as a registered repo name/id in the dispatch DB. Returns the
 * absolute path or null when neither resolves.
 */
export function resolveTarget(dbPath, target) {
  const t = String(target ?? "").trim();
  if (!t) return null;
  if (isExistingDir(t)) return resolve(t);
  const viaDb = resolveRepoPath(dbPath, t);
  return viaDb && isExistingDir(viaDb) ? resolve(viaDb) : viaDb || null;
}

/**
 * Build the crew onboard argv (the SAME shape `gaffer onboard <path>` runs):
 *   [<crewCli>, -c, <config>, repo, onboard, <path>, --standalone]
 * Pulled out so the dry-run path + tests can assert it without spawning anything.
 */
export function buildCrewArgv({ crewDir, crewConfig, repoPath }) {
  const cli = resolve(crewDir, "dist", "cli", "index.js");
  return [cli, "-c", crewConfig, "repo", "onboard", repoPath, "--standalone"];
}

/**
 * Pull the onboarding SCAN FACTS out of crew's `repo onboard` JSON stdout so
 * the model analysis can be fed the SAME facts (stack, commands, branch, remote,
 * repo id/name) WITHOUT a second scan. crew prints `{ ok, onboarded: { repoId,
 * name, scan: { stack, ... } } }`. Tolerant: a parse miss returns null and the
 * caller falls back to the repo path + a bare scan. The JSON may be embedded in
 * other log noise (we capture stdout only, but be defensive): try a strict parse,
 * then scan for the last balanced top-level object.
 */
export function extractScanFacts(stdout) {
  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" ? o : null;
    } catch {
      return null;
    }
  };
  let obj = tryParse(String(stdout ?? "").trim());
  if (!obj) {
    const bare = lastBalancedObject(String(stdout ?? ""));
    if (bare) obj = tryParse(bare);
  }
  const onboarded = obj?.onboarded;
  if (!onboarded || typeof onboarded !== "object") return null;
  const scan = onboarded.scan && typeof onboarded.scan === "object" ? onboarded.scan : {};
  return {
    repoId: onboarded.repoId ?? null,
    name: onboarded.name ?? null,
    stack: scan.stack ?? null,
    packageManager: scan.packageManager ?? null,
    defaultBranch: scan.defaultBranch ?? null,
    remoteUrl: scan.remoteUrl ?? null,
    buildCommand: scan.buildCommand ?? null,
    testCommand: scan.testCommand ?? null,
    lintCommand: scan.lintCommand ?? null,
    coverageCommand: scan.coverageCommand ?? null,
    riskSignals: Array.isArray(scan.riskSignals) ? scan.riskSignals : [],
  };
}

/** Find the last balanced top-level {…} substring (quote/escape aware). */
function lastBalancedObject(text) {
  let last = null;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        last = text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return last;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.repo.trim()) {
    fail("DISPATCH_ONBOARD_REPO is required (the repo name/id or path to onboard)");
    return;
  }

  const repoPath = resolveTarget(CONFIG.dispatchDb, opts.repo);
  if (!repoPath) {
    fail(
      `could not resolve onboard target "${opts.repo}" — not a directory on disk and not a registered repo (db: ${CONFIG.dispatchDb})`,
    );
    return;
  }

  const argv = buildCrewArgv({
    crewDir: CONFIG.crewDir,
    crewConfig: CONFIG.crewConfig,
    repoPath,
  });

  if (opts.dryRun) {
    // Test/inspection path: report the planned invocation WITHOUT spawning crew.
    emit({ phase: "dry-run", repo: opts.repo, repoPath, argv }, 0);
    return;
  }

  if (!opts.dryRun && !existsSync(repoPath)) {
    fail(`onboard target "${opts.repo}" resolves to ${repoPath}, which is not on disk`);
    return;
  }

  log(`onboarding "${opts.repo}" (${repoPath}) via crew repo onboard`);
  const res = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // crew reads the factory state dir as GAFFER_DATA_DIR (see `gaffer onboard`).
      GAFFER_DATA_DIR: GAFFER_DATA,
    },
  });

  if (res.error) {
    fail(`failed to spawn crew: ${res.error.message ?? res.error}`);
    return;
  }
  if (res.stdout) log(res.stdout.trim());
  if (res.stderr) log(res.stderr.trim());
  log(`onboard run for "${opts.repo}" finished (exit ${res.status ?? 0})`);

  // MODEL-BACKED analysis (supersedes crew's mechanical digest/features).
  // Gated + best-effort: it only runs when the crew onboard SUCCEEDED and the
  // memory CLI is configured; any failure degrades to a minimal honest digest (no
  // fake features) and NEVER fails the onboard. We feed it the SAME scan facts
  // crew just printed, so there is no second repo scan.
  let analysis = null;
  if ((res.status ?? 0) === 0) {
    try {
      const facts = extractScanFacts(res.stdout) ?? {};
      const scan = {
        repoId: facts.repoId ?? opts.repo,
        name: facts.name ?? facts.repoId ?? opts.repo,
        ...facts,
      };
      analysis = analyzeAndWrite(repoPath, scan, { log: (m) => log(`analysis: ${m}`) });
    } catch (err) {
      // Defensive: the analysis is best-effort. A bug here must not fail the onboard.
      log(`analysis: skipped after error: ${err?.message ?? err}`);
    }
  }

  emit(
    {
      phase: "done",
      repo: opts.repo,
      repoPath,
      exit: res.status ?? 0,
      ...(analysis ? { analysis } : {}),
    },
    res.status ?? 0,
  );
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
