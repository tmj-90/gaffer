#!/usr/bin/env node
/**
 * Gaffer factory — token SPEND ESTIMATE CLI.
 *
 * Predicts a ticket's likely token usage from the honest USAGE LEDGER so a human
 * can SANITY-CHECK spend BEFORE a run. It reads $GAFFER_USAGE_LEDGER (default
 * $GAFFER_DATA/usage-ledger.jsonl — the same convention as lib/usage-ledger.mjs's
 * appendUsageRecord), keeps ONLY measured rows of the requested kind, and prints
 * a loudly-labelled estimate: median + p10–p90 range of input tokens, output
 * tokens, and num_turns, with the sample size N and the date range it is built on.
 *
 * Usage:
 *   node bin/estimate-usage.mjs --kind <kind>
 *   node bin/estimate-usage.mjs --ticket <n>     # resolves the ticket's kind
 *   node bin/estimate-usage.mjs --kind delivery --ledger /path/to/ledger.jsonl
 *
 * HONESTY (the entire point — the user was explicit):
 *   • TOKENS and TURNS only — this CLI NEVER prints a dollar/cost figure.
 *   • Every numeric block is headed "ESTIMATE (tokens) — based on N past <kind>
 *     calls; actuals may differ" — a prediction, not a measurement.
 *   • Below MIN_SAMPLES (5) measured rows → "not enough history to estimate yet
 *     (only N measured <kind> calls)" and NO numbers.
 *   • measured:false / "unknown" rows are filtered out before anything is computed.
 *   • The basis (N, kind, date range) is always shown.
 *
 * Exit codes: 0 = printed an estimate OR an honest "not enough history" notice;
 *             2 = bad invocation (unknown/ missing kind, unresolvable ticket).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { LEDGER_FILENAME, VALID_KINDS } from "../lib/usage-ledger.mjs";
import {
  MIN_SAMPLES,
  P_HIGH,
  P_LOW,
  filterMeasured,
  parseLedger,
  resolveTicketKind,
  summarise,
} from "../lib/estimate.mjs";

/** Resolve the ledger path: --ledger > GAFFER_USAGE_LEDGER > $GAFFER_DATA/<file>. */
export function resolveLedgerPath(args, env) {
  if (args.ledger) return args.ledger;
  if (env.GAFFER_USAGE_LEDGER) return env.GAFFER_USAGE_LEDGER;
  if (env.GAFFER_DATA) return join(env.GAFFER_DATA, LEDGER_FILENAME);
  return null;
}

function parseArgs(argv) {
  const out = { kind: null, ticket: null, ledger: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") out.kind = argv[++i];
    else if (a === "--ticket") out.ticket = argv[++i];
    else if (a === "--ledger") out.ledger = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  return [
    "Gaffer SPEND ESTIMATE — predict a ticket's TOKEN/TURN usage from history.",
    "",
    "Usage:",
    "  node bin/estimate-usage.mjs --kind <kind>",
    "  node bin/estimate-usage.mjs --ticket <n>",
    "",
    `  <kind> ∈ { ${[...VALID_KINDS].join(", ")} }`,
    "",
    "  --ledger <path>   override the ledger file",
    "                    (default: $GAFFER_USAGE_LEDGER, then $GAFFER_DATA/" +
      LEDGER_FILENAME +
      ")",
    "",
    "Reports TOKENS and TURNS only — never a cost figure. It is a PREDICTION from",
    "past calls, not a measurement; actuals may differ.",
  ].join("\n");
}

/** "1,234" — thousands separators for readability. */
function fmtInt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString("en-US");
}

/** One metric line: "  input tokens   ~1,200   (range 900–1,800)". */
function metricLine(label, band) {
  if (!band) return `  ${label.padEnd(14)} (no data)`;
  const med = fmtInt(band.median);
  const lo = fmtInt(band.low);
  const hi = fmtInt(band.high);
  return `  ${label.padEnd(14)} ~${med}   (range ${lo}–${hi})`;
}

function fmtDateRange(dateRange) {
  if (!dateRange) return "unknown date range";
  const first = dateRange.first.slice(0, 10);
  const last = dateRange.last.slice(0, 10);
  return first === last ? `on ${first}` : `${first} → ${last}`;
}

/**
 * Render the human-facing report. Returns a string. NEVER includes a $ or any
 * cost figure (honesty rule 1) — only tokens, turns, and the basis.
 */
export function renderReport(summary) {
  const { kind, n, enough, dateRange } = summary;
  if (!enough) {
    // Honesty rule 3: below threshold → NO numbers, just an honest notice.
    return (
      `not enough history to estimate yet (only ${n} measured ${kind} calls)\n` +
      `need at least ${MIN_SAMPLES}. ${fmtDateRange(dateRange)}.`
    );
  }
  const lines = [
    // Honesty rule 2: loud prediction label on every output.
    `ESTIMATE (tokens) — based on ${n} past ${kind} calls; actuals may differ`,
    `basis: N=${n} measured ${kind} calls, ${fmtDateRange(dateRange)}`,
    `(median with p${P_LOW}–p${P_HIGH} range; a PREDICTION, not a measurement)`,
    "",
    metricLine("input tokens", summary.inputTokens),
    metricLine("output tokens", summary.outputTokens),
    metricLine("turns", summary.turns),
  ];
  return lines.join("\n");
}

function readLedger(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const args = parseArgs(argv);
  if (args.help) {
    out.write(usage() + "\n");
    return 0;
  }

  if (args.kind == null && args.ticket == null) {
    err.write("error: provide --kind <kind> or --ticket <n>\n\n" + usage() + "\n");
    return 2;
  }

  const ledgerPath = resolveLedgerPath(args, env);
  if (!ledgerPath) {
    err.write(
      "error: no ledger path — set GAFFER_USAGE_LEDGER or GAFFER_DATA, or pass --ledger <path>\n",
    );
    return 2;
  }

  const records = parseLedger(readLedger(ledgerPath));

  // Resolve kind: explicit --kind wins; otherwise look the ticket up in history.
  let kind = args.kind;
  if (kind == null && args.ticket != null) {
    kind = resolveTicketKind(records, args.ticket);
    if (kind == null) {
      err.write(
        `error: ticket ${args.ticket} has no measured rows in the ledger — ` +
          "cannot resolve its kind. Pass --kind explicitly.\n",
      );
      return 2;
    }
    out.write(
      `(resolved ticket ${args.ticket} → kind '${kind}' from its latest measured ledger row)\n`,
    );
  }

  if (!VALID_KINDS.has(kind)) {
    err.write(`error: unknown kind '${kind}'. Expected one of: ${[...VALID_KINDS].join(", ")}\n`);
    return 2;
  }

  const measured = filterMeasured(records, kind);
  const summary = summarise(measured, kind);
  out.write(renderReport(summary) + "\n");
  return 0;
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  process.exit(main(process.argv.slice(2)));
}
