/**
 * PARITY (external review #7): crew's memory client against the REAL memory-mcp in
 * factory context. An UNAPPROVED draft one agent filed must be invisible to another
 * agent in every read path: search (even when it asks for drafts), the duplicate
 * feedback suggest_lore returns, and a direct get_lore by id. Needs the memory package
 * built (CI builds first); skipped otherwise.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpMemoryClient, memoryServerEnv } from "../src/memory/mcpClient.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMORY_MCP_BIN = resolve(HERE, "../../memory/dist/bin/memory-mcp.js");

describe.runIf(existsSync(MEMORY_MCP_BIN))(
  "factory memory-mcp: drafts are invisible to other agents",
  () => {
    let dir: string;
    let env: Record<string, string>;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "crew-draft-parity-"));
      env = {
        MEMORY_DB: join(dir, "memory.sqlite"),
        MEMORY_AUDIT_OFF: "1",
        GAFFER_FACTORY: "1",
        GAFFER_TICKET_REPOS: "svc",
      };
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const crewClient = () =>
      McpMemoryClient.connect({ command: process.execPath, args: [MEMORY_MCP_BIN], env });
    async function rawCall(tool: string, args: Record<string, unknown>): Promise<string> {
      const c = new Client({ name: "agent-b", version: "1" });
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [MEMORY_MCP_BIN],
          env: memoryServerEnv(process.env, env),
        }),
      );
      try {
        const r = (await c.callTool({ name: tool, arguments: args })) as {
          content: Array<{ text: string }>;
        };
        return r.content.map((b) => b.text).join("");
      } finally {
        await c.close();
      }
    }

    it("search (includeDrafts), duplicate feedback and get_lore never return agent A's draft", async () => {
      const a = await crewClient();
      const draft = await a.suggestLore({
        title: "Rotate payment webhook signing secret quarterly",
        summary: "DRAFT-TEXT unapproved advice from agent A",
        tags: ["payments"],
      });
      await a.close();
      expect(draft.status).toBe("draft");

      const b = await crewClient();
      const found = await b.searchLore({ text: "rotate payment webhook", includeDrafts: true });
      await b.close();
      expect(found.map((r) => r.id)).not.toContain(draft.suggestionId);

      const dup = await rawCall("suggest_lore", {
        title: "Rotate payment webhook signing key",
        summary: "B",
        body: "B body",
        repos: ["svc"],
      });
      expect(dup).not.toContain(draft.suggestionId);
      expect(dup).not.toContain("DRAFT-TEXT");

      const got = await rawCall("get_lore", { id: draft.suggestionId });
      expect(JSON.parse(got)).toEqual({ found: false, id: draft.suggestionId });
    }, 60_000);
  },
);
