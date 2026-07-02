#!/usr/bin/env node
/**
 * Gaffer factory — PROVENANCE BUILD-LOG generator (pure core).
 *
 * The artifact that proves "this factory built itself, transparently." It walks
 * the factory's OWN delivery history (the done/merged tickets in Dispatch) and
 * renders a Markdown build-log: for each delivered ticket, its number + title,
 * the review outcome, a one-line evidence summary, and — joined from the usage
 * ledger ($GAFFER_USAGE_LEDGER, keyed by `ticket`) — its measured token usage.
 * Optional: any safety-hook blocks that fired during it ($GAFFER_DATA/
 * safety-blocks.jsonl, by ticket).
 *
 * This module is the PURE core: parsing + Markdown shaping, zero I/O side
 * effects. The CLI (bin/build-log.mjs) wires the stub-able accessors
 * (BUILDLOG_LIST_CMD / BUILDLOG_SHOW_CMD, mirroring run-summary.sh's
 * SUMMARY_LIST_CMD / SUMMARY_SHOW_CMD) and the ledger files to it, so the
 * generator is fully testable without the real `wg` CLI.
 *
 * HONESTY RULES (the entire point — enforced here, not just documented). These
 * mirror lib/usage-ledger.mjs:
 *   1. Only REAL recorded data. A ticket is reported as factory-delivered only
 *      because it appears in the done list — we never assert delivery otherwise.
 *   2. TOKENS verbatim — relayed exactly as the ledger recorded them.
 *   3. DOLLARS are RELAYED, never computed. If a cost is shown at all it is the
 *      ledger's own `total_cost_usd`, labelled "API-equivalent (Claude Code's
 *      own figure)". We never multiply tokens by a price table.
 *   4. A ticket with no measured usage row still appears (it WAS delivered),
 *      with `usage: unknown` — NEVER 0, never blank. Blank/0 would falsely
 *      imply the work was free.
 */

// JSONL→records parsing is delegated to lib/estimate.mjs's parseLedger — the
// single shared usage-ledger reader (same tolerant semantics: blank lines
// skipped, one corrupt line dropped rather than aborting the whole read).
import { parseLedger } from "./estimate.mjs";

export const UNKNOWN = "unknown";

/** API-equivalent cost label — the only place a $ figure may surface, relayed. */
export const COST_LABEL = "API-equivalent (Claude Code's own figure)";

/** Parse JSON tolerantly; return fallback on any failure (never throws). */
export function safeJsonParse(text, fallback) {
  if (typeof text !== "string" || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * A real, finite, non-negative-ish number, or null. We never coerce a
 * missing/garbage/"unknown" value to 0 — that would let unmeasured work read as
 * free (honesty rule 4). Booleans are rejected.
 */
function asNum(v) {
  if (typeof v === "number" && Number.isFinite(v) && !Number.isNaN(v)) return v;
  return null;
}

/**
 * Parse the done-ticket list JSON (output of `wg ticket list -s done`) into a
 * normalised array of { number, title }. Tolerant of an empty/garbage payload.
 */
export function parseTicketList(listJson) {
  const arr = Array.isArray(listJson) ? listJson : safeJsonParse(listJson, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      number: t.number ?? t.id ?? null,
      title: typeof t.title === "string" ? t.title : "",
    }))
    .filter((t) => t.number != null);
}

/**
 * Pull the review outcome from a `wg ticket show` payload. A delivered ticket
 * surfaced from the done list is, by definition, merged/approved — but we still
 * report the RECORDED outcome rather than asserting one. We look (in order) at an
 * explicit ticket.review/outcome/resolution field, then scan evidence/events for
 * an approval/merge signal, falling back to the ticket's state.
 */
export function extractReviewOutcome(showJson) {
  const d = typeof showJson === "string" ? safeJsonParse(showJson, {}) : showJson || {};
  const ticket =
    (d && typeof d === "object" && d.ticket && typeof d.ticket === "object" ? d.ticket : d) || {};

  // 1. Explicit recorded outcome on the ticket.
  for (const key of ["review_outcome", "reviewOutcome", "resolution", "review", "outcome"]) {
    const v = ticket[key] ?? (d && d[key]);
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  // 2. Scan evidence + events for an approval / merge signal.
  const blobs = [];
  for (const e of evidenceEntries(d)) blobs.push(evidenceText(e));
  for (const e of eventEntries(d)) blobs.push(eventText(e));
  const hay = blobs.join(" \n ").toLowerCase();
  if (/\bapproved\b|review approve|human approval|approved by/.test(hay)) return "approved";
  if (/\bmerged\b|auto[_-]?merge|gaffer_auto_merge|landed/.test(hay)) return "merged";

  // 3. Fall back to the ticket's recorded state, else "done" (it's in the done list).
  const state = ticket.state ?? ticket.status ?? d.state ?? d.status;
  if (typeof state === "string" && state.trim()) return state.trim();
  return "done";
}

function evidenceEntries(d) {
  return Array.isArray(d && d.evidence) ? d.evidence.filter((e) => e && typeof e === "object") : [];
}
function eventEntries(d) {
  return Array.isArray(d && d.events) ? d.events.filter((e) => e && typeof e === "object") : [];
}
function evidenceText(e) {
  // Includes `type` so the review-outcome keyword scan can see e.g. "diff_summary".
  return [e.summary, e.description, e.type]
    .map((x) => (typeof x === "string" ? x : ""))
    .join(" ")
    .trim();
}
/** Human-readable evidence text for DISPLAY — summary/description only, no type tag. */
function evidenceDisplayText(e) {
  return [e.summary, e.description]
    .map((x) => (typeof x === "string" ? x : ""))
    .join(" ")
    .trim();
}
function eventText(e) {
  return [e.summary, e.reason, e.payload]
    .map((x) => (typeof x === "string" ? x : ""))
    .join(" ")
    .trim();
}

/**
 * A single-line evidence summary for the ticket: the first substantive evidence
 * entry (preferring a diff_summary, then any evidence, then an event). Collapsed
 * to one line and trimmed. Empty string when nothing was recorded.
 */
export function extractEvidenceSummary(showJson, maxLen = 160) {
  const d = typeof showJson === "string" ? safeJsonParse(showJson, {}) : showJson || {};
  const evidence = evidenceEntries(d);

  // Prefer a diff_summary (the delivery artifact), else first non-empty evidence.
  const preferred =
    evidence.find(
      (e) =>
        String(e.type || "")
          .toLowerCase()
          .includes("diff") && evidenceDisplayText(e),
    ) || evidence.find((e) => evidenceDisplayText(e));
  let text = preferred ? evidenceDisplayText(preferred) : "";

  if (!text) {
    const ev = eventEntries(d).find((e) => eventText(e));
    text = ev ? eventText(ev) : "";
  }

  return collapseLine(text, maxLen);
}

/** Collapse whitespace/newlines to a single trimmed line, capped at maxLen. */
function collapseLine(text, maxLen) {
  const oneLine = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

/**
 * Index a usage-ledger JSONL string by ticket number. Each line is a record from
 * lib/usage-ledger.mjs. When a ticket has multiple measured rows (e.g. clarify +
 * delivery) we MERGE: tokens summed, costs summed, kinds collected. A row that is
 * not `measured:true` contributes NO numbers (honesty rule 4) — but if a ticket
 * has ONLY unknown rows it still ends up `measured:false` so it can render
 * "unknown" rather than be dropped.
 *
 * Returns Map<ticketKey, {measured, tokens:{in,out,cache_read,cache_create},
 *   cost_usd: number|null, kinds: string[]}>.
 */
export function indexUsageByTicket(ledgerText) {
  const byTicket = new Map();

  for (const rec of parseLedger(ledgerText)) {
    if (rec.ticket == null) continue;
    const key = String(rec.ticket);

    let agg = byTicket.get(key);
    if (!agg) {
      agg = {
        measured: false,
        tokens: { in: 0, out: 0, cache_read: 0, cache_create: 0 },
        cost_usd: null,
        kinds: [],
      };
      byTicket.set(key, agg);
    }

    if (typeof rec.kind === "string" && rec.kind && !agg.kinds.includes(rec.kind)) {
      agg.kinds.push(rec.kind);
    }

    // Unknown rows contribute NO numbers.
    if (rec.measured !== true) continue;
    agg.measured = true;

    // Tokens: verbatim, summed across the ticket's measured rows.
    const models = rec.models;
    if (models && typeof models === "object" && !Array.isArray(models) && models !== UNKNOWN) {
      for (const mu of Object.values(models)) {
        if (!mu || typeof mu !== "object") continue;
        addNum(agg.tokens, "in", asNum(mu.input));
        addNum(agg.tokens, "out", asNum(mu.output));
        addNum(agg.tokens, "cache_read", asNum(mu.cache_read));
        addNum(agg.tokens, "cache_create", asNum(mu.cache_create));
      }
    }

    // Cost: RELAYED from the ledger's own total_cost_usd — never computed.
    const c = asNum(rec.total_cost_usd);
    if (c !== null) agg.cost_usd = (agg.cost_usd ?? 0) + c;
  }

  return byTicket;
}

function addNum(obj, key, v) {
  if (v !== null) obj[key] += v;
}

/**
 * Index a safety-blocks JSONL string by ticket number → array of category
 * strings (in recorded order). Mirrors run-summary.sh's safety section; used to
 * optionally note which deterministic hook blocks fired during a ticket.
 */
export function indexBlocksByTicket(blocksText) {
  const byTicket = new Map();
  // Same JSONL shape as the usage ledger — reuse the shared reader.
  for (const rec of parseLedger(blocksText)) {
    if (rec.ticket == null) continue;
    const key = String(rec.ticket);
    const cat = typeof rec.category === "string" && rec.category ? rec.category : "other";
    const list = byTicket.get(key) || [];
    list.push(cat);
    byTicket.set(key, list);
  }
  return byTicket;
}

/** Render a usage Map entry as a one-line Markdown string. */
function renderUsage(usage) {
  if (!usage || usage.measured !== true) return UNKNOWN;
  const t = usage.tokens;
  const tokensPart = `in=${t.in} out=${t.out} cache_read=${t.cache_read} cache_create=${t.cache_create}`;
  // Cost: ONLY if the ledger relayed one. Labelled, never computed. No row → omit
  // (we never print "$0").
  if (usage.cost_usd !== null) {
    return `${tokensPart} — ${COST_LABEL}: $${usage.cost_usd.toFixed(4)}`;
  }
  return tokensPart;
}

/** Escape a value for safe inclusion in a Markdown table cell. */
function mdCell(text) {
  return String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

/**
 * Build a per-ticket provenance row from the raw show payload + the joined usage
 * and blocks indexes. Pure: no I/O. Returns a structured row the renderer turns
 * into Markdown (also handy for tests asserting on shape).
 */
export function buildTicketRow({ number, title, showJson, usageByTicket, blocksByTicket }) {
  const key = String(number);
  const usage = usageByTicket instanceof Map ? usageByTicket.get(key) : undefined;
  const blocks = blocksByTicket instanceof Map ? blocksByTicket.get(key) : undefined;
  return {
    number,
    title: title || (extractTitleFromShow(showJson) ?? ""),
    review: extractReviewOutcome(showJson),
    evidence: extractEvidenceSummary(showJson),
    usage: renderUsage(usage),
    measured: !!(usage && usage.measured === true),
    blocks: Array.isArray(blocks) ? blocks.slice() : [],
  };
}

function extractTitleFromShow(showJson) {
  const d = typeof showJson === "string" ? safeJsonParse(showJson, {}) : showJson || {};
  const ticket = d && d.ticket && typeof d.ticket === "object" ? d.ticket : d;
  return ticket && typeof ticket.title === "string" ? ticket.title : null;
}

/**
 * Render the full Markdown build-log from the assembled rows. Honesty rules are
 * structural here: every delivered ticket is a row; usage is "unknown" when
 * unmeasured; cost only appears with its API-equivalent label.
 */
export function renderBuildLog(rows, { generatedAt } = {}) {
  const ts = generatedAt || new Date().toISOString();
  const lines = [];
  lines.push("# Gaffer factory — provenance build-log");
  lines.push("");
  lines.push("> This factory built itself, transparently. Every row below is a ticket the");
  lines.push("> factory actually delivered (it appears in Dispatch's `done` list). Token");
  lines.push("> usage is relayed verbatim from the usage ledger; where a ticket has no");
  lines.push("> measured usage row it shows `unknown` (NOT zero — the work was not free,");
  lines.push("> it was simply unmeasured). Any dollar figure is relayed from Claude Code's");
  lines.push(`> own number, labelled "${COST_LABEL}" — never computed from a price table.`);
  lines.push("");
  lines.push(`_Generated ${ts} from the factory's own delivery history._`);
  lines.push("");

  if (rows.length === 0) {
    lines.push("_No delivered tickets recorded yet._");
    lines.push("");
    return lines.join("\n");
  }

  const measuredCount = rows.filter((r) => r.measured).length;
  const unknownCount = rows.length - measuredCount;
  lines.push(
    `**${rows.length} delivered ticket(s)** — ${measuredCount} with measured usage, ` +
      `${unknownCount} unknown (\`unknown\` = unmeasured, never \`$0\`).`,
  );
  lines.push("");

  lines.push("| Ticket | Title | Review | Evidence | Usage |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| #${mdCell(r.number)} | ${mdCell(r.title)} | ${mdCell(r.review)} | ` +
        `${mdCell(r.evidence) || "_(none recorded)_"} | ${mdCell(r.usage)} |`,
    );
  }
  lines.push("");

  // Optional safety section: per-ticket deterministic hook blocks, if any fired.
  const ticketsWithBlocks = rows.filter((r) => r.blocks && r.blocks.length > 0);
  if (ticketsWithBlocks.length > 0) {
    lines.push("## Safety-hook blocks during delivery");
    lines.push("");
    lines.push("The deterministic PreToolUse hook stopped these risky tool calls. The trust");
    lines.push(
      'signal is not "nothing happened" — it is "the agent tried, and every one was stopped".',
    );
    lines.push("");
    for (const r of ticketsWithBlocks) {
      const counts = countCategories(r.blocks);
      const summary = Object.entries(counts)
        .map(([cat, n]) => `${cat}×${n}`)
        .join(", ");
      lines.push(`- **#${mdCell(r.number)}** ${mdCell(r.title)} — ${summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function countCategories(cats) {
  const out = {};
  for (const c of cats) out[c] = (out[c] || 0) + 1;
  return out;
}

/**
 * Assemble rows from already-fetched per-ticket show payloads. Pure orchestrator
 * the CLI uses after running the (stub-able) accessors. `shows` is a Map or
 * object keyed by ticket number → show JSON (string or object).
 */
export function assembleRows({ tickets, shows, usageByTicket, blocksByTicket }) {
  const getShow = (number) => {
    if (shows instanceof Map) return shows.get(String(number)) ?? shows.get(number);
    if (shows && typeof shows === "object") return shows[String(number)] ?? shows[number];
    return undefined;
  };
  return tickets.map((t) =>
    buildTicketRow({
      number: t.number,
      title: t.title,
      showJson: getShow(t.number),
      usageByTicket,
      blocksByTicket,
    }),
  );
}
