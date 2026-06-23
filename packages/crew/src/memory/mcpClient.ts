/**
 * Real, ASYNC Memory client backed by a Memory MCP server over stdio.
 *
 * IMPORTANT: this is intentionally async and lives OUTSIDE the synchronous hot
 * path. Crew's sync `MemoryClient` interface (and the sync packet
 * builder) are never made async. Instead, callers pre-fetch lore with this
 * client at the already-async CLI/MCP entry points, seed a sync
 * `StubMemoryClient` for the packet build, and flush suggestions async
 * afterwards (see `prefetch.ts`).
 *
 * The client maps Memory MCP tools to Crew's record/suggestion shapes:
 *   - `search_lore` (and/or `get_lore`) -> `LoreRecord[]`
 *   - `suggest_lore`                     -> `LoreSuggestionResult`
 *
 * Tool results are validated/normalised with zod and tolerate missing fields.
 * Any connection failure surfaces as a structured `CrewError`
 * (`MEMORY_UNAVAILABLE`); callers degrade to the Null client rather than crash.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { CrewError } from "../util/errors.js";
import type {
  AdvanceFeatureResult,
  BacklogFeature,
  ExistingFeature,
  FeatureInput,
  FeatureResult,
  FeatureStatus,
  LoreRecord,
  LoreSearchQuery,
  LoreSuggestionInput,
  LoreSuggestionResult,
  RepoDigestInput,
  RepoDigestResult,
} from "./client.js";

const FEATURE_STATUSES: ReadonlySet<string> = new Set(["backlog", "building", "shipped"]);

/** Coerce an arbitrary status string into a known FeatureStatus, defaulting to `backlog`. */
function coerceFeatureStatus(value: unknown, fallback: FeatureStatus = "backlog"): FeatureStatus {
  return typeof value === "string" && FEATURE_STATUSES.has(value)
    ? (value as FeatureStatus)
    : fallback;
}

/** Async mirror of the sync `MemoryClient`. Used only by pre-fetch helpers. */
export interface AsyncMemoryClient {
  searchLore(query: LoreSearchQuery): Promise<LoreRecord[]>;
  suggestLore(input: LoreSuggestionInput): Promise<LoreSuggestionResult>;
  /** Upsert the repo digest (by `repo`) via Memory's `update_repo_digest`. */
  updateRepoDigest(input: RepoDigestInput): Promise<RepoDigestResult>;
  /** List the features already recorded for a repo (`list_features`), for de-dupe. */
  listFeatures(repo: string): Promise<ExistingFeature[]>;
  /**
   * List feature ledger rows for a repo filtered by lifecycle status, with the
   * detail (id, summary, priority, createdAt) needed to pick a candidate. Maps to
   * `list_features(repo, { status })`.
   */
  listBacklogFeatures(repo: string, status: FeatureStatus): Promise<BacklogFeature[]>;
  /** Record one feature via Memory's `add_feature`. */
  addFeature(input: FeatureInput): Promise<FeatureResult>;
  /**
   * Advance a feature's lifecycle status (`backlog → building → shipped`). Maps to
   * `advance_feature(id, toStatus)`. Used to claim a backlog feature (so it is not
   * picked twice) and to roll it back on a downstream failure.
   */
  advanceFeature(id: string, toStatus: FeatureStatus): Promise<AdvanceFeatureResult>;
  close(): Promise<void>;
}

export interface McpMemoryConfig {
  /** Executable that starts the Memory MCP server (stdio). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Optional working directory + environment for the spawned server. */
  cwd?: string;
  env?: Record<string, string>;
}

// ── Defensive result normalisation ──────────────────────────────────────────
//
// Memory tools may return either a plain object via `structuredContent` or a
// JSON string in `content[0].text`. We tolerate both, and tolerate missing
// fields on every record.

const loreRecordSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    recordType: z.string().optional(),
    // Memory may use snake_case; accept and remap.
    record_type: z.string().optional(),
  })
  .passthrough();

const searchResultSchema = z
  .object({
    records: z.array(loreRecordSchema).optional(),
    results: z.array(loreRecordSchema).optional(),
    lore: z.array(loreRecordSchema).optional(),
  })
  .passthrough();

const suggestResultSchema = z
  .object({
    suggestionId: z.string().optional(),
    suggestion_id: z.string().optional(),
    id: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const repoDigestResultSchema = z
  .object({
    repo: z.string().optional(),
    status: z.string().optional(),
    created: z.boolean().optional(),
    updated: z.boolean().optional(),
  })
  .passthrough();

const featureResultSchema = z
  .object({
    featureId: z.string().optional(),
    feature_id: z.string().optional(),
    id: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const featureRecordSchema = z
  .object({
    repo: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const listFeaturesResultSchema = z
  .object({
    features: z.array(featureRecordSchema).optional(),
    results: z.array(featureRecordSchema).optional(),
  })
  .passthrough();

/** A richer feature row carrying id/summary/status/ordering fields (list_features). */
const backlogFeatureSchema = z
  .object({
    id: z.string().optional(),
    feature_id: z.string().optional(),
    featureId: z.string().optional(),
    repo: z.string().optional(),
    name: z.string().optional(),
    summary: z.string().optional(),
    status: z.string().optional(),
    priority: z.number().optional(),
    createdAt: z.string().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

const listBacklogFeaturesResultSchema = z
  .object({
    features: z.array(backlogFeatureSchema).optional(),
    results: z.array(backlogFeatureSchema).optional(),
  })
  .passthrough();

const advanceFeatureResultSchema = z
  .object({
    id: z.string().optional(),
    feature_id: z.string().optional(),
    featureId: z.string().optional(),
    status: z.string().optional(),
    toStatus: z.string().optional(),
    to_status: z.string().optional(),
  })
  .passthrough();

/** The CallToolResult shape we read from (only the bits we need). */
const callToolResultSchema = z
  .object({
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
      .optional(),
    structuredContent: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

function normaliseRecord(raw: z.infer<typeof loreRecordSchema>, index: number): LoreRecord {
  return {
    id: raw.id ?? `lore-${index}`,
    title: raw.title ?? "",
    summary: raw.summary ?? "",
    tags: raw.tags ?? [],
    recordType: raw.recordType ?? raw.record_type ?? "unknown",
  };
}

/**
 * Extract the structured payload from a CallToolResult. Prefers
 * `structuredContent`; falls back to parsing the first text block as JSON.
 * Returns `{}` (not a throw) when no structured payload is recoverable, so an
 * empty/odd tool response degrades to "no records" rather than an error.
 */
function payloadFrom(rawResult: unknown): Record<string, unknown> {
  const parsed = callToolResultSchema.safeParse(rawResult);
  if (!parsed.success) return {};
  const result = parsed.data;
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    return result.structuredContent;
  }
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return {};
  try {
    const decoded: unknown = JSON.parse(text);
    return typeof decoded === "object" && decoded !== null
      ? (decoded as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class McpMemoryClient implements AsyncMemoryClient {
  private constructor(private readonly client: Client) {}

  /**
   * Connect to the Memory MCP server. A connection failure (bad command,
   * handshake error) is wrapped as `MEMORY_UNAVAILABLE` so callers can
   * degrade to the Null client. Tests inject an in-memory transport via
   * {@link connectTransport}.
   */
  static async connect(config: McpMemoryConfig): Promise<McpMemoryClient> {
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: config.env } : {}),
    });
    return McpMemoryClient.connectTransport(transport, {
      command: config.command,
      args: config.args,
    });
  }

  /** Connect over an arbitrary transport (used by tests with InMemoryTransport). */
  static async connectTransport(
    transport: Transport,
    details: Record<string, unknown> = {},
  ): Promise<McpMemoryClient> {
    const client = new Client({ name: "crew-memory", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (err) {
      throw new CrewError("MEMORY_UNAVAILABLE", "Failed to connect to the Memory MCP server.", {
        ...details,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return new McpMemoryClient(client);
  }

  async searchLore(query: LoreSearchQuery): Promise<LoreRecord[]> {
    // memory-mcp arg names: `query` (free text), `repo` (singular), `tag` (string
    // or array). Map Crew's query shape onto them.
    const args: Record<string, unknown> = {};
    if (query.tags && query.tags.length > 0) args.tag = query.tags;
    if (query.text) args.query = query.text;
    if (query.repoName) args.repo = query.repoName;
    if (typeof query.limit === "number") args.limit = query.limit;

    const raw = await this.callTool("search_lore", args);
    const parsed = searchResultSchema.safeParse(payloadFrom(raw));
    if (!parsed.success) return [];
    const records = parsed.data.records ?? parsed.data.results ?? parsed.data.lore ?? [];
    return records.map(normaliseRecord);
  }

  async suggestLore(input: LoreSuggestionInput): Promise<LoreSuggestionResult> {
    // memory-mcp requires a non-empty `body`; reuse the summary and fold the
    // originating ticket reference into it (memory-mcp's `source` must be a URL,
    // so a ticket id can't go there).
    const body = input.sourceTicketId
      ? `${input.summary}\n\nSource ticket: ${input.sourceTicketId}`
      : input.summary;
    const args: Record<string, unknown> = {
      title: input.title,
      summary: input.summary,
      body,
    };
    if (input.tags) args.tags = input.tags;

    const raw = await this.callTool("suggest_lore", args);
    const parsed = suggestResultSchema.safeParse(payloadFrom(raw));
    const suggestionId = parsed.success
      ? (parsed.data.suggestionId ?? parsed.data.suggestion_id ?? parsed.data.id)
      : undefined;
    // Suggestions are always drafts by contract — never auto-approved.
    return { suggestionId: suggestionId ?? "memory-suggestion", status: "draft" };
  }

  async updateRepoDigest(input: RepoDigestInput): Promise<RepoDigestResult> {
    // `update_repo_digest` upserts by `repo` (writes apply directly, off the
    // lore draft gate). We pass the digest fields straight through; the server
    // owns the create-vs-update decision.
    const args: Record<string, unknown> = {
      repo: input.repo,
      overview: input.overview,
      structure: input.structure,
      conventions: input.conventions,
      source: input.source,
    };
    if (input.stack !== null) args.stack = input.stack;

    const raw = await this.callTool("update_repo_digest", args);
    const parsed = repoDigestResultSchema.safeParse(payloadFrom(raw));
    // Honour an explicit server signal; only assume "updated" (the upsert's
    // common case) when the server tells us nothing.
    const status =
      parsed.success && (parsed.data.status === "created" || parsed.data.created === true)
        ? "created"
        : "updated";
    return { repo: input.repo, status };
  }

  async listFeatures(repo: string): Promise<ExistingFeature[]> {
    const raw = await this.callTool("list_features", { repo });
    const parsed = listFeaturesResultSchema.safeParse(payloadFrom(raw));
    if (!parsed.success) return [];
    const features = parsed.data.features ?? parsed.data.results ?? [];
    return features
      .filter((f): f is { repo?: string; name: string } => typeof f.name === "string")
      .map((f) => ({ repo: f.repo ?? repo, name: f.name }));
  }

  async listBacklogFeatures(repo: string, status: FeatureStatus): Promise<BacklogFeature[]> {
    const raw = await this.callTool("list_features", { repo, status });
    const parsed = listBacklogFeaturesResultSchema.safeParse(payloadFrom(raw));
    if (!parsed.success) return [];
    const features = parsed.data.features ?? parsed.data.results ?? [];
    return features
      .map((f): BacklogFeature | null => {
        const id = f.id ?? f.feature_id ?? f.featureId;
        if (typeof id !== "string" || typeof f.name !== "string") return null;
        // A server that ignores the status filter could return mixed rows; keep
        // only the requested status so callers never act on the wrong lifecycle.
        const rowStatus = coerceFeatureStatus(f.status, status);
        if (rowStatus !== status) return null;
        const feature: BacklogFeature = {
          id,
          repo: f.repo ?? repo,
          name: f.name,
          summary: f.summary ?? "",
          status: rowStatus,
        };
        if (typeof f.priority === "number") feature.priority = f.priority;
        const createdAt = f.createdAt ?? f.created_at;
        if (typeof createdAt === "string") feature.createdAt = createdAt;
        return feature;
      })
      .filter((f): f is BacklogFeature => f !== null);
  }

  async advanceFeature(id: string, toStatus: FeatureStatus): Promise<AdvanceFeatureResult> {
    const raw = await this.callTool("advance_feature", { id, toStatus });
    const parsed = advanceFeatureResultSchema.safeParse(payloadFrom(raw));
    const status = parsed.success
      ? coerceFeatureStatus(
          parsed.data.status ?? parsed.data.toStatus ?? parsed.data.to_status,
          toStatus,
        )
      : toStatus;
    return { id, status };
  }

  async addFeature(input: FeatureInput): Promise<FeatureResult> {
    const args: Record<string, unknown> = {
      repo: input.repo,
      name: input.name,
      summary: input.summary,
      status: input.status,
      area: input.area,
      provenance: input.provenance,
    };
    if (input.scopeNode !== undefined) args.scope_node = input.scopeNode;

    const raw = await this.callTool("add_feature", args);
    const parsed = featureResultSchema.safeParse(payloadFrom(raw));
    const featureId = parsed.success
      ? (parsed.data.featureId ?? parsed.data.feature_id ?? parsed.data.id)
      : undefined;
    // Forward a server-side de-dupe signal ("skipped") rather than always
    // claiming "added"; the server may have its own idempotency.
    const status = parsed.success && parsed.data.status === "skipped" ? "skipped" : "added";
    return { featureId: featureId ?? "memory-feature", status };
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Closing a dead transport must never throw into the caller's cleanup path.
    }
  }

  /**
   * Call a tool, wrapping both protocol failures (callTool rejects) AND
   * tool-level failures (`isError: true`, e.g. the server handler threw) as a
   * structured MEMORY_UNAVAILABLE so callers degrade cleanly.
   */
  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    let raw: unknown;
    try {
      raw = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      throw new CrewError("MEMORY_UNAVAILABLE", `Memory tool '${name}' failed.`, {
        tool: name,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    const parsed = callToolResultSchema.safeParse(raw);
    if (parsed.success && parsed.data.isError === true) {
      const text = parsed.data.content?.find((c) => c.type === "text")?.text;
      throw new CrewError("MEMORY_UNAVAILABLE", `Memory tool '${name}' reported an error.`, {
        tool: name,
        ...(text ? { detail: text } : {}),
      });
    }
    return raw;
  }
}
