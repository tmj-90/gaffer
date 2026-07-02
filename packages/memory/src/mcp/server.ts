import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../core/audit.js";
import { findActiveAbsence, recordAbsence } from "../core/absence.js";
import { findDependents, suggestBoundary } from "../core/boundaries.js";
import {
  diagnoseRepoKeyMismatch,
  getFileCard,
  repoKey,
  searchFileCards,
} from "../core/fileCards.js";
import {
  addFeature,
  advanceFeature,
  AdvanceFeatureError,
  getDigest,
  listFeatures,
  upsertDigest,
} from "../core/repoUnderstanding.js";
import {
  findPossibleDuplicates,
  getLore,
  reportConflict,
  ReportConflictError,
  searchLore,
  searchLoreCount,
  suggestLore,
} from "../core/lore.js";
import { cardsForScope } from "../core/scopePacket.js";
import { defaultDbPath, openDb } from "../db/index.js";
import { DatabaseTooNewError } from "../db/migrations.js";
import {
  ABSENCE_DISABLED_REFUSAL,
  buildSearchResponseBody,
  CONFLICT_AGAINST_RESTRICTED_REFUSAL,
  redactRestricted,
  shouldGateAbsenceWrite,
  shouldGateRestrictedGet,
  shouldRefuseConflictAgainstRestricted,
  stripPossibleConflicts,
} from "./redact.js";
import {
  auditMessageForTooLong,
  checkLength,
  checkMaxLen,
  DIGEST_CAPS,
  FEATURE_CAPS,
  LENGTH_CAPS,
} from "./validation.js";
import {
  quarantineCard,
  quarantineDigest,
  quarantineFeature,
  quarantineLore,
  QUARANTINE_NOTICE,
  stripEnvelopeTokens,
} from "./quarantine.js";
import type { Boundary, Feature } from "../db/types.js";
import { VERSION } from "../version.js";

/**
 * Compact boundary projection for MCP responses — repo / role / contract
 * plus the optional classifier, detail, and source. Omits internal
 * timestamps and status (the map is active-only over MCP) to keep the
 * agent's context lean.
 */
function boundaryForMcp(b: Boundary): Record<string, unknown> {
  return {
    repo: b.repo,
    role: b.role,
    contract: b.contract,
    ...(b.kind ? { kind: b.kind } : {}),
    ...(b.detail ? { detail: b.detail } : {}),
    ...(b.source ? { source: b.source } : {}),
  };
}

/**
 * Compact feature projection for MCP responses. Carries the lifecycle
 * status, the optional scope-node (so a node-level feature is
 * addressable), and the area/provenance hints, omitting internal
 * timestamps to keep the agent's context lean.
 */
function featureForMcp(f: Feature): Record<string, unknown> {
  // Agent-derived free text (name / summary / area / provenance) is wrapped in
  // the quarantine envelope so it reaches a future agent as DATA, never as
  // instructions. Mechanical fields (id / repo / scope_node / status) are
  // trusted identifiers and stay raw.
  return quarantineFeature({
    id: f.id,
    repo: f.repo,
    ...(f.scopeNode ? { scope_node: f.scopeNode } : {}),
    name: f.name,
    summary: f.summary,
    status: f.status,
    ...(f.area ? { area: f.area } : {}),
    ...(f.provenance ? { provenance: f.provenance } : {}),
  });
}

/**
 * R1 — MCP server. Stdio transport only (no network listener). Three
 * tools exposed to the client:
 *
 *   - search_lore  — brief-by-default; default-filtered to active records,
 *                    excludes drafts/deprecated/superseded/restricted unless
 *                    explicitly opted in via flags. The token-saving entry.
 *   - get_lore     — full body of one record by id. Use this AFTER a
 *                    search hit to spend tokens on detail only when needed.
 *   - suggest_lore — agent-authored knowledge lands as a DRAFT
 *                    (status='draft'). Hidden from default search until
 *                    a human runs `memory approve <id>`. Agents cannot
 *                    promote their own records.
 *
 * Every tool call is recorded to `~/.memory/audit.jsonl` with the request
 * args, result count, and result ids — never the full result bodies.
 */
export async function runMcpServer(): Promise<void> {
  // Open the DB before wiring tools. If it fails (locked by another process,
  // corrupt file, unwritable dir) the agent's client would otherwise see a
  // raw SqliteError stack and a bare "server failed to start". Emit an
  // actionable diagnostic to stderr — which MCP clients surface on launch
  // failure — and exit cleanly instead.
  let db: Database;
  try {
    db = openDb();
  } catch (err) {
    if (err instanceof DatabaseTooNewError) {
      process.stderr.write(`memory-mcp: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    const dbPath = defaultDbPath();
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `memory-mcp: could not open the lore database at ${dbPath}\n` +
        `  reason: ${reason}\n` +
        `  • If another process holds a write lock, close it and relaunch.\n` +
        `  • If the file is corrupt, restore a backup or re-run \`memory init\`.\n` +
        `  • Check the directory is writable and you have free disk space.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const server = buildMcpServer(db);

  // Connect on stdio. The MCP client (Claude Code, Cursor, etc.) is the
  // parent process; we read JSON-RPC framed messages on stdin, reply on
  // stdout. Logs go to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block forever — connect() returns once the transport is bound; the
  // server runs as long as stdin stays open. Closing stdin (client
  // disconnect) exits the process.
}

/**
 * Wire all memory MCP tools onto a fresh `McpServer` backed by the
 * given database. Split out of `runMcpServer` so tests can drive the
 * real server (and its real handlers, redaction gates, and audit calls)
 * over an in-memory transport against a temp DB — no stdio subprocess,
 * no production `~/.memory` paths. `runMcpServer` is the thin shell:
 * open the default DB, build, connect stdio.
 */
export function buildMcpServer(db: Database): McpServer {
  const server = new McpServer({
    name: "memory",
    version: VERSION,
  });

  // ---- search_lore -----------------------------------------------------
  server.registerTool(
    "search_lore",
    {
      title: "Search team lore",
      description:
        "**Call this BEFORE any non-trivial change.** Memory is the " +
        "team's memory of conventions, decisions, gotchas, deprecated " +
        "patterns, and incident lessons. If there's any chance the team " +
        "has an opinion on what you're about to do, search first. The " +
        "only changes that don't warrant a search are pure typos / " +
        "formatting / mechanical renames where the team can't have an " +
        "opinion. Cost asymmetry favours over-calling: an empty search " +
        "costs one cheap query; a skipped search lets you repeat a " +
        "mistake the team already learned from.\n\n" +
        "**Search broadly, not just by current repo.** If your task " +
        "touches code that interacts with another service / repo — shared " +
        "infra, cross-repo APIs, common conventions — search WITHOUT a " +
        "`repo` filter at least once. Lore records can be tagged for " +
        "multiple repos (e.g. an org-wide rule), and a too-narrow filter " +
        "will hide them. If a repo-scoped query returns zero hits, " +
        "consider retrying without the filter before concluding the team " +
        "has no position.\n\n" +
        "Returns BRIEF summaries (no body). Call get_lore({ id }) only " +
        "when a summary mentions a specific number / threshold / " +
        "exception you can't act on without the detail. Default: returns " +
        "only 'active' records; excludes drafts and deprecated/superseded. " +
        "Results include `stale: true` when the record's review date has " +
        "passed; treat stale hits as starting points, not authority.\n\n" +
        "Phrase queries as 'topic + scope' — e.g. \"password hashing\", " +
        '"date timezone payments-svc", "webhook retry policy", ' +
        '"migration style guide". On a zero-hit response, the server ' +
        "may include an `absence_marker` (an acknowledged team-known gap) " +
        "or a `next` field coaching your next move. When more matches " +
        "exist than were returned, a `truncated: { shown, total, hint }` " +
        "block tells you the set is partial — narrow or raise `limit` " +
        "before treating the shown hits as the team's complete position. " +
        "Results are ordered by relevance ADJUSTED for trust (active, " +
        "sourced, higher-confidence, non-stale records rank higher), so " +
        "the top hits are the ones most worth acting on.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text query (matches title, summary, and body via FTS5). " +
              "Omit to list recent active records.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Narrow to records tagged for this repo (use the repo's name as " +
              "you'd write it in a Git URL, e.g. 'payments-svc').",
          ),
        tag: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Narrow to records carrying this tag, or any of these tags " +
              "if a list is given (ANY-of). Tags are lowercased / hyphenated " +
              "automatically — pass them however you like.",
          ),
        prefix: z
          .boolean()
          .optional()
          .describe(
            "If true, query tokens of 3+ chars match as PREFIXES " +
              "('timez' → 'timezone'). Off by default; turn on when you're " +
              "guessing at a term or want broader recall.",
          ),
        updatedAfter: z
          .string()
          .optional()
          .describe(
            "ISO timestamp. Returns only records whose `updated_at` is " +
              "on/after this. Use sparingly — most useful queries don't " +
              "filter by time. Format: '2026-01-15' or full ISO datetime.",
          ),
        includeDrafts: z
          .boolean()
          .optional()
          .describe(
            "If true, also return agent-suggested drafts awaiting human approval. " +
              "Default false — drafts haven't been reviewed and may be wrong.",
          ),
        includeDeprecated: z
          .boolean()
          .optional()
          .describe("If true, also return records the team has marked deprecated."),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe(
            "If true, also return records that have been superseded by a " +
              "newer record. Default false — the superseding record is " +
              "usually what you want.",
          ),
        includeRestricted: z
          .boolean()
          .optional()
          .describe(
            "If true, also return records the team has marked restricted. " +
              "Default false — most agent tasks should leave this off.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results. Default 10, hard cap 50."),
      },
    },
    async (args) => {
      try {
        const searchOpts = {
          query: args.query,
          repo: args.repo,
          tag: args.tag,
          prefix: args.prefix,
          updatedAfter: args.updatedAfter,
          includeDrafts: args.includeDrafts,
          includeDeprecated: args.includeDeprecated,
          includeSuperseded: args.includeSuperseded,
          // R4 — env-gated. The agent can ASK for restricted records, but
          // the server ignores the flag unless MEMORY_ALLOW_RESTRICTED_MCP=1
          // is set at startup. Belt-and-braces beyond the schema default.
          includeRestricted:
            process.env["MEMORY_ALLOW_RESTRICTED_MCP"] === "1" ? args.includeRestricted : false,
          limit: args.limit,
        };
        const hits = searchLore(db, searchOpts);
        // Unlimited count under the SAME filters, so the response can tell
        // the agent when results were capped ("showing 10 of 23") and it
        // narrows rather than concluding the team has nothing more. Only
        // worth the extra query when we actually hit the cap.
        const totalMatches =
          hits.length >= (args.limit ?? 10) ? searchLoreCount(db, searchOpts) : hits.length;
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          resultCount: hits.length,
          resultIds: hits.map((h) => h.id),
        });
        // possibleConflicts is a CLI-only heuristic for human triage —
        // see stripPossibleConflicts for the rationale.
        const mcpHits = stripPossibleConflicts(hits).map((h) => quarantineLore(h));
        // Verified-absence: when there are no hits AND the agent
        // explicitly searched (not a blank "list recent" call), surface
        // any active marker so the next agent knows "we checked, known
        // gap" rather than re-discovering the same nothing. Absent the
        // query we have nothing to match a marker against.
        let absenceMarker: ReturnType<typeof findActiveAbsence> = null;
        if (mcpHits.length === 0 && args.query) {
          absenceMarker = findActiveAbsence(db, {
            query: args.query,
            repo: args.repo,
          });
        }
        // Response shape is built by a pure helper so the three
        // branches (hits / empty+marker / empty+no-marker+coach) can
        // be unit-tested without spinning up stdio. See redact.ts for
        // the contract.
        const responseBody = buildSearchResponseBody({
          hits: mcpHits,
          query: args.query,
          absenceMarker,
          totalMatches,
        });
        // Standing instruction so the agent treats the <untrusted-lore> spans
        // in each result as data, not instructions.
        responseBody["security"] = QUARANTINE_NOTICE;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responseBody, null, 2),
            },
          ],
          structuredContent: responseBody,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `search_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- get_lore --------------------------------------------------------
  server.registerTool(
    "get_lore",
    {
      title: "Fetch one lore record (full body)",
      description:
        "**Call this when a search_lore summary isn't enough to act on** — " +
        "typically when the summary references a specific value / threshold " +
        "/ exception, says 'see body for...', or you need the rationale " +
        "behind the rule to apply it correctly. Don't call get_lore on " +
        "every search hit; the summary is designed to stand alone for the " +
        "common case. Pulling the full body for an obvious rule wastes " +
        "tokens.\n\n" +
        "Returns null when no record matches the id.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("The 8-char lore id, e.g. '7vk3qm9b'. Get this from search_lore."),
      },
    },
    async (args) => {
      try {
        const lore = getLore(db, args.id);
        // R4 — restricted gate. `search_lore` already env-gates restricted
        // retrieval; without a matching gate here, an agent with an id from
        // a stale audit / CLI output / prior context can bypass the search
        // filter and fetch the body. Same env knob as search, minimal
        // refusal shape (no title) so the response itself can't leak.
        if (shouldGateRestrictedGet(lore, process.env)) {
          audit({
            tool: "get_lore",
            request: args as Record<string, unknown>,
            resultCount: 1,
            resultIds: [lore!.id],
            blocked: "restricted",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(redactRestricted(lore!.id), null, 2),
              },
            ],
          };
        }
        audit({
          tool: "get_lore",
          request: args as Record<string, unknown>,
          resultCount: lore ? 1 : 0,
          resultIds: lore ? [lore.id] : [],
        });
        if (!lore) {
          const notFound = { found: false, id: args.id };
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(notFound, null, 2),
              },
            ],
            structuredContent: notFound,
          };
        }
        // Agent-derived free text (title / summary / body) is wrapped in the
        // quarantine envelope; the record's trust metadata (status / source /
        // confidence / repos / tags) stays raw so the agent can still judge it.
        const loreOut = {
          ...quarantineLore(lore as unknown as Record<string, unknown>),
          security: QUARANTINE_NOTICE,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(loreOut, null, 2),
            },
          ],
          structuredContent: loreOut,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "get_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `get_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- suggest_lore ----------------------------------------------------
  server.registerTool(
    "suggest_lore",
    {
      title: "Suggest a new lore record (draft)",
      description:
        "**Call this at the END of a task IF you discovered a durable, " +
        "project-specific finding that future agents would have benefited " +
        "from knowing at the start.** Concrete triggers: (1) a convention " +
        "that isn't obvious from code (naming, timezone handling, auth, " +
        "permissions, data modelling); (2) a gotcha that wasted time in " +
        "this session and is likely to bite again; (3) a deprecated " +
        "pattern you spotted and steered away from; (4) a migration " +
        "constraint or in-flight transition; (5) an incident lesson; " +
        "(6) a cross-repo rule you inferred from multiple touch points.\n\n" +
        "Do NOT call for: TypeScript/language syntax, generic programming " +
        "advice, transient task state, file paths you happened to read, " +
        "or anything you're not at least 80% confident the next agent " +
        "should know. Rough rule: would a future teammate, six months " +
        "from now, thank you for capturing this? If unsure, skip — the " +
        "cost of a missing record is one re-search; the cost of a noisy " +
        "record is reviewer fatigue.\n\n" +
        "Lands as a DRAFT (invisible to default search until a human " +
        "approves via `memory review`). The response includes any " +
        "near-duplicate records you should be aware of in `possibleDuplicates` " +
        "— if a hit looks like the same rule, your suggestion is probably " +
        "redundant; consider not calling at all, or call with a sharper " +
        "title that complements rather than duplicates.",
      inputSchema: {
        // Length caps live in the handler, not the schema. zod's max-cap
        // path produced "body is undefined" upstream when an over-cap
        // summary failed parsing — the cause was masked and agents
        // dropped the suggestion. The handler now returns a structured
        // `{error: "summary_too_long", suggested_cut, ...}` the agent
        // can correct against. The description still names the cap so
        // well-behaved agents respect it upfront.
        title: z
          .string()
          .min(1)
          .describe(`Short title — what is the rule / fact? Hard cap ${LENGTH_CAPS.title} chars.`),
        summary: z
          .string()
          .min(1)
          .describe(
            `One-paragraph summary (≤ ${LENGTH_CAPS.summary} chars). This is what most search ` +
              "results show — should stand alone without the body; assume " +
              "readers won't drill in. Aim for the *why* and the *what*, " +
              "not just the *what*; a longer cap exists so search hits can " +
              "be self-contained without a follow-up get_lore call.",
          ),
        body: z
          .string()
          .min(1)
          .describe(
            "Full detail / reasoning / evidence. Markdown is fine. " +
              "Include enough context to verify the claim.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe("Repos this rule applies to. Helps future agents narrow searches."),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Lowercase tags. Common tags include: security, dates, db, auth, " +
              "deploy, conventions, gotchas, incident-lessons.",
          ),
        source: z
          .string()
          .url()
          .optional()
          .describe(
            "URL: PR / ADR / incident / Slack permalink that justifies this " +
              "record. Records WITHOUT a source are treated as lower-trust.",
          ),
        confidence: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe(
            "How sure are you? Default 'medium'. Use 'low' for inferred " +
              "conventions; 'high' only when you have a source link.",
          ),
        kind: z
          .enum(["decision", "requirement", "non-goal", "convention", "gotcha", "other"])
          .optional()
          .describe(
            "What KIND of knowledge is this? 'decision' (a durable choice + " +
              "why), 'requirement' (a product need the work serves), 'non-goal' " +
              "(deliberately out of scope), 'convention' (how-we-do-it-here), " +
              "'gotcha' (a trap that bit). Product intent → decision/requirement/" +
              "non-goal. Defaults to 'other'.",
          ),
        team: z.string().optional().describe("Owning team, if known."),
      },
    },
    async (args) => {
      // Build a sanitised audit shape that DELIBERATELY omits the body
      // (and summary length is bounded by the schema so it's safe to keep).
      // This is the trust-model boundary called out in SECURITY.md — the
      // audit log records that a suggestion happened, not the suggestion's
      // contents. To inspect the content, read the SQLite `lore` row.
      const sanitised: Record<string, unknown> = {
        title: args.title,
        summaryChars: args.summary.length,
        bodyChars: args.body.length,
        repos: args.repos,
        tags: args.tags,
        source: args.source,
        confidence: args.confidence,
        kind: args.kind,
        team: args.team,
      };
      // Length guards — check title first, then summary. Return the
      // structured error to the agent (NOT isError: true — the response
      // is well-formed, the agent just has to retry with shorter input)
      // and log the cap breach to the audit log with a greppable shape.
      const titleErr = checkLength("title", args.title);
      if (titleErr) {
        audit({
          tool: "suggest_lore",
          request: sanitised,
          error: auditMessageForTooLong(titleErr),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(titleErr, null, 2) }],
        };
      }
      const summaryErr = checkLength("summary", args.summary);
      if (summaryErr) {
        audit({
          tool: "suggest_lore",
          request: sanitised,
          error: auditMessageForTooLong(summaryErr),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(summaryErr, null, 2) }],
        };
      }
      try {
        // Auto-approve mode (MEMORY_AUTO_APPROVE=1): the operator has opted
        // into an autonomous factory populating lore without human review, so
        // the entry lands `active` immediately. Unset (default) keeps the
        // governed draft flow — the standalone product is unchanged.
        const autoApprove = process.env["MEMORY_AUTO_APPROVE"] === "1";
        const lore = suggestLore(
          db,
          {
            title: args.title,
            summary: args.summary,
            body: args.body,
            repos: args.repos,
            tags: args.tags,
            source: args.source,
            confidence: args.confidence,
            kind: args.kind,
            team: args.team,
            author: "agent",
          },
          { autoApprove },
        );
        // Hint-only duplicate check. Never blocks — the human reviewer
        // decides. Surfaced in the response so the calling agent can warn
        // the user inline ("I drafted this but here are 2 similar
        // existing records"), and counted in the audit so a human reading
        // ~/.memory/audit.jsonl can see how often agents suggest near-dupes.
        //
        // Restricted handling: titles of restricted records are not
        // surfaced unless MEMORY_ALLOW_RESTRICTED_MCP=1 (same env knob that
        // governs search and get). Restricted matches are still counted
        // so the response can say "and N more we're not showing you".
        const allowRestricted = process.env["MEMORY_ALLOW_RESTRICTED_MCP"] === "1";
        const { duplicates: possibleDuplicates, restrictedDuplicateCount } = findPossibleDuplicates(
          db,
          {
            id: lore.id,
            title: args.title,
            repos: args.repos,
            tags: args.tags,
          },
          { allowRestricted },
        );
        sanitised["possibleDuplicateCount"] = possibleDuplicates.length;
        sanitised["restrictedDuplicateCount"] = restrictedDuplicateCount;
        audit({
          tool: "suggest_lore",
          request: sanitised,
          resultCount: 1,
          resultIds: [lore.id],
        });
        const out = {
          id: lore.id,
          status: lore.status,
          message: autoApprove
            ? "Record approved and active."
            : "Draft created. A human will review with `memory review` and " +
              "promote with `memory approve " +
              lore.id +
              "`.",
          possibleDuplicates,
          restrictedDuplicateCount,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, 2),
            },
          ],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "suggest_lore",
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `suggest_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- report_conflict -------------------------------------------------
  server.registerTool(
    "report_conflict",
    {
      title: "Report a conflict against a canonical lore record",
      description:
        "**Call this when a search_lore hit contradicts what the code (or " +
        "another authoritative source) actually does right now.** Concrete " +
        "triggers: lore says 'use requireSession()' but the codebase only " +
        "uses the legacy middleware; lore says 'all timestamps UTC' but you " +
        "found a callsite storing local time; lore says 'feature flags " +
        "preferred' but you found long-lived feature branches being merged. " +
        "If you spot this and stay silent, the lore stays wrong and the " +
        "next agent inherits it.\n\n" +
        "Creates a DRAFT counter-record linked back to the original via " +
        "`conflictsWith` — it lands in `memory review` for the human " +
        "to triage. The original record is NEVER mutated; the link is " +
        "one-way. Resolution is the reviewer's call (approve the counter-" +
        "claim → `memory supersede` or `memory update` to fix the " +
        "original; reject → the original stands).\n\n" +
        "Distinct from the runtime `possibleConflicts` heuristic on search " +
        "results — that's shared-scope overlap detection. This is explicit, " +
        "persisted, evidence-backed disagreement.",
      inputSchema: {
        existingId: z
          .string()
          .min(1)
          .describe(
            "The 8-char id of the existing ACTIVE record being challenged. " +
              "Get this from a prior `search_lore` or `get_lore` call.",
          ),
        observation: z
          .string()
          .min(1)
          .max(800)
          .describe(
            "What did you observe that contradicts the existing record? " +
              "Stand-alone explanation — the reviewer reads this without " +
              "additional context. ≤ 800 chars (mirrors suggest_lore.summary).",
          ),
        source: z
          .string()
          .url()
          .optional()
          .describe(
            "URL pointing at the contradicting evidence (commit, PR, " +
              "code permalink). Counter-claims with a source are higher-trust.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            "Repos this counter-claim is scoped to. Inherits from the " +
              "challenged record if omitted (handled by the reviewer).",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Extra tags. 'conflict-report' is always added automatically."),
      },
    },
    async (args) => {
      // Audit shape mirrors suggest_lore: never record the observation
      // body, just its length, so the audit log can be grepped for
      // "agent X repeatedly challenges record Y" without leaking content.
      const sanitised: Record<string, unknown> = {
        existingId: args.existingId,
        observationChars: args.observation.length,
        source: args.source,
        repos: args.repos,
        tags: args.tags,
      };
      try {
        // Restricted records are NEVER challengeable via MCP — the
        // core reportConflict refuses them regardless of the env
        // gate. We pre-check here purely to (a) emit a cleaner
        // `blocked: "restricted"` audit row and (b) give the agent a
        // useful hint instead of the generic catch-block message.
        // No env check: even with MEMORY_ALLOW_RESTRICTED_MCP=1
        // the core would still throw. Telling the agent to set the
        // env var would be a lie.
        const existing = getLore(db, args.existingId);
        if (shouldRefuseConflictAgainstRestricted(existing)) {
          audit({
            tool: "report_conflict",
            request: sanitised,
            blocked: "restricted",
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(CONFLICT_AGAINST_RESTRICTED_REFUSAL, null, 2),
              },
            ],
          };
        }
        const draft = reportConflict(db, {
          existingId: args.existingId,
          observation: args.observation,
          source: args.source,
          repos: args.repos,
          tags: args.tags,
        });
        audit({
          tool: "report_conflict",
          request: sanitised,
          resultCount: 1,
          resultIds: [draft.id],
        });
        const out = {
          id: draft.id,
          status: draft.status,
          conflictsWith: draft.conflictsWith ?? [],
          message:
            "Counter-draft created. A human will review with `memory review` and " +
            "either approve / reject / edit / supersede the original.",
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, 2),
            },
          ],
          structuredContent: out,
        };
      } catch (err) {
        const reason = err instanceof ReportConflictError ? err.reason : "internal_error";
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "report_conflict",
          request: sanitised,
          error: `${reason}: ${msg}`,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `report_conflict failed (${reason}): ${msg}`,
            },
          ],
        };
      }
    },
  );

  // ---- record_absence -------------------------------------------------
  server.registerTool(
    "record_absence",
    {
      title: "Record a verified-absence marker (no lore on this topic)",
      description:
        "**Call this only when ALL THREE are true:** (1) you searched, " +
        "(2) you got zero hits, AND (3) you've confirmed the gap is real " +
        "and durable — i.e. the team genuinely has no policy on this " +
        "topic, you're not just one re-phrasing away from a hit, and " +
        "you'd expect the gap to still be there in a month. The strict " +
        "trigger is intentional: default to NOT calling unless the " +
        "absence is itself a finding worth recording.\n\n" +
        "Cheap to be wrong (markers self-expire — default 14 days, max " +
        "365); cheap to omit (next agent just re-searches). Future " +
        "search_lore calls on the same normalised query (lowercase, " +
        "sorted tokens) surface the marker as `absence_marker: { reason, " +
        "expiresAt }` alongside an empty results array, so the next agent " +
        "knows it's an acknowledged gap rather than re-discovering nothing.\n\n" +
        "Anti-patterns: do NOT call on every zero-hit search; do NOT call " +
        "as a substitute for suggest_lore (markers say 'no policy', not " +
        "'here's a policy'); do NOT chain into a suggest_lore that just " +
        "re-states the absence.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "The query you ran that returned zero hits. Normalised at " +
              "write time (lowercase, sorted tokens) so re-phrasings match.",
          ),
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "One-sentence explanation of WHY this is a known gap " +
              "(e.g. 'team has no policy yet; decided ad hoc per incident').",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Optional repo scope. Repo-scoped markers shadow global ones " +
              "when search_lore is called with the same repo.",
          ),
        expiresInDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            "Days until the marker auto-expires. Default 14. Stale 'we " +
              "checked' claims age out fast so they don't become permanent " +
              "and a bad call from one agent can't poison retrieval for a " +
              "whole month.",
          ),
      },
    },
    async (args) => {
      const sanitised: Record<string, unknown> = {
        queryChars: args.query.length,
        reasonChars: args.reason.length,
        repo: args.repo,
        expiresInDays: args.expiresInDays,
      };
      if (shouldGateAbsenceWrite(process.env)) {
        audit({
          tool: "record_absence",
          request: sanitised,
          blocked: "mcp_disabled",
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(ABSENCE_DISABLED_REFUSAL, null, 2),
            },
          ],
        };
      }
      try {
        const result = recordAbsence(db, {
          query: args.query,
          reason: args.reason,
          repo: args.repo,
          expiresInDays: args.expiresInDays,
          recordedBy: "agent",
        });
        audit({
          tool: "record_absence",
          request: sanitised,
          resultCount: 1,
          resultIds: [result.id],
        });
        const out = {
          id: result.id,
          expiresAt: result.expiresAt,
          message:
            "Absence marker recorded. Future search_lore calls " +
            "matching this normalised query will surface this marker " +
            `until ${result.expiresAt}.`,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, 2),
            },
          ],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "record_absence",
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `record_absence failed: ${msg}` }],
        };
      }
    },
  );

  // ---- find_dependents -------------------------------------------------
  server.registerTool(
    "find_dependents",
    {
      title: "Find who provides / consumes a contract (impact check)",
      description:
        "**Call this BEFORE changing any cross-repo contract** — an event " +
        "you publish, an HTTP endpoint you serve, a queue, a shared DB " +
        "table, an RPC method. Memory keeps a team-ratified map of " +
        "which repos `provides` (own / produce) and which `consumes` " +
        "(depend on) each contract, aggregated across every repo's " +
        "committed lore. This tool returns both sides for one contract, " +
        "so the `consumers` list is your blast radius: change the shape " +
        "and those are the repos that break.\n\n" +
        "Use it to answer 'if I change `order-submitted`, what does it " +
        "affect?'. An empty result doesn't prove safety — the map is only " +
        "as complete as what teams have declared — but a non-empty " +
        "`consumers` list is a concrete warning to coordinate the change. " +
        "If you discover a producer/consumer relationship that ISN'T in " +
        "the map, call `declare_boundary` to add it (lands as a draft).",
      inputSchema: {
        contract: z
          .string()
          .min(1)
          .describe(
            "The contract name: an event ('order-submitted'), endpoint " +
              "('POST /v1/orders'), queue, table, or RPC. Matched after " +
              "normalisation (lowercased / hyphenated), so casing and " +
              "spacing don't matter.",
          ),
      },
    },
    async (args) => {
      try {
        const result = findDependents(db, args.contract);
        audit({
          tool: "find_dependents",
          request: args as Record<string, unknown>,
          resultCount: result.providers.length + result.consumers.length,
          resultIds: [...result.providers, ...result.consumers].map((b) => b.id),
        });
        const out = {
          contract: result.contract,
          providers: result.providers.map(boundaryForMcp),
          consumers: result.consumers.map(boundaryForMcp),
          next:
            result.providers.length === 0 && result.consumers.length === 0
              ? "No declared providers or consumers for this contract. " +
                "The map may be incomplete — this is NOT proof the " +
                "change is safe. If you know of a producer/consumer, " +
                "call declare_boundary to record it."
              : "These are the declared cross-repo dependents. Treat " +
                "`consumers` as the blast radius of a shape change and " +
                "coordinate accordingly.",
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, 2),
            },
          ],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "find_dependents",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `find_dependents failed: ${msg}` }],
        };
      }
    },
  );

  // ---- declare_boundary ------------------------------------------------
  server.registerTool(
    "declare_boundary",
    {
      title: "Declare a cross-repo boundary edge (draft)",
      description:
        "**Call this when you discover that a repo produces or depends on " +
        "a cross-repo contract** and that relationship isn't already in " +
        "the map (check with `find_dependents` first). Concrete triggers: " +
        "you find code publishing an event another service handles; a " +
        "service calling another's endpoint; a job reading a table another " +
        "team owns.\n\n" +
        "`role: 'provides'` = this repo OWNS / produces the contract " +
        "(the event publisher, the endpoint's server). `role: 'consumes'` " +
        "= this repo DEPENDS on it (subscriber, caller, reader).\n\n" +
        "Lands as a DRAFT — invisible to the default map until a human " +
        "ratifies it with `memory boundary approve <id>`. You cannot " +
        "promote your own edges; same trust gate as suggest_lore. Don't " +
        "declare speculative or transient links — only durable " +
        "integration points a future agent should see.",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe(
            "The repo this edge belongs to (the producer's or consumer's " +
              "name, as you'd write it in a Git URL — e.g. 'orders-svc').",
          ),
        contract: z
          .string()
          .min(1)
          .describe(
            "The contract name (event / endpoint / queue / table / rpc). " +
              "Normalised (lowercased / hyphenated) so it joins across repos.",
          ),
        role: z
          .enum(["provides", "consumes"])
          .describe(
            "'provides' if this repo owns/produces the contract; " +
              "'consumes' if it depends on it.",
          ),
        kind: z
          .enum(["event", "endpoint", "queue", "table", "rpc", "other"])
          .optional()
          .describe("Optional classifier for the contract."),
        detail: z
          .string()
          .max(800)
          .optional()
          .describe(
            "Optional note: which field/version/path, migration caveats, " +
              "the evidence you saw. ≤ 800 chars.",
          ),
        source: z
          .string()
          .url()
          .optional()
          .describe("URL to the code / PR / doc that evidences this edge."),
      },
    },
    async (args) => {
      const sanitised: Record<string, unknown> = {
        repo: args.repo,
        contract: args.contract,
        role: args.role,
        kind: args.kind,
        detailChars: args.detail?.length,
        source: args.source,
      };
      try {
        const edge = suggestBoundary(db, {
          repo: args.repo,
          contract: args.contract,
          role: args.role,
          kind: args.kind,
          detail: args.detail,
          source: args.source,
          author: "agent",
        });
        audit({
          tool: "declare_boundary",
          request: sanitised,
          resultCount: 1,
          resultIds: [edge.id],
        });
        const out = {
          id: edge.id,
          status: edge.status,
          repo: edge.repo,
          contract: edge.contract,
          role: edge.role,
          message:
            "Boundary edge drafted. A human will review with " +
            "`memory boundary review` and ratify with " +
            `\`memory boundary approve ${edge.id}\`.`,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, 2),
            },
          ],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "declare_boundary",
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `declare_boundary failed: ${msg}` }],
        };
      }
    },
  );

  // ---- get_repo_digest -------------------------------------------------
  server.registerTool(
    "get_repo_digest",
    {
      title: "Get a repo's current understanding digest",
      description:
        "Fetch the current digest for a repo — a living TLDR of what the " +
        "repo is, how it's structured, the stack, and the conventions to " +
        "follow. Produced by the factory's onboard/merge steps. Call this " +
        "to get oriented in a repo fast.\n\n" +
        "The result always carries `updated_at` + `source` (provenance) so " +
        "you can judge freshness, and a `caveat`: the digest is a SUMMARY — " +
        "verify it against the actual code before high-stakes work. Returns " +
        "`null` when no digest has been written for the repo yet.",
      inputSchema: {
        repo: z.string().min(1).describe("The repo name to fetch the digest for."),
      },
    },
    async (args) => {
      try {
        const digest = getDigest(db, args.repo);
        audit({
          tool: "get_repo_digest",
          request: args as Record<string, unknown>,
          resultCount: digest ? 1 : 0,
          resultIds: digest ? [digest.repo] : [],
        });
        const out = digest
          ? {
              // Model-derived free text (overview / structure / conventions /
              // stack) is wrapped in the quarantine envelope so it reaches a
              // future agent as DATA, never as instructions. repo / source /
              // updated_at are trusted metadata and stay raw.
              ...quarantineDigest({
                repo: digest.repo,
                overview: digest.overview,
                structure: digest.structure,
                conventions: digest.conventions,
                stack: digest.stack,
                updated_at: digest.updatedAt,
                source: digest.source,
              }),
              security: QUARANTINE_NOTICE,
              caveat:
                "This digest is a summary. For high-stakes work, verify it " +
                "against the actual code — it may be stale or incomplete.",
            }
          : {
              repo: args.repo,
              digest: null,
              message:
                "No digest has been written for this repo yet. Run the " +
                "onboarding step (or `update_repo_digest`) to create one.",
            };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "get_repo_digest",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `get_repo_digest failed: ${msg}` }],
        };
      }
    },
  );

  // ---- update_repo_digest ----------------------------------------------
  server.registerTool(
    "update_repo_digest",
    {
      title: "Write/replace a repo's understanding digest",
      description:
        "Write (or replace) the single current digest for a repo. A repo " +
        "has exactly ONE digest; calling this supersedes the prior in " +
        "place, but the supersede is audited (an event per update) so the " +
        "history of refreshes stays inspectable.\n\n" +
        "Unlike `suggest_lore`, this is NOT routed through the draft/review " +
        "gate: a digest is a FACTUAL POST-MERGE REFLECTION of what the code " +
        "now is (produced by the onboard/merge steps against real code), " +
        "not an opinion that needs human ratification — so it APPLIES " +
        "DIRECTLY. Set `source` to record provenance: 'onboard', " +
        "'merge:#<pr>', or 'manual'.",
      inputSchema: {
        repo: z.string().min(1).describe("The repo this digest describes."),
        overview: z.string().min(1).describe("TLDR prose: what this repo is and does."),
        structure: z.string().min(1).describe("Key modules / dirs and the role each plays."),
        conventions: z
          .string()
          .min(1)
          .describe("Stack + the patterns a contributor should follow."),
        stack: z
          .string()
          .min(1)
          .describe("Headline tech stack (languages / frameworks / datastores)."),
        source: z
          .string()
          .min(1)
          .describe("Provenance: 'onboard' | 'merge:#<pr-number>' | 'manual'."),
      },
    },
    async (args) => {
      // Length-bound + sanitize BEFORE applying. The digest applies directly
      // (no human gate) and feeds every future agent's orientation, so it is
      // the top memory-poisoning target. Reject an over-cap field (structured,
      // agent-correctable error) and strip any embedded <untrusted-*> delimiter
      // tokens so stored text can't break out of the serve-time quarantine
      // envelope. Onboard writes the digest via the CLI, not this MCP tool, so
      // these caps never truncate the factory's own post-merge reflection.
      for (const field of ["overview", "structure", "conventions", "stack"] as const) {
        const err = checkMaxLen(field, args[field], DIGEST_CAPS[field]);
        if (err) {
          audit({
            tool: "update_repo_digest",
            request: { repo: args.repo, source: args.source },
            error: `${err.error}: ${err.provided} > ${err.max}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
          };
        }
      }
      try {
        const digest = upsertDigest(db, {
          repo: args.repo,
          overview: stripEnvelopeTokens(args.overview),
          structure: stripEnvelopeTokens(args.structure),
          conventions: stripEnvelopeTokens(args.conventions),
          stack: stripEnvelopeTokens(args.stack),
          source: args.source,
        });
        audit({
          tool: "update_repo_digest",
          request: {
            repo: args.repo,
            source: args.source,
            overviewChars: args.overview.length,
          },
          resultCount: 1,
          resultIds: [digest.repo],
        });
        const out = {
          repo: digest.repo,
          updated_at: digest.updatedAt,
          source: digest.source,
          message:
            "Repo digest written (applied directly — factual reflection, " +
            "not a draft). Prior digest, if any, was superseded; the update " +
            "is recorded in the audit trail.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "update_repo_digest",
          request: { repo: args.repo, source: args.source },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `update_repo_digest failed: ${msg}` }],
        };
      }
    },
  );

  // ---- list_features ---------------------------------------------------
  server.registerTool(
    "list_features",
    {
      title: "List a repo's features (ledger)",
      description:
        "List the features in a repo's ledger. Features live at REPO level " +
        "or at a SCOPE-NODE level (a sub-area like 'auth'). Filter by " +
        "`status` (backlog = ideas; building = in flight; shipped = the " +
        "current product) and/or by `scope_node`.\n\n" +
        "Node addressing: omit `scope_node` for every feature in the repo; " +
        "pass a node name to narrow to that sub-area. The `scope_node` is a " +
        "soft reference — the scope graph itself lives in dispatch.",
      inputSchema: {
        repo: z.string().min(1).describe("The repo whose ledger to list."),
        status: z
          .enum(["backlog", "building", "shipped"])
          .optional()
          .describe("Optional status filter."),
        scope_node: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional scope-node filter (e.g. 'auth'). Omit for all " + "features in the repo.",
          ),
      },
    },
    async (args) => {
      try {
        const features = listFeatures(db, args.repo, {
          status: args.status,
          scopeNode: args.scope_node,
        });
        audit({
          tool: "list_features",
          request: args as Record<string, unknown>,
          resultCount: features.length,
          resultIds: features.map((f) => f.id),
        });
        const out = {
          repo: args.repo,
          ...(args.status ? { status: args.status } : {}),
          ...(args.scope_node ? { scope_node: args.scope_node } : {}),
          count: features.length,
          features: features.map(featureForMcp),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "list_features",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `list_features failed: ${msg}` }],
        };
      }
    },
  );

  // ---- add_feature -----------------------------------------------------
  server.registerTool(
    "add_feature",
    {
      title: "Add a feature to a repo's ledger",
      description:
        "Add a feature to a repo's ledger. Defaults to `backlog` status (a " +
        "proposed idea). A feature is always anchored to a repo; pass " +
        "`scope_node` to scope it to a sub-area (e.g. a feature of the " +
        "'auth' node rather than the whole repo) — the node is a soft " +
        "reference into dispatch's scope graph, stored but not validated.\n\n" +
        "This APPLIES DIRECTLY as a proposal (not routed through the lore " +
        "draft/review gate): a backlog idea is cheap and reversible, and " +
        "the ledger's value is in staying current. Use `provenance` to " +
        "record where the idea came from.",
      inputSchema: {
        repo: z.string().min(1).describe("The repo this feature belongs to."),
        name: z.string().min(1).max(200).describe("Short feature name (≤ 200 chars)."),
        summary: z.string().describe("One-line summary of the feature."),
        scope_node: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional scope-node name to scope the feature below repo " +
              "level (e.g. 'auth'). Soft ref to dispatch; omit for a " +
              "repo-level feature.",
          ),
        status: z
          .enum(["backlog", "building", "shipped"])
          .optional()
          .describe(
            "Initial status (default 'backlog'). Onboard inventory may " +
              "land an already-present feature straight as 'shipped'.",
          ),
        area: z
          .string()
          .optional()
          .describe("Optional free-text path/area hint (e.g. 'src/auth')."),
        provenance: z
          .string()
          .optional()
          .describe("Where the idea came from, or the epic/ticket ref."),
      },
    },
    async (args) => {
      // Length-bound + sanitize BEFORE applying. add_feature applies directly
      // (no human gate); bound the free-text fields and strip embedded
      // <untrusted-*> delimiter tokens so stored text can't break out of the
      // serve-time quarantine envelope. (name is also zod-capped at 200.)
      for (const [field, value] of [
        ["name", args.name],
        ["summary", args.summary],
        ["area", args.area],
        ["provenance", args.provenance],
      ] as const) {
        if (value === undefined) continue;
        const err = checkMaxLen(field, value, FEATURE_CAPS[field]);
        if (err) {
          audit({
            tool: "add_feature",
            request: { repo: args.repo, scope_node: args.scope_node },
            error: `${err.error}: ${err.provided} > ${err.max}`,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(err, null, 2) }],
          };
        }
      }
      try {
        const feature = addFeature(db, {
          repo: args.repo,
          scopeNode: args.scope_node,
          name: stripEnvelopeTokens(args.name),
          summary: stripEnvelopeTokens(args.summary),
          status: args.status,
          area: args.area === undefined ? undefined : stripEnvelopeTokens(args.area),
          provenance:
            args.provenance === undefined ? undefined : stripEnvelopeTokens(args.provenance),
        });
        audit({
          tool: "add_feature",
          request: {
            repo: args.repo,
            scope_node: args.scope_node,
            status: args.status,
          },
          resultCount: 1,
          resultIds: [feature.id],
        });
        const out = {
          ...featureForMcp(feature),
          message:
            "Feature added to the ledger (applied directly as a proposal). " +
            "Advance it with `advance_feature` as it moves to building / " +
            "shipped.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "add_feature",
          request: { repo: args.repo, scope_node: args.scope_node },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `add_feature failed: ${msg}` }],
        };
      }
    },
  );

  // ---- advance_feature -------------------------------------------------
  server.registerTool(
    "advance_feature",
    {
      title: "Advance a feature's lifecycle status",
      description:
        "Move a feature forward through its lifecycle: backlog → building → " +
        "shipped (or the direct backlog → shipped jump for things " +
        "inventoried as already present). Backward / same-state moves (e.g. " +
        "shipped → backlog) are rejected.\n\n" +
        "An advance INTO `shipped` is a FACTUAL POST-MERGE REFLECTION (the " +
        "feature is now in the product), so this APPLIES DIRECTLY rather " +
        "than going through the lore draft/review gate. Each transition is " +
        "recorded in the audit trail.",
      inputSchema: {
        id: z.string().min(1).describe("The feature id to advance."),
        to_status: z
          .enum(["backlog", "building", "shipped"])
          .describe("The status to move the feature to."),
      },
    },
    async (args) => {
      try {
        const feature = advanceFeature(db, args.id, args.to_status);
        audit({
          tool: "advance_feature",
          request: args as Record<string, unknown>,
          resultCount: 1,
          resultIds: [feature.id],
        });
        const out = {
          ...featureForMcp(feature),
          message: `Feature advanced to '${feature.status}' (applied directly).`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const reason = err instanceof AdvanceFeatureError ? err.reason : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "advance_feature",
          request: args as Record<string, unknown>,
          error: reason ? `${reason}: ${msg}` : msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `advance_feature failed: ${msg}` }],
        };
      }
    },
  );

  // ---- get_file_card ---------------------------------------------------
  server.registerTool(
    "get_file_card",
    {
      title: "Get a file card (retrieval aid — not authoritative source)",
      description:
        "Fetch the card for a single file in a repo. A card is a RETRIEVAL " +
        "AID that helps you choose what to read — it does NOT replace reading " +
        "the actual file before editing. Mechanical fields (path, symbols, loc) " +
        "are always present when a card exists. Model fields (tldr, role) are " +
        "only present when the summary passed validation (model_status=active).\n\n" +
        "Returns null when no active card exists for the path. Absence of a " +
        "card does NOT mean the file is unimportant — it means no card has been " +
        "written for it yet. Read the file directly in that case.\n\n" +
        "Pass `repoCanonical` = the repo's remote origin URL (preferred) or its " +
        "absolute realpath on disk. The display `repo` name is used for digest " +
        "and lore queries only.",
      inputSchema: {
        repoCanonical: z
          .string()
          .min(1)
          .describe(
            "Canonical repo identifier: remote origin URL (e.g. " +
              "'https://github.com/org/repo') or absolute local realpath. " +
              "Used as the stable repo identity key — do NOT use the display name.",
          ),
        repo: z.string().min(1).describe("Human-readable repo name (e.g. 'payments-svc')."),
        path: z
          .string()
          .min(1)
          .describe("Relative file path within the repo (e.g. 'src/api/payments.ts')."),
      },
    },
    async (args) => {
      try {
        const rk = repoKey(args.repoCanonical);
        const card = getFileCard(db, rk, args.path);
        audit({
          tool: "get_file_card",
          request: { repoCanonical: args.repoCanonical, repo: args.repo, path: args.path },
          resultCount: card ? 1 : 0,
          resultIds: card ? [card.id] : [],
        });
        const out = card
          ? {
              found: true,
              // Model-derived text (tldr / role_primary) is wrapped in the
              // quarantine envelope so it arrives as DATA, not instructions.
              // Mechanical fields (path, symbols, loc) stay raw.
              card: quarantineCard(card as unknown as Record<string, unknown>),
              security: QUARANTINE_NOTICE,
              caveat:
                "This card is a retrieval aid — verify against the actual file " +
                "before making changes. Model fields (tldr, role) are only present " +
                "when model_status='active'.",
            }
          : {
              found: false,
              path: args.path,
              message:
                "No active card for this path. The file may exist but have no " +
                "card yet, or the card may be stale/shadow. Read the file directly.",
            };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "get_file_card",
          request: { repoCanonical: args.repoCanonical, repo: args.repo, path: args.path },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `get_file_card failed: ${msg}` }],
        };
      }
    },
  );

  // ---- search_file_cards -----------------------------------------------
  server.registerTool(
    "search_file_cards",
    {
      title: "Search file cards (retrieval aid — not authoritative source)",
      description:
        "FTS5 search over file cards in a repo — searches path, tldr, and " +
        "symbol names. Returns cards ordered by bm25 relevance.\n\n" +
        "Cards are RETRIEVAL AIDS — they help you choose which files to inspect. " +
        "They do NOT replace reading the actual code before editing. Model fields " +
        "(tldr, role) are only present when model_status='active'; a card with " +
        "model_status='absent' still has useful mechanical fields (path, symbols).\n\n" +
        "For a budgeted, prioritised multi-tier assembly (path-first, then FTS, " +
        "then lore) use `cards_for_scope` instead — it is the preferred call " +
        "for starting a task.",
      inputSchema: {
        repoCanonical: z
          .string()
          .min(1)
          .describe("Canonical repo identifier: remote origin URL or absolute local realpath."),
        repo: z.string().min(1).describe("Human-readable repo name."),
        query: z.string().min(1).describe("Free-text query (FTS5 over path, tldr, symbols)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results. Default 20, hard cap 50."),
      },
    },
    async (args) => {
      try {
        const rk = repoKey(args.repoCanonical);
        const limit = Math.min(args.limit ?? 20, 50);
        const cards = searchFileCards(db, rk, args.query, limit);
        // FAIL LOUD but OUT-OF-BAND: an empty result while cards exist under a
        // different key is a canonical/key mismatch, not "no cards". Surface it
        // to stderr (operator log), NOT into the agent-facing result — the
        // diagnostic names other repos' keys and is untrusted context noise.
        // Consistent with every other diagnostic path (logs go to stderr).
        const diagnostic =
          cards.length === 0
            ? diagnoseRepoKeyMismatch(db, rk, args.repo, args.repoCanonical)
            : null;
        if (diagnostic) process.stderr.write(`memory-mcp: ${diagnostic}\n`);
        audit({
          tool: "search_file_cards",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
            limit,
          },
          resultCount: cards.length,
          resultIds: cards.map((c) => c.id),
        });
        const out = {
          query: args.query,
          repo: args.repo,
          count: cards.length,
          // Model-derived text on each card is wrapped in the quarantine
          // envelope so it arrives as DATA, not instructions.
          cards: cards.map((c) => quarantineCard(c as unknown as Record<string, unknown>)),
          security: QUARANTINE_NOTICE,
          caveat:
            "Cards are retrieval aids — use them to choose files to read, not " +
            "as a substitute for reading the code. Model fields (tldr, role) " +
            "are only present when model_status='active'.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "search_file_cards",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
          },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `search_file_cards failed: ${msg}` }],
        };
      }
    },
  );

  // ---- cards_for_scope ------------------------------------------------
  server.registerTool(
    "cards_for_scope",
    {
      title: "Get a budgeted scope packet of file cards (retrieval aids)",
      description:
        "**Call this at the START of a task** to orient yourself before reading " +
        "code. Returns a budgeted, prioritised packet of file cards relevant to " +
        "the given scope — plus the repo digest and top lore records.\n\n" +
        "RETRIEVAL AID FRAMING (non-negotiable):\n" +
        "  File cards help you CHOOSE WHAT TO READ. They are never authoritative\n" +
        "  source. Before editing any file, you MUST read the actual file or a\n" +
        "  real excerpt. Absence of a card does NOT mean the file is safe to\n" +
        "  ignore — it means no card exists yet.\n\n" +
        "SELECTION PRIORITY (deterministic signals always outrank fuzzy):\n" +
        "  1. Exact `paths` matches — highest confidence.\n" +
        "  2. Path-prefix matches of `paths` — files under those directories.\n" +
        "  3. `importantPaths` exact + prefix — caller-flagged context.\n" +
        "  4. FTS over path / tldr / symbols — fuzzy, never outranks filename hits.\n" +
        "  5. Repo digest + top lore — always included.\n\n" +
        "RESULT TRANSPARENCY:\n" +
        "  `omitted` lists cards excluded by budget + why.\n" +
        "  `coverage.missing` lists requested paths with no card in the DB.\n" +
        "  `truncationReason` explains why the result was cut short.\n" +
        "  Absence of a card ≠ the file is unimportant.",
      inputSchema: {
        repoCanonical: z
          .string()
          .min(1)
          .describe(
            "Canonical repo identifier: remote origin URL (preferred) or " +
              "absolute local realpath. Used as the stable repo identity key.",
          ),
        repo: z
          .string()
          .min(1)
          .describe("Human-readable repo name. Used for digest + lore queries."),
        query: z
          .string()
          .min(1)
          .describe(
            "Free-text scope description — the task, feature, or area being " +
              "changed. Used for FTS (tier 4) and lore lookup (tier 5).",
          ),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit file paths known to be in scope. Tier-1 = exact matches; " +
              "tier-2 = directory-prefix expansion (all files under these dirs). " +
              "Path-based cards always outrank FTS results.",
          ),
        importantPaths: z
          .array(z.string())
          .optional()
          .describe(
            "Additional paths the caller considers important context (tier 3). " +
              "Lower priority than `paths` but higher than FTS.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max cards to return. Default 20, hard cap 100."),
        maxTokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Overall token budget (estimated as chars/4). Cards that would push " +
              "the total over this limit are moved to `omitted`.",
          ),
        perCardMaxTokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Per-card token cap. Cards exceeding this have their `tldr` " +
              "truncated to fit. The card is still returned — truncated content " +
              "is better than no content.",
          ),
      },
    },
    async (args) => {
      try {
        const maxCards = Math.min(args.limit ?? 20, 100);
        const packet = cardsForScope(db, {
          repoCanonical: args.repoCanonical,
          repo: args.repo,
          query: args.query,
          paths: args.paths,
          importantPaths: args.importantPaths,
          maxCards,
          maxTokens: args.maxTokens,
          perCardMaxTokens: args.perCardMaxTokens,
        });
        audit({
          tool: "cards_for_scope",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
            pathCount: args.paths?.length ?? 0,
            maxCards,
          },
          resultCount: packet.cards.length,
          resultIds: packet.cards.map((c) => c.id),
        });
        // A canonical/key mismatch diagnostic is an operator concern — log it
        // to stderr, never into the agent-facing packet (it names other repos'
        // keys and is untrusted noise). Consistent with search_file_cards.
        const { diagnostics, ...packetRest } = packet;
        if (diagnostics?.length) {
          for (const d of diagnostics) process.stderr.write(`memory-mcp: ${d}\n`);
        }
        // Wrap every agent-facing free-text span in the packet — cards, the
        // repo digest, and the lore hits — in the quarantine envelope. This
        // packet is the START-OF-TASK orientation context, the single biggest
        // poisoning surface, so all three record kinds arrive as DATA, never
        // instructions. Selection metadata / paths / coverage stay raw.
        const out = {
          ...packetRest,
          cards: packet.cards.map((c) => quarantineCard(c as unknown as Record<string, unknown>)),
          digest: packet.digest
            ? quarantineDigest(packet.digest as unknown as Record<string, unknown>)
            : packet.digest,
          lore: packet.lore.map((l) => quarantineLore(l as unknown as Record<string, unknown>)),
          security: QUARANTINE_NOTICE,
          caveat:
            "File cards are retrieval aids — use them to choose what to read, " +
            "not as a substitute for reading the actual code. Before editing any " +
            "file, read the real file or a real excerpt. Absence of a card ≠ the " +
            "file is unimportant.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "cards_for_scope",
          request: {
            repoCanonical: args.repoCanonical,
            repo: args.repo,
            query: args.query,
          },
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `cards_for_scope failed: ${msg}` }],
        };
      }
    },
  );

  return server;
}
