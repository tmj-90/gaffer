import { readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { createApiServer } from "../src/api/server.js";
import { serveStatic } from "../src/api/static.js";

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

  it("serves every module the entry imports, and only those, as no-store JavaScript", async () => {
    // Walk the page's module graph the way a browser does: every relative import of
    // every module the server hands out must come back 200 text/javascript, no-store.
    const seen = new Set<string>();
    const queue = [`${h.baseUrl}/app.js`];
    while (queue.length) {
      const url = queue.shift() ?? "";
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await fetch(url);
      const at = new URL(url).pathname;
      expect(res.status, at).toBe(200);
      expect(res.headers.get("content-type"), at).toBe("text/javascript; charset=utf-8");
      expect(res.headers.get("cache-control"), at).toMatch(/no-store/);
      const src = await res.text();
      for (const m of src.matchAll(/^import [^;]*? from "(\.{1,2}\/[^"]+)";/gms))
        queue.push(new URL(m[1] ?? "", url).href);
    }
    // Every module on disk is reachable from the entry (no orphan the page never loads).
    const jsDir = join(dirname(fileURLToPath(import.meta.url)), "../src/api/web/js");
    const onDisk = readdirSync(jsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".js"))
      .map((f) => `/js/${f.split(sep).join("/")}`);
    const served = [...seen].map((u) => new URL(u).pathname).filter((p) => p !== "/app.js");
    expect(served.sort()).toEqual(onDisk.sort());
    expect(served.length).toBeGreaterThan(50);
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

  it("refuses non-JS and traversal under /js/ (JSON 404)", async () => {
    for (const p of ["/js/state.css", "/js/missing.js", "/js/views/missing.js", "/js/"]) {
      const res = await fetch(`${h.baseUrl}${p}`);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("content-type"), p).toMatch(/application\/json/);
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
    expect(await raw("/js/../api/static.js")).toBe(404);
    expect(await raw("/js/views/../../server.js")).toBe(404);
    expect(await raw("/js/%2e%2e/static.js")).toBe(404);
    // The server normalises dot segments before routing; the guard itself must still
    // refuse a path that resolves outside web/js (src/api/static.ts sits beside web/).
    const untouched = { writeHead: () => untouched, end: () => untouched } as never;
    for (const p of ["/js/../../static.js", "/js/../app.js", "/js/views/../../../server.js"])
      expect(serveStatic(p, untouched), p).toBe(false);
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
