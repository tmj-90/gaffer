import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureApiToken,
  isPrivilegedPath,
  isRequestAuthorized,
  recordApiTokenSource,
} from "../src/api/auth.js";
import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import type { IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Loopback read-auth hardening (balanced fix):
//   (a) a Host/Origin check rejects DNS-rebinding (a foreign Host/Origin → 403);
//   (b) /api/settings requires the token EVEN on a loopback read (it reports
//       notify/webhook URLs — secrets);
//   (c) general board reads stay tokenless on a loopback bind for local dev —
//       AUTO-provisioned token posture only. An OPERATOR-SET token
//       (DISPATCH_API_TOKEN in the startup env) restores the strict posture:
//       every request, loopback reads included, requires the token (see the
//       "operator-set vs auto-provisioned token posture" describe below).
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

/** Raw GET so we can spoof Host/Origin (undici's fetch strips those headers). */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

// --- Pure decision-function coverage (fast, no socket) ----------------------

describe("isPrivilegedPath / isRequestAuthorized", () => {
  it("treats /api/settings (and a trailing slash) as privileged, board paths as not", () => {
    expect(isPrivilegedPath("/api/settings")).toBe(true);
    expect(isPrivilegedPath("/api/settings/")).toBe(true);
    expect(isPrivilegedPath("/api/board")).toBe(false);
    expect(isPrivilegedPath("/tickets")).toBe(false);
    expect(isPrivilegedPath("/")).toBe(false);
  });

  it("refuses a tokenless loopback READ of a privileged path but allows a board read", () => {
    const saved = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "tok";
    try {
      const getReq = { method: "GET", headers: {} } as unknown as IncomingMessage;
      // Privileged: refused even for a loopback GET with no token.
      expect(isRequestAuthorized(getReq, true, "/api/settings")).toBe(false);
      // Board read: allowed tokenless on loopback.
      expect(isRequestAuthorized(getReq, true, "/api/board")).toBe(true);
      // Privileged with the token present: allowed.
      const authed = {
        method: "GET",
        headers: { authorization: "Bearer tok" },
      } as unknown as IncomingMessage;
      expect(isRequestAuthorized(authed, true, "/api/settings")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = saved;
    }
  });
});

// --- End-to-end over a real loopback-bound server ---------------------------

interface Harness {
  wg: Dispatch;
  port: number;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "wg-auth-harden-"));
  process.env.GAFFER_DATA = dir; // settings module reads settings.json from here
  const wg = Dispatch.open(":memory:");
  const server = createApiServer(wg); // default bind host = 127.0.0.1 (loopback)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

describe("loopback read-auth hardening (over a bound server)", () => {
  const TOKEN = "operator-secret";
  const saved: Record<string, string | undefined> = {};
  const TOUCHED = ["DISPATCH_API_TOKEN", "GAFFER_DATA"];
  let h: Harness;

  beforeEach(async () => {
    for (const k of TOUCHED) saved[k] = process.env[k];
    process.env.DISPATCH_API_TOKEN = TOKEN; // a token IS configured (the default posture)
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("(b) refuses a tokenless GET /api/settings on loopback, accepts it with the token", async () => {
    const noToken = await rawGet(h.port, "/api/settings");
    expect(noToken.status).toBe(401);

    const withToken = await rawGet(h.port, "/api/settings", {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(withToken.status).toBe(200);
    expect(withToken.body).toContain("settings");
  });

  it("(c) still serves a tokenless board read on loopback", async () => {
    const board = await rawGet(h.port, "/api/board");
    expect(board.status).toBe(200);
    expect(board.body).toContain("columns");
  });

  it("(a) rejects a foreign Host header (DNS-rebinding) with 403", async () => {
    const rebind = await rawGet(h.port, "/api/board", { Host: "evil.example.com" });
    expect(rebind.status).toBe(403);
    expect(rebind.body).toContain("FORBIDDEN_HOST");
  });

  it("(a) rejects a foreign Origin header with 403 even when Host is loopback", async () => {
    const rebind = await rawGet(h.port, "/api/board", {
      Origin: "http://evil.example.com",
    });
    expect(rebind.status).toBe(403);
    expect(rebind.body).toContain("FORBIDDEN_HOST");
  });

  it("(a) allows a loopback Host/Origin (localhost + 127.0.0.1)", async () => {
    const viaLocalhost = await rawGet(h.port, "/api/board", {
      Host: `localhost:${h.port}`,
      Origin: `http://127.0.0.1:${h.port}`,
    });
    expect(viaLocalhost.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// FINDING 8 — operator-set vs auto-provisioned token posture.
// An operator who EXPLICITLY sets DISPATCH_API_TOKEN asked for auth on purpose:
// every request, loopback reads included, must present the token (the original
// strict posture). Only the AUTO-provisioned dashboard token (generated / reused
// from the token file when the env is unset at startup) keeps the relaxed
// tokenless-loopback-read UX. The posture is captured at startup by
// ensureApiToken (via recordApiTokenSource), not re-derived per request.
// ---------------------------------------------------------------------------

describe("operator-set vs auto-provisioned token posture", () => {
  const TOKEN = "operator-secret";
  const saved: Record<string, string | undefined> = {};
  const TOUCHED = ["DISPATCH_API_TOKEN", "GAFFER_DATA"];

  beforeEach(() => {
    for (const k of TOUCHED) saved[k] = process.env[k];
  });
  afterEach(() => {
    // Reset the recorded startup posture so other tests keep the default.
    recordApiTokenSource(null);
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("pure: the recorded token source drives the tokenless loopback-read decision", () => {
    process.env.DISPATCH_API_TOKEN = "tok";
    const getReq = { method: "GET", headers: {} } as unknown as IncomingMessage;
    // Operator-set (env) → strict: even a plain board read is refused.
    recordApiTokenSource("env");
    expect(isRequestAuthorized(getReq, true, "/api/board")).toBe(false);
    // Auto-provisioned (generated or reused file) → relaxed loopback reads.
    recordApiTokenSource("generated");
    expect(isRequestAuthorized(getReq, true, "/api/board")).toBe(true);
    recordApiTokenSource("file");
    expect(isRequestAuthorized(getReq, true, "/api/board")).toBe(true);
  });

  it("(a) operator-set token: a tokenless loopback board GET is refused (401)", async () => {
    process.env.DISPATCH_API_TOKEN = TOKEN;
    const h = await startHarness();
    try {
      ensureApiToken(process.env); // startup resolution: source=env → strict
      const res = await rawGet(h.port, "/api/board");
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("(c) operator-set token + correct Authorization header → 200", async () => {
    process.env.DISPATCH_API_TOKEN = TOKEN;
    const h = await startHarness();
    try {
      ensureApiToken(process.env);
      const res = await rawGet(h.port, "/api/board", { authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(res.body).toContain("columns");
    } finally {
      await h.close();
    }
  });

  it("(b) auto-generated token (env unset at startup): a tokenless loopback board read stays 200", async () => {
    delete process.env.DISPATCH_API_TOKEN;
    const h = await startHarness(); // sets GAFFER_DATA to a fresh temp dir
    try {
      const ensured = ensureApiToken(process.env); // generates + exports the token
      expect(ensured.source).toBe("generated");
      const board = await rawGet(h.port, "/api/board");
      expect(board.status).toBe(200);
      // The privileged-path carve-out still applies under the relaxed posture.
      const settings = await rawGet(h.port, "/api/settings");
      expect(settings.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
