/**
 * Request bodies the REST surface refuses, and how it refuses them.
 *
 * - A body over the 1 MB limit gets a JSON 413, not a reset connection
 *   (exploratory finding api-robustness/F5: readJsonBody destroyed the socket
 *   before throwing, so its "Request body too large" 422 was never sent).
 */
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";

let wg: Dispatch;
let server: ReturnType<typeof createApiServer>;
let port: number;

beforeEach(async () => {
  wg = Dispatch.open(":memory:");
  server = createApiServer(wg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  wg.db.close();
});

/** POST raw bytes with node:http and resolve with the response (ignores a late EPIPE). */
function rawPost(
  path: string,
  body: Buffer,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    let answered = false;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (res) => {
        answered = true;
        let text = "";
        res.on("data", (b: Buffer) => (text += b.toString()));
        res.on("end", () => {
          try {
            ok({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
          } catch (e) {
            fail(e as Error);
          }
        });
      },
    );
    req.on("error", (e) => {
      if (!answered) fail(e);
    });
    req.end(body);
  });
}

describe("request body limits", () => {
  it("a body over 1 MB answers a JSON 413 (node:http client), not a reset socket", async () => {
    const big = Buffer.from(JSON.stringify({ title: "x".repeat(1_500_000) }));
    const res = await rawPost("/tickets", big);
    expect(res.status).toBe(413);
    expect((res.json.error as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    expect((res.json.error as { message: string }).message).toMatch(/too large/i);
    expect(wg.listTickets({}).length).toBe(0);
  });

  it("a body over 1 MB answers a JSON 413 to fetch too, even a much larger one", async () => {
    for (const size of [1_200_000, 8_000_000]) {
      const res = await fetch(`http://127.0.0.1:${port}/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "t", body: "y".repeat(size) }),
      });
      expect(res.status, String(size)).toBe(413);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("the server still answers the next request after a refused upload", async () => {
    await rawPost("/tickets", Buffer.alloc(1_100_000, 0x20));
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });
});
