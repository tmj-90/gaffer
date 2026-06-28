/**
 * Setup and utility commands: demo, setup, doctor, audit, absent, prune,
 * stats, hooks.
 *
 * These commands configure and maintain the memory installation, provide
 * observability (audit, stats), and handle edge-case lifecycle tasks
 * (pruning, absence markers, demo data).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  findActiveAbsence,
  listAbsences,
  pruneExpiredAbsences,
  recordAbsence,
} from "../../core/absence.js";
import { pruneReadEvents } from "../../core/lore.js";
import { openDb } from "../../db/index.js";
import { getBool, getString } from "../args.js";
import type { parseArgs } from "../args.js";
import { cleanDemo, countLore, seedDemo } from "../demo.js";
import { renderDoctor, runDoctor } from "../doctor.js";
import { formatAuditLine } from "../helpers/audit.js";
import {
  addMcpServer,
  appendInstructionsToFile,
  claudeMdPath,
  type ClaudeMdScope,
  copySkillFile,
  detectIngestSources,
  findBundledSkillPath,
  skillDestPath,
} from "../setup.js";

export async function cmdDemo(args: ReturnType<typeof parseArgs>): Promise<number> {
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

export async function cmdSetup(args: ReturnType<typeof parseArgs>): Promise<number> {
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

export async function cmdDoctor(): Promise<number> {
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
export async function cmdAudit(args: ReturnType<typeof parseArgs>): Promise<number> {
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

export async function cmdAbsent(args: ReturnType<typeof parseArgs>): Promise<number> {
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
export async function cmdPrune(args: ReturnType<typeof parseArgs>): Promise<number> {
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

export async function cmdStats(args: ReturnType<typeof parseArgs>): Promise<number> {
  const {
    evidenceForRecord,
    recentActivity,
    renderStatsReport,
    retireCandidates,
    topCitedRecords,
  } = await import("../stats.js");
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

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

export async function cmdHooks(args: ReturnType<typeof parseArgs>): Promise<number> {
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
  } = await import("../hooks.js");
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
