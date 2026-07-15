import type { Lore, LoreSummary } from "../db/types.js";

/**
 * Tiny ANSI helpers — no chalk dep. We use these for the human CLI; the
 * MCP server never emits ANSI.
 */
const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
};

function colour(useColour: boolean, code: string, s: string): string {
  return useColour ? `${code}${s}${ansi.reset}` : s;
}

function useColour(): boolean {
  if (process.env["NO_COLOR"]) return false;
  if (process.env["MEMORY_NO_COLOR"]) return false;
  return process.stdout.isTTY === true;
}

function statusColour(status: string): string {
  switch (status) {
    case "draft":
      return ansi.yellow;
    case "active":
      return ansi.green;
    case "deprecated":
      return ansi.grey;
    case "superseded":
      return ansi.grey;
    default:
      return ansi.reset;
  }
}

function confidenceColour(conf: string): string {
  switch (conf) {
    case "high":
      return ansi.green;
    case "medium":
      return ansi.cyan;
    case "low":
      return ansi.grey;
    default:
      return ansi.reset;
  }
}

/** Render one search hit as a 3-line block. */
export function renderSummary(s: LoreSummary): string {
  const c = useColour();
  const header = [colour(c, ansi.bold, s.title), colour(c, ansi.grey, `(${s.id})`)].join(" ");
  const meta = [
    colour(c, statusColour(s.status), `[${s.status}]`),
    colour(c, confidenceColour(s.confidence), `conf=${s.confidence}`),
    s.stale ? colour(c, ansi.red, "⚠ stale") : null,
    s.flaggedForReview ? colour(c, ansi.yellow, "⚑ flagged") : null,
    s.restricted ? colour(c, ansi.red, "🔒 restricted") : null,
    s.possibleConflicts && s.possibleConflicts.length > 0
      ? colour(c, ansi.red, `⚠ possibly conflicts with ${s.possibleConflicts.join(", ")}`)
      : null,
    s.conflictsWith && s.conflictsWith.length > 0
      ? colour(c, ansi.magenta, `⚠ counter-claims: ${s.conflictsWith.length}`)
      : null,
    s.source ? colour(c, ansi.blue, s.source) : null,
    s.repos.length ? colour(c, ansi.dim, `repos=${s.repos.join(",")}`) : null,
    s.tags.length ? colour(c, ansi.dim, `tags=${s.tags.join(",")}`) : null,
  ]
    .filter(Boolean)
    .join("  ");
  return `${header}\n  ${s.summary}\n  ${meta}`;
}

/** Render the full lore (used by `memory show`). */
export function renderFull(l: Lore): string {
  const c = useColour();
  const lines: string[] = [];
  lines.push(colour(c, ansi.bold, l.title));
  lines.push(colour(c, ansi.grey, l.id));
  const meta = [
    colour(c, statusColour(l.status), `[${l.status}]`),
    colour(c, confidenceColour(l.confidence), `conf=${l.confidence}`),
    l.restricted ? colour(c, ansi.red, "🔒 restricted") : null,
  ]
    .filter(Boolean)
    .join("  ");
  lines.push(meta);
  if (l.source) lines.push(`source: ${colour(c, ansi.blue, l.source)}`);
  if (l.author) lines.push(`author: ${l.author}`);
  if (l.team) lines.push(`team:   ${l.team}`);
  if (l.repos.length) lines.push(`repos:  ${l.repos.join(", ")}`);
  if (l.tags.length) lines.push(`tags:   ${l.tags.join(", ")}`);
  lines.push(`created: ${l.createdAt}`);
  lines.push(`updated: ${l.updatedAt}`);
  if (l.lastVerifiedAt) lines.push(`verified: ${l.lastVerifiedAt}`);
  if (l.reviewAfter) {
    const stale = new Date(l.reviewAfter).getTime() < Date.now();
    lines.push(`reviewAfter: ${l.reviewAfter}${stale ? colour(c, ansi.red, " ⚠ stale") : ""}`);
  }
  if (l.supersededBy) {
    lines.push(colour(c, ansi.yellow, `superseded by: ${l.supersededBy}`));
  }
  if (l.conflictsWith && l.conflictsWith.length > 0) {
    lines.push(colour(c, ansi.magenta, `conflicts with: ${l.conflictsWith.join(", ")}`));
  }
  lines.push("");
  lines.push(colour(c, ansi.dim, "summary:"));
  lines.push(l.summary);
  lines.push("");
  lines.push(colour(c, ansi.dim, "body:"));
  lines.push(l.body);
  return lines.join("\n");
}
