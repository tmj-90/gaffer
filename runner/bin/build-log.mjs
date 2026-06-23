#!/usr/bin/env node
/**
 * Gaffer factory — PROVENANCE BUILD-LOG generator (CLI).
 *
 * Emits a Markdown build-log proving "this factory built itself, transparently."
 * It reads the factory's OWN delivery history through STUB-ABLE accessors (so it
 * is testable without the real `wg` CLI — exactly like run-summary.sh):
 *
 *   BUILDLOG_LIST_CMD   prints `ticket list -s done` JSON  (status appended)
 *                       default: `wg ticket list -s done`
 *   BUILDLOG_SHOW_CMD   prints `ticket show <ref>` JSON    (ref appended)
 *                       default: `wg ticket show`
 *
 * and joins, by `ticket`:
 *   $GAFFER_USAGE_LEDGER (usage-ledger.jsonl)      — token usage per ticket
 *   $GAFFER_DATA/safety-blocks.jsonl               — optional safety-hook blocks
 *     (override with $GAFFER_BLOCK_LEDGER, mirroring run-summary.sh)
 *
 * Output: Markdown to stdout, or to a file via `--out <path>`.
 *
 * Honesty enforcement lives in lib/build-log.mjs: only real recorded tickets are
 * reported as delivered; tokens are relayed verbatim; any cost is the ledger's
 * own `total_cost_usd`, labelled "API-equivalent (Claude Code's own figure)",
 * never computed; a ticket with no measured usage still appears, with
 * `usage: unknown` (never 0, never blank).
 *
 * Usage:
 *   node bin/build-log.mjs [--out <path>] [--status <status>]
 *   BUILDLOG_LIST_CMD=… BUILDLOG_SHOW_CMD=… node bin/build-log.mjs   (for tests)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assembleRows,
  indexBlocksByTicket,
  indexUsageByTicket,
  parseTicketList,
  renderBuildLog,
  safeJsonParse,
} from "../lib/build-log.mjs";

const DEFAULT_LIST_CMD = "wg ticket list -s";
const DEFAULT_SHOW_CMD = "wg ticket show";

/** Parse argv → { out, status }. */
function parseArgs(argv) {
  const out = { out: null, status: "done" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i] || null;
    else if (a === "--status") out.status = argv[++i] || "done";
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const HELP = `gaffer build-log — provenance build-log generator

Usage:
  node bin/build-log.mjs [--out <path>] [--status <status>]

Options:
  --out <path>      write Markdown to <path> instead of stdout
  --status <s>      ticket status to report (default: done)
  -h, --help        show this help

Stub-able accessors (mirroring run-summary.sh):
  BUILDLOG_LIST_CMD   prints \`ticket list -s <status>\` JSON  (default: ${DEFAULT_LIST_CMD} <status>)
  BUILDLOG_SHOW_CMD   prints \`ticket show <ref>\` JSON         (default: ${DEFAULT_SHOW_CMD} <ref>)

Joined data sources (keyed by ticket):
  GAFFER_USAGE_LEDGER  usage-ledger.jsonl  — token usage per delivered ticket
  GAFFER_BLOCK_LEDGER  safety-blocks.jsonl — optional safety-hook blocks
                      (defaults to $GAFFER_DATA/safety-blocks.jsonl)
`;

/**
 * Run a shell accessor (the stub or the real `wg`) with one appended argument.
 * Returns its stdout, or "" on any failure (the report degrades gracefully — a
 * missing CLI must never crash the generator).
 */
function runAccessor(baseCmd, arg) {
  try {
    return execSync(`${baseCmd} ${shellQuote(arg)}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** Minimal single-quote shell escaping for an accessor argument. */
function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

/** Read a file, returning "" when it is absent/unreadable (never throws). */
function readFileSafe(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function resolveUsageLedgerPath(env) {
  if (env.GAFFER_USAGE_LEDGER) return env.GAFFER_USAGE_LEDGER;
  if (env.GAFFER_DATA) return join(env.GAFFER_DATA, "usage-ledger.jsonl");
  return null;
}

function resolveBlockLedgerPath(env) {
  if (env.GAFFER_BLOCK_LEDGER) return env.GAFFER_BLOCK_LEDGER;
  if (env.GAFFER_DATA) return join(env.GAFFER_DATA, "safety-blocks.jsonl");
  return null;
}

/**
 * Generate the build-log Markdown. Pure-ish: side effects are confined to the
 * injected `runAccessor` / `readFile` seams, which the tests can drive directly.
 */
export function generateBuildLog({
  env = process.env,
  status = "done",
  runAccessor: run = (base, arg) => runAccessor(base, arg),
  readFile = readFileSafe,
  generatedAt,
} = {}) {
  const listBase = env.BUILDLOG_LIST_CMD || DEFAULT_LIST_CMD;
  const showBase = env.BUILDLOG_SHOW_CMD || DEFAULT_SHOW_CMD;

  // 1. The done list — the ground truth of "what the factory delivered".
  const listOut = run(listBase, status);
  const tickets = parseTicketList(safeJsonParse(listOut, []));

  // 2. Per-ticket show payloads (review outcome + evidence).
  const shows = new Map();
  for (const t of tickets) {
    shows.set(String(t.number), run(showBase, String(t.number)));
  }

  // 3. Join token usage + safety blocks by ticket.
  const usageByTicket = indexUsageByTicket(readFile(resolveUsageLedgerPath(env)));
  const blocksByTicket = indexBlocksByTicket(readFile(resolveBlockLedgerPath(env)));

  // 4. Assemble + render.
  const rows = assembleRows({ tickets, shows, usageByTicket, blocksByTicket });
  return renderBuildLog(rows, { generatedAt });
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const markdown = generateBuildLog({ status: args.status });
  if (args.out) {
    writeFileSync(args.out, markdown.endsWith("\n") ? markdown : markdown + "\n");
  } else {
    process.stdout.write(markdown.endsWith("\n") ? markdown : markdown + "\n");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
