import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureApiToken, isRequestAuthorized } from "../src/api/auth.js";
import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import type { IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Loopback read-auth hardening (S-M1):
//   (a) a Host/Origin check rejects DNS-rebinding (a foreign Host/Origin → 403);
//   (b) EVERY data-returning endpoint — /api/settings AND general board/ticket
//       reads — requires the token, loopback reads included. There is NO tokenless
//       loopback-read relaxation any more: a same-user process (e.g. a
//       token-scrubbed delivery agent) must not be able to `GET /tickets` on the
//       loopback bind and read the backlog. Only the public bootstrap surface (the
//       static SPA shell + /healthz) stays tokenless. The token source (operator-set
//       vs auto-provisioned) no longer changes the read posture — both are gated
//       identically (see the "token posture" describe below).
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

describe("isRequestAuthorized", () => {
  it("S-M1: with a token configured, EVERY tokenless GET is refused (board reads included)", () => {
    const saved = process.env.DISPATCH_API_TOKEN;
    process.env.DISPATCH_API_TOKEN = "tok";
    try {
      const getReq = { method: "GET", headers: {} } as unknown as IncomingMessage;
      // Privileged path: refused (unchanged).
      expect(isRequestAuthorized(getReq)).toBe(false);
      // Board/ticket read: NOW refused too — no tokenless loopback read path.
      expect(isRequestAuthorized(getReq)).toBe(false);
      // A correct bearer passes.
      const authed = {
        method: "GET",
        headers: { authorization: "Bearer tok" },
      } as unknown as IncomingMessage;
      expect(isRequestAuthorized(authed)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
      else process.env.DISPATCH_API_TOKEN = saved;
    }
  });

  it("S-M1: with NO token configured, requests pass (embedder/test posture unchanged)", () => {
    const saved = process.env.DISPATCH_API_TOKEN;
    delete process.env.DISPATCH_API_TOKEN;
    try {
      const getReq = { method: "GET", headers: {} } as unknown as IncomingMessage;
      expect(isRequestAuthorized(getReq)).toBe(true);
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

  it("(c) S-M1: refuses a tokenless board read on loopback, accepts it with the token", async () => {
    const noToken = await rawGet(h.port, "/api/board");
    expect(noToken.status).toBe(401);

    const withToken = await rawGet(h.port, "/api/board", { authorization: `Bearer ${TOKEN}` });
    expect(withToken.status).toBe(200);
    expect(withToken.body).toContain("columns");
  });

  it("(c) S-M1: a tokenless loopback GET /tickets is 401; a tokened one is 200", async () => {
    const noToken = await rawGet(h.port, "/tickets");
    expect(noToken.status).toBe(401);
    expect(noToken.body).toContain("UNAUTHORIZED");

    const withToken = await rawGet(h.port, "/tickets", { authorization: `Bearer ${TOKEN}` });
    expect(withToken.status).toBe(200);
  });

  it("(c) S-M1: the dashboard bootstrap surface stays tokenless (shell + /healthz)", async () => {
    // The SPA shell and health probe must load WITHOUT a token so the page can
    // boot and adopt the token; they carry no board data.
    const health = await rawGet(h.port, "/healthz");
    expect(health.status).toBe(200);
    const shell = await rawGet(h.port, "/");
    expect(shell.status).toBe(200);
    expect(shell.body).toContain("<!doctype html");
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

  it("(a) allows a loopback Host/Origin (localhost + 127.0.0.1) with the token", async () => {
    const viaLocalhost = await rawGet(h.port, "/api/board", {
      Host: `localhost:${h.port}`,
      Origin: `http://127.0.0.1:${h.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(viaLocalhost.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// S-M1 — token posture is now UNIFORM for reads.
// Historically an operator-SET DISPATCH_API_TOKEN gated every request while an
// AUTO-provisioned token relaxed tokenless loopback reads. S-M1 removes that
// relaxation: both postures require the token for every data-returning endpoint,
// loopback reads included. The token source is reported by ensureApiToken for the
// operator-facing startup log only; it never enters the auth decision.
// ---------------------------------------------------------------------------

describe("token posture is uniform for reads (S-M1)", () => {
  const TOKEN = "operator-secret";
  const saved: Record<string, string | undefined> = {};
  const TOUCHED = ["DISPATCH_API_TOKEN", "GAFFER_DATA"];

  beforeEach(() => {
    for (const k of TOUCHED) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("pure: a tokenless loopback read is refused whenever a token is configured", () => {
    process.env.DISPATCH_API_TOKEN = "tok";
    const getReq = { method: "GET", headers: {} } as unknown as IncomingMessage;
    expect(isRequestAuthorized(getReq)).toBe(false);
    // A correct bearer passes.
    const authed = {
      method: "GET",
      headers: { authorization: "Bearer tok" },
    } as unknown as IncomingMessage;
    expect(isRequestAuthorized(authed)).toBe(true);
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

  it("(b) S-M1: auto-generated token (env unset at startup) ALSO gates a tokenless loopback board read (401)", async () => {
    delete process.env.DISPATCH_API_TOKEN;
    const h = await startHarness(); // sets GAFFER_DATA to a fresh temp dir
    try {
      const ensured = ensureApiToken(process.env); // generates + exports the token
      expect(ensured.source).toBe("generated");
      // Board read: now refused tokenless even under the auto-provisioned posture.
      const board = await rawGet(h.port, "/api/board");
      expect(board.status).toBe(401);
      // A correct bearer passes.
      const authed = await rawGet(h.port, "/api/board", {
        authorization: `Bearer ${ensured.token}`,
      });
      expect(authed.status).toBe(200);
      // The privileged path is refused tokenless too (unchanged).
      const settings = await rawGet(h.port, "/api/settings");
      expect(settings.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
