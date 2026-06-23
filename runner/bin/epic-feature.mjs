#!/usr/bin/env node
// Gaffer factory — the BROWNFIELD epic → feature(building) hook.
//
// CONTEXT. A brownfield (existing-repo) epic is created via bin/decompose.mjs
// (existing-repo mode) → the dashboard confirms it → dispatch `create_epic`. At
// that confirm/create moment the work for a feature has STARTED — so the feature
// lifecycle must move to `building`. This helper is that hook: a deterministic,
// best-effort CLI the factory calls right AFTER it creates a brownfield epic, to
//   • advance an existing `backlog` feature → `building`, OR
//   • add_feature(repo, scope_node?, name, summary, status:"building",
//     provenance:<epic ref>)
// with the EPIC REF as provenance, so the digest/feature view shows the feature is
// in flight while the factory delivers the epic's tickets.
//
// NO agent — it just builds the MEMORY CLI argv (lib/feature-digest.mjs) and runs it.
// It mirrors the merge runner's discipline: the memory CLI's `feature add` / `feature
// advance` verbs are the memory product's surface for the MCP add_feature/advance_feature
// tools (the same product the onboard producer writes to), NOT dispatch verbs; a
// non-zero exit (or a build that hasn't shipped them yet) is LOGGED, never fatal. Epic
// creation already succeeded; this only annotates the feature view.
//
// =====================================================================
// CONTRACT
// ---------------------------------------------------------------------
// INVOCATION:
//   node bin/epic-feature.mjs --repo <name> --epic <ref> [--name <feature>]
//        [--summary <text>] [--scope-node <id>] [--feature-id <id>] [--dry-run]
//
// FLAGS:
//   --repo <name>        (required unless --feature-id) the existing repo the
//                        brownfield epic targets — the feature's repo.
//   --epic <ref>         (required) the epic ref — recorded as the feature provenance.
//   --name <feature>     the feature name (required to add_feature; omit when
//                        --feature-id advances an existing backlog feature).
//   --summary <text>     a one-line feature summary for add_feature.
//   --scope-node <id>    optional scope node to attach the feature to.
//   --feature-id <id>    advance THIS existing (backlog) feature → building instead
//                        of adding a new one. Wins over --name when both are given.
//   --dry-run            print the planned Dispatch argv as JSON; run nothing.
//
// OUTPUT (stdout, single JSON object):
//   { "phase":"building", repo, epic, jobs:[{kind,ok}|{kind,args}] }   (exit 0)
//   { "phase":"noop", reason }                                          (exit 0)
//   { "phase":"error", error }                                          (exit 1)
//
// EXIT: 0 on building/noop/dry-run; 1 only on a usage error (nothing to do AND no
//   resolvable feature). A failed Dispatch write is NOT an error — it is logged
//   and reported as `ok:false`, never a non-zero exit (best-effort by contract).
// =====================================================================

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEpicBuildingCommands } from "../lib/feature-digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");
const GAFFER_DATA = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");

// Digest + feature lifecycle live in the MEMORY product (memory-mcp), not the
// dispatch control plane. Mirror the `lg` helper in factory.config.sh: spawn the memory
// CLI with the DB passed via the MEMORY_DB env var (no `--db` flag — the memory CLI's
// bin contract). MEMORY_CLI_BIN points at dist/bin/memory.js.
const MEMORY_DB = process.env.MEMORY_DB || resolve(GAFFER_DATA, "memory.sqlite");
const MEMORY_CLI =
  process.env.MEMORY_CLI ||
  process.env.MEMORY_CLI_BIN ||
  resolve(RUNNER_DIR, "..", "packages", "memory", "dist", "bin", "memory.js");

function log(msg) {
  process.stderr.write(`[epic-feature] ${msg}\n`);
}
function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}
function fail(reason, code = 1) {
  emit({ phase: "error", error: reason }, code);
}

export function parseArgs(argv) {
  const opts = {
    repo: "",
    epic: "",
    name: "",
    summary: "",
    scopeNode: "",
    featureId: "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--repo":
        opts.repo = next() ?? "";
        break;
      case "--epic":
        opts.epic = next() ?? "";
        break;
      case "--name":
        opts.name = next() ?? "";
        break;
      case "--summary":
        opts.summary = next() ?? "";
        break;
      case "--scope-node":
        opts.scopeNode = next() ?? "";
        break;
      case "--feature-id":
        opts.featureId = next() ?? "";
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

function runMemoryCli(args) {
  return spawnSync(process.execPath, [MEMORY_CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_DB },
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!String(opts.epic).trim()) {
    fail("--epic <ref> is required (the epic ref recorded as the feature provenance)");
    return;
  }

  const jobs = buildEpicBuildingCommands({
    repo: opts.repo,
    name: opts.name,
    summary: opts.summary,
    provenance: opts.epic,
    scopeNode: opts.scopeNode,
    featureId: opts.featureId,
  });

  if (jobs.length === 0) {
    // Nothing resolvable: no feature id to advance and no name+repo to add.
    emit({
      phase: "noop",
      reason:
        "nothing to do — pass --feature-id to advance an existing feature, or --repo + --name to add one",
    });
    return;
  }

  if (opts.dryRun) {
    emit({
      phase: "dry-run",
      repo: opts.repo,
      epic: opts.epic,
      jobs: jobs.map((j) => ({ kind: j.kind, command: j.command, args: j.args })),
    });
    return;
  }

  const ran = [];
  for (const job of jobs) {
    let ok = false;
    try {
      // feature jobs target the MEMORY CLI (job.command is MEMORY_CLI, "lg").
      const res = runMemoryCli(job.args);
      ok = !res.error && res.status === 0;
      if (!ok) {
        log(
          `feature write skipped (\`${job.command} ${job.args.join(" ")}\` exit ${res.status ?? "spawn-error"}) — ` +
            "memory not updated; epic creation unaffected",
        );
      }
    } catch (e) {
      log(`feature write threw (${e?.message ?? e}) — swallowed; epic creation unaffected`);
    }
    ran.push({ kind: job.kind, ok });
  }

  emit({ phase: "building", repo: opts.repo, epic: opts.epic, jobs: ran });
}

// Run only as a CLI (importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
