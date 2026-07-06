import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../../core/audit.js";
import { recordAbsence } from "../../core/absence.js";
import { ABSENCE_DISABLED_REFUSAL, shouldGateAbsenceWrite } from "../redact.js";

/**
 * Register the verified-absence MCP tool onto `server`:
 *
 *   - record_absence — mark a topic as an acknowledged team-known gap so a
 *                      future search_lore on the same normalised query
 *                      surfaces "we checked, known gap" rather than a bare
 *                      empty result. Markers self-expire.
 */
export function registerAbsenceTools(server: McpServer, db: Database): void {
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
}
