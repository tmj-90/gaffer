/**
 * SECRET-BEARING SETTINGS (external review #5). A READ-ONLY token used to retrieve
 * complete webhook URLs from GET /api/settings — env-backed and file-backed — and a
 * Slack incoming-webhook URL is posting authority by itself. Now every principal sees
 * only `configured` + `host` for a `secret: true` key; only an ADMIN principal (the
 * operator token, or an admin principal with full capability) reads the value back,
 * through GET /api/settings/secret/:key.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { deriveReadToken } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { resetDerivedSettings, SETTING_DEFS } from "../src/api/settings.js";

const FULL = "operator-full-token-0123456789abcdef";
const SLACK = "https://hooks.slack.com/services/T000/B000/SECRET-ENV-XOXB";
const HOOK = "https://hooks.example.com/generic/SECRET-FILE-PATH";
const OLD_HOOK = "https://old.example.com/generic/SECRET-OLD-KEY";

interface View {
  key: string;
  value: string;
  effective: string;
  secret?: boolean;
  configured?: boolean;
  host?: string | null;
}

describe("secret settings never reach a non-admin principal", () => {
  const TOUCHED = ["GAFFER_DATA", "DISPATCH_API_TOKEN", "GAFFER_NOTIFY_SLACK_URL"];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let base: string;
  let close: () => Promise<void>;
  let wg: Dispatch;

  beforeEach(async () => {
    for (const k of TOUCHED) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "wg-secret-settings-"));
    process.env.GAFFER_DATA = dir;
    process.env.DISPATCH_API_TOKEN = FULL;
    // A derived notify URL the operator exported (an override), the setting in the
    // file, and an old notify key still in the file.
    process.env.GAFFER_NOTIFY_SLACK_URL = SLACK;
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ GAFFER_NOTIFY: `desktop,${HOOK}`, GAFFER_NOTIFY_WEBHOOK_URL: OLD_HOOK }),
    );
    resetDerivedSettings(process.env);
    wg = Dispatch.open(":memory:");
    const server = createApiServer(wg);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((r) =>
        server.close(() => {
          wg.db.close();
          rmSync(dir, { recursive: true, force: true });
          r();
        }),
      );
  });
  afterEach(async () => {
    await close();
    resetDerivedSettings(process.env);
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const get = (path: string, token: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const post = (path: string, token: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GAFFER_NOTIFY is the one secret setting", () => {
    expect(SETTING_DEFS.filter((d) => d.secret).map((d) => d.key)).toEqual(["GAFFER_NOTIFY"]);
  });

  it("a READ token sees the channels and hosts only: settings, derived, overrides, migration, cleanup", async () => {
    const res = await get("/api/settings", deriveReadToken(FULL));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-");
    const body = JSON.parse(text) as {
      settings: View[];
      overrides: { name: string; value: string }[];
      migration: { key: string; old: string }[];
    };
    const notify = body.settings.find((s) => s.key === "GAFFER_NOTIFY")!;
    expect(notify).toMatchObject({
      secret: true,
      configured: true,
      value: "desktop, a webhook URL (hooks.example.com)",
    });
    expect(body.overrides).toContainEqual(
      expect.objectContaining({ name: "GAFFER_NOTIFY_SLACK_URL", value: "(set, hidden)" }),
    );
    expect(body.migration.find((m) => m.key === "GAFFER_NOTIFY_WEBHOOK_URL")?.old).toBe(
      "(set, hidden)",
    );
  });

  it("even the operator token's GET /api/settings carries no secret value", async () => {
    const text = await (await get("/api/settings", FULL)).text();
    expect(text).not.toContain("SECRET-");
  });

  it("a read token and a human principal are refused the read-back; the admin gets it", async () => {
    const r1 = await get("/api/settings/secret/GAFFER_NOTIFY", deriveReadToken(FULL));
    expect(r1.status).toBe(403);
    expect(await r1.text()).not.toContain("SECRET-");
    const human = wg.createPrincipal(
      { name: "alice", capability: "full", actorType: "human", actorId: "alice" },
      { type: "admin", id: "op" },
    );
    const r2 = await get("/api/settings/secret/GAFFER_NOTIFY", human.token);
    expect(r2.status).toBe(403);
    const admin = wg.createPrincipal(
      { name: "ops", capability: "full", actorType: "admin", actorId: "ops" },
      { type: "admin", id: "op" },
    );
    const r3 = await get("/api/settings/secret/GAFFER_NOTIFY", admin.token);
    expect(r3.status).toBe(200);
    expect(await r3.json()).toEqual({
      key: "GAFFER_NOTIFY",
      value: `desktop,${HOOK}`,
      source: "dashboard",
    });
    const r5 = await get("/api/settings/secret/GAFFER_NOTIFY_SLACK_URL", FULL);
    expect(r5.status).toBe(404);
  });

  it("a write (a URL or the structured notify change) never echoes a secret back", async () => {
    const res = await post("/api/settings", FULL, {
      settings: { GAFFER_NOTIFY: "desktop,https://new.example/SECRET-NEW" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-");
    expect(JSON.parse(text).written).toEqual(["GAFFER_NOTIFY"]);
    const r2 = await post("/api/settings", FULL, { notify: { desktop: false } });
    expect(r2.status).toBe(200);
    expect(await r2.text()).not.toContain("SECRET-");
    const admin = wg.createPrincipal(
      { name: "ops2", capability: "full", actorType: "admin", actorId: "ops2" },
      { type: "admin", id: "op" },
    );
    const back = await (await get("/api/settings/secret/GAFFER_NOTIFY", admin.token)).json();
    expect(back.value).toBe("https://new.example/SECRET-NEW");
  });

  it("who may change settings is unchanged, and the removal act needs the same authority", async () => {
    const human = wg.createPrincipal(
      { name: "bob", capability: "full", actorType: "human", actorId: "bob" },
      { type: "admin", id: "op" },
    );
    const plan = { drop: ["GAFFER_NOTIFY_WEBHOOK_URL"], rewrite: [] };
    for (const token of [deriveReadToken(FULL), human.token]) {
      const w = await post("/api/settings", token, { settings: { GAFFER_EFFORT: "large" } });
      const r = await post("/api/settings/remove-old-keys", token, plan);
      expect(w.status).toBe(403);
      expect(r.status).toBe(403);
    }
    const ok = await post("/api/settings/remove-old-keys", FULL, plan);
    expect(ok.status).toBe(200);
  });
});
