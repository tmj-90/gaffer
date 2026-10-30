import { request as httpRequest } from "node:http";
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
    // The product name is Gaffer (Dispatch is its control plane).
    expect(body).toContain("<title>Gaffer</title>");
    expect(body).toContain('src="/app.js"');
    // One token set for both kits: the shell no longer hard-codes dark.
    expect(body).toContain('<meta name="color-scheme" content="light dark" />');
    // Every linked stylesheet is a layered sheet under /css/ that the server serves.
    const sheets = [...body.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(sheets.length).toBeGreaterThan(4);
    for (const href of sheets) {
      expect(href.startsWith("/css/")).toBe(true);
      const css = await fetch(`${h.baseUrl}${href}`);
      expect(css.status, href).toBe(200);
      expect(css.headers.get("content-type")).toMatch(/text\/css/);
    }
  });

  it("serves /app.js as JavaScript", async () => {
    const res = await fetch(`${h.baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("serves the layered stylesheets under /css/ and the pre-paint theme script", async () => {
    // styles.css was split into css/*.css (@layer reset, tokens, base, layout,
    // components, views, utilities); tokens.css declares the layer order.
    const res = await fetch(`${h.baseUrl}/css/tokens.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
    expect(await res.text()).toContain(
      "@layer reset, tokens, base, layout, components, views, utilities;",
    );
    const view = await fetch(`${h.baseUrl}/css/views/work.css`);
    expect(view.status).toBe(200);
    const theme = await fetch(`${h.baseUrl}/theme.js`);
    expect(theme.status).toBe(200);
    expect(theme.headers.get("content-type")).toMatch(/javascript/);
  });

  it("refuses non-CSS and traversal under /css/ (JSON 404)", async () => {
    for (const p of ["/css/tokens.js", "/css/missing.css"]) {
      const res = await fetch(`${h.baseUrl}${p}`);
      expect(res.status, p).toBe(404);
    }
    // fetch() normalises dot segments, so send the raw path to reach the server's guard.
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${h.baseUrl}${path}`, { method: "GET", path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await raw("/css/../api/static.css")).toBe(404);
    expect(await raw("/css/views/../../index.css")).toBe(404);
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

  it("serves the self-hosted fonts under /assets/fonts/ as woff2", async () => {
    // The unreferenced hero/texture images (assets/bg) were deleted; the fonts remain.
    const res = await fetch(
      `${h.baseUrl}/assets/fonts/big-shoulders-display-latin-wght-normal.woff2`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(1000);
    // The retired faces are gone.
    const old = await fetch(`${h.baseUrl}/assets/fonts/SpaceGrotesk-400.woff2`);
    expect(old.status).toBe(404);
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
