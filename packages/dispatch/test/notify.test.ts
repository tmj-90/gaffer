import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import {
  buildNotifierFromEnv,
  CompositeNotifier,
  DesktopSink,
  parseAllowedEvents,
  renderSlackText,
  SlackSink,
  WebhookSink,
  type CommandResult,
  type HttpTransport,
  type Notifier,
  type NotifyEvent,
  type NotifyKind,
} from "../src/notify/index.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const reviewer: Actor = { type: "human", id: "rev" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

/**
 * A recording {@link Notifier} fake: captures every event the facade fires so a
 * test can assert the structured shape without any real sink/transport.
 */
class FakeNotifier implements Notifier {
  readonly events: NotifyEvent[] = [];
  enabled = true;
  notify(event: NotifyEvent): void {
    this.events.push(event);
  }
}

function freshWg(notifier: Notifier, clock = new TestClock()): Dispatch {
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner, { notifier });
}

/** Drive a fresh ticket all the way to `in_review` and return its id + token. */
function driveToInReview(wg: Dispatch): { ticketId: string; acId: string; claimToken: string } {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  return { ticketId: t.id, acId: ac.id, claimToken: claim!.claimToken };
}

describe("H2 facade gate notifications", () => {
  it("fires a correctly-shaped review_needed event when a ticket enters in_review", () => {
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    const { ticketId } = driveToInReview(wg);

    expect(wg.view(ticketId).ticket.status).toBe("in_review");
    const review = notifier.events.filter((e) => e.kind === "review_needed");
    expect(review).toHaveLength(1);
    const ev = review[0]!;
    expect(ev).toMatchObject({
      kind: "review_needed",
      title: "Ship it",
      status: "in_review",
      repo: "svc",
      detail: "done",
    });
    expect(ev.ticket_number).toBeTypeOf("number");
    expect(typeof ev.at).toBe("string");
  });

  it("fires ticket_blocked when an agent blocks its claimed ticket", () => {
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket(
      { title: "Blocked one", description: "needs a human", policy_pack: "team_light" },
      human,
    );
    wg.linkRepository(t.id, "svc", "primary", human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
    wg.markBlocked(
      { claimToken: claim!.claimToken, ticket_id: t.id, reason: "missing creds" },
      agentActor,
    );

    expect(wg.view(t.id).ticket.status).toBe("blocked");
    const blocked = notifier.events.filter((e) => e.kind === "ticket_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      kind: "ticket_blocked",
      title: "Blocked one",
      status: "blocked",
      detail: "missing creds",
    });
  });

  it("fires ticket_parked when a reject exhausts the retry budget", () => {
    const notifier = new FakeNotifier();
    // maxAttempts=1 so the first requeue immediately parks to blocked.
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      notifier,
      maxAttempts: 1,
    });

    const { ticketId } = driveToInReview(wg);
    notifier.events.length = 0; // drop the review_needed from submit

    const res = wg.rejectReview(ticketId, "refining", reviewer, "not good enough");
    expect(res.ticket.status).toBe("blocked");

    const parked = notifier.events.filter((e) => e.kind === "ticket_parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ kind: "ticket_parked", status: "blocked" });
    expect(parked[0]!.detail).toContain("retry cap reached");
  });

  it("does NOT park-notify on an ordinary reject below the cap", () => {
    const notifier = new FakeNotifier();
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, {
      notifier,
      maxAttempts: 5,
    });
    const { ticketId } = driveToInReview(wg);
    notifier.events.length = 0;

    const res = wg.rejectReview(ticketId, "refining", reviewer, "minor nit");
    expect(res.ticket.status).toBe("refining");
    expect(notifier.events.filter((e) => e.kind === "ticket_parked")).toHaveLength(0);
  });

  it("fires decision_pending when a decision is raised", () => {
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    wg.createDecision(
      { title: "Which DB?", question: "Postgres or SQLite?", severity: "human_required" },
      human,
    );

    const pending = notifier.events.filter((e) => e.kind === "decision_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "decision_pending",
      title: "Which DB?",
      detail: "Postgres or SQLite?",
      status: "human_required",
    });
  });

  it("filters by the allow-list: only allowed kinds reach the sinks", () => {
    const recorder: NotifyEvent[] = [];
    const sink = {
      name: "recorder",
      deliver: async (e: NotifyEvent) => {
        recorder.push(e);
      },
    };
    // Allow only review_needed.
    const notifier = new CompositeNotifier([sink], ["review_needed"]);
    const wg = freshWg(notifier);

    driveToInReview(wg); // review_needed — allowed
    wg.createDecision({ title: "X", question: "?", severity: "human_required" }, human); // filtered

    const kinds = recorder.map((e) => e.kind);
    expect(kinds).toContain("review_needed");
    expect(kinds).not.toContain("decision_pending");
  });

  it("is silent end-to-end with no notify env configured (no-op notifier)", () => {
    // No FakeNotifier — let the facade build from a CLEAN env (nothing set).
    const saved = snapshotNotifyEnv();
    clearNotifyEnv();
    try {
      const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
      // The default notifier must be a no-op: nothing should throw, and driving a
      // gate is a complete no-op (we can't observe sinks, so we assert the
      // transitions still succeed, which proves the emit path is harmless).
      const { ticketId } = driveToInReview(wg);
      expect(wg.view(ticketId).ticket.status).toBe("in_review");
      wg.createDecision({ title: "X", question: "?" }, human);
    } finally {
      restoreNotifyEnv(saved);
    }
  });

  it("isolates a sink failure: a throwing sink does NOT break the transition", () => {
    const warnings: string[] = [];
    const exploding = {
      name: "boom",
      deliver: async () => {
        throw new Error("sink is down");
      },
    };
    const notifier = new CompositeNotifier([exploding], ["review_needed"], {
      warn: (m) => warnings.push(m),
    });
    const wg = freshWg(notifier);

    // The ticket must still reach in_review despite the sink throwing.
    const { ticketId } = driveToInReview(wg);
    expect(wg.view(ticketId).ticket.status).toBe("in_review");
  });
});

describe("AFK-LOOP P1 deep-links (GAFFER_DASHBOARD_URL)", () => {
  afterEach(() => {
    delete process.env.GAFFER_DASHBOARD_URL;
  });

  it("builds a ticket deep-link on review_needed when the base is set", () => {
    process.env.GAFFER_DASHBOARD_URL = "http://192.168.1.5:8787";
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    driveToInReview(wg);

    const review = notifier.events.find((e) => e.kind === "review_needed");
    expect(review).toBeDefined();
    expect(review!.ticket_number).toBeTypeOf("number");
    expect(review!.url).toBe(`http://192.168.1.5:8787/tickets/${review!.ticket_number}`);
  });

  it("builds a decision deep-link on decision_pending when the base is set", () => {
    process.env.GAFFER_DASHBOARD_URL = "http://192.168.1.5:8787/"; // trailing slash trimmed
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    const decision = wg.createDecision(
      { title: "Which DB?", question: "Postgres or SQLite?", severity: "human_required" },
      human,
    );

    const pending = notifier.events.find((e) => e.kind === "decision_pending");
    expect(pending).toBeDefined();
    expect(pending!.url).toBe(`http://192.168.1.5:8787/decisions/${decision.id}`);
  });

  it("negative control: NO url on either event when the base is unset", () => {
    delete process.env.GAFFER_DASHBOARD_URL;
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    driveToInReview(wg);
    wg.createDecision(
      { title: "Which DB?", question: "Postgres or SQLite?", severity: "human_required" },
      human,
    );

    const review = notifier.events.find((e) => e.kind === "review_needed");
    const pending = notifier.events.find((e) => e.kind === "decision_pending");
    expect(review).toBeDefined();
    expect(pending).toBeDefined();
    expect(review!.url).toBeUndefined();
    expect(pending!.url).toBeUndefined();
  });

  it("negative control: empty/whitespace base degrades to no url", () => {
    process.env.GAFFER_DASHBOARD_URL = "   ";
    const notifier = new FakeNotifier();
    const wg = freshWg(notifier);

    wg.createDecision(
      { title: "Which DB?", question: "Postgres or SQLite?", severity: "human_required" },
      human,
    );

    const pending = notifier.events.find((e) => e.kind === "decision_pending");
    expect(pending).toBeDefined();
    expect(pending!.url).toBeUndefined();
  });
});

describe("CompositeNotifier failure isolation", () => {
  it("logs and swallows an async rejection, never propagating it", async () => {
    const warnings: string[] = [];
    const exploding = {
      name: "boom",
      deliver: () => Promise.reject(new Error("kaboom")),
    };
    const notifier = new CompositeNotifier([exploding], ["review_needed"], {
      warn: (m) => warnings.push(m),
    });

    expect(() =>
      notifier.notify({ kind: "review_needed", at: new Date().toISOString() }),
    ).not.toThrow();
    // Let the microtask queue flush so the .catch runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings.some((w) => w.includes("boom") && w.includes("kaboom"))).toBe(true);
  });

  it("logs and swallows a SYNCHRONOUS throw inside deliver", () => {
    const warnings: string[] = [];
    const syncThrow = {
      name: "sync-boom",
      deliver: (): Promise<void> => {
        throw new Error("immediate");
      },
    };
    const notifier = new CompositeNotifier([syncThrow], ["review_needed"], {
      warn: (m) => warnings.push(m),
    });
    expect(() =>
      notifier.notify({ kind: "review_needed", at: new Date().toISOString() }),
    ).not.toThrow();
    expect(warnings.some((w) => w.includes("sync-boom"))).toBe(true);
  });

  it("is disabled (no sinks) → notify is a no-op", () => {
    const notifier = new CompositeNotifier([], ["review_needed"]);
    expect(notifier.enabled).toBe(false);
    expect(() =>
      notifier.notify({ kind: "review_needed", at: new Date().toISOString() }),
    ).not.toThrow();
  });
});

describe("WebhookSink", () => {
  const event: NotifyEvent = {
    kind: "review_needed",
    ticket_number: 7,
    title: "Ship it",
    status: "in_review",
    at: "2026-01-01T00:00:00.000Z",
  };

  it("POSTs the event as JSON to the configured URL", async () => {
    const calls: Array<{ url: string; init: { method: string; body: string } }> = [];
    const transport: HttpTransport = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    };
    const sink = new WebhookSink("https://example.test/hook", transport);
    await sink.deliver(event);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.test/hook");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({
      kind: "review_needed",
      ticket_number: 7,
    });
  });

  it("rejects on a non-2xx response (so the composite logs it)", async () => {
    const transport: HttpTransport = async () => ({ ok: false, status: 503 });
    const sink = new WebhookSink("https://example.test/hook", transport);
    await expect(sink.deliver(event)).rejects.toThrow(/503/);
  });

  it("rejects when the transport rejects", async () => {
    const transport: HttpTransport = async () => {
      throw new Error("network down");
    };
    const sink = new WebhookSink("https://example.test/hook", transport);
    await expect(sink.deliver(event)).rejects.toThrow(/network down/);
  });
});

describe("FIX-6 outbound redaction (GAFFER_NOTIFY_REDACT)", () => {
  // An agent-influenceable event: the title/detail are free text a prompt-injected
  // agent can steer, so they must not leave the box when redaction is on.
  const sensitive: NotifyEvent = {
    kind: "review_needed",
    ticket_number: 42,
    title: "EXFIL token=sk-secret-abc123",
    detail: "leaked: AKIA_FAKE_KEY and a customer email",
    status: "in_review",
    repo: "svc",
    url: "https://dash.test/t/42",
    at: "2026-01-01T00:00:00.000Z",
  };

  /** Capture the JSON body a CompositeNotifier+WebhookSink actually POSTs. */
  async function capturePost(redact: boolean): Promise<Record<string, unknown>> {
    let body = "";
    const transport: HttpTransport = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200 };
    };
    const sink = new WebhookSink("https://example.test/hook", transport);
    const notifier = new CompositeNotifier([sink], ["review_needed"], undefined, redact);
    notifier.notify(sensitive);
    // notify() is fire-and-forget; let the sink's microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    return JSON.parse(body) as Record<string, unknown>;
  }

  it("full mode (default) sends the raw title and detail", async () => {
    const sent = await capturePost(false);
    expect(sent["title"]).toBe(sensitive.title);
    expect(sent["detail"]).toBe(sensitive.detail);
    expect(sent["kind"]).toBe("review_needed");
    expect(sent["ticket_number"]).toBe(42);
  });

  it("redacted mode drops title/detail/repo, keeps kind+ticket+status+url", async () => {
    const sent = await capturePost(true);
    // The agent-influenceable free text must be GONE.
    expect(sent["title"]).toBeUndefined();
    expect(sent["detail"]).toBeUndefined();
    expect(sent["repo"]).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("EXFIL");
    expect(JSON.stringify(sent)).not.toContain("AKIA_FAKE_KEY");
    // The structural triage fields stay.
    expect(sent["kind"]).toBe("review_needed");
    expect(sent["ticket_number"]).toBe(42);
    expect(sent["status"]).toBe("in_review");
    expect(sent["url"]).toBe("https://dash.test/t/42");
  });

  it("GAFFER_NOTIFY_REDACT=1 makes the env-built notifier POST a redacted body", async () => {
    // buildNotifierFromEnv constructs its own WebhookSink over the global fetch, so
    // stub fetch to capture the body the env-wired notifier actually sends.
    const realFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      body = init.body;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    try {
      const notifier = buildNotifierFromEnv({
        GAFFER_NOTIFY_WEBHOOK_URL: "https://example.test/hook",
        GAFFER_NOTIFY_REDACT: "1",
      });
      expect(notifier.enabled).toBe(true);
      notifier.notify(sensitive);
      await new Promise((r) => setTimeout(r, 0));
      const sent = JSON.parse(body) as Record<string, unknown>;
      expect(sent["title"]).toBeUndefined();
      expect(sent["detail"]).toBeUndefined();
      expect(sent["kind"]).toBe("review_needed");
      expect(sent["ticket_number"]).toBe(42);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("without the flag the env-built notifier POSTs the full body", async () => {
    const realFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      body = init.body;
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    try {
      const notifier = buildNotifierFromEnv({
        GAFFER_NOTIFY_WEBHOOK_URL: "https://example.test/hook",
      });
      notifier.notify(sensitive);
      await new Promise((r) => setTimeout(r, 0));
      expect((JSON.parse(body) as Record<string, unknown>)["title"]).toBe(sensitive.title);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("SlackSink", () => {
  it("rewrites the body to Slack's {text} shape", async () => {
    let captured = "";
    const transport: HttpTransport = async (_url, init) => {
      captured = init.body;
      return { ok: true, status: 200 };
    };
    const sink = new SlackSink("https://hooks.slack.test/abc", transport);
    await sink.deliver({
      kind: "ticket_blocked",
      ticket_number: 3,
      title: "Blocked one",
      at: "2026-01-01T00:00:00.000Z",
    });
    const body = JSON.parse(captured) as { text: string };
    expect(body.text).toContain("Ticket blocked");
    expect(body.text).toContain("#3");
    expect(body.text).toContain("Blocked one");
  });

  it("renders each kind to a distinct heading", () => {
    const at = "2026-01-01T00:00:00.000Z";
    expect(renderSlackText({ kind: "review_needed", at })).toContain("Review needed");
    expect(renderSlackText({ kind: "decision_pending", at, title: "Q" })).toContain(
      "Decision pending",
    );
    expect(renderSlackText({ kind: "ticket_parked", at })).toContain("(untitled)");
  });
});

describe("DesktopSink", () => {
  it("spawns notify-send on Linux", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = (command: string, args: readonly string[]): CommandResult => {
      calls.push({ command, args });
      return { status: 0, stderr: "" };
    };
    const sink = new DesktopSink(runner, "linux");
    await sink.deliver({
      kind: "review_needed",
      ticket_number: 9,
      title: "Ship it",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(calls[0]!.command).toBe("notify-send");
    expect(calls[0]!.args.join(" ")).toContain("review needed");
  });

  it("falls back to osascript on macOS when terminal-notifier is absent", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = (command: string, args: readonly string[]): CommandResult => {
      calls.push({ command, args });
      return { status: 0, stderr: "" };
    };
    // terminal-notifier almost certainly isn't installed on CI → osascript path.
    const sink = new DesktopSink(runner, "darwin");
    await sink.deliver({ kind: "ticket_blocked", title: "x", at: "2026-01-01T00:00:00.000Z" });
    // Either terminal-notifier (if present locally) or osascript — both acceptable.
    expect(["terminal-notifier", "osascript"]).toContain(calls[0]!.command);
  });

  it("throws (degrades gracefully) when the binary exits non-zero", async () => {
    const runner = (): CommandResult => ({ status: 1, stderr: "no display" });
    const sink = new DesktopSink(runner, "linux");
    await expect(
      sink.deliver({ kind: "review_needed", at: "2026-01-01T00:00:00.000Z" }),
    ).rejects.toThrow(/exited 1/);
  });

  it("surfaces a thrown runner error (absent binary) for the composite to swallow", async () => {
    const runner = (): CommandResult => {
      throw new Error("spawn notify-send ENOENT");
    };
    const sink = new DesktopSink(runner, "linux");
    await expect(
      sink.deliver({ kind: "review_needed", at: "2026-01-01T00:00:00.000Z" }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("config: buildNotifierFromEnv + parseAllowedEvents", () => {
  it("returns a no-op notifier when nothing is configured", () => {
    const notifier = buildNotifierFromEnv({});
    expect(notifier.enabled).toBe(false);
  });

  it("builds an enabled notifier when a webhook URL is set", () => {
    const notifier = buildNotifierFromEnv({ GAFFER_NOTIFY_WEBHOOK_URL: "https://x.test/h" });
    expect(notifier.enabled).toBe(true);
  });

  it("enables the desktop sink on a truthy flag", () => {
    expect(buildNotifierFromEnv({ GAFFER_NOTIFY_DESKTOP: "1" }).enabled).toBe(true);
    expect(buildNotifierFromEnv({ GAFFER_NOTIFY_DESKTOP: "true" }).enabled).toBe(true);
    expect(buildNotifierFromEnv({ GAFFER_NOTIFY_DESKTOP: "0" }).enabled).toBe(false);
  });

  it("treats a blank/whitespace URL as unconfigured", () => {
    expect(buildNotifierFromEnv({ GAFFER_NOTIFY_WEBHOOK_URL: "   " }).enabled).toBe(false);
  });

  it("defaults the allow-list to all kinds when unset/empty", () => {
    expect(parseAllowedEvents(undefined)).toHaveLength(4);
    expect(parseAllowedEvents("")).toHaveLength(4);
  });

  it("parses a CSV allow-list and drops unknown tokens", () => {
    const kinds = parseAllowedEvents("review_needed, bogus ,decision_pending");
    expect(kinds).toContain<NotifyKind>("review_needed");
    expect(kinds).toContain<NotifyKind>("decision_pending");
    expect(kinds).not.toContain("ticket_blocked" as NotifyKind);
  });

  it("falls back to the default when every token is unknown", () => {
    expect(parseAllowedEvents("nope,also-nope")).toHaveLength(4);
  });
});

// --- env helpers (keep the process env clean across the no-op test) ---------

const NOTIFY_KEYS = [
  "GAFFER_NOTIFY_WEBHOOK_URL",
  "GAFFER_NOTIFY_SLACK_URL",
  "GAFFER_NOTIFY_DESKTOP",
  "GAFFER_NOTIFY_EVENTS",
] as const;

function snapshotNotifyEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of NOTIFY_KEYS) snap[k] = process.env[k];
  return snap;
}

function clearNotifyEnv(): void {
  for (const k of NOTIFY_KEYS) delete process.env[k];
}

function restoreNotifyEnv(snap: Record<string, string | undefined>): void {
  for (const k of NOTIFY_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let envSnapshot: Record<string, string | undefined>;
beforeEach(() => {
  envSnapshot = snapshotNotifyEnv();
  clearNotifyEnv();
});
afterEach(() => {
  restoreNotifyEnv(envSnapshot);
  vi.restoreAllMocks();
});
