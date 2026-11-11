import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CompositeNotifier,
  SlackSink,
  WebhookSink,
  type HttpTransport,
  type NotifyEvent,
  type NotifySink,
} from "../src/notify/index.js";

/**
 * A configured webhook / Slack URL is a credential (Slack keeps it in the PATH).
 * A failed delivery must name the sink, the URL's origin and the status only:
 * never its path, query or user information, in the log or in the error a client
 * is shown (`dispatch notify test`). And a timed-out delivery aborts its request.
 */

const SECRET = "FAKE_WEBHOOK_SECRET";
const SLACK = `https://hooks.slack.com/services/TFAKE/BFAKE/${SECRET}`;
const HOOK = `https://user:${SECRET}-pw@hooks.example.test/notify/${SECRET}?token=${SECRET}-q`;

const event: NotifyEvent = {
  kind: "review_needed",
  ticket_number: 7,
  status: "in_review",
  at: "2026-01-01T00:00:00.000Z",
};

/** Deliver through a real CompositeNotifier and return what was logged and reported. */
async function failThrough(sink: NotifySink): Promise<{ logged: string[]; reported: string }> {
  const logged: string[] = [];
  const notifier = new CompositeNotifier([sink], ["review_needed"], {
    warn: (m) => logged.push(m),
  });
  const report = await notifier.notifyAndReport(event);
  expect(report.sinks[0]!.ok).toBe(false);
  return { logged, reported: report.sinks[0]!.error ?? "" };
}

function expectNoSecret(...texts: string[]): void {
  for (const t of texts) {
    expect(t).not.toContain(SECRET);
    expect(t).not.toContain("/services/");
    expect(t).not.toContain("TFAKE");
    expect(t).not.toContain("/notify/");
    expect(t).not.toContain("token=");
    expect(t).not.toContain("user:");
  }
}

describe("notify failures never carry the URL path, query or credentials", () => {
  it("a Slack 503 logs the sink, the origin and the status only", async () => {
    const transport: HttpTransport = async () => ({ ok: false, status: 503 });
    const { logged, reported } = await failThrough(new SlackSink(SLACK, transport));
    expect(logged).toEqual([
      "[notify] sink 'slack' failed: webhook POST to https://hooks.slack.com returned 503",
    ]);
    expectNoSecret(reported, ...logged);
  });

  it("a webhook non-2xx with user info and a query is reduced to the origin", async () => {
    const transport: HttpTransport = async () => ({ ok: false, status: 500 });
    const { logged, reported } = await failThrough(new WebhookSink(HOOK, transport));
    expect(reported).toBe("webhook POST to https://hooks.example.test returned 500");
    expectNoSecret(reported, ...logged);
  });

  it("a transport error whose message carries the URL is scrubbed", async () => {
    for (const url of [SLACK, HOOK]) {
      const transport: HttpTransport = async (u) => {
        throw new TypeError(`fetch failed for ${u} (cause: connect ECONNREFUSED ${u})`);
      };
      const { logged, reported } = await failThrough(new WebhookSink(url, transport));
      expect(reported).toMatch(
        /^webhook POST to https:\/\/hooks\.(slack\.com|example\.test) failed/,
      );
      expect(reported).toContain("ECONNREFUSED");
      expectNoSecret(reported, ...logged);
    }
  });

  it("a timeout names the origin only", async () => {
    const transport: HttpTransport = () => new Promise(() => {});
    const { logged, reported } = await failThrough(new SlackSink(SLACK, transport, 20));
    expect(reported).toBe("webhook POST to https://hooks.slack.com timed out after 20ms");
    expectNoSecret(reported, ...logged);
  });

  it("an invalid URL (the real fetch refuses it) leaks nothing", async () => {
    const bad = `hooks.slack.com/services/TFAKE/BFAKE/${SECRET}`;
    const { logged, reported } = await failThrough(new SlackSink(bad));
    expectNoSecret(reported, ...logged);
    // a URL carrying credentials, which fetch refuses with the URL in its message
    const creds = await failThrough(new WebhookSink(HOOK));
    expectNoSecret(creds.reported, ...creds.logged);
  });

  it("a custom sink's error that quotes a URL is scrubbed at the notifier", async () => {
    const sink: NotifySink = {
      name: "custom",
      deliver: async () => {
        throw new Error(`could not reach ${SLACK}`);
      },
    };
    const { logged, reported } = await failThrough(sink);
    expect(reported).toBe("could not reach https://hooks.slack.com");
    expectNoSecret(reported, ...logged);
  });

  it("the outbound deep link loses user info and a query (the dashboard token)", async () => {
    const bodies: string[] = [];
    const transport: HttpTransport = async (_u, init) => {
      bodies.push(init.body);
      return { ok: true, status: 200 };
    };
    for (const redact of [true, false]) {
      const notifier = new CompositeNotifier(
        [new WebhookSink("https://hooks.example.test/x", transport)],
        ["review_needed"],
        undefined,
        redact,
      );
      await notifier.notifyAndReport({
        ...event,
        url: `http://op:${SECRET}@10.0.0.5:8080/?token=${SECRET}/tickets/7#/tickets/7`,
      });
    }
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b).not.toContain(SECRET);
      expect(JSON.parse(b).url).toBe("http://10.0.0.5:8080/#/tickets/7");
    }
  });
});

describe("a timed-out notification aborts its HTTP request", () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("the server sees the socket close after the deadline", async () => {
    let socket: Socket | undefined;
    let requestSeen!: () => void;
    const seen = new Promise<void>((r) => (requestSeen = r));
    let closed!: () => void;
    const socketClosed = new Promise<void>((r) => (closed = r));
    server = createServer((req) => {
      // never answer
      socket = req.socket;
      req.socket.on("close", () => closed());
      requestSeen();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;

    const sink = new WebhookSink(`http://127.0.0.1:${port}/hook/${SECRET}`, undefined, 200);
    const started = Date.now();
    await expect(sink.deliver(event)).rejects.toThrow(/timed out after 200ms/);
    await seen;
    expect(socket).toBeDefined();
    // The request is torn down by the client shortly after the deadline, not left
    // running until the server gives up.
    const outcome = await Promise.race([
      socketClosed.then(() => "closed"),
      new Promise((r) => setTimeout(() => r("still open"), 2_000)),
    ]);
    expect(outcome).toBe("closed");
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("an injected transport that ignores the signal still times out", async () => {
    let gotSignal: AbortSignal | undefined;
    const transport: HttpTransport = (_u, init) => {
      gotSignal = (init as { signal?: AbortSignal }).signal;
      return new Promise(() => {});
    };
    const sink = new WebhookSink("https://hooks.example.test/x", transport, 20);
    await expect(sink.deliver(event)).rejects.toThrow(/timed out after 20ms/);
    expect(gotSignal?.aborted).toBe(true);
  });
});
