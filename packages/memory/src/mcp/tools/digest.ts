import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../../core/audit.js";
import { getDigest, upsertDigest } from "../../core/repoUnderstanding.js";
import { checkMaxLen, DIGEST_CAPS } from "../validation.js";
import { quarantineDigest, QUARANTINE_NOTICE, stripEnvelopeTokens } from "../quarantine.js";

/**
 * Register the repo-digest MCP tools onto `server`:
 *
 *   - get_repo_digest    — fetch a repo's living TLDR (overview / structure /
 *                          conventions / stack), quarantine-wrapped.
 *   - update_repo_digest — write/replace the single current digest directly
 *                          (a factual post-merge reflection, not a draft).
 */
export function registerDigestTools(server: McpServer, db: Database): void {
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
}
