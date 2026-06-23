/**
 * Tests the ASYNC McpMemoryClient against a MOCK in-process Memory MCP
 * server (an @modelcontextprotocol/sdk server over InMemoryTransport exposing
 * fake `search_lore` / `suggest_lore` tools). No real Memory server needed.
 *
 * Asserts:
 *   - search_lore maps records (tolerating snake_case / missing fields);
 *   - suggest_lore returns a draft suggestion id;
 *   - a connection failure and a handler failure both degrade cleanly to a
 *     structured MEMORY_UNAVAILABLE CrewError.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { McpMemoryClient } from "../src/memory/mcpClient.js";
import { CrewError } from "../src/util/errors.js";

interface MockOptions {
  /** Records returned by search_lore (defaults to a small fixture set). */
  records?: Array<Record<string, unknown>>;
  /** When true, every tool handler throws — simulating a broken server. */
  failHandlers?: boolean;
}

/** A configurable in-process Memory MCP server for tests. */
function mockMemoryServer(opts: MockOptions = {}): McpServer {
  const server = new McpServer({ name: "mock-memory", version: "0.0.0" });
  const records = opts.records ?? [
    // Mixed shapes: one canonical, one snake_case, one missing fields.
    {
      id: "L1",
      title: "Use argon2id",
      summary: "Hash with argon2id",
      tags: ["auth"],
      recordType: "convention",
    },
    {
      id: "L2",
      title: "Hooks only",
      summary: "Functional components",
      tags: ["react"],
      record_type: "convention",
    },
    { title: "No id here", tags: ["misc"] },
  ];

  server.registerTool(
    "search_lore",
    {
      description: "Search lore",
      inputSchema: {
        tags: z.array(z.string()).optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async () => {
      if (opts.failHandlers) throw new Error("search boom");
      const data = { records };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "suggest_lore",
    {
      description: "Suggest lore",
      inputSchema: { title: z.string(), summary: z.string(), tags: z.array(z.string()).optional() },
    },
    async () => {
      if (opts.failHandlers) throw new Error("suggest boom");
      const data = { suggestionId: "draft-42", status: "draft" };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  // Repo Understanding tools (update_repo_digest / add_feature / list_features).
  server.registerTool(
    "update_repo_digest",
    {
      description: "Upsert a repo digest",
      inputSchema: {
        repo: z.string(),
        overview: z.string(),
        structure: z.string(),
        conventions: z.string(),
        stack: z.string().optional(),
        source: z.string(),
      },
    },
    async ({ repo }) => {
      if (opts.failHandlers) throw new Error("digest boom");
      const data = { repo, status: "updated" };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "add_feature",
    {
      description: "Add a feature",
      inputSchema: {
        repo: z.string(),
        name: z.string(),
        summary: z.string(),
        status: z.string(),
        area: z.string(),
        provenance: z.string(),
        scope_node: z.string().optional(),
      },
    },
    async ({ name, scope_node }) => {
      if (opts.failHandlers) throw new Error("feature boom");
      const data = { feature_id: `f-${name}`, status: "added", scope_node: scope_node ?? null };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "list_features",
    {
      description: "List features",
      inputSchema: { repo: z.string(), status: z.string().optional() },
    },
    async ({ repo, status }) => {
      if (opts.failHandlers) throw new Error("list boom");
      // When a status filter is given, return the richer backlog row shape with
      // id/summary/priority/created_at so the backlog loop can order candidates.
      const data = status
        ? {
            features: [
              {
                id: "feat-9",
                repo,
                name: "Data export",
                summary: "Export as CSV",
                status,
                priority: 2,
                created_at: "2026-02-01T00:00:00.000Z",
              },
              // A row with a DIFFERENT status to prove client-side filtering.
              { id: "feat-shipped", repo, name: "Old thing", status: "shipped" },
            ],
          }
        : { features: [{ repo, name: "Existing feature" }] };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "advance_feature",
    { description: "Advance a feature", inputSchema: { id: z.string(), toStatus: z.string() } },
    async ({ id, toStatus }) => {
      if (opts.failHandlers) throw new Error("advance boom");
      const data = { id, status: toStatus };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  return server;
}

async function connectClient(server: McpServer): Promise<McpMemoryClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return McpMemoryClient.connectTransport(clientTransport);
}

describe("McpMemoryClient", () => {
  it("maps search_lore results into LoreRecord[] tolerating odd shapes", async () => {
    const client = await connectClient(mockMemoryServer());
    const records = await client.searchLore({ tags: ["auth"], text: "reset", limit: 10 });

    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({
      id: "L1",
      title: "Use argon2id",
      summary: "Hash with argon2id",
      tags: ["auth"],
      recordType: "convention",
    });
    // snake_case record_type is remapped to recordType.
    expect(records[1]!.recordType).toBe("convention");
    // Missing fields are filled defensively rather than throwing.
    expect(records[2]!.id).toMatch(/^lore-/);
    expect(records[2]!.summary).toBe("");
    expect(records[2]!.recordType).toBe("unknown");

    await client.close();
  });

  it("suggest_lore returns a draft suggestion id", async () => {
    const client = await connectClient(mockMemoryServer());
    const result = await client.suggestLore({
      title: "New rule",
      summary: "Do the thing",
      tags: ["x"],
    });

    expect(result.status).toBe("draft");
    expect(result.suggestionId).toBe("draft-42");

    await client.close();
  });

  it("update_repo_digest passes the digest through and maps a non-secret scope arg", async () => {
    const client = await connectClient(mockMemoryServer());
    const result = await client.updateRepoDigest({
      repo: "api",
      overview: "o",
      structure: "s",
      conventions: "c",
      stack: "typescript",
      source: "onboard",
    });
    expect(result.repo).toBe("api");
    expect(result.status).toBe("updated");
    await client.close();
  });

  it("add_feature returns a feature id; list_features maps existing records", async () => {
    const client = await connectClient(mockMemoryServer());
    const added = await client.addFeature({
      repo: "api",
      name: "Build pipeline",
      summary: "Builds via tsc",
      status: "shipped",
      area: "build",
      provenance: "onboard",
      scopeNode: "Checkout",
    });
    expect(added.status).toBe("added");
    expect(added.featureId).toBe("f-Build pipeline");

    const existing = await client.listFeatures("api");
    expect(existing).toEqual([{ repo: "api", name: "Existing feature" }]);
    await client.close();
  });

  it("list_features(repo, {status}) maps backlog rows and filters off-status rows", async () => {
    const client = await connectClient(mockMemoryServer());
    const backlog = await client.listBacklogFeatures("api", "backlog");
    expect(backlog).toHaveLength(1); // the shipped row is filtered out
    expect(backlog[0]).toMatchObject({
      id: "feat-9",
      repo: "api",
      name: "Data export",
      summary: "Export as CSV",
      status: "backlog",
      priority: 2,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await client.close();
  });

  it("advance_feature returns the new status", async () => {
    const client = await connectClient(mockMemoryServer());
    const result = await client.advanceFeature("feat-9", "building");
    expect(result).toEqual({ id: "feat-9", status: "building" });
    await client.close();
  });

  it("digest/feature tools degrade cleanly when a handler fails", async () => {
    const client = await connectClient(mockMemoryServer({ failHandlers: true }));
    await expect(
      client.updateRepoDigest({
        repo: "r",
        overview: "o",
        structure: "s",
        conventions: "c",
        stack: null,
        source: "onboard",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_UNAVAILABLE" });
    await expect(
      client.addFeature({
        repo: "r",
        name: "n",
        summary: "s",
        status: "shipped",
        area: "a",
        provenance: "onboard",
      }),
    ).rejects.toBeInstanceOf(CrewError);
    await expect(client.listFeatures("r")).rejects.toMatchObject({ code: "MEMORY_UNAVAILABLE" });
    await client.close();
  });

  it("degrades cleanly when a handler fails (MEMORY_UNAVAILABLE)", async () => {
    const client = await connectClient(mockMemoryServer({ failHandlers: true }));

    await expect(client.searchLore({ tags: ["auth"] })).rejects.toMatchObject({
      code: "MEMORY_UNAVAILABLE",
    });
    await expect(client.suggestLore({ title: "t", summary: "s" })).rejects.toBeInstanceOf(
      CrewError,
    );

    await client.close();
  });

  it("degrades cleanly on connection failure (MEMORY_UNAVAILABLE)", async () => {
    // A command that cannot be spawned forces the stdio connect to fail.
    await expect(
      McpMemoryClient.connect({ command: "definitely-not-a-real-binary-xyz", args: [] }),
    ).rejects.toMatchObject({ code: "MEMORY_UNAVAILABLE" });
  });

  it("returns [] when search_lore yields no recognisable payload", async () => {
    const server = new McpServer({ name: "empty-memory", version: "0.0.0" });
    server.registerTool("search_lore", { description: "Search", inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "not json at all" }],
      structuredContent: {},
    }));
    server.registerTool(
      "suggest_lore",
      { description: "Suggest", inputSchema: { title: z.string(), summary: z.string() } },
      async () => ({ content: [{ type: "text" as const, text: "{}" }], structuredContent: {} }),
    );
    const client = await connectClient(server);

    expect(await client.searchLore({ tags: ["x"] })).toEqual([]);
    // A suggest with no id still yields a draft (defensive default).
    const suggestion = await client.suggestLore({ title: "t", summary: "s" });
    expect(suggestion.status).toBe("draft");
    expect(suggestion.suggestionId).toBe("memory-suggestion");

    await client.close();
  });
});
