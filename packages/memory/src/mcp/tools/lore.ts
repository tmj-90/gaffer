import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../../core/audit.js";
import { findActiveAbsence } from "../../core/absence.js";
import {
  findPossibleDuplicates,
  getLore,
  reportConflict,
  ReportConflictError,
  searchLore,
  searchLoreCount,
  suggestLore,
} from "../../core/lore.js";
import {
  buildSearchResponseBody,
  CONFLICT_AGAINST_RESTRICTED_REFUSAL,
  redactRestricted,
  shouldGateRestrictedGet,
  shouldRefuseConflictAgainstRestricted,
  stripPossibleConflicts,
} from "../redact.js";
import { auditMessageForTooLong, checkLength, LENGTH_CAPS } from "../validation.js";
import { quarantineLore, QUARANTINE_NOTICE } from "../quarantine.js";

/**
 * Register the lore-knowledge MCP tools onto `server`:
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
 *   - report_conflict — a persisted, evidence-backed disagreement with an
 *                    active record; lands as a linked counter-draft.
 */
export function registerLoreTools(server: McpServer, db: Database): void {
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
          ...quarantineLore(lore),
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
        spec_id: z
          .string()
          .optional()
          .describe(
            "Structured provenance: id of the frozen spec this record was seeded " +
              "from (Spec-Driven Development). Pair with clause_id. Omit for ordinary lore.",
          ),
        clause_id: z
          .string()
          .optional()
          .describe("Structured provenance: stable clause id within spec_id. Pair with spec_id."),
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
        spec_id: args.spec_id,
        clause_id: args.clause_id,
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
            ...(args.spec_id ? { specId: args.spec_id } : {}),
            ...(args.clause_id ? { clauseId: args.clause_id } : {}),
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
}
