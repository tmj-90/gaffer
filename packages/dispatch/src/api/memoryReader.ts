import { spawnSync } from "node:child_process";

/**
 * Server-side reader for the MEMORY product (memory-mcp).
 *
 * The unified control room serves ONE origin: the SPA hits the Dispatch API for
 * everything, including the new Memory surfaces (Repo Digest + Feature ledger +
 * Lore). The memory data lives in a SEPARATE product, readable only through its
 * CLI's read verbs. Rather than stand up a second server, this module spawns the
 * configured memory CLI *server-side* and parses its text output, so the browser
 * never talks to the memory store directly.
 *
 * Layout-agnostic invocation (mirrors the gaffer factory's `lg` helper — see
 * lib/feature-digest.mjs / bin/merge-ticket.mjs in runner): the CLI binary
 * comes from {@link MEMORY_CLI_BIN_ENV}, the DB from {@link MEMORY_DB_ENV},
 * and the DB is passed via the env var (NO `--db` flag — that is the memory CLI's
 * bin contract). The read verbs are:
 *
 *   memory digest <repo>
 *   memory features <repo> [--status …] [--node …]
 *   memory list
 *
 * GRACEFUL DEGRADATION (the load-bearing contract): the memory product is
 * OPTIONAL. When it is not configured, not built, or errors, every read returns a
 * structured `available:false` result with a human reason — it NEVER throws and
 * NEVER turns into a 500 that breaks the dashboard. The Memory views render a
 * clean "memory unavailable" state from that result.
 */

/** Env var holding the path to the memory CLI binary (e.g. dist/bin/memory.js). */
export const MEMORY_CLI_BIN_ENV = "MEMORY_CLI_BIN";

/** Env var holding the path to the memory SQLite DB (passed via env, no `--db`). */
export const MEMORY_DB_ENV = "MEMORY_DB";

/** Wall-clock cap on a single memory CLI read (a local SQLite read is fast). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Cap captured stdout so a runaway CLI can't exhaust memory. */
const MAX_OUTPUT_BYTES = 4_000_000;

/** A digest section's freshness + provenance line. */
export interface DigestMeta {
  readonly updatedAt: string | null;
  readonly source: string | null;
}

/** A parsed repo understanding digest (the four prose sections + freshness). */
export interface RepoDigest {
  readonly repo: string;
  readonly overview: string;
  readonly structure: string;
  readonly conventions: string;
  readonly stack: string;
  readonly meta: DigestMeta;
  /** The honesty caveat the CLI prints — surfaced verbatim in the UI. */
  readonly caveat: string;
}

/** One feature ledger entry. */
export interface MemoryFeature {
  readonly status: "backlog" | "building" | "shipped";
  readonly name: string;
  readonly summary: string;
  readonly id: string | null;
  readonly scopeNode: string | null;
  readonly area: string | null;
  readonly provenance: string | null;
}

/** One lore record summary (from `memory list`). */
export interface LoreSummary {
  readonly id: string | null;
  readonly title: string;
  readonly summary: string;
  readonly status: string | null;
  readonly confidence: string | null;
  readonly source: string | null;
  readonly repos: readonly string[];
  readonly tags: readonly string[];
  readonly stale: boolean;
  /**
   * Recall-feedback signal: true when the learn loop has flagged this record
   * for human review (served into a ticket that then reworked/blocked). The
   * Memory view badges these and links to the CLI review gate.
   */
  readonly flagged: boolean;
  /** Product-intent classifier (decision / requirement / non-goal / convention / gotcha / other). Only the JSON list verb carries it. */
  readonly kind?: string;
}

/** One calendar-day (UTC) recall-outcome roll-up, from `memory recall-stats`. */
export interface RecallDayStat {
  readonly date: string;
  readonly clean: number;
  readonly reworked: number;
  readonly blocked: number;
  readonly total: number;
  readonly effectiveness_pct: number;
}

/**
 * Recall-effectiveness roll-up: of the knowledge Memory served into tickets, how
 * often did it lead to a CLEAN outcome vs rework/block, overall and per-day. The
 * Factory Health surface reads this for its recall trend.
 */
export interface RecallEffectiveness {
  readonly total: number;
  readonly clean: number;
  readonly reworked: number;
  readonly blocked: number;
  /** clean/total as a 0–100 number, or null when nothing has been recorded. */
  readonly effectiveness_pct: number | null;
  readonly items_adjusted: number;
  readonly by_day: readonly RecallDayStat[];
  readonly last_applied_at: string | null;
}

/** A read that may be unavailable. `T` carries the parsed payload when present. */
export type MemoryResult<T> = ({ available: true } & T) | { available: false; reason: string };

export interface MemoryReader {
  digest(repo: string): MemoryResult<{ digest: RepoDigest | null }>;
  features(
    repo: string,
    opts?: { status?: string; node?: string },
  ): MemoryResult<{ features: MemoryFeature[] }>;
  lore(): MemoryResult<{ lore: LoreSummary[] }>;
  /**
   * Recall-effectiveness trend for the Health surface. Best-effort like every
   * other read: `{ available:false, reason }` when Memory isn't wired / errors.
   */
  recallEffectiveness(opts?: { repo?: string }): MemoryResult<{ recall: RecallEffectiveness }>;
  /**
   * File a lore DRAFT via the memory CLI `suggest` (the ONLY write dispatch does to
   * memory — and it's not a DB write: `suggest` lands the record in the memory review
   * queue as a DRAFT that a human must approve; dispatch never touches the memory DB).
   * Used to capture a human's review-rejection reason so the highest-signal correction
   * compounds into durable memory. Best-effort — a memory outage must NEVER block the
   * rejection that triggered it.
   */
  captureLoreDraft(input: {
    title: string;
    summary: string;
    repo?: string;
    tags?: string[];
  }): MemoryResult<{ id: string | null }>;
  /**
   * Browse lore by lifecycle status / repo / kind with pagination — the dashboard's
   * ratification read (`memory list --json …`). Unlike {@link MemoryReader.lore}
   * (the 50 freshest records, text-parsed) this can ask for ONLY drafts, per repo,
   * and page through them. Same graceful degradation as every other read.
   */
  listLore(opts?: LoreListOptions): MemoryResult<LoreListPage>;
  /**
   * Ratify a draft: `memory approve <id>` promotes it to `active`. Dispatch never
   * touches the memory DB — the CLI is the write boundary, exactly as for
   * {@link MemoryReader.captureLoreDraft}. A non-draft / unknown id is reported as
   * `{ available:false, reason }` carrying the CLI's own message.
   */
  approveLore(id: string): MemoryResult<{ id: string; status: "active" }>;
  /** Drop a draft: `memory reject <id> [--reason …]`. Same contract as approveLore. */
  rejectLore(id: string, reason?: string): MemoryResult<{ id: string; status: "rejected" }>;
}

/** Filters + page for {@link MemoryReader.listLore}. */
export interface LoreListOptions {
  readonly repo?: string;
  readonly status?: readonly string[];
  readonly kind?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

/** One page of lore records (the `memory list --json` shape, normalised). */
export interface LoreListPage {
  readonly lore: LoreSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Memory lore ids are 8 chars of the `a-z2-9` alphabet; refuse anything else early. */
export const LORE_ID_RE = /^[a-z2-9]{8}$/;

/** Build the structured "memory unavailable" result every failure path returns. */
function unavailable<T>(reason: string): MemoryResult<T> {
  return { available: false, reason };
}

interface CliOutcome {
  ok: boolean;
  stdout: string;
  reason: string;
}

/**
 * Run the memory CLI with the given verb args, best-effort. The DB rides in the
 * child env (no `--db` flag — the memory CLI's bin contract); colour is disabled
 * (NO_COLOR + MEMORY_NO_COLOR) so the parsers see plain text. Never throws —
 * any spawn/timeout/non-zero exit collapses to `{ ok:false, reason }`.
 */
function runCli(env: NodeJS.ProcessEnv, args: string[]): CliOutcome {
  const bin = (env[MEMORY_CLI_BIN_ENV] ?? "").trim();
  if (bin === "") {
    return {
      ok: false,
      stdout: "",
      reason: `Memory is not configured — set ${MEMORY_CLI_BIN_ENV} (and ${MEMORY_DB_ENV}) to the memory CLI to enable the Memory surfaces.`,
    };
  }
  const db = (env[MEMORY_DB_ENV] ?? "").trim();
  // Strip Dispatch's own bearer token from the child env (defence-in-depth,
  // mirroring the merge/product-owner runners) and disable CLI colour so the
  // text parsers see plain output regardless of the inherited TTY state.
  const { DISPATCH_API_TOKEN: _omitToken, ...rest } = env;
  void _omitToken;
  const childEnv: NodeJS.ProcessEnv = {
    ...rest,
    NO_COLOR: "1",
    MEMORY_NO_COLOR: "1",
    ...(db !== "" ? { [MEMORY_DB_ENV]: db } : {}),
  };

  let res;
  try {
    // No shell: argv is [execPath, bin, ...args]; `repo`/filter values are
    // discrete argv elements, never interpolated into a command line.
    res = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: childEnv,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      reason: `Memory CLI failed to run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.error) {
    return {
      ok: false,
      stdout: "",
      reason: `Memory CLI failed to run: ${res.error.message}`,
    };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").toString().trim();
    return {
      ok: false,
      stdout: res.stdout ?? "",
      reason:
        stderr !== ""
          ? `Memory CLI exited ${res.status ?? "?"}: ${stderr}`
          : `Memory CLI exited ${res.status ?? "?"}.`,
    };
  }
  return { ok: true, stdout: res.stdout ?? "", reason: "" };
}

// --- Parsers ---------------------------------------------------------------

/**
 * Parse `memory digest <repo>` output. The "no digest yet" message is a
 * SUCCESS with a null digest (the repo simply hasn't been onboarded), distinct
 * from the memory product being unavailable. Returns null when no digest exists.
 */
export function parseDigest(repo: string, stdout: string): RepoDigest | null {
  const text = stdout.replace(/\r\n/g, "\n");
  if (!/^Repo digest:/m.test(text)) return null;

  // Section bodies are the indented lines under each ALL-CAPS header, captured up
  // to the NEXT header / the freshness line / the NOTE caveat / EOF. The `\n` (no
  // `m` flag) anchors avoid `$` matching at every line end, which would clip
  // multi-line sections to their first line.
  const HEADERS = ["OVERVIEW", "STRUCTURE", "CONVENTIONS", "STACK"];
  const section = (name: string): string => {
    const re = new RegExp(
      `\\n${name}\\n([\\s\\S]*?)(?=\\n(?:${HEADERS.join("|")})\\n|\\nupdated_at:|\\nNOTE:|$)`,
    );
    const m = re.exec(text);
    if (!m) return "";
    return m[1]!
      .split("\n")
      .map((l) => l.replace(/^ {2}/, "").trimEnd())
      .join("\n")
      .trim();
  };

  const fresh = /^updated_at:\s*(.*?)\s*·\s*source:\s*(.*)$/m.exec(text);
  const note = /^NOTE:\s*(.*)$/m.exec(text);

  return {
    repo,
    overview: section("OVERVIEW"),
    structure: section("STRUCTURE"),
    conventions: section("CONVENTIONS"),
    stack: section("STACK"),
    meta: {
      updatedAt: fresh ? fresh[1]!.trim() || null : null,
      source: fresh ? fresh[2]!.trim() || null : null,
    },
    caveat: note ? note[1]!.trim() : "",
  };
}

/**
 * Parse `memory features <repo>` output into a flat ledger array. The CLI
 * groups by `STATUS (n)` headers, each followed by feature blocks rendered as:
 *
 *   [status] name  @scopeNode  (area)  (id)
 *       summary
 *       provenance: <p>          (optional)
 *
 * The "no features" message is a SUCCESS with an empty array (nothing shipped /
 * backlogged yet), not an unavailable memory product.
 */
export function parseFeatures(stdout: string): MemoryFeature[] {
  const text = stdout.replace(/\r\n/g, "\n");
  if (/^memory: no features/m.test(text)) return [];

  const lines = text.split("\n");
  const features: MemoryFeature[] = [];
  let cur: { feature: MemoryFeature; mutableSummary: string } | null = null;

  const flush = (): void => {
    if (cur) {
      features.push({ ...cur.feature, summary: cur.mutableSummary.trim() });
      cur = null;
    }
  };

  const headRe =
    /^ {2}\[(backlog|building|shipped)\]\s+(.+?)\s*(?:\(([^()]*)\))?\s*\(([^()]+)\)\s*$/;

  for (const line of lines) {
    const head = headRe.exec(line);
    if (head) {
      flush();
      // The name portion may carry a trailing `@scopeNode` chip; split it off.
      let name = head[2]!.trim();
      let scopeNode: string | null = null;
      const at = /\s+@(\S+)$/.exec(name);
      if (at) {
        scopeNode = at[1]!;
        name = name.slice(0, at.index).trim();
      }
      cur = {
        feature: {
          status: head[1] as MemoryFeature["status"],
          name,
          summary: "",
          id: (head[4] ?? "").trim() || null,
          scopeNode,
          area: (head[3] ?? "").trim() || null,
          provenance: null,
        },
        mutableSummary: "",
      };
      continue;
    }
    if (!cur) continue;
    const prov = /^ {6}provenance:\s*(.*)$/.exec(line);
    if (prov) {
      cur = { ...cur, feature: { ...cur.feature, provenance: prov[1]!.trim() || null } };
      continue;
    }
    const body = /^ {6}(.*)$/.exec(line);
    if (body) {
      cur.mutableSummary = cur.mutableSummary
        ? `${cur.mutableSummary} ${body[1]!.trim()}`
        : body[1]!.trim();
    }
  }
  flush();
  return features;
}

/**
 * Parse `memory list` output. Each record is a 3-line block:
 *
 *   <title> (<id>)
 *     <summary>
 *     [status]  conf=<c>  ⚠ stale?  <source>?  repos=a,b?  tags=x,y?
 *
 * Blocks are separated by a blank line. The "nothing here yet" message yields an
 * empty array (no lore recorded), still a SUCCESS.
 */
export function parseLore(stdout: string): LoreSummary[] {
  const text = stdout.replace(/\r\n/g, "\n");
  if (/^memory: nothing here yet/m.test(text)) return [];

  const out: LoreSummary[] = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split("\n").filter((l) => l.trim() !== "");
    if (rows.length < 2) continue;
    const headerLine = rows[0]!;
    const idMatch = /\(([^()]+)\)\s*$/.exec(headerLine);
    const title = idMatch ? headerLine.slice(0, idMatch.index).trim() : headerLine.trim();
    const id = idMatch ? idMatch[1]!.trim() : null;
    if (title === "") continue;
    const summary = rows[1]!.trim();
    const meta = rows[2] ? rows[2].trim() : "";

    const statusM = /\[([^\]]+)\]/.exec(meta);
    const confM = /conf=(\S+)/.exec(meta);
    const sourceM = /(?:^|\s)source=(\S+)/.exec(meta);
    const reposM = /repos=(\S+)/.exec(meta);
    const tagsM = /tags=(\S+)/.exec(meta);

    out.push({
      id,
      title,
      summary,
      status: statusM ? statusM[1]! : null,
      confidence: confM ? confM[1]! : null,
      source: sourceM ? sourceM[1]! : null,
      repos: reposM ? reposM[1]!.split(",").filter(Boolean) : [],
      tags: tagsM ? tagsM[1]!.split(",").filter(Boolean) : [],
      stale: /stale/.test(meta),
      // The learn loop's per-record recall signal — the memory CLI prints a
      // "⚑ flagged" marker when a record was served into a reworked/blocked
      // ticket. Match the glyph so a tag literally named "flagged" can't trip it.
      flagged: /⚑\s*flagged/.test(meta),
    });
  }
  return out;
}

/** Coerce a raw value to a finite number, or 0. */
function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse `memory recall-stats --json` output. Unlike the other read verbs this one
 * emits JSON, so parsing is a defensive `JSON.parse` + coercion — a malformed
 * payload yields a zero-state (null effectiveness) rather than throwing.
 */
export function parseRecallStats(stdout: string): RecallEffectiveness {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || "{}");
  } catch {
    raw = {};
  }
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const by_day: RecallDayStat[] = Array.isArray(p.by_day)
    ? p.by_day
        .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
        .filter((d) => typeof d.date === "string")
        .map((d) => ({
          date: d.date as string,
          clean: numOr0(d.clean),
          reworked: numOr0(d.reworked),
          blocked: numOr0(d.blocked),
          total: numOr0(d.total),
          effectiveness_pct: numOr0(d.effectiveness_pct),
        }))
    : [];

  return {
    total: numOr0(p.total),
    clean: numOr0(p.clean),
    reworked: numOr0(p.reworked),
    blocked: numOr0(p.blocked),
    effectiveness_pct:
      typeof p.effectiveness_pct === "number" && Number.isFinite(p.effectiveness_pct)
        ? p.effectiveness_pct
        : null,
    items_adjusted: numOr0(p.items_adjusted),
    by_day,
    last_applied_at: typeof p.last_applied_at === "string" ? p.last_applied_at : null,
  };
}

/**
 * Parse `memory list --json` output: ONE object `{ total, limit, offset, items }`.
 * Each item is normalised onto the {@link LoreSummary} shape the Memory view already
 * renders (plus `kind`), so a record looks the same whichever verb produced it.
 * Malformed output (an older CLI printing prose, truncated JSON) returns null so the
 * caller can degrade to `{ available:false }` instead of throwing.
 */
export function parseLoreJson(stdout: string): LoreListPage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const lore: LoreSummary[] = (p.items as unknown[])
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      id: str(it.id),
      title: str(it.title) ?? "",
      summary: str(it.summary) ?? "",
      status: str(it.status),
      confidence: str(it.confidence),
      source: str(it.source),
      repos: strs(it.repos),
      tags: strs(it.tags),
      stale: it.stale === true,
      flagged: it.flaggedForReview === true || it.flagged === true,
      ...(str(it.kind) !== null ? { kind: str(it.kind) as string } : {}),
    }))
    .filter((l) => l.title !== "");
  return {
    lore,
    total: numOr0(p.total),
    limit: numOr0(p.limit),
    offset: numOr0(p.offset),
  };
}

/**
 * Build the default memory reader. It spawns the configured memory CLI for each
 * read verb and parses the text output. Every method degrades gracefully — a
 * missing/unbuilt/erroring memory product yields `{ available:false, reason }`,
 * never a throw.
 */
export function createMemoryReader(env: NodeJS.ProcessEnv = process.env): MemoryReader {
  return {
    listLore(opts = {}) {
      const args = ["list", "--json"];
      const repo = (opts.repo ?? "").trim();
      if (repo !== "") args.push("--repo", repo);
      // Repeatable flags, one value each — never a joined string the CLI would have
      // to split, so a value can't smuggle a second flag.
      for (const s of opts.status ?? []) {
        const v = String(s).trim();
        if (v !== "") args.push("--status", v);
      }
      for (const k of opts.kind ?? []) {
        const v = String(k).trim();
        if (v !== "") args.push("--kind", v);
      }
      if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
      if (opts.offset !== undefined) args.push("--offset", String(opts.offset));
      const outcome = runCli(env, args);
      if (!outcome.ok) return unavailable(outcome.reason);
      const page = parseLoreJson(outcome.stdout);
      if (!page) {
        return unavailable(
          "Memory CLI `list --json` returned no parsable page — is the memory package up to date?",
        );
      }
      return { available: true, ...page };
    },
    approveLore(id) {
      if (!LORE_ID_RE.test(id)) return unavailable(`"${id}" is not a memory lore id.`);
      const outcome = runCli(env, ["approve", id]);
      if (!outcome.ok) return unavailable(outcome.reason);
      return { available: true, id, status: "active" };
    },
    rejectLore(id, reason) {
      if (!LORE_ID_RE.test(id)) return unavailable(`"${id}" is not a memory lore id.`);
      const args = ["reject", id];
      const why = (reason ?? "").trim();
      if (why !== "") args.push("--reason", why);
      const outcome = runCli(env, args);
      if (!outcome.ok) return unavailable(outcome.reason);
      return { available: true, id, status: "rejected" };
    },
    digest(repo) {
      const outcome = runCli(env, ["digest", repo]);
      if (!outcome.ok) return unavailable(outcome.reason);
      return { available: true, digest: parseDigest(repo, outcome.stdout) };
    },
    features(repo, opts = {}) {
      const args = ["features", repo];
      if (opts.status) args.push("--status", opts.status);
      if (opts.node) args.push("--node", opts.node);
      const outcome = runCli(env, args);
      if (!outcome.ok) return unavailable(outcome.reason);
      return { available: true, features: parseFeatures(outcome.stdout) };
    },
    lore() {
      const outcome = runCli(env, ["list"]);
      if (!outcome.ok) return unavailable(outcome.reason);
      return { available: true, lore: parseLore(outcome.stdout) };
    },
    recallEffectiveness(opts = {}) {
      const args = ["recall-stats", "--json"];
      if (opts.repo) args.push("--repo", opts.repo);
      const outcome = runCli(env, args);
      if (!outcome.ok) return unavailable(outcome.reason);
      return { available: true, recall: parseRecallStats(outcome.stdout) };
    },
    captureLoreDraft(input) {
      const title = (input.title ?? "").trim();
      const summary = (input.summary ?? "").trim();
      if (title === "" || summary === "") {
        return unavailable("a lore draft needs a non-empty title + summary");
      }
      // `suggest` lands a DRAFT (human-gated). All values are discrete argv elements
      // (runCli uses no shell), so a rejection reason can't inject a CLI flag/command.
      const args = ["suggest", "--title", title, "--summary", summary];
      const repo = (input.repo ?? "").trim();
      if (repo !== "") args.push("--repo", repo);
      for (const tag of input.tags ?? []) {
        const t = String(tag).trim();
        if (t !== "") args.push("--tag", t);
      }
      const outcome = runCli(env, args);
      if (!outcome.ok) return unavailable(outcome.reason);
      // The suggest CLI prints `memory: suggested <id> (draft)`; pull that id, best-effort.
      const m = /\bsuggested\s+([a-z0-9]{4,})\b/i.exec(outcome.stdout ?? "");
      return { available: true, id: m ? m[1]! : null };
    },
  };
}
