import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";

/**
 * P1-C — the dashboard must ship baseline security headers on every response
 * (CSP, X-Content-Type-Options, Referrer-Policy, X-Frame-Options), with HSTS
 * emitted ONLY for a non-loopback bind (a plain-HTTP loopback dev server must
 * not pin localhost to HTTPS).
 */

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(bindHost?: string): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  const server: Server = createApiServer(wg, undefined, undefined, undefined, undefined, bindHost);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

describe("P1-C: security response headers", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("sets CSP and the baseline hardening headers on an API response", async () => {
    h = await startHarness();
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);

    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    // Scripts are 'self' only — no inline-script allowance.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets the headers on static SPA assets too", async () => {
    h = await startHarness();
    const res = await fetch(`${h.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("permits the SPA's external font stylesheet + font origins in the CSP", async () => {
    h = await startHarness();
    const res = await fetch(`${h.baseUrl}/healthz`);
    const csp = res.headers.get("content-security-policy") ?? "";
    // The shell pulls its webfonts from Google Fonts; the CSP must allow them
    // without relaxing script-src.
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
  });

  it("does NOT emit HSTS on a loopback (default) bind", async () => {
    h = await startHarness("127.0.0.1");
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("emits HSTS when bound to a non-loopback host", async () => {
    h = await startHarness("203.0.113.10");
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });
});
