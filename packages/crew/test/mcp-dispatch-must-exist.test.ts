/**
 * crew-mcp never creates a missing Dispatch DB.
 *
 * Regression: the MCP server's default opener was a bare `openDispatch`, and
 * Dispatch.open CREATES a missing sqlite. On a factory whose DB was absent (or
 * whose path drifted), the read-only `list_repos` / `check_path_write_allowed`
 * left an empty dispatch.sqlite behind, and `run_idle_loop` filed drafts into
 * it while `crew idle` on the same factory refused with DISPATCH_UNAVAILABLE.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initFactory } from "../src/config/init.js";
import { resolveSqlitePath } from "../src/config/loader.js";
import { mcpDispatchOpener } from "../src/mcp/server.js";
import { makeHandlers, type ToolResult } from "../src/mcp/tools.js";
import { loadFactory } from "../src/runtime/wiring.js";

function structured(result: ToolResult): Record<string, unknown> {
  return result.structuredContent;
}

/** Every *.sqlite file under `dir` (the factory root and its data dir). */
function sqliteFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.includes(".sqlite"));
}

describe("crew-mcp's default opener refuses a missing Dispatch DB", () => {
  let tmp: string;
  let ctx: ReturnType<typeof loadFactory>;
  let dbPath: string;
  const savedEnv = process.env.CREW_DISPATCH_DB;

  beforeEach(() => {
    delete process.env.CREW_DISPATCH_DB; // resolve crew.yaml's own sqlite_path
    tmp = mkdtempSync(join(tmpdir(), "gaffer-mcp-must-exist-"));
    initFactory({ dir: tmp, factoryName: "mcp-must-exist", force: true });
    ctx = loadFactory({ config: join(tmp, "crew.yaml") });
    dbPath = resolveSqlitePath(ctx.loaded);
    expect(dbPath.startsWith(tmp)).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.CREW_DISPATCH_DB;
    else process.env.CREW_DISPATCH_DB = savedEnv;
  });

  function handlers() {
    return makeHandlers({
      ctx,
      openDispatch: mcpDispatchOpener,
      audit: { env: { GAFFER_AUDIT_OFF: "1" } },
    });
  }

  it("list_repos answers from crew.yaml and creates no sqlite", async () => {
    const result = await handlers().list_repos({});
    expect(result.isError).toBeFalsy();
    const repos = structured(result).repos as Array<{ id: string }>;
    expect(repos.map((r) => r.id)).toEqual(ctx.repoRegistry.list().map((r) => r.id));
    expect(existsSync(dbPath)).toBe(false);
    expect(sqliteFiles(tmp)).toEqual([]);
  });

  it("check_path_write_allowed answers and creates no sqlite", async () => {
    const result = await handlers().check_path_write_allowed({ path: join(tmp, "x.txt") });
    expect(result.isError).toBeFalsy();
    expect(structured(result).decision).toBeDefined();
    expect(existsSync(dbPath)).toBe(false);
    expect(sqliteFiles(tmp)).toEqual([]);
  });

  it("run_idle_loop fails with DISPATCH_UNAVAILABLE, like `crew idle`, and creates nothing", async () => {
    const result = await handlers().run_idle_loop({});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("DISPATCH_UNAVAILABLE");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(dirname(dbPath)) ? sqliteFiles(dirname(dbPath)) : []).toEqual([]);
    expect(sqliteFiles(tmp)).toEqual([]);
  });

  it("get_factory_status reports dispatch.ok=false instead of creating the DB", async () => {
    const status = structured(await handlers().get_factory_status({}));
    expect(status.dispatch).toMatchObject({ ok: false, error: { code: "DISPATCH_UNAVAILABLE" } });
    expect(sqliteFiles(tmp)).toEqual([]);
  });
});
