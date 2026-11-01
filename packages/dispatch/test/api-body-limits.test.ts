/**
 * Request bodies the REST surface refuses, and how it refuses them.
 *
 * - A body over the 1 MB limit gets a JSON 413, not a reset connection
 *   (exploratory finding api-robustness/F5: readJsonBody destroyed the socket
 *   before throwing, so its "Request body too large" 422 was never sent).
 * - The routes that take no body parse it like every other route, and a body that
 *   is not valid UTF-8 is a 422, never stored lossily as U+FFFD (exploratory
 *   finding api-robustness/F14).
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
  method = "POST",
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    let answered = false;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
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

describe("bodies on the routes that take none, and invalid UTF-8", () => {
  const human = { type: "human" as const, id: "tom" };
  const routes = () => {
    const t = wg.createTicket({ title: "t" }, human);
    return [`/tickets/${t.id}/ready-approval`, `/tickets/${t.id}/mono-fallback`, "/plan-sessions"];
  };

  it("broken JSON, a non-empty object and an over-limit body are refused; no body still works", async () => {
    for (const path of routes()) {
      const broken = await rawPost(path, Buffer.from("{"));
      expect(broken.status, `${path} broken`).toBe(422);
      expect((broken.json.error as { code: string }).code).toBe("VALIDATION_ERROR");
      const extra = await rawPost(path, Buffer.from(JSON.stringify({ unexpected: 1 })));
      expect(extra.status, `${path} extra`).toBe(422);
      const big = await rawPost(path, Buffer.from(JSON.stringify({ x: "y".repeat(1_100_000) })));
      expect(big.status, `${path} big`).toBe(413);
      // An empty body (what the dashboard sends) is not a validation failure.
      const none = await rawPost(path, Buffer.alloc(0));
      expect(none.status, `${path} none`).not.toBe(422);
      expect(none.status, `${path} none`).toBeLessThan(500);
    }
    expect((await rawPost("/plan-sessions", Buffer.alloc(0))).status).toBe(201);
    expect((await rawPost("/plan-sessions", Buffer.from("{}"))).status).toBe(201);
  });

  it("invalid UTF-8 in a title or a spec body is a 422, not stored as replacement characters", async () => {
    const bad = (json: string) =>
      Buffer.concat([
        Buffer.from(json.slice(0, json.indexOf("@"))),
        Buffer.from([0xff, 0xfe, 0x28]),
        Buffer.from(json.slice(json.indexOf("@") + 1)),
      ]);
    const t = await rawPost("/tickets", bad('{"title":"broken @ title"}'));
    expect(t.status).toBe(422);
    expect((t.json.error as { message: string }).message).toMatch(/UTF-8/);
    expect(wg.listTickets({}).length).toBe(0);
    const sp = await rawPost("/specs", bad('{"title":"s","body":"text @ here"}'));
    expect(sp.status).toBe(422);
    // Valid multi-byte text is untouched.
    const ok = await rawPost("/tickets", Buffer.from(JSON.stringify({ title: "café ✓ 日本" })));
    expect(ok.status).toBe(201);
    expect(wg.listTickets({})[0]?.title).toBe("café ✓ 日本");
  });
});
