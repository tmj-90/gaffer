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
import { SETTING_DEFS } from "../src/api/settings.js";

const FULL = "operator-full-token-0123456789abcdef";
const SLACK = "https://hooks.slack.com/services/T000/B000/SECRET-ENV-XOXB";
const HOOK = "https://hooks.example.com/generic/SECRET-FILE-PATH";

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
    process.env.GAFFER_NOTIFY_SLACK_URL = SLACK; // env-backed
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ GAFFER_NOTIFY_WEBHOOK_URL: HOOK }));
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
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const get = (path: string, token: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

  it("the webhook keys are marked secret in SETTING_DEFS", () => {
    const secret = SETTING_DEFS.filter((d) => d.secret).map((d) => d.key);
    expect(secret).toEqual(
      expect.arrayContaining(["GAFFER_NOTIFY_WEBHOOK_URL", "GAFFER_NOTIFY_SLACK_URL"]),
    );
  });

  it("a READ token sees configured + host only, for env- and file-backed secrets", async () => {
    const res = await get("/api/settings", deriveReadToken(FULL));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-");
    const body = JSON.parse(text) as { settings: View[] };
    const slack = body.settings.find((s) => s.key === "GAFFER_NOTIFY_SLACK_URL")!;
    const hook = body.settings.find((s) => s.key === "GAFFER_NOTIFY_WEBHOOK_URL")!;
    expect(slack).toMatchObject({
      value: "",
      effective: "",
      secret: true,
      configured: true,
      host: "hooks.slack.com",
    });
    expect(hook).toMatchObject({
      value: "",
      effective: "",
      secret: true,
      configured: true,
      host: "hooks.example.com",
    });
  });

  it("even the operator token's GET /api/settings carries no secret value", async () => {
    const text = await (await get("/api/settings", FULL)).text();
    expect(text).not.toContain("SECRET-");
  });

  it("a read token and a human principal are refused the read-back; the admin gets it", async () => {
    const r1 = await get("/api/settings/secret/GAFFER_NOTIFY_SLACK_URL", deriveReadToken(FULL));
    expect(r1.status).toBe(403);
    expect(await r1.text()).not.toContain("SECRET-");
    const human = wg.createPrincipal(
      { name: "alice", capability: "full", actorType: "human", actorId: "alice" },
      { type: "admin", id: "op" },
    );
    const r2 = await get("/api/settings/secret/GAFFER_NOTIFY_SLACK_URL", human.token);
    expect(r2.status).toBe(403);
    const admin = wg.createPrincipal(
      { name: "ops", capability: "full", actorType: "admin", actorId: "ops" },
      { type: "admin", id: "op" },
    );
    const r3 = await get("/api/settings/secret/GAFFER_NOTIFY_SLACK_URL", admin.token);
    expect(r3.status).toBe(200);
    expect(await r3.json()).toEqual({
      key: "GAFFER_NOTIFY_SLACK_URL",
      value: SLACK,
      source: "env",
    });
    const r4 = await get("/api/settings/secret/GAFFER_NOTIFY_WEBHOOK_URL", FULL);
    expect(await r4.json()).toEqual({
      key: "GAFFER_NOTIFY_WEBHOOK_URL",
      value: HOOK,
      source: "file",
    });
    const r5 = await get("/api/settings/secret/MAX_TICKS", FULL);
    expect(r5.status).toBe(404);
  });

  it("the POST response does not echo a secret back", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { authorization: `Bearer ${FULL}`, "content-type": "application/json" },
      body: JSON.stringify({
        settings: { GAFFER_NOTIFY_WEBHOOK_URL: "https://new.example/SECRET-NEW" },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-");
    expect(JSON.parse(text).written).toContain("GAFFER_NOTIFY_WEBHOOK_URL");
  });
});
