import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";

// ---------------------------------------------------------------------------
// Host/Origin check refinement (Finding 5):
//   (a) /healthz is EXEMPT from the Host/Origin check — health probes (load
//       balancers, k8s, uptime monitors) legitimately arrive with arbitrary
//       Host headers and the response carries no state;
//   (b) a request presenting a VALID bearer token bypasses the check — the
//       check exists solely to stop token-LESS DNS-rebinding reads (a browser
//       cannot attach the bearer token cross-origin), so a valid token proves
//       the caller is legitimate. A merely-present-but-WRONG token does NOT
//       bypass;
//   (c) DISPATCH_ALLOWED_HOSTS (comma-separated hostnames) extends the host
//       allowlist for reverse-proxy / DNS-fronted deployments.
// The rebinding defense stays fully intact for tokenless requests: a tokenless
// foreign Host/Origin on a loopback bind is still 403.
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

interface Harness {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start a server whose HANDLER believes it is bound to `bindHost` while the
 * socket actually listens on 127.0.0.1 — the bind host only drives the
 * Host/Origin check + read-auth posture, so this simulates a `--host 0.0.0.0`
 * deployment without opening a real wildcard socket in tests.
 */
async function startHarness(bindHost?: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "wg-host-check-"));
  process.env.GAFFER_DATA = dir;
  const wg = Dispatch.open(":memory:");
  const server = createApiServer(wg, undefined, undefined, undefined, undefined, bindHost);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
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

const TOKEN = "operator-secret";
const FOREIGN_HOST = "gaffer.internal.example";

describe("Host/Origin check refinement", () => {
  const saved: Record<string, string | undefined> = {};
  const TOUCHED = ["DISPATCH_API_TOKEN", "GAFFER_DATA", "DISPATCH_ALLOWED_HOSTS"];
  let h: Harness | undefined;

  beforeEach(() => {
    for (const k of TOUCHED) saved[k] = process.env[k];
    process.env.DISPATCH_API_TOKEN = TOKEN; // default posture: a token IS configured
    delete process.env.DISPATCH_ALLOWED_HOSTS;
  });
  afterEach(async () => {
    await h?.close();
    h = undefined;
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("(c) LAN-QR: the static SPA shell is public, the API stays Host-gated", () => {
    it("serves the shell (/) to a FOREIGN Host with NO token — a phone's first load isn't a 403", async () => {
      h = await startHarness("0.0.0.0");
      const res = await rawGet(h.port, "/", { Host: FOREIGN_HOST });
      expect(res.status).toBe(200);
      expect(res.body.toLowerCase()).toContain("html");
    });

    it("serves /app.js to a FOREIGN Host with NO token (public static, no data)", async () => {
      h = await startHarness("0.0.0.0");
      const res = await rawGet(h.port, "/app.js", { Host: FOREIGN_HOST });
      expect(res.status).toBe(200);
    });

    it("NEGATIVE CONTROL: a tokenless API request with a foreign Host is STILL 403 (rebinding defense intact)", async () => {
      h = await startHarness("0.0.0.0");
      const res = await rawGet(h.port, "/api/board", { Host: FOREIGN_HOST });
      expect(res.status).toBe(403);
      expect(res.body).toContain("FORBIDDEN_HOST");
    });
  });

  describe("(b) a VALID bearer token bypasses the Host/Origin check", () => {
    it("allows a foreign Host on a 0.0.0.0-style non-loopback bind with the token", async () => {
      h = await startHarness("0.0.0.0");
      const res = await rawGet(h.port, "/api/board", {
        Host: FOREIGN_HOST,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain("columns");
    });

    it("allows a foreign Host on a loopback bind with the token", async () => {
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", {
        Host: FOREIGN_HOST,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(200);
    });

    it("allows a foreign Origin with the token (same reasoning as Host)", async () => {
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", {
        Origin: `https://${FOREIGN_HOST}`,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(200);
    });

    it("does NOT bypass for a merely-present but WRONG bearer token", async () => {
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", {
        Host: FOREIGN_HOST,
        authorization: "Bearer wrong-token",
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("FORBIDDEN_HOST");
    });
  });

  describe("(a) /healthz is exempt from the Host/Origin check", () => {
    it("answers a tokenless /healthz probe with a foreign Host on loopback", async () => {
      h = await startHarness();
      const res = await rawGet(h.port, "/healthz", { Host: FOREIGN_HOST });
      expect(res.status).toBe(200);
      expect(res.body).toContain("ok");
    });

    it("answers a tokenless /healthz probe with a foreign Host on a non-loopback bind", async () => {
      h = await startHarness("0.0.0.0");
      const res = await rawGet(h.port, "/healthz", { Host: FOREIGN_HOST });
      expect(res.status).toBe(200);
    });
  });

  describe("(c) DISPATCH_ALLOWED_HOSTS extends the host allowlist", () => {
    // S-M1: reads require the token, so these assert the HOST allowlist by sending
    // the token (the host check runs before the auth gate; an allowlisted host +
    // valid token → 200, proving the host was permitted).
    const AUTH = { authorization: `Bearer ${TOKEN}` };
    it("allows a tokened read with an allowlisted Host on loopback", async () => {
      process.env.DISPATCH_ALLOWED_HOSTS = "example.com";
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", { Host: "example.com", ...AUTH });
      expect(res.status).toBe(200);
      expect(res.body).toContain("columns");
    });

    it("allows an allowlisted Origin too", async () => {
      process.env.DISPATCH_ALLOWED_HOSTS = "example.com";
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", { Origin: "https://example.com", ...AUTH });
      expect(res.status).toBe(200);
    });

    it("normalises entries: trims, lowercases, ignores empties", async () => {
      process.env.DISPATCH_ALLOWED_HOSTS = " , Example.COM:8080 ,, Proxy.Internal ";
      h = await startHarness();
      const viaFirst = await rawGet(h.port, "/api/board", { Host: "example.com", ...AUTH });
      expect(viaFirst.status).toBe(200);
      const viaSecond = await rawGet(h.port, "/api/board", {
        Host: "proxy.internal:9999",
        ...AUTH,
      });
      expect(viaSecond.status).toBe(200);
    });

    it("still refuses a host NOT on the allowlist", async () => {
      process.env.DISPATCH_ALLOWED_HOSTS = "example.com";
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", { Host: "evil.example.net" });
      expect(res.status).toBe(403);
      expect(res.body).toContain("FORBIDDEN_HOST");
    });
  });

  describe("REGRESSION: the tokenless rebinding defense stays intact", () => {
    it("refuses a tokenless read with a foreign Host on loopback (403)", async () => {
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", { Host: "evil.example.com" });
      expect(res.status).toBe(403);
      expect(res.body).toContain("FORBIDDEN_HOST");
    });

    it("refuses a tokenless read with a foreign Origin on loopback (403)", async () => {
      h = await startHarness();
      const res = await rawGet(h.port, "/api/board", { Origin: "http://evil.example.com" });
      expect(res.status).toBe(403);
      expect(res.body).toContain("FORBIDDEN_HOST");
    });

    it("S-M1: a loopback Host/Origin passes the host check but a tokenless read is now 401", async () => {
      h = await startHarness();
      const headers = { Host: `localhost:${h.port}`, Origin: `http://127.0.0.1:${h.port}` };
      // Host check passes (loopback), but the auth gate now refuses the tokenless read.
      const noToken = await rawGet(h.port, "/api/board", headers);
      expect(noToken.status).toBe(401);
      // With the token it serves — proving the loopback host was permitted.
      const withToken = await rawGet(h.port, "/api/board", {
        ...headers,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(withToken.status).toBe(200);
    });
  });
});
