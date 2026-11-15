// SEALED PRINCIPALS on the CLI (the built binary, the way `gaffer wg` runs it):
// GAFFER_PRINCIPAL_TOKEN for a row written straight into sqlite is refused like an unknown
// token; `principal unsigned` names it; `principal resign` is the operator's (a principal
// token is refused), `--all` revives rows created before signing and leaves a row with no
// creation on record for a person to name.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { hostGateKeyring } from "../src/events/gateSeal.js";
import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

vi.setConfig({ testTimeout: 60_000 });

const operator: Actor = { type: "human", id: "tom" };
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function forge(wg: Dispatch, name: string): string {
  const token = `gfp_${randomBytes(32).toString("base64url")}`;
  wg.db
    .prepare(
      "INSERT INTO api_principals (id, name, token_hash, capability, actor_type, actor_id, created_by, created_at) " +
        "VALUES (?, ?, ?, 'full', 'admin', ?, 'tom', ?)",
    )
    .run(
      `forged-${name}`,
      name,
      createHash("sha256").update(token).digest("hex"),
      name,
      new Date().toISOString(),
    );
  return token;
}

const env = (token = "") => ({ env: { GAFFER_PRINCIPAL_TOKEN: token, USER: "cli-user" } });

describe.skipIf(!CLI_BUILT)("wg principal: sealed rows on the CLI", () => {
  it("refuses a forged token, lists it, and only the operator re-signs", () => {
    dir = mkdtempSync(join(tmpdir(), "cli-principal-seal-"));
    const db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db, undefined, undefined, { gateKeyring: hostGateKeyring(db) });
    const legacy = wg.createPrincipal({ name: "legacy" }, operator);
    const admin = wg.createPrincipal({ name: "ops", actorType: "admin" }, operator);
    const forged = forge(wg, "root");
    // `legacy` from before signing: its seal never existed.
    wg.db.prepare("DELETE FROM row_seals WHERE row_id = ?").run(legacy.principal.id);
    wg.db.close();

    // The CLI principal path refuses both unsigned tokens, exactly like an unknown one.
    for (const token of [forged, legacy.token]) {
      const r = runBin(db, ["whoami"], env(token));
      expect(r.status).not.toBe(0);
      expect(oneLineError(r.stderr).code).toBe("UNAUTHORIZED");
    }
    expect(runBin(db, ["whoami"], env(admin.token)).status).toBe(0);

    const list = runBin(db, ["principal", "unsigned"], env());
    expect(list.status).toBe(0);
    const unsigned = (JSON.parse(list.stdout) as { unsigned: Array<{ name: string }> }).unsigned;
    expect(unsigned.map((u) => u.name).sort()).toEqual(["legacy", "root"]);

    // A principal token, even an admin's, may not re-sign.
    const byPrincipal = runBin(db, ["principal", "resign", "--all"], env(admin.token));
    expect(byPrincipal.status).not.toBe(0);
    expect(oneLineError(byPrincipal.stderr)).toMatchObject({
      code: "ACTOR_NOT_PERMITTED",
      message: expect.stringMatching(/re-sign principals/),
    });
    expect(runBin(db, ["whoami"], env(legacy.token)).status).not.toBe(0);

    // The operator: --all revives the legacy row, not the forged one.
    const all = runBin(db, ["principal", "resign", "--all"], env());
    expect(all.status).toBe(0);
    const res = JSON.parse(all.stdout) as {
      resigned: Array<{ name: string }>;
      skipped: Array<{ name: string }>;
    };
    expect(res.resigned.map((r) => r.name)).toEqual(["legacy"]);
    expect(res.skipped.map((r) => r.name)).toEqual(["root"]);
    expect(all.stderr).toMatch(/Not re-signed: root/);
    expect(runBin(db, ["whoami"], env(legacy.token)).status).toBe(0);
    expect(runBin(db, ["whoami"], env(forged)).status).not.toBe(0);
  });
});
