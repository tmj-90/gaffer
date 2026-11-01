/**
 * PRINCIPAL SCOPES migration (schema v30 -> v31, exploratory finding
 * rough-scopes-review/migration): the two scope columns are added to an existing
 * api_principals table, a principal minted before them keeps working with no scope
 * (full access, as before), and opening the database again changes nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("schema v31: principal scopes", () => {
  it("adds the scope columns to a v30 database; an old principal stays unscoped", () => {
    dir = mkdtempSync(join(tmpdir(), "principal-v31-"));
    const db = join(dir, "d.sqlite");
    const first = Dispatch.open(db);
    const repo = first.registerRepository({ name: "app", default_branch: "main" }, human);
    const { token } = first.createPrincipal({ name: "old-bot" }, human);
    // Make it a v30 database: no scope columns, version 30.
    first.db.exec("ALTER TABLE api_principals DROP COLUMN scope_repos");
    first.db.exec("ALTER TABLE api_principals DROP COLUMN scope_tickets");
    first.db.prepare("UPDATE schema_meta SET value = '30' WHERE key = 'schema_version'").run();
    first.db.close();

    for (let open = 0; open < 2; open += 1) {
      const wg = Dispatch.open(db);
      const cols = (
        wg.db.prepare("PRAGMA table_info(api_principals)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols.filter((c) => c.startsWith("scope_"))).toEqual(["scope_repos", "scope_tickets"]);
      const ver = wg.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(Number(ver.value)).toBe(SCHEMA_VERSION);
      const resolved = wg.resolvePrincipalToken(token);
      expect(resolved?.principal).toMatchObject({ name: "old-bot", scope: null });
      // No scope: every ticket is visible and every action allowed, as before.
      expect(wg.ticketVisibility(resolved!.principal)).toBeNull();
      expect(() =>
        wg.assertPrincipalAccess(resolved!.principal, { kind: "write_factory" }),
      ).not.toThrow();
      // A scoped principal can be minted on the migrated database.
      if (open === 0) {
        const scoped = wg.createPrincipal({ name: "new-bot", repos: [repo.id] }, human);
        expect(scoped.principal.scope).toEqual({
          repos: [{ id: repo.id, name: "app" }],
          tickets: null,
        });
      }
      wg.db.close();
    }
  });
});
