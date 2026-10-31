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
//   --name <alias>       register the repo under this alias instead of its directory
//                        name (DISPATCH_ONBOARD_NAME). Required when a DIFFERENT
//                        repository is already onboarded under the directory name: a
//                        name match is a refresh only for the same repository (same
//                        canonical local path; a path-less record: the same remote).
//   --dry-run            do NOT spawn crew; print the planned invocation as JSON
//                        (used by tests to assert the argv offline)
//   --summary            the TERMINAL view (`gaffer onboard` passes it): the full log —
//                        crew's pretty-printed scan JSON, every analysis line — goes to
//                        $GAFFER_DATA/onboard.log, and stderr gets a summary of at most
//                        ~8 lines (registered name, stack/test/branch, model analysis
//                        yes/no + why not, counts, the intake decision, the next step).
//                        GAFFER_VERBOSE=1 keeps the full log on stderr. Without the flag
//                        (the dashboard's run log, tests) the output is unchanged.
//
// EXIT: 0 on a clean run (crew spawned + exited 0), non-zero on a hard failure
//   (no target, unresolvable target, spawn error). On a hard failure it emits a single
//   JSON line {"phase":"error","error":...} to stdout for the (detached) log.
// =====================================================================

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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
  crewDir: process.env.CREW_DIR || resolve(GAFFER_HOME, "packages", "crew"),
  crewConfig: process.env.CREW_CONFIG || resolve(GAFFER_DATA, "crew.yaml"),
};

// --summary: where the full log goes instead of stderr (null = stderr, the default).
let LOG_FILE = null;
function log(msg) {
  const line = `[onboard-run] ${msg}\n`;
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line);
      return;
    } catch {
      /* unwritable log file — fall back to stderr */
    }
  }
  process.stderr.write(line);
}

/** Emit a single JSON object on stdout (for the detached log) and exit. */
function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}
function fail(reason, code = 1) {
  log(`ERROR: ${reason}`);
  // A hard failure always reaches the terminal, summary mode or not.
  if (LOG_FILE) process.stderr.write(`✗ ${reason}\n`);
  emit({ phase: "error", error: reason }, code);
}

function parseArgs(argv) {
  const opts = {
    repo: process.env.DISPATCH_ONBOARD_REPO || "",
    name: process.env.DISPATCH_ONBOARD_NAME || "",
    dryRun: false,
    summary: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--repo":
        opts.repo = next() ?? "";
        break;
      case "--name":
        // A distinct ALIAS for a repository whose directory name is already taken by a
        // different repository (crew refuses a name match that is not the same repo).
        opts.name = next() ?? "";
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--summary":
        opts.summary = true;
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

/** A safe repository alias: letters, digits, dot, dash, underscore (1–100 chars). */
export const REPO_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Build the crew onboard argv (the SAME shape `gaffer onboard <path>` runs):
 *   [<crewCli>, -c, <config>, repo, onboard, <path>, --standalone [--id <alias> --name <alias>]]
 * Pulled out so the dry-run path + tests can assert it without spawning anything.
 */
export function buildCrewArgv({ crewDir, crewConfig, repoPath, name = "" }) {
  const cli = resolve(crewDir, "dist", "cli", "index.js");
  const alias = String(name ?? "").trim();
  return [
    cli,
    "-c",
    crewConfig,
    "repo",
    "onboard",
    repoPath,
    "--standalone",
    ...(alias ? ["--id", alias, "--name", alias] : []),
  ];
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

/**
 * The --summary view: a few lines a new user needs NEXT, built from crew's onboard
 * JSON + the analysis result. `gaffer onboard` used to print ~150 lines of raw JSON
 * (its single-line JSON filter never matched crew's pretty-printed output), burying
 * the repo name, the test command, whether the model ran, and the intake decision.
 * Pure (returns the lines); exported for tests.
 */
/**
 * crew's own refusal ({"ok":false,"code","message"} on its stderr/stdout), so a refused
 * onboard says WHY (a name taken by a different repository, a missing directory) instead
 * of only "failed — see the log". → { code, message } | null.
 */
export function crewRefusal(...outputs) {
  for (const out of outputs) {
    for (const line of String(out ?? "").split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const o = JSON.parse(t);
        if (o && o.ok === false && typeof o.message === "string")
          return { code: String(o.code ?? ""), message: o.message };
      } catch {
        /* not a JSON line */
      }
    }
  }
  return null;
}

export function buildOnboardSummary({ stdout, exit, analysis, logFile, refusal = null }) {
  const facts = extractScanFacts(stdout) ?? {};
  let clarifications = [];
  try {
    const obj = JSON.parse(String(stdout ?? "").trim());
    if (Array.isArray(obj?.clarifications)) clarifications = obj.clarifications;
  } catch {
    /* not JSON — no intake line */
  }
  const name = facts.name ?? facts.repoId ?? "(unknown)";
  const lines = [];
  if ((exit ?? 0) !== 0) {
    lines.push(
      refusal
        ? `✗ not onboarded: ${refusal.message}`
        : `✗ crew onboard failed (exit ${exit}) — see ${logFile}`,
    );
    return lines;
  }
  const bits = [
    facts.stack ? `stack ${facts.stack}` : null,
    facts.testCommand ? `test "${facts.testCommand}"` : "no test command found",
    facts.defaultBranch ? `branch ${facts.defaultBranch}` : null,
  ].filter(Boolean);
  lines.push(`✓ registered: ${name}   (${bits.join(" · ")})`);
  if (!analysis || !analysis.ran) {
    lines.push("! model analysis skipped (memory CLI not configured) — mechanical digest only");
  } else if (analysis.usedModel) {
    const st = analysis.stats ?? {};
    const cs = analysis.cardStats;
    lines.push(
      `✓ model analysis: digest written · features +${st.featuresAdded ?? 0} · lore drafts +${st.loreDrafted ?? 0}` +
        (cs ? ` · cards ${cs.modelCarded}/${cs.carded} model-summarised` : ""),
    );
  } else if (analysis.modelError) {
    lines.push(
      `! model analysis unavailable (claude: ${analysis.modelError}) — mechanical-only digest + cards; ` +
        "fix claude auth (`claude`, then /login) and re-run the onboard",
    );
  } else {
    lines.push(
      "! model analysis gave no usable answer — wrote a minimal honest digest (mechanical-only)",
    );
  }
  const decisionId = clarifications.find((c) => c && c.decisionId)?.decisionId;
  if (decisionId) {
    const short = String(decisionId).slice(0, 8);
    lines.push(
      `! intake: ${clarifications.length} question(s) about the product, filed as decision ${short} — ` +
        `answer in the dashboard, or: gaffer wg decisions resolve ${short} --answer "…"`,
    );
  }
  lines.push(
    `next: gaffer wg ticket create -t "…" -d "…", then ac add · repo-access set <n> ${name} · ready ` +
      "(quickstart §4) — or map it in the Factory Map tab",
  );
  if (logFile) lines.push(`full log: ${logFile}`);
  return lines;
}

function ensureCrewConfig() {
  if (existsSync(CONFIG.crewConfig)) return;
  const crewCli = resolve(CONFIG.crewDir, "dist", "cli", "index.js");
  if (!existsSync(crewCli)) return; // crew not built — the spawn below reports it loudly
  log(`crew config ${CONFIG.crewConfig} missing — initialising it (first run)`);
  const init = spawnSync(process.execPath, [crewCli, "init", "-d", GAFFER_DATA, "-n", "gaffer"], {
    encoding: "utf8",
  });
  if (init.status !== 0 || !existsSync(CONFIG.crewConfig)) {
    log(`crew init failed (exit ${init.status}): ${(init.stderr || init.stdout || "").trim()}`);
    return;
  }
  try {
    const yaml = readFileSync(CONFIG.crewConfig, "utf8").replace(
      /sqlite_path:.*/,
      `sqlite_path: ${CONFIG.dispatchDb}`,
    );
    writeFileSync(CONFIG.crewConfig, yaml);
  } catch (err) {
    log(`could not point crew.yaml at the dispatch db: ${err?.message ?? err}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summary =
    opts.summary && !opts.dryRun && !/^(1|true|yes|on)$/i.test(process.env.GAFFER_VERBOSE ?? "");
  if (summary) {
    LOG_FILE = resolve(GAFFER_DATA, "onboard.log");
    try {
      writeFileSync(LOG_FILE, "", { mode: 0o600 });
    } catch {
      LOG_FILE = null; // cannot write the state dir — keep the full log on stderr
    }
  }

  if (!opts.repo.trim()) {
    fail("DISPATCH_ONBOARD_REPO is required (the repo name/id or path to onboard)");
    return;
  }

  if (opts.name.trim() && !REPO_ALIAS_RE.test(opts.name.trim())) {
    fail(
      `--name "${opts.name}" is not a usable alias (letters, digits, '.', '-', '_'; starts with a letter or digit)`,
    );
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
    name: opts.name,
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

  // FIRST-RUN SELF-HEAL: the dashboard's Onboard button (and `gaffer onboard`) used to
  // fail with CONFIG_NOT_FOUND when `gaffer setup` had not created crew.yaml — visible
  // only in the Runs panel while the UI toasted "will appear shortly". Create the
  // factory's crew config the same way setup.sh does (crew init + point it at the
  // dispatch DB), then proceed. Idempotent: a present config is left untouched.
  ensureCrewConfig();

  log(`onboarding "${opts.repo}" (${repoPath}) via crew repo onboard`);
  const res = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // crew reads the factory state dir as GAFFER_DATA_DIR (see `gaffer onboard`).
      GAFFER_DATA_DIR: GAFFER_DATA,
      // The factory's one events log (as factory.config.sh exports it), so a
      // dashboard-spawned onboard never writes `.crew/` into whatever its cwd is.
      GAFFER_CREW_EVENTS: process.env.GAFFER_CREW_EVENTS || join(GAFFER_DATA, "events.jsonl"),
      // Register into the factory's DB even if crew.yaml's sqlite_path has drifted.
      ...(process.env.DISPATCH_DB ? { CREW_DISPATCH_DB: process.env.DISPATCH_DB } : {}),
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
      // The onboard still succeeds (mechanical digest + cards), but say loudly WHY the
      // model half is missing — it used to read as a silent, degraded success.
      if (analysis?.modelError) {
        log(
          `WARNING: model analysis unavailable (claude: ${analysis.modelError}) — digest and ` +
            "cards are mechanical-only; fix claude auth (`claude`, then /login) and re-run the onboard",
        );
      }
    } catch (err) {
      // Defensive: the analysis is best-effort. A bug here must not fail the onboard.
      log(`analysis: skipped after error: ${err?.message ?? err}`);
    }
  }

  const refusal = (res.status ?? 0) !== 0 ? crewRefusal(res.stderr, res.stdout) : null;
  if (summary) {
    const lines = buildOnboardSummary({
      stdout: res.stdout,
      exit: res.status ?? 0,
      analysis,
      logFile: LOG_FILE,
      refusal,
    });
    process.stderr.write(lines.join("\n") + "\n");
  }

  emit(
    {
      phase: "done",
      repo: opts.repo,
      repoPath,
      exit: res.status ?? 0,
      ...(refusal ? { refused: refusal } : {}),
      ...(analysis ? { analysis } : {}),
    },
    res.status ?? 0,
  );
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
