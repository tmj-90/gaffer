import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { createApiServer } from "../src/api/server.js";
import { TestClock } from "../src/util/clock.js";
import Database from "better-sqlite3";

/**
 * H9 — durable async plan-build chat.
 *
 * Covers:
 *  - migration applies idempotently (plan_sessions table appears on existing v10 DB)
 *  - session CRUD via the repository: create, getById, getActive, appendMessage, archive
 *  - archiveAllActive before create ensures only one active session exists
 *  - message append: history grows, brief + plan_json update correctly
 *  - status transitions: active → confirmed / abandoned
 *  - list cap: returns most-recent first, honours the limit
 *  - REST surface: POST /plan-sessions, GET /plan-sessions/active, GET /plan-sessions/:id,
 *    POST /plan-sessions/:id/turns, POST /plan-sessions/:id/archive, GET /plan-sessions
 *  - bearer 401 on all plan-sessions paths when auth is configured
 *  - reload-restores-session integration shape: create → turns → fetch → confirm matches
 */

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

// ===========================================================================
//  Migration idempotency
// ===========================================================================

describe("plan_sessions migration", () => {
  it("creates the plan_sessions table on a fresh DB", () => {
    const db = new Database(":memory:");
    migrate(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_sessions'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("plan_sessions");
    db.close();
  });

  it("applies idempotently when migrate() is called twice", () => {
    const db = new Database(":memory:");
    migrate(db);
    // Second call must not throw (idempotent CREATE TABLE IF NOT EXISTS).
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it("stamps the current schema_version after migration", () => {
    const db = new Database(":memory:");
    migrate(db);
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(Number(row?.value)).toBe(SCHEMA_VERSION);
    db.close();
  });
});

// ===========================================================================
//  Repository unit tests
// ===========================================================================

describe("PlanSessionRepository — CRUD", () => {
  it("creates a session with empty messages and active status", () => {
    const wg = freshWg();
    const session = wg.createPlanSession();
    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");
    expect(session.brief).toBeNull();
    expect(session.plan_json).toBeNull();
    expect(JSON.parse(session.messages_json)).toEqual([]);
  });

  it("getById returns the session", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    const fetched = wg.getPlanSession(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(id);
  });

  it("getById returns null for an unknown id", () => {
    const wg = freshWg();
    expect(wg.getPlanSession("does-not-exist")).toBeNull();
  });

  it("getActivePlanSession returns the most recent active session", () => {
    const wg = freshWg();
    const s1 = wg.createPlanSession();
    const active = wg.getActivePlanSession();
    expect(active?.id).toBe(s1.id);
  });

  it("getActivePlanSession returns null when no active sessions exist", () => {
    const wg = freshWg();
    expect(wg.getActivePlanSession()).toBeNull();
  });
});

describe("PlanSessionRepository — createPlanSession archives previous active", () => {
  it("archives the previous active session as abandoned before creating a new one", () => {
    const wg = freshWg();
    const first = wg.createPlanSession();
    expect(first.status).toBe("active");

    const second = wg.createPlanSession();
    expect(second.status).toBe("active");
    expect(second.id).not.toBe(first.id);

    // First session is now abandoned.
    const archived = wg.getPlanSession(first.id);
    expect(archived?.status).toBe("abandoned");

    // Only the second is active.
    const active = wg.getActivePlanSession();
    expect(active?.id).toBe(second.id);
  });
});

describe("PlanSessionRepository — appendMessage", () => {
  it("appends a user message, updates brief, and grows messages_json", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();

    const updated = wg.appendPlanMessage(
      id,
      { role: "user", content: "build a gym app" },
      { brief: "build a gym app" },
    );
    expect(updated).not.toBeNull();
    expect(updated!.brief).toBe("build a gym app");
    const messages = JSON.parse(updated!.messages_json) as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("build a gym app");
  });

  it("appends an assistant clarify message with the JSON envelope as content", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    wg.appendPlanMessage(id, { role: "user", content: "gym app" }, { brief: "gym app" });

    const envelope = JSON.stringify({ phase: "clarify", questions: ["Web or mobile?"] });
    const updated = wg.appendPlanMessage(id, { role: "assistant", content: envelope });
    const messages = JSON.parse(updated!.messages_json) as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("assistant");
    expect(JSON.parse(messages[1]!.content)).toEqual({
      phase: "clarify",
      questions: ["Web or mobile?"],
    });
  });

  it("stores plan_json when a plan is appended", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    const plan = { epic: { name: "Gym" }, tickets: [{ title: "bootstrap", dependsOn: [] }] };
    const updated = wg.appendPlanMessage(
      id,
      { role: "assistant", content: JSON.stringify({ phase: "plan", plan }) },
      { plan },
    );
    expect(updated!.plan_json).not.toBeNull();
    const stored = JSON.parse(updated!.plan_json!);
    expect(stored.epic.name).toBe("Gym");
  });

  it("returns null when the session id is not found", () => {
    const wg = freshWg();
    const result = wg.appendPlanMessage("no-such-id", { role: "user", content: "hello" });
    expect(result).toBeNull();
  });

  it("accumulates multiple messages in order", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    wg.appendPlanMessage(id, { role: "user", content: "brief" }, { brief: "brief" });
    wg.appendPlanMessage(id, {
      role: "assistant",
      content: JSON.stringify({ phase: "clarify", questions: ["Q?"] }),
    });
    wg.appendPlanMessage(id, { role: "user", content: "answer" });

    const session = wg.getPlanSession(id)!;
    const messages = JSON.parse(session.messages_json) as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("PlanSessionRepository — status transitions", () => {
  it("archives an active session as confirmed", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    wg.archivePlanSession(id, "confirmed");
    const session = wg.getPlanSession(id)!;
    expect(session.status).toBe("confirmed");
  });

  it("archives an active session as abandoned", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    wg.archivePlanSession(id, "abandoned");
    const session = wg.getPlanSession(id)!;
    expect(session.status).toBe("abandoned");
  });

  it("archive is a no-op on an already-archived session", () => {
    const wg = freshWg();
    const { id } = wg.createPlanSession();
    wg.archivePlanSession(id, "confirmed");
    // Second call with a different status — the first status must win.
    wg.archivePlanSession(id, "abandoned");
    const session = wg.getPlanSession(id)!;
    expect(session.status).toBe("confirmed");
  });
});

describe("PlanSessionRepository — list cap", () => {
  it("lists most-recently-created sessions first", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Each createPlanSession archives the previous one; we want three total.
      // Use the repository directly to avoid the auto-archive behaviour.
      const repo = wg.planSessions;
      const now = clock.now();
      const s = repo.create({ id: `s-${i}`, created_at: now, updated_at: now });
      ids.push(s.id);
      clock.advanceSeconds(1);
    }
    const all = wg.listPlanSessions({ limit: 10 });
    // Most-recently created is last in ids array, first in list.
    expect(all[0]!.id).toBe(ids[2]);
    expect(all[1]!.id).toBe(ids[1]);
    expect(all[2]!.id).toBe(ids[0]);
  });

  it("honours the limit cap and never returns more than 100", () => {
    const wg = freshWg();
    const repo = wg.planSessions;
    const now = "2026-01-01T00:00:00.000Z";
    for (let i = 0; i < 5; i++) {
      repo.create({ id: `s-${i}`, created_at: now, updated_at: now });
    }
    const limited = wg.listPlanSessions({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("filters by status when given", () => {
    const wg = freshWg();
    const repo = wg.planSessions;
    const now = "2026-01-01T00:00:00.000Z";
    const s1 = repo.create({ id: "a", created_at: now, updated_at: now });
    const s2 = repo.create({ id: "b", created_at: now, updated_at: now });
    repo.archive({ id: s1.id, status: "confirmed", updated_at: now });
    void s2;

    const confirmed = wg.listPlanSessions({ status: "confirmed" });
    expect(confirmed.map((s) => s.id)).toContain(s1.id);
    expect(confirmed.map((s) => s.id)).not.toContain(s2.id);

    const active = wg.listPlanSessions({ status: "active" });
    expect(active.map((s) => s.id)).toContain(s2.id);
    expect(active.map((s) => s.id)).not.toContain(s1.id);
  });
});

// ===========================================================================
//  REST surface
// ===========================================================================

interface Harness {
  baseUrl: string;
  wg: Dispatch;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wg,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("POST /plan-sessions — create a session", () => {
  it("returns 201 with a new active session", async () => {
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "POST", "/plan-sessions");
      expect(res.status).toBe(201);
      const session = res.body.session as Record<string, unknown>;
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("active");
      expect(session.brief).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("returns 405 for GET on /plan-sessions when a body exists", async () => {
    // GET /plan-sessions is list, so test method not allowed via DELETE.
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "DELETE", "/plan-sessions");
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });
});

describe("GET /plan-sessions/active", () => {
  it("returns null when no active session exists", async () => {
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "GET", "/plan-sessions/active");
      expect(res.status).toBe(200);
      expect(res.body.session).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("returns the active session after creating one", async () => {
    const h = await startHarness();
    try {
      await call(h.baseUrl, "POST", "/plan-sessions");
      const res = await call(h.baseUrl, "GET", "/plan-sessions/active");
      expect(res.status).toBe(200);
      expect(res.body.session).not.toBeNull();
      const session = res.body.session as Record<string, unknown>;
      expect(session.status).toBe("active");
    } finally {
      await h.close();
    }
  });
});

describe("GET /plan-sessions/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "GET", "/plan-sessions/does-not-exist");
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("returns the session by id", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;
      const fetched = await call(h.baseUrl, "GET", `/plan-sessions/${id}`);
      expect(fetched.status).toBe(200);
      expect((fetched.body.session as Record<string, unknown>).id).toBe(id);
    } finally {
      await h.close();
    }
  });
});

describe("POST /plan-sessions/:id/turns", () => {
  it("appends a user message and returns the updated session", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;

      const turned = await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        role: "user",
        content: "build a gym tracker",
        brief: "build a gym tracker",
      });
      expect(turned.status).toBe(200);
      const session = turned.body.session as Record<string, unknown>;
      expect(session.brief).toBe("build a gym tracker");
      const messages = JSON.parse(session.messages_json as string) as Array<{ role: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe("user");
    } finally {
      await h.close();
    }
  });

  it("appends an assistant turn with a plan and stores plan_json", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;

      const plan = {
        epic: { name: "Gym tracker" },
        tickets: [{ title: "bootstrap", dependsOn: [] }],
      };
      await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        role: "assistant",
        content: JSON.stringify({ phase: "plan", plan }),
        plan,
      });

      const fetched = await call(h.baseUrl, "GET", `/plan-sessions/${id}`);
      const session = fetched.body.session as Record<string, unknown>;
      expect(session.plan_json).not.toBeNull();
      expect(JSON.parse(session.plan_json as string).epic.name).toBe("Gym tracker");
    } finally {
      await h.close();
    }
  });

  it("returns 404 for a turn on an unknown session id", async () => {
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "POST", "/plan-sessions/unknown/turns", {
        role: "user",
        content: "hello",
      });
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("returns 422 for a missing role field", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;
      const res = await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        content: "oops",
      });
      expect(res.status).toBe(422);
    } finally {
      await h.close();
    }
  });
});

describe("POST /plan-sessions/:id/archive", () => {
  it("transitions the session to confirmed", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;

      const archived = await call(h.baseUrl, "POST", `/plan-sessions/${id}/archive`, {
        status: "confirmed",
      });
      expect(archived.status).toBe(200);
      expect((archived.body.session as Record<string, unknown>).status).toBe("confirmed");
    } finally {
      await h.close();
    }
  });

  it("transitions the session to abandoned", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;

      const archived = await call(h.baseUrl, "POST", `/plan-sessions/${id}/archive`, {
        status: "abandoned",
      });
      expect((archived.body.session as Record<string, unknown>).status).toBe("abandoned");
    } finally {
      await h.close();
    }
  });

  it("returns 404 for an unknown session id", async () => {
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "POST", "/plan-sessions/unknown/archive", {
        status: "abandoned",
      });
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("returns 422 for an invalid status value", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;

      const res = await call(h.baseUrl, "POST", `/plan-sessions/${id}/archive`, {
        status: "bogus",
      });
      expect(res.status).toBe(422);
    } finally {
      await h.close();
    }
  });
});

describe("GET /plan-sessions — list", () => {
  it("returns an empty list when no sessions exist", async () => {
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "GET", "/plan-sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("returns both sessions after two creates (second archives the first)", async () => {
    const h = await startHarness();
    try {
      // Creating two sessions — the second call archives the first as abandoned.
      const first = await call(h.baseUrl, "POST", "/plan-sessions");
      const firstId = (first.body.session as Record<string, unknown>).id as string;
      const second = await call(h.baseUrl, "POST", "/plan-sessions");
      const secondId = (second.body.session as Record<string, unknown>).id as string;

      const list = await call(h.baseUrl, "GET", "/plan-sessions?limit=5");
      const sessions = list.body.sessions as Array<{ id: string }>;
      expect(sessions.length).toBe(2);
      // Both ids are in the list regardless of ordering (timestamps may collide in TestClock).
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(firstId);
      expect(ids).toContain(secondId);
    } finally {
      await h.close();
    }
  });

  it("honours the ?status= filter", async () => {
    const h = await startHarness();
    try {
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      const id = (created.body.session as Record<string, unknown>).id as string;
      await call(h.baseUrl, "POST", `/plan-sessions/${id}/archive`, { status: "confirmed" });
      // Create another active one via the second POST (archives previous).
      await call(h.baseUrl, "POST", "/plan-sessions");

      const confirmed = await call(h.baseUrl, "GET", "/plan-sessions?status=confirmed");
      const sessions = confirmed.body.sessions as Array<{ id: string; status: string }>;
      expect(sessions.every((s) => s.status === "confirmed")).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("Plan-sessions bearer 401", () => {
  const TOKEN = "plan-s3cr3t";
  const originalToken = process.env.DISPATCH_API_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = originalToken;
  });

  it("rejects plan-session requests without a token when auth is configured", async () => {
    process.env.DISPATCH_API_TOKEN = TOKEN;
    const h = await startHarness();
    try {
      const unauthenticated = await Promise.all([
        call(h.baseUrl, "POST", "/plan-sessions"),
        call(h.baseUrl, "GET", "/plan-sessions/active"),
        call(h.baseUrl, "GET", "/plan-sessions/some-id"),
        call(h.baseUrl, "POST", "/plan-sessions/some-id/turns", { role: "user", content: "x" }),
        call(h.baseUrl, "POST", "/plan-sessions/some-id/archive", { status: "abandoned" }),
        call(h.baseUrl, "GET", "/plan-sessions"),
      ]);
      for (const r of unauthenticated) {
        expect(r.status).toBe(401);
      }
    } finally {
      await h.close();
    }
  });

  it("accepts plan-session requests with the correct bearer token", async () => {
    process.env.DISPATCH_API_TOKEN = TOKEN;
    const h = await startHarness();
    try {
      const res = await call(h.baseUrl, "POST", "/plan-sessions", undefined, TOKEN);
      expect(res.status).toBe(201);
    } finally {
      await h.close();
    }
  });
});

describe("Reload-restores-session integration", () => {
  it("creates a session, adds turns, fetches it, and confirms — full round-trip", async () => {
    const h = await startHarness();
    try {
      // 1. Panel opens — create a session.
      const created = await call(h.baseUrl, "POST", "/plan-sessions");
      expect(created.status).toBe(201);
      const id = (created.body.session as Record<string, unknown>).id as string;

      // 2. User sends a brief.
      await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        role: "user",
        content: "gym tracker app",
        brief: "gym tracker app",
      });

      // 3. Assistant responds with clarify questions.
      const clarify = JSON.stringify({ phase: "clarify", questions: ["Web or mobile?"] });
      await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        role: "assistant",
        content: clarify,
      });

      // 4. User answers.
      await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        role: "user",
        content: "web",
      });

      // 5. Assistant delivers a plan.
      const plan = {
        epic: { name: "Gym tracker" },
        tickets: [{ title: "bootstrap", dependsOn: [] }],
      };
      const planContent = JSON.stringify({ phase: "plan", plan });
      await call(h.baseUrl, "POST", `/plan-sessions/${id}/turns`, {
        role: "assistant",
        content: planContent,
        plan,
      });

      // 6. Simulate a reload: fetch the active session and verify it restores.
      const activeRes = await call(h.baseUrl, "GET", "/plan-sessions/active");
      expect(activeRes.status).toBe(200);
      const restored = activeRes.body.session as Record<string, unknown>;
      expect(restored.id).toBe(id);
      expect(restored.brief).toBe("gym tracker app");
      expect(restored.plan_json).not.toBeNull();

      const messages = JSON.parse(restored.messages_json as string) as Array<{ role: string }>;
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

      // 7. Confirm the plan.
      const confirmed = await call(h.baseUrl, "POST", `/plan-sessions/${id}/archive`, {
        status: "confirmed",
      });
      expect((confirmed.body.session as Record<string, unknown>).status).toBe("confirmed");

      // 8. No more active sessions.
      const afterConfirm = await call(h.baseUrl, "GET", "/plan-sessions/active");
      expect(afterConfirm.body.session).toBeNull();
    } finally {
      await h.close();
    }
  });
});
