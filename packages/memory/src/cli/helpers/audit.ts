/**
 * Audit-log rendering helpers — shared by `cmdAudit` and any future
 * consumer that needs to format JSONL audit rows for human display.
 */

/**
 * Render a single audit JSONL row as a short, redacted one-liner.
 * Falls back to the raw line if it can't be parsed — never throws.
 */
export function formatAuditLine(line: string): string {
  let row: {
    ts?: string;
    tool?: string;
    request?: Record<string, unknown>;
    resultCount?: number;
    resultIds?: string[];
    error?: string;
    blocked?: string;
  };
  try {
    row = JSON.parse(line);
  } catch {
    return line;
  }
  const ts = (row.ts ?? "").replace(/\.\d+Z$/, "Z");
  const tool = row.tool ?? "?";
  const req = row.request ?? {};
  const reqBits: string[] = [];
  if (tool === "search_lore") {
    if (typeof req["query"] === "string") {
      reqBits.push(`q="${redactQuery(req["query"] as string)}"`);
    }
    if (req["repo"]) reqBits.push(`repo=${String(req["repo"])}`);
    if (req["tag"]) reqBits.push(`tag=${String(req["tag"])}`);
    if (req["includeRestricted"]) reqBits.push("+restricted");
    if (req["includeDrafts"]) reqBits.push("+drafts");
  } else if (tool === "suggest_lore") {
    if (typeof req["title"] === "string") {
      reqBits.push(`title="${redactTitle(req["title"] as string)}"`);
    }
    if (typeof req["bodyChars"] === "number") {
      reqBits.push(`bodyChars=${req["bodyChars"]}`);
    }
    if (req["source"]) reqBits.push(`source=${String(req["source"])}`);
    if (req["confidence"]) reqBits.push(`conf=${String(req["confidence"])}`);
  } else if (tool === "get_lore") {
    if (req["id"]) reqBits.push(`id=${String(req["id"])}`);
  } else {
    // Unknown tool — show keys, not values.
    for (const k of Object.keys(req)) reqBits.push(k);
  }
  const result = row.error
    ? `→ ERR: ${row.error}`
    : row.blocked
      ? `→ BLOCKED: ${row.blocked}`
      : row.resultCount !== undefined
        ? `→ ${row.resultCount} hit${row.resultCount === 1 ? "" : "s"}`
        : "";
  return `${ts}  ${tool}  ${reqBits.join(" ")}  ${result}`.trim();
}

/** Truncate long search queries to keep the audit display tidy + privacy-respecting. */
export function redactQuery(q: string): string {
  if (q.length <= 60) return q;
  return q.slice(0, 57) + "…";
}

/** Same for titles. */
export function redactTitle(t: string): string {
  if (t.length <= 50) return t;
  return t.slice(0, 47) + "…";
}
