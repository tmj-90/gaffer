import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boot the API (with the SPA static route) on an ephemeral port. */
async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:");
  const server = createApiServer(wg);
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

describe("API: SPA static surface", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("serves the SPA shell at GET / as text/html", async () => {
    const res = await fetch(`${h.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Dispatch");
    expect(body).toContain('src="/app.js"');
  });

  it("serves /app.js as JavaScript", async () => {
    const res = await fetch(`${h.baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("serves /styles.css as CSS", async () => {
    const res = await fetch(`${h.baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("does not let the SPA fallback swallow an unknown API path (still JSON 404)", async () => {
    const res = await fetch(`${h.baseUrl}/tickets/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");

    // An arbitrary unknown path is also a JSON 404, not the HTML shell.
    const nope = await fetch(`${h.baseUrl}/nope`);
    expect(nope.status).toBe(404);
    expect(nope.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("still answers the JSON API at GET /healthz", async () => {
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("serves a hero background under /assets/ as an image", async () => {
    const res = await fetch(`${h.baseUrl}/assets/bg/hero-city.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(1000);
  });

  it("serves a split texture under /assets/ as a png", async () => {
    const res = await fetch(`${h.baseUrl}/assets/bg/tex-01.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("refuses a non-image extension under /assets/ (ext allowlist → JSON 404)", async () => {
    const res = await fetch(`${h.baseUrl}/assets/bg/secret.json`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns JSON 404 for a missing asset", async () => {
    const res = await fetch(`${h.baseUrl}/assets/bg/does-not-exist.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("does not leak source files via /assets/ traversal", async () => {
    // Negative control: even after URL normalization, escaping the assets dir
    // must never serve a source/config file.
    for (const p of ["/assets/../server.js", "/assets/bg/%2e%2e/%2e%2e/server.js"]) {
      const res = await fetch(`${h.baseUrl}${p}`);
      expect(res.status).toBe(404);
    }
  });
});
