import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  findActiveAbsence,
  listAbsences,
  pruneExpiredAbsences,
  recordAbsence,
} from "../core/absence.js";
import { defaultDbPath, openDb } from "../db/index.js";
import { pruneReadEvents } from "../core/lore.js";
import { getBool, getString, parseArgs } from "./args.js";
import {
  cmdAdd,
  cmdApprove,
  cmdDelete,
  cmdDeprecate,
  cmdReject,
  cmdReview,
  cmdSupersede,
  cmdSuggestFromCommit,
  cmdUpdate,
  cmdVerify,
} from "./commands/lifecycle.js";
import { cmdExport, cmdList, cmdRepos, cmdSearch, cmdShow, cmdTags } from "./commands/queries.js";
import {
  cmdBoundary,
  cmdDigest,
  cmdFeature,
  cmdFeatures,
  cmdImpact,
} from "./commands/knowledge.js";
import { cmdSync } from "./commands/sync.js";
import { formatAuditLine } from "./helpers/audit.js";
import { cleanDemo, countLore, seedDemo } from "./demo.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderClaudeInstructions } from "./instructions.js";
import {
  addMcpServer,
  appendInstructionsToFile,
  claudeMdPath,
  type ClaudeMdScope,
  copySkillFile,
  detectIngestSources,
  findBundledSkillPath,
  skillDestPath,
} from "./setup.js";
import { VERSION } from "../version.js";

const HELP = `memory — reviewed project memory for AI coding agents

USAGE
  memory <command> [options]

COMMANDS
  init                      Create / migrate the local DB
  add                       Add a note (human, status=active). Interactive
                            unless --title is given.
  suggest                   Same as add but lands as a draft. Used by agents;
                            also handy when you want to triage later.
  suggest --from-commit <sha>
                            Draft a record straight from a commit message
                            (subject -> title, body -> summary/detail).
                            Auto-derives a commit permalink as the source
                            from remote.origin.url. Lands as a draft;
                            promote via review. --repo/--tag/--source apply.
  search <query...>         Full-text search. Returns brief summaries.
                            Flags: --repo, --tag (repeatable for ANY-of),
                            --prefix (match tokens of 3+ chars as
                            prefixes), --updated-after, --include-drafts,
                            --include-deprecated, --include-superseded,
                            --include-restricted, --limit
  show <id>                 Print the full record (body included).
  list                      Recent records across all lifecycle states.
  review [--list]           Interactive triage queue: show each pending
                            draft and ask [a]pprove / [r]eject / [e]dit /
                            [s]kip / [q]uit. Use --list (or pipe to stdout)
                            for the non-interactive list view.
  approve <id>              Promote draft → active.
  reject <id> [--reason "..."]
                            Drop a draft. Refuses non-drafts (use
                            deprecate instead). Emits a 'rejected' event
                            so the audit chain shows the triage decision.
                            --reason is optional but recommended — gives
                            the agent (or future-you) a record of WHY
                            the draft was dropped.
  deprecate <id>            Mark deprecated.
  supersede <old-id> --with <new-id>
                            Mark <old-id> as superseded by <new-id>.
  verify <id> [--review-after <iso-date>]
                            Bump last_verified_at; if review-after has
                            lapsed, push it 90 days forward (or use the
                            value you pass with --review-after).
  update <id> [--title ... --summary ... --body ... --source ... etc.]
                            Edit fields on an existing record. Useful
                            for fixing an agent's draft before approving.
  delete <id>               Hard-delete the record (events row preserved).
  tags                      Print all distinct tags.
  repos                     Print all distinct repos.
  export [--out <path>]     Export lore as a single JSON document
                            (envelope: { schemaVersion, exportedAt,
                            records }). Default: active + non-restricted
                            only, stable ordering by updated_at desc.
                            Without --out, writes to stdout. With --out,
                            writes the file with mode 0600.
                            Opt-ins: --include-drafts,
                            --include-deprecated, --include-superseded,
                            --include-restricted.
  sync export <dir> [--clean]
                            Write one .md file per record into <dir>
                            (e.g. .memory/) — PR-reviewable team lore.
                            Active + non-restricted by default; same
                            --include-* opt-ins as \`export\`. Pass --clean
                            to remove existing <id>.md files in <dir>
                            before writing (only files matching the
                            8-char id pattern; hand-written .md files
                            are left alone).
  sync import <dir>         Read every *.md file in <dir> and upsert
                            into the local DB. Restricted records are
                            skipped unless --include-restricted is set.
                            Imports respect the file's declared status
                            (the PR is the review gate).
  sync pull <parent>        Recursively discover every .memory/
                            directory under <parent> and import each.
                            One command bootstraps a fresh machine
                            across every repo in your workspace tree.
                            Same flags as \`sync import\`. Skips heavy
                            directories (node_modules, .git, dist,
                            build, target, vendor, etc.).
  audit [--n=N] [--raw]     Print the last N audit log lines (default 20)
                            in a redacted human-readable form. Use --raw
                            to see the full JSON instead.
  doctor                    Health-check the local install: DB exists,
                            permissions, FTS index, audit log, restricted
                            MCP gate, version. Exits non-zero on hard
                            failures, zero on warnings.
  setup [--dry-run] [--force] [--claude-md project|user]
                            One-command bootstrap: register the MCP server
                            with Claude Code, append the retrieval rule to
                            CLAUDE.md, install /memory-onboard into
                            ~/.claude/skills/, and point you at
                            /memory-onboard for cold-start (detects
                            CLAUDE.md, AGENTS.md, ADR dirs, top-level docs
                            to make the nudge concrete).
                            Idempotent. Opt out per step with --skip-mcp,
                            --skip-claude-md, --skip-skill,
                            --skip-corpus-nudge.
  demo [--force | --clean]  Seed five illustrative records (tagged 'demo')
                            so you can try list / search / review without
                            authoring content first. Refuses to seed into
                            a non-empty DB unless --force. Use --clean to
                            remove the demo records later.
  absent record "<query>" --reason "..." [--repo X] [--expires-days 14]
                            Record a verified-absence marker: "we
                            checked, the team has no policy on this".
                            When future search_lore returns zero hits
                            on the same normalised query, the response
                            includes this marker so the agent knows
                            it's an acknowledged gap. Self-expires
                            (default 14 days).
  absent list [--include-expired]
                            List active absence markers (or all of
                            them with --include-expired).
  stats [--top N] [--retire] [--since-days N] [--quiet-for-days N] [--json]
                            Local read-tracking view: top-cited
                            records, retirement candidates (active +
                            zero reads in N days), recent activity.
                            Opt out of read tracking via
                            MEMORY_NO_TELEMETRY=1.
  prune [--read-events-older-than N] [--vacuum] [--dry-run]
                            Local-DB GC. Deletes 'read' audit events
                            older than N days (default 90; lifecycle
                            events are never touched) and expired
                            absence markers. --vacuum reclaims disk
                            after; --dry-run reports counts only.
  impact <contract>         Cross-repo impact map for a contract: who
                            PROVIDES (owns/produces) it and who CONSUMES
                            (depends on) it. The consumers are the blast
                            radius of a shape change. Reads the map
                            aggregated locally + via sync pull.
  boundary <sub> ...        Manage cross-repo interaction edges:
                            add <repo> <contract> <provides|consumes>
                              [--kind K --detail "..." --source URL]
                            suggest ...   (same, lands as a draft)
                            list [--repo X --contract C --role R
                              --include-drafts --include-deprecated]
                            review [--list]   triage draft edges
                            approve <id> | reject <id> | deprecate <id>
                            Agents declare edges as drafts via MCP; a
                            human ratifies them — same trust gate as lore.
  digest <repo>             Show the repo's understanding digest: TLDR
                            overview, key structure, conventions + stack,
                            with a freshness line (updated_at / source)
                            and a caveat that it's a summary to verify
                            against code for high-stakes work.
  digest set <repo> --source <s>
      [--overview <s>] [--structure <s>] [--conventions <s>] [--stack <s>]
                            Upsert the repo digest. A PARTIAL set MERGES
                            into the existing digest — any section you
                            don't pass keeps its prior value. The first
                            set for a repo must include every section.
                            --source stamps provenance ('onboard' |
                            'merge:#<n>' | 'manual').
  digest touch <repo> --source <s>
                            Freshness stamp only — re-stamp source /
                            updated_at, leave every section's content
                            untouched. Refuses if no digest exists yet.
  feature add <repo> --name <s> --summary <s>
      [--status backlog|building|shipped] [--scope-node <s>] [--provenance <s>]
                            Add a feature to the repo's ledger (defaults
                            to backlog). --scope-node narrows it to a
                            sub-area; --provenance records where it came
                            from (e.g. an epic ref or merge source).
  feature advance <id> --to backlog|building|shipped
                            Move a feature to a new lifecycle status,
                            enforcing the legal forward transitions
                            (backlog → building → shipped, plus the direct
                            backlog → shipped jump). A backward / same-
                            state / unknown move is refused.
  features <repo> [--status backlog|building|shipped] [--node N]
                            List the repo's feature ledger, grouped by
                            lifecycle status. --node filters to a single
                            scope-node (a sub-area of the repo); omit it
                            to list every feature in the repo.
  hooks install [--project] [--dry-run]
                            Wire the Claude Code Stop-hook for
                            session-end review nudges. Writes
                            .claude/settings.json so when Claude is
                            about to stop, the hook checks for pending
                            drafts and (once per session) asks the
                            user whether to triage them. Opt-in.
  hooks review-nudge        Internal — invoked by the Stop hook.
                            Reads Claude hook JSON on stdin; emits
                            block-JSON to stdout when drafts are
                            pending and this session hasn't been
                            nudged yet.
  print-claude-instructions
                            Print the retrieval rule to paste into
                            your CLAUDE.md / agent instructions so the
                            agent reliably calls search_lore.
  mcp                       Run the MCP server on stdio (same as memory-mcp).

EXAMPLES
  memory add --title "Argon2id is the default" --summary "..." --body "..."
  memory search "password hashing" --repo payments-svc
  memory review
  memory approve 7vk3qm9b
`;

async function cmdInit(): Promise<number> {
  const path = defaultDbPath();
  const db = openDb(path);
  db.close();
  // openDb runs migrations and creates the file with 0600 perms.
  process.stdout.write(`memory: initialised at ${path}\n`);
  return 0;
}

async function cmdDemo(args: ReturnType<typeof parseArgs>): Promise<number> {
  const force = getBool(args.flags, "force");
  const clean = getBool(args.flags, "clean");
  if (force && clean) {
    process.stderr.write("memory: --force and --clean are mutually exclusive\n");
    return 2;
  }
  const db = openDb();
  try {
    if (clean) {
      const removed = cleanDemo(db);
      process.stdout.write(
        removed === 0
          ? "memory: no demo records found (nothing to clean)\n"
          : `memory: removed ${removed} demo record(s)\n`,
      );
      return 0;
    }
    const existing = countLore(db);
    if (existing > 0 && !force) {
      process.stderr.write(
        `memory: refusing to seed demo into a non-empty DB (${existing} record(s) already present).\n` +
          "      Re-run with --force to seed anyway, or `memory demo --clean` to remove demo records later.\n",
      );
      return 1;
    }
    const { inserted, ids } = seedDemo(db);
    process.stdout.write(
      `memory: seeded ${inserted} demo record(s).\n\n` +
        `Try:\n` +
        `  memory list\n` +
        `  memory search "timezone"\n` +
        `  memory review        # the demo set includes one draft to triage\n\n` +
        `Cleanup when you're done:\n` +
        `  memory demo --clean  # removes only records tagged 'demo'\n`,
    );
    // Echo the ids so a curious user can `memory show <id>` immediately.
    for (const id of ids) process.stdout.write(`  ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSetup(args: ReturnType<typeof parseArgs>): Promise<number> {
  const dryRun = getBool(args.flags, "dry-run");
  const force = getBool(args.flags, "force");
  const skipMcp = getBool(args.flags, "skip-mcp");
  const skipClaudeMd = getBool(args.flags, "skip-claude-md");
  const skipSkill = getBool(args.flags, "skip-skill");
  const scopeFlag = getString(args.flags, "claude-md") ?? "project";
  if (scopeFlag !== "project" && scopeFlag !== "user") {
    process.stderr.write(`memory: --claude-md must be 'project' or 'user' (got '${scopeFlag}')\n`);
    return 2;
  }
  const scope = scopeFlag as ClaudeMdScope;
  const cmPath = claudeMdPath(scope);

  process.stdout.write(
    `memory setup${dryRun ? " (dry-run)" : ""}\n` + `  claude.md scope: ${scope} (${cmPath})\n\n`,
  );

  // [1/4] MCP server
  if (skipMcp) {
    process.stdout.write("[1/4] MCP server: skipped (--skip-mcp)\n");
  } else if (dryRun) {
    process.stdout.write("[1/4] would run: claude mcp add memory memory-mcp\n");
  } else {
    const r = addMcpServer();
    if (r.action === "registered") {
      process.stdout.write("[1/4] ✓ registered memory MCP server with Claude Code\n");
    } else if (r.action === "already-present") {
      process.stdout.write("[1/4] · MCP server already registered\n");
    } else if (r.action === "claude-cli-missing") {
      process.stdout.write(`[1/4] ! ${r.detail}\n`);
    } else {
      process.stdout.write(`[1/4] ! claude mcp add failed: ${r.detail ?? ""}\n`);
    }
  }

  // [2/4] CLAUDE.md retrieval rule
  if (skipClaudeMd) {
    process.stdout.write("[2/4] CLAUDE.md retrieval rule: skipped (--skip-claude-md)\n");
  } else if (dryRun) {
    process.stdout.write(`[2/4] would append retrieval rule to ${cmPath}\n`);
  } else {
    const r = appendInstructionsToFile(cmPath, force);
    if (r.action === "created") {
      process.stdout.write(`[2/4] ✓ created ${cmPath} with retrieval rule\n`);
    } else if (r.action === "appended") {
      process.stdout.write(`[2/4] ✓ appended retrieval rule to ${cmPath}\n`);
    } else if (r.action === "replaced") {
      process.stdout.write(`[2/4] ✓ replaced existing retrieval block in ${cmPath}\n`);
    } else if (r.action === "already-present") {
      process.stdout.write(`[2/4] · retrieval rule already present in ${cmPath}\n`);
    } else {
      process.stdout.write(
        `[2/4] ! ${cmPath} has a partial memory block (only one marker) — re-run with --force to replace\n`,
      );
    }
  }

  // [3/4] /memory-onboard skill
  if (skipSkill) {
    process.stdout.write("[3/4] /memory-onboard skill: skipped (--skip-skill)\n");
  } else if (dryRun) {
    process.stdout.write(`[3/4] would copy skill to ${skillDestPath()}\n`);
  } else {
    try {
      const r = copySkillFile(findBundledSkillPath(), skillDestPath(), force);
      if (r.action === "copied") {
        process.stdout.write(`[3/4] ✓ installed skill at ${r.dest}\n`);
      } else if (r.action === "overwritten") {
        process.stdout.write(`[3/4] ✓ overwrote skill at ${r.dest}\n`);
      } else if (r.action === "already-present") {
        process.stdout.write(`[3/4] · skill already up to date at ${r.dest}\n`);
      } else {
        process.stdout.write(
          `[3/4] ! ${r.dest} exists and differs from bundled — re-run with --force to overwrite\n`,
        );
      }
    } catch (err) {
      process.stdout.write(`[3/4] ! ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // [4/4] cold-start nudge — the MAIN failure mode of day-1 is: setup
  // succeeds, the first Claude session calls search_lore, gets zero
  // hits, and the user concludes the tool's broken. The fix is to send
  // them straight to /memory-onboard, which reads the repo with
  // agent judgement and proposes well-shaped drafts (far better than the
  // old mechanical induct/ingest paths, now removed). We detect likely
  // source docs only to make the nudge concrete — we don't ingest here.
  const skipCorpusNudge = getBool(args.flags, "skip-corpus-nudge");
  if (skipCorpusNudge) {
    process.stdout.write("[4/4] cold-start nudge: skipped (--skip-corpus-nudge)\n");
  } else {
    const sources = detectIngestSources();
    const found: string[] = [];
    if (sources.claudeMd) found.push(sources.claudeMd);
    if (sources.adrDirs.length > 0) {
      found.push(
        `${sources.adrDirs.length} ADR director${sources.adrDirs.length === 1 ? "y" : "ies"} (${sources.adrDirs.join(", ")})`,
      );
    }
    if (sources.otherDocs.length > 0) {
      found.push(`${sources.otherDocs.length} other top-level doc(s)`);
    }
    process.stdout.write("[4/4] Cold-start:\n");
    if (found.length > 0) {
      process.stdout.write(`  Detected likely knowledge sources: ${found.join("; ")}\n`);
    }
    if (skipSkill) {
      process.stdout.write(
        "  The /memory-onboard skill wasn't installed (--skip-skill).\n" +
          "  Install it, then in Claude Code run /memory-onboard to\n" +
          "  populate your first records.\n",
      );
    } else {
      process.stdout.write(
        "  Next: open Claude Code in this repo and run /memory-onboard.\n" +
          "  The skill reads the repo (README, ADRs, recent commits) and\n" +
          "  proposes well-shaped DRAFT records with source citations.\n" +
          "  Trust gate is unchanged — drafts land in `memory review`.\n",
      );
    }
  }

  process.stdout.write("\nDone. After /memory-onboard, run `memory list` to see your drafts.\n");
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const { exitCode, checks } = await runDoctor();
  process.stdout.write(renderDoctor(checks) + "\n");
  return exitCode;
}

/**
 * Audit display. Default is a redacted human-readable form:
 *
 *   2026-05-16T11:32:18Z  search_lore  q="password hashing" repo=payments-svc  → 2 hits
 *
 * The on-disk JSONL never contains result bodies (the audit module already
 * scrubs those before write — see audit.test.ts), but raw JSON exposes
 * search queries and titles that might carry sensitive intent. `--raw`
 * opts back into full JSON for power users who explicitly want it.
 */
async function cmdAudit(args: ReturnType<typeof parseArgs>): Promise<number> {
  const path = process.env["MEMORY_AUDIT_LOG"] ?? join(homedir(), ".memory", "audit.jsonl");
  if (!existsSync(path)) {
    process.stdout.write("memory: no audit log yet\n");
    return 0;
  }
  const n = Number(getString(args.flags, "n") ?? "20");
  const raw = getBool(args.flags, "raw");
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - n));
  if (raw) {
    for (const l of tail) process.stdout.write(l + "\n");
    return 0;
  }
  for (const l of tail) {
    process.stdout.write(formatAuditLine(l) + "\n");
  }
  return 0;
}

async function cmdAbsent(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== "record" && sub !== "list") {
    process.stderr.write(
      'memory: absent requires a subcommand — `memory absent record "<query>" --reason "..."` or `memory absent list`\n',
    );
    return 2;
  }
  const db = openDb();
  try {
    if (sub === "record") {
      const query = args.positionals[1];
      if (!query) {
        process.stderr.write("memory: absent record requires a query (in quotes)\n");
        return 2;
      }
      const reason = getString(args.flags, "reason");
      if (!reason) {
        process.stderr.write('memory: absent record requires --reason "..." explaining the gap\n');
        return 2;
      }
      const repo = getString(args.flags, "repo");
      const expiresInDaysRaw = getString(args.flags, "expires-days");
      let expiresInDays: number | undefined;
      if (expiresInDaysRaw !== undefined) {
        const n = Number(expiresInDaysRaw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          process.stderr.write(
            `memory: --expires-days must be an integer (got ${JSON.stringify(expiresInDaysRaw)})\n`,
          );
          return 2;
        }
        expiresInDays = Math.max(1, Math.min(365, n));
      }
      const result = recordAbsence(db, {
        query,
        reason,
        repo,
        expiresInDays,
        recordedBy: "human",
      });
      process.stdout.write(
        `memory: recorded absence marker ${result.id} (expires ${result.expiresAt})\n`,
      );
      // Echo what an active search would surface — useful sanity check.
      const found = findActiveAbsence(db, { query, repo });
      if (found) {
        process.stdout.write(
          `  query normalised to: "${found.query}"${found.repo ? ` (repo: ${found.repo})` : ""}\n`,
        );
      }
      return 0;
    }
    const includeExpired = getBool(args.flags, "include-expired");
    const markers = listAbsences(db, { includeExpired });
    if (markers.length === 0) {
      process.stdout.write(
        includeExpired
          ? "memory: no absence markers recorded\n"
          : "memory: no active absence markers (pass --include-expired to see aged-out ones)\n",
      );
      return 0;
    }
    for (const m of markers) {
      const scope = m.repo ? ` [${m.repo}]` : "";
      const now = new Date().toISOString();
      const expired = m.expiresAt <= now;
      const flag = expired ? " (expired)" : "";
      process.stdout.write(
        `${m.id}${scope}  "${m.query}"${flag}\n  reason:  ${m.reason}\n  recorded: ${m.recordedAt} by ${m.recordedBy}\n  expires:  ${m.expiresAt}\n\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory prune` — local-DB GC. Two leaks accumulate forever without
 * this: `read` audit events (one per search/get result) and expired
 * absence markers. Neither affects correctness (stats windows are
 * bounded; expired markers are already filtered out), but on a busy
 * multi-agent install the row count climbs indefinitely.
 *
 *   --read-events-older-than N   delete 'read' events older than N days
 *                                (default 90 — matches the stats window,
 *                                so nothing stats would show is lost)
 *   --vacuum                     reclaim disk after deletes (VACUUM)
 *   --dry-run                    report what would be deleted, write nothing
 */
async function cmdPrune(args: ReturnType<typeof parseArgs>): Promise<number> {
  const rawDays = getString(args.flags, "read-events-older-than");
  let readDays = 90;
  if (rawDays !== undefined) {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      process.stderr.write(
        `memory prune: --read-events-older-than must be a non-negative integer (got ${JSON.stringify(rawDays)})\n`,
      );
      return 2;
    }
    readDays = n;
  }
  const vacuum = getBool(args.flags, "vacuum");
  const dryRun = getBool(args.flags, "dry-run");

  const db = openDb();
  try {
    if (dryRun) {
      const cutoff = new Date(Date.now() - readDays * 86_400_000).toISOString();
      const reads = (
        db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'read' AND ts < ?")
          .get(cutoff) as { n: number }
      ).n;
      const markers = (
        db
          .prepare("SELECT COUNT(*) AS n FROM absence_markers WHERE expires_at <= ?")
          .get(new Date().toISOString()) as { n: number }
      ).n;
      process.stdout.write(
        `memory prune (dry-run):\n` +
          `  would delete ${reads} read event(s) older than ${readDays} days\n` +
          `  would delete ${markers} expired absence marker(s)\n` +
          (vacuum ? `  would VACUUM after deletes\n` : "") +
          `  (dry-run — nothing written)\n`,
      );
      return 0;
    }
    const reads = pruneReadEvents(db, readDays);
    const markers = pruneExpiredAbsences(db);
    process.stdout.write(
      `memory prune: deleted ${reads} read event(s) older than ${readDays} days, ${markers} expired absence marker(s)\n`,
    );
    if (vacuum) {
      // VACUUM can't run inside a transaction; openDb doesn't hold one
      // open here. Reclaims pages freed by the deletes above.
      db.exec("VACUUM");
      process.stdout.write("memory prune: reclaimed free pages (VACUUM)\n");
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdStats(args: ReturnType<typeof parseArgs>): Promise<number> {
  const {
    evidenceForRecord,
    recentActivity,
    renderStatsReport,
    retireCandidates,
    topCitedRecords,
  } = await import("./stats.js");
  // Numeric flags: refuse non-integer input early rather than passing
  // NaN through to better-sqlite3 (which raises an unhelpful "datatype
  // mismatch" deep in the call stack).
  function parseInt1(flag: string, fallback: number): number | null {
    const raw = getString(args.flags, flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      process.stderr.write(
        `memory stats: --${flag} must be a positive integer (got ${JSON.stringify(raw)})\n`,
      );
      return null;
    }
    return n;
  }
  const top = parseInt1("top", 10);
  if (top === null) return 2;
  const sinceDays = parseInt1("since-days", 90);
  if (sinceDays === null) return 2;
  const quietForDays = parseInt1("quiet-for-days", 180);
  if (quietForDays === null) return 2;
  const wantsJson = getBool(args.flags, "json");
  const retireOnly = getBool(args.flags, "retire");
  const wantsEvidence = getBool(args.flags, "evidence");
  const evidenceLimit = parseInt1("evidence-top", 5);
  if (evidenceLimit === null) return 2;
  const db = openDb();
  try {
    const retire = retireCandidates(db, { quietForDays });
    if (retireOnly) {
      if (wantsJson) {
        process.stdout.write(JSON.stringify(retire, null, 2) + "\n");
      } else if (retire.length === 0) {
        process.stdout.write("memory: no retirement candidates\n");
      } else {
        for (const r of retire) {
          const lastSeen = r.lastReadAt ? `last read ${r.lastReadAt.slice(0, 10)}` : "never read";
          const src = r.hasSource ? "sourced" : "no source";
          process.stdout.write(`${r.id}  ${r.title}  [${r.confidence}, ${src}, ${lastSeen}]\n`);
        }
      }
      return 0;
    }
    const cited = topCitedRecords(db, { sinceDays, limit: top });
    const activity = recentActivity(db, { days: sinceDays });
    // --evidence: pull the actual audit queries that hit each top-cited
    // record. Streamed; safe on large audit logs. Answers "is memory
    // earning its keep?" concretely — each top-cited record gets its
    // citation count broken down by the queries that produced it.
    const evidence: Array<{
      id: string;
      rows: Array<{ query: string; tool: string; count: number }>;
      truncated: number;
    }> = [];
    if (wantsEvidence) {
      const auditPath =
        process.env["MEMORY_AUDIT_LOG"] ?? join(homedir(), ".memory", "audit.jsonl");
      for (const c of cited) {
        const { rows, truncated } = await evidenceForRecord(auditPath, c.id, {
          sinceDays,
          limit: evidenceLimit,
        });
        evidence.push({ id: c.id, rows, truncated });
      }
    }
    if (wantsJson) {
      const payload: Record<string, unknown> = {
        topCited: cited,
        retireCandidates: retire,
        recentActivity: activity,
      };
      if (wantsEvidence) {
        const byId = new Map(evidence.map((e) => [e.id, e]));
        payload["topCited"] = cited.map((c) => ({
          ...c,
          evidence: byId.get(c.id)?.rows ?? [],
          evidenceTruncated: byId.get(c.id)?.truncated ?? 0,
        }));
      }
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      process.stdout.write(
        renderStatsReport(cited, retire, activity, { sinceDays, quietForDays }) + "\n",
      );
      if (wantsEvidence && cited.length > 0) {
        process.stdout.write("\nEvidence (queries that hit each top record):\n");
        const byId = new Map(evidence.map((e) => [e.id, e]));
        for (const c of cited) {
          const e = byId.get(c.id);
          process.stdout.write(`\n  ${c.id}  ${c.title}\n`);
          if (!e || e.rows.length === 0) {
            process.stdout.write(
              "    (no recorded queries in audit log — reads may pre-date\n" +
                "     read-tracking, or MEMORY_NO_TELEMETRY may be set)\n",
            );
            continue;
          }
          for (const r of e.rows) {
            const via = r.tool === "get_lore" ? " (get_lore)" : "";
            process.stdout.write(`    ${String(r.count).padStart(4)}× "${r.query}"${via}\n`);
          }
          if (e.truncated > 0) {
            process.stdout.write(
              `         + ${e.truncated} other quer${e.truncated === 1 ? "y" : "ies"}\n`,
            );
          }
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdHooks(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== "install" && sub !== "review-nudge") {
    process.stderr.write(
      "memory: hooks requires a subcommand — `memory hooks install [--project]` or `memory hooks review-nudge`\n",
    );
    return 2;
  }
  const {
    decideNudge,
    markSessionNudged,
    mergeHookSettings,
    parseHookInput,
    projectHookSettingsPath,
    readSettingsFile,
    sessionAlreadyNudged,
  } = await import("./hooks.js");
  if (sub === "install") {
    const dryRun = getBool(args.flags, "dry-run");
    const path = projectHookSettingsPath();
    const existing = readSettingsFile(path);
    const next = mergeHookSettings(existing);
    if (existing === next) {
      process.stdout.write(
        `memory hooks install: ${path} already contains the memory Stop hook (no changes)\n`,
      );
      return 0;
    }
    if (dryRun) {
      process.stdout.write(`--- would write ${path} ---\n`);
      process.stdout.write(next);
      process.stdout.write("--- (dry-run — nothing written) ---\n");
      return 0;
    }
    const { dirname } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    process.stdout.write(`memory hooks install: wired Stop hook into ${path}\n`);
    return 0;
  }
  // review-nudge: invoked by the Stop hook. Read stdin, check drafts,
  // emit JSON. Never throw — Claude will surface our exit code as a
  // hook failure to the user, which is louder than the bug warrants.
  try {
    const stdin = await readAllStdin();
    const { sessionId } = parseHookInput(stdin);
    const db = openDb();
    try {
      const pending = (
        db.prepare("SELECT COUNT(*) AS n FROM lore WHERE status = 'draft'").get() as { n: number }
      ).n;
      const nudgeEveryTime = process.env["MEMORY_REVIEW_NUDGE_EVERY_TIME"] === "1";
      const out = decideNudge({
        pendingDraftCount: pending,
        sessionAlreadyNudged: sessionAlreadyNudged(sessionId),
        nudgeEveryTime,
      });
      if (out.decision === "block") {
        markSessionNudged(sessionId);
        process.stdout.write(JSON.stringify(out));
      }
      // else: silent pass — Claude stops normally.
      return 0;
    } finally {
      db.close();
    }
  } catch (err) {
    // Don't surface — the hook failing should NOT block Claude
    // stopping or break the user's workflow. Log to stderr (Claude
    // shows hook stderr but doesn't interpret it as a block).
    process.stderr.write(
      `memory hooks review-nudge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , ...rest] = argv;
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (rest[0] === "--version" || rest[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const [cmd, ...subArgs] = rest;
  const parsed = parseArgs(subArgs);
  try {
    switch (cmd) {
      case "init":
        return await cmdInit();
      case "add":
        return await cmdAdd(parsed, false);
      case "suggest": {
        const fromCommit = getString(parsed.flags, "from-commit");
        if (fromCommit) return await cmdSuggestFromCommit(parsed, fromCommit);
        return await cmdAdd(parsed, true);
      }
      case "search":
        return await cmdSearch(parsed);
      case "show":
        return await cmdShow(parsed);
      case "list":
        return await cmdList();
      case "review":
        return await cmdReview(parsed);
      case "approve":
        return await cmdApprove(parsed);
      case "reject":
        return await cmdReject(parsed);
      case "deprecate":
        return await cmdDeprecate(parsed);
      case "supersede":
        return await cmdSupersede(parsed);
      case "verify":
        return await cmdVerify(parsed);
      case "update":
      case "edit":
        return await cmdUpdate(parsed);
      case "delete":
        return await cmdDelete(parsed);
      case "tags":
        return await cmdTags();
      case "repos":
        return await cmdRepos();
      case "audit":
        return await cmdAudit(parsed);
      case "export":
        return await cmdExport(parsed);
      case "sync":
        return await cmdSync(parsed);
      case "setup":
        return await cmdSetup(parsed);
      case "demo":
        return await cmdDemo(parsed);
      case "absent":
        return await cmdAbsent(parsed);
      case "stats":
        return await cmdStats(parsed);
      case "prune":
        return await cmdPrune(parsed);
      case "impact":
        return await cmdImpact(parsed);
      case "boundary":
        return await cmdBoundary(parsed);
      case "digest":
        return await cmdDigest(parsed);
      case "feature":
        return await cmdFeature(parsed);
      case "features":
        return await cmdFeatures(parsed);
      case "hooks":
        return await cmdHooks(parsed);
      case "doctor":
        return await cmdDoctor();
      case "print-claude-instructions":
      case "instructions":
        process.stdout.write(renderClaudeInstructions());
        return 0;
      case "mcp": {
        const { runMcpServer } = await import("../mcp/server.js");
        await runMcpServer();
        return 0;
      }
      default:
        process.stderr.write(`memory: unknown command '${cmd}'\n${HELP}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`memory: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
