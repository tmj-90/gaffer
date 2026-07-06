import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { audit } from "../../core/audit.js";
import {
  addFeature,
  advanceFeature,
  AdvanceFeatureError,
  listFeatures,
} from "../../core/repoUnderstanding.js";
import type { Feature } from "../../db/types.js";
import { checkMaxLen, FEATURE_CAPS } from "../validation.js";
import { quarantineFeature, stripEnvelopeTokens } from "../quarantine.js";

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
 * Register the feature-ledger MCP tools onto `server`:
 *
 *   - list_features   — list a repo's features, filterable by status /
 *                       scope-node.
 *   - add_feature     — add a feature (defaults to backlog); applies directly
 *                       as a proposal.
 *   - advance_feature — move a feature forward through its lifecycle.
 */
export function registerFeatureTools(server: McpServer, db: Database): void {
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
}
