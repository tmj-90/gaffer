import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../../core/audit.js";
import { findDependents, suggestBoundary } from "../../core/boundaries.js";
import type { Boundary } from "../../db/types.js";

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
 * Register the cross-repo boundary MCP tools onto `server`:
 *
 *   - find_dependents  — return the providers + consumers of a contract, so
 *                        the consumers list is the blast radius of a change.
 *   - declare_boundary — record a producer/consumer edge as a DRAFT until a
 *                        human ratifies it.
 */
export function registerBoundaryTools(server: McpServer, db: Database): void {
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
}
