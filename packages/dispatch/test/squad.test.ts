/**
 * SQUAD (schema v27) — the club identity + agent display names / shirt numbers
 * behind the dashboard's Match Day view. Presentation only.
 *
 *   migration — a v26 DB (agents without squad columns, no club table) upgrades in
 *               place: rows survive, the new columns read NULL, the CHECK and the
 *               partial unique index on shirt_number hold, the version is stamped.
 *   validation — club name / short name / kit colour, display-name length + trim,
 *               shirt number range + uniqueness (409-class DUPLICATE).
 *   defaults  — deterministic derived names from role + index ("Delivery 1",
 *               "Reviewer", "Security reviewer", "Tester"); "Gaffer" for the club.
 *   identity  — a rename never changes the id claims / events record; the new
 *               name shows through `agent_display` on claims.
 *   events    — every change is one `club.updated` / `agent.display_updated`
 *               event with a before/after diff; a no-op writes nothing.
 *   REST      — reads with the read token, writes refused for it (403) and
 *               accepted with the full token (attributed to the request's actor);
 *               `agent_display` on /claims, /tickets/:id, /api/board,
 *               /api/activity and /agents.
 *   CLI       — `club show|set`, `agent list|rename`.
 *   MCP       — read-only `get_squad`; no tool takes a name / number / club field.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { deriveReadToken, setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { registerAgent } from "../src/cli/commands/agent.js";
import { registerClub } from "../src/cli/commands/club.js";
import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { EXPORT_TABLES } from "../src/io/stateExport.js";
import { makeHandlers, toolSchemas } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const operator: Actor = { type: "human", id: "tom" };

function fresh(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

/** The runner's two principals plus a security reviewer, a tester and a second delivery agent. */
function seedSquad(wg: Dispatch) {
  const delivery = wg.registerAgent({ display_name: "gaffer-factory" }, operator);
  const reviewer = wg.registerAgent({ display_name: "gaffer-factory-reviewer" }, operator);
  const security = wg.registerAgent({ display_name: "gaffer-security-reviewer" }, operator);
  const tester = wg.registerAgent({ display_name: "gaffer-tester" }, operator);
  const delivery2 = wg.registerAgent({ display_name: "crew-implementer" }, operator);
  return { delivery, reviewer, security, tester, delivery2 };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe("squad: migration v26 → v27", () => {
  const V26_AGENTS = `
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, display_name TEXT,
      agent_type TEXT NOT NULL DEFAULT 'coding_agent', model TEXT, runtime TEXT, host TEXT,
      max_risk TEXT NOT NULL DEFAULT 'medium' CHECK (max_risk IN ('low','medium','high','critical')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
      created_by TEXT, last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`;

  it("adds squad_name/shirt_number + the club table to a v26 DB, keeping its agents", () => {
    const db = new Database(":memory:");
    db.exec(V26_AGENTS);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','26')").run();
    db.prepare("INSERT INTO agents (id, display_name) VALUES ('a1', 'gaffer-factory')").run();
    db.prepare(
      "INSERT INTO agents (id, display_name) VALUES ('a2', 'gaffer-factory-reviewer')",
    ).run();

    migrate(db);

    expect(SCHEMA_VERSION).toBe(27);
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(27);
    const cols = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(["squad_name", "shirt_number"]));
    expect(db.prepare("SELECT * FROM agents WHERE id='a1'").get()).toMatchObject({
      display_name: "gaffer-factory",
      squad_name: null,
      shirt_number: null,
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='club'").get(),
    ).toBeTruthy();

    // CHECK (1–99) and the partial unique index hold on the migrated table.
    expect(() => db.prepare("UPDATE agents SET shirt_number = 0 WHERE id='a1'").run()).toThrow();
    expect(() => db.prepare("UPDATE agents SET shirt_number = 100 WHERE id='a1'").run()).toThrow();
    db.prepare("UPDATE agents SET shirt_number = 7 WHERE id='a1'").run();
    expect(() => db.prepare("UPDATE agents SET shirt_number = 7 WHERE id='a2'").run()).toThrow(
      /UNIQUE/,
    );
    // Many agents may have no number.
    db.prepare("INSERT INTO agents (id) VALUES ('a3')").run();

    // Idempotent: a second migrate is a no-op.
    migrate(db);
    db.close();
  });

  it("a real pre-v27 database file opens, upgrades, and derives default names", () => {
    const dir = mkdtempSync(join(tmpdir(), "squad-mig-"));
    const path = join(dir, "dispatch.sqlite");
    try {
      const wg = Dispatch.open(path, new TestClock());
      const { delivery, reviewer } = seedSquad(wg);
      wg.db.close();
      // Downgrade the file to the v26 shape.
      const raw = new Database(path);
      raw.exec(`
        DROP INDEX idx_agents_shirt_number;
        ALTER TABLE agents DROP COLUMN shirt_number;
        ALTER TABLE agents DROP COLUMN squad_name;
        DROP TABLE club;
        UPDATE schema_meta SET value = '26' WHERE key = 'schema_version';
      `);
      raw.close();

      const reopened = Dispatch.open(path, new TestClock());
      const squad = reopened.listSquad();
      expect(squad.map((a) => a.agent_id)).toContain(delivery.id);
      expect(squad.find((a) => a.agent_id === delivery.id)?.display_name_effective).toBe(
        "Delivery 1",
      );
      expect(squad.find((a) => a.agent_id === reviewer.id)?.display_name_effective).toBe(
        "Reviewer",
      );
      expect(reopened.getClub().name_effective).toBe("Gaffer");
      reopened.updateAgentDisplay(delivery.id, { display_name: "Kev", shirt_number: 9 }, operator);
      expect(reopened.listSquad()[0]).toMatchObject({ display_name: "Kev", shirt_number: 9 });
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the club travels with the board in the state bundle", () => {
    expect((EXPORT_TABLES as readonly string[]).includes("club")).toBe(true);
  });
});

describe("squad: club identity", () => {
  it('defaults to "Gaffer" with a derived short name and no kit', () => {
    const wg = fresh();
    expect(wg.getClub()).toEqual({
      name: null,
      short_name: null,
      kit_primary: null,
      kit_secondary: null,
      name_effective: "Gaffer",
      short_name_effective: "GAF",
      updated_by: null,
      updated_at: null,
    });
  });

  it("sets, normalises, derives and clears", () => {
    const wg = fresh();
    const { club, changed } = wg.updateClub(
      { name: "  Factory Athletic Club ", kit_primary: "#1D4ED8", kit_secondary: "#FfF" },
      operator,
    );
    expect(changed).toEqual(["name", "kit_primary", "kit_secondary"]);
    expect(club).toMatchObject({
      name: "Factory Athletic Club",
      name_effective: "Factory Athletic Club",
      short_name: null,
      short_name_effective: "FAC",
      kit_primary: "#1d4ed8",
      kit_secondary: "#ffffff",
      updated_by: "tom",
    });
    expect(wg.updateClub({ short_name: "FAC1" }, operator).club.short_name_effective).toBe("FAC1");
    // Omitted fields are unchanged; "" / null clear.
    const cleared = wg.updateClub({ name: "", kit_primary: null }, operator).club;
    expect(cleared).toMatchObject({
      name: null,
      name_effective: "Gaffer",
      short_name: "FAC1",
      kit_primary: null,
      kit_secondary: "#ffffff",
    });
  });

  it("validates name length, short name and hex kit colours", () => {
    const wg = fresh();
    expect(codeOf(() => wg.updateClub({ name: "x".repeat(61) }, operator))).toBe(
      "VALIDATION_ERROR",
    );
    expect(wg.updateClub({ name: "x".repeat(60) }, operator).club.name).toHaveLength(60);
    expect(codeOf(() => wg.updateClub({ name: "bad\nname" }, operator))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => wg.updateClub({ short_name: "ABCDE" }, operator))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => wg.updateClub({ short_name: "A B" }, operator))).toBe("VALIDATION_ERROR");
    for (const bad of ["red", "#12345", "#gggggg", "1d4ed8", "#1d4ed8ff"]) {
      expect(
        codeOf(() => wg.updateClub({ kit_primary: bad }, operator)),
        bad,
      ).toBe("VALIDATION_ERROR");
      expect(
        codeOf(() => wg.updateClub({ kit_secondary: bad }, operator)),
        bad,
      ).toBe("VALIDATION_ERROR");
    }
    // A refused update changes nothing.
    expect(wg.getClub().kit_primary).toBeNull();
  });

  it("records one club.updated event per change with a before/after diff, none for a no-op", () => {
    const wg = fresh();
    wg.updateClub({ name: "Rovers" }, operator);
    wg.updateClub({ name: "Rovers" }, operator); // no-op
    wg.updateClub({ name: "United", kit_primary: "#000000" }, { type: "admin", id: "ops" });
    const events = listEvents(wg.db, "club", "club");
    expect(events.map((e) => e.event_type)).toEqual(["club.updated", "club.updated"]);
    expect(events[0]).toMatchObject({ actor_type: "human", actor_id: "tom" });
    expect(JSON.parse(events[0]?.payload_json ?? "{}")).toEqual({
      changes: { name: { from: null, to: "Rovers" } },
    });
    expect(events[1]).toMatchObject({ actor_type: "admin", actor_id: "ops" });
    expect(JSON.parse(events[1]?.payload_json ?? "{}")).toEqual({
      changes: {
        name: { from: "Rovers", to: "United" },
        kit_primary: { from: null, to: "#000000" },
      },
    });
    expect(wg.verifyEventChain().ok).toBe(true);
  });
});

describe("squad: agent display names + shirt numbers", () => {
  it("derives deterministic defaults from role + registration index", () => {
    const wg = fresh();
    const s = seedSquad(wg);
    const extraReviewer = wg.registerAgent({ display_name: "second-reviewer" }, operator);
    const byId = new Map(wg.listSquad().map((a) => [a.agent_id, a]));
    expect(byId.get(s.delivery.id)).toMatchObject({
      role: "delivery",
      display_name: null,
      display_name_effective: "Delivery 1",
      default_display_name: "Delivery 1",
      registered_name: "gaffer-factory",
      shirt_number: null,
    });
    expect(byId.get(s.reviewer.id)).toMatchObject({
      role: "reviewer",
      display_name_effective: "Reviewer",
    });
    expect(byId.get(s.security.id)).toMatchObject({
      role: "security_reviewer",
      display_name_effective: "Security reviewer",
    });
    expect(byId.get(s.tester.id)).toMatchObject({
      role: "tester",
      display_name_effective: "Tester",
    });
    expect(byId.get(s.delivery2.id)?.display_name_effective).toBe("Delivery 2");
    expect(byId.get(extraReviewer.id)?.display_name_effective).toBe("Reviewer 2");
    // Listed in registration order, stable across calls.
    expect(wg.listSquad().map((a) => a.agent_id)).toEqual([
      s.delivery.id,
      s.reviewer.id,
      s.security.id,
      s.tester.id,
      s.delivery2.id,
      extraReviewer.id,
    ]);
  });

  it("validates the display name (trimmed, ≤ 40) and the shirt number (1–99)", () => {
    const wg = fresh();
    const { delivery } = seedSquad(wg);
    expect(
      wg.updateAgentDisplay(delivery.id, { display_name: "   Kevin Keegan  " }, operator).agent
        .display_name,
    ).toBe("Kevin Keegan");
    expect(
      codeOf(() => wg.updateAgentDisplay(delivery.id, { display_name: "x".repeat(41) }, operator)),
    ).toBe("VALIDATION_ERROR");
    expect(
      wg.updateAgentDisplay(delivery.id, { display_name: "y".repeat(40) }, operator).agent
        .display_name,
    ).toHaveLength(40);
    expect(
      codeOf(() => wg.updateAgentDisplay(delivery.id, { display_name: "tab\there" }, operator)),
    ).toBe("VALIDATION_ERROR");
    for (const bad of [0, 100, -1, 1.5, Number.NaN]) {
      expect(
        codeOf(() => wg.updateAgentDisplay(delivery.id, { shirt_number: bad }, operator)),
        String(bad),
      ).toBe("VALIDATION_ERROR");
    }
    expect(
      wg.updateAgentDisplay(delivery.id, { shirt_number: 1 }, operator).agent.shirt_number,
    ).toBe(1);
    expect(
      wg.updateAgentDisplay(delivery.id, { shirt_number: 99 }, operator).agent.shirt_number,
    ).toBe(99);
    // "" clears the name back to the derived default.
    const cleared = wg.updateAgentDisplay(delivery.id, { display_name: "" }, operator).agent;
    expect(cleared).toMatchObject({ display_name: null, display_name_effective: "Delivery 1" });
    expect(
      codeOf(() => wg.updateAgentDisplay("no-such-agent", { shirt_number: 3 }, operator)),
    ).toBe("NOT_FOUND");
  });

  it("keeps shirt numbers unique among agents; clearing frees the number", () => {
    const wg = fresh();
    const { delivery, reviewer } = seedSquad(wg);
    wg.updateAgentDisplay(delivery.id, { display_name: "Kev", shirt_number: 9 }, operator);
    let err: unknown;
    try {
      wg.updateAgentDisplay(reviewer.id, { shirt_number: 9 }, operator);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "DUPLICATE", details: { agent_id: delivery.id } });
    expect((err as Error).message).toMatch(/already worn by Kev/);
    // Re-setting your own number is fine (no change).
    expect(wg.updateAgentDisplay(delivery.id, { shirt_number: 9 }, operator).changed).toEqual([]);
    wg.updateAgentDisplay(delivery.id, { shirt_number: null }, operator);
    expect(
      wg.updateAgentDisplay(reviewer.id, { shirt_number: 9 }, operator).agent.shirt_number,
    ).toBe(9);
  });

  it("resolves by id or a unique registered name, never by display name", () => {
    const wg = fresh();
    const { reviewer } = seedSquad(wg);
    wg.updateAgentDisplay("gaffer-factory-reviewer", { display_name: "Gary" }, operator);
    expect(wg.listSquad().find((a) => a.agent_id === reviewer.id)?.display_name).toBe("Gary");
    expect(codeOf(() => wg.updateAgentDisplay("Gary", { shirt_number: 2 }, operator))).toBe(
      "NOT_FOUND",
    );
    wg.registerAgent({ display_name: "twin" }, operator);
    wg.registerAgent({ display_name: "twin" }, operator);
    expect(codeOf(() => wg.updateAgentDisplay("twin", { shirt_number: 2 }, operator))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("never changes the agent id claims and events record; the name shows via agent_display", () => {
    const wg = fresh();
    const { delivery } = seedSquad(wg);
    const t = wg.createTicket({ title: "Task", policy_pack: "solo_loose" }, operator);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, operator);
    wg.markReady(t.id, operator);
    const claim = wg.claimNextTicket(
      { agentId: delivery.id, ttlSeconds: 300 },
      { type: "agent", id: delivery.id },
    );
    expect(claim?.ticketId).toBe(t.id);

    wg.updateAgentDisplay(delivery.id, { display_name: "Kev", shirt_number: 7 }, operator);

    const [active] = wg.listActiveClaims();
    expect(active?.agent_id).toBe(delivery.id);
    expect(active?.agent_display_name).toBe("gaffer-factory"); // the legacy field is unchanged
    expect(active?.agent_display).toMatchObject({
      agent_id: delivery.id,
      display_name: "Kev",
      display_name_effective: "Kev",
      shirt_number: 7,
      role: "delivery",
    });
    expect(wg.agents.findById(delivery.id)?.id).toBe(delivery.id);
    const ticketEvents = listEvents(wg.db, "ticket", t.id).filter((e) => e.actor_type === "agent");
    expect(ticketEvents.length).toBeGreaterThan(0);
    expect(ticketEvents.every((e) => e.actor_id === delivery.id)).toBe(true);

    const agentEvents = listEvents(wg.db, "agent", delivery.id);
    expect(agentEvents.map((e) => e.event_type)).toEqual([
      "agent.registered",
      "agent.display_updated",
    ]);
    expect(agentEvents[1]).toMatchObject({ actor_type: "human", actor_id: "tom" });
    expect(JSON.parse(agentEvents[1]?.payload_json ?? "{}")).toEqual({
      changes: {
        display_name: { from: null, to: "Kev" },
        shirt_number: { from: null, to: 7 },
      },
    });
    // A no-op writes no event.
    wg.updateAgentDisplay(delivery.id, { display_name: " Kev " }, operator);
    expect(listEvents(wg.db, "agent", delivery.id)).toHaveLength(2);
    expect(wg.verifyEventChain().ok).toBe(true);

    // The board card's claim carries it too.
    const card = wg
      .board()
      .columns.flatMap((c) => c.cards)
      .find((c) => c.id === t.id);
    expect(card?.claim?.agentId).toBe(delivery.id);
    expect(card?.claim?.agent_display?.display_name_effective).toBe("Kev");
  });
});

describe("squad: REST", () => {
  const FULL = "shared-full-token-for-squad-tests-0123456789abcdef";
  const READ = deriveReadToken(FULL);
  const saved = process.env.DISPATCH_API_TOKEN;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    setPrincipalResolver(null);
    if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = saved;
  });

  async function start(): Promise<{ base: string; wg: Dispatch }> {
    process.env.DISPATCH_AUDIT_OFF = "1";
    process.env.DISPATCH_API_TOKEN = FULL;
    const wg = fresh();
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, wg };
  }
  const call = async (
    base: string,
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, any> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  };

  it("club: read with the read token, write only with the full token, recorded as an event", async () => {
    const { base, wg } = await start();
    expect((await call(base, "GET", "/api/club", null)).status).toBe(401);
    const read = await call(base, "GET", "/api/club", READ);
    expect(read.status).toBe(200);
    expect(read.json.club).toMatchObject({ name: null, name_effective: "Gaffer" });

    const denied = await call(base, "PATCH", "/api/club", READ, { name: "Nope FC" });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("READ_ONLY_TOKEN");
    expect(wg.getClub().name).toBeNull();

    const ok = await call(base, "PATCH", "/api/club", FULL, {
      name: "Factory FC",
      short_name: "FFC",
      kit_primary: "#ABCDEF",
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      club: { name: "Factory FC", short_name: "FFC", kit_primary: "#abcdef", kit_secondary: null },
      changed: ["name", "short_name", "kit_primary"],
    });
    const [ev] = listEvents(wg.db, "club", "club");
    expect(ev).toMatchObject({
      event_type: "club.updated",
      actor_type: "human",
      actor_id: "dispatch-api",
    });

    for (const bad of [
      { kit_secondary: "blue" },
      { short_name: "TOOLONG" },
      { name: "x".repeat(61) },
      { name: 5 },
    ]) {
      const r = await call(base, "PATCH", "/api/club", FULL, bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.json.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await call(base, "POST", "/api/club", FULL, { name: "x" })).status).toBe(405);
  });

  it("squad: list + update agents; duplicate shirt 409; unknown 404; read token refused", async () => {
    const { base, wg } = await start();
    const { delivery, reviewer } = seedSquad(wg);

    const squad = await call(base, "GET", "/api/squad", READ);
    expect(squad.status).toBe(200);
    expect(squad.json.club.name_effective).toBe("Gaffer");
    expect(
      squad.json.agents.map((a: { display_name_effective: string }) => a.display_name_effective),
    ).toEqual(["Delivery 1", "Reviewer", "Security reviewer", "Tester", "Delivery 2"]);

    const path = `/api/squad/agents/${delivery.id}`;
    const denied = await call(base, "PATCH", path, READ, { display_name: "Kev" });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("READ_ONLY_TOKEN");

    const ok = await call(base, "PATCH", path, FULL, { display_name: " Kev ", shirt_number: 9 });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      agent: { agent_id: delivery.id, display_name: "Kev", shirt_number: 9, role: "delivery" },
      changed: ["display_name", "shirt_number"],
    });
    expect(listEvents(wg.db, "agent", delivery.id).at(-1)).toMatchObject({
      event_type: "agent.display_updated",
      actor_id: "dispatch-api",
    });

    const dup = await call(base, "PATCH", `/api/squad/agents/${reviewer.id}`, FULL, {
      shirt_number: 9,
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("DUPLICATE");
    expect(
      (await call(base, "PATCH", "/api/squad/agents/ghost", FULL, { shirt_number: 3 })).status,
    ).toBe(404);
    for (const bad of [
      { shirt_number: 0 },
      { shirt_number: 100 },
      { display_name: "x".repeat(41) },
    ]) {
      expect((await call(base, "PATCH", path, FULL, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await call(base, "PUT", path, FULL, {})).status).toBe(405);
  });

  it("adds agent_display wherever agent identities are returned, keeping the old fields", async () => {
    const { base, wg } = await start();
    const { delivery } = seedSquad(wg);
    wg.updateAgentDisplay(delivery.id, { display_name: "Kev", shirt_number: 7 }, operator);
    const t = wg.createTicket({ title: "Task", policy_pack: "solo_loose" }, operator);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, operator);
    wg.markReady(t.id, operator);
    wg.claimNextTicket(
      { agentId: delivery.id, ttlSeconds: 300 },
      { type: "agent", id: delivery.id },
    );
    const kev = { agent_id: delivery.id, display_name_effective: "Kev", shirt_number: 7 };

    const claims = await call(base, "GET", "/claims", READ);
    expect(claims.json.claims[0]).toMatchObject({
      agent_id: delivery.id,
      agent_display_name: "gaffer-factory",
      agent_display: kev,
    });

    const detail = await call(base, "GET", `/tickets/${t.id}`, READ);
    expect(detail.status).toBe(200);
    expect(detail.json.agent_display[delivery.id]).toMatchObject(kev);
    // Non-agent actors (the human operator) are not in the map.
    expect(Object.keys(detail.json.agent_display)).toEqual([delivery.id]);

    const board = await call(base, "GET", "/api/board", READ);
    const card = board.json.columns
      .flatMap((c: { cards: unknown[] }) => c.cards)
      .find((c: { id: string }) => c.id === t.id);
    expect(card.claim).toMatchObject({ agentId: delivery.id, agent_display: kev });

    const activity = await call(base, "GET", "/api/activity?limit=50", READ);
    const byAgent = activity.json.events.filter(
      (e: { actor_id: string | null }) => e.actor_id === delivery.id,
    );
    expect(byAgent.length).toBeGreaterThan(0);
    expect(byAgent[0].agent_display).toMatchObject(kev);
    const byHuman = activity.json.events.find(
      (e: { actor_id: string | null }) => e.actor_id === "tom",
    );
    expect(byHuman.agent_display).toBeNull();

    const agents = await call(base, "GET", "/agents", READ);
    const row = agents.json.agents.find((a: { id: string }) => a.id === delivery.id);
    expect(row).toMatchObject({
      id: delivery.id,
      display_name: "gaffer-factory",
      agent_display: kev,
    });
  });
});

describe("squad: CLI", () => {
  function runCli(dbPath: string, ...args: string[]): Record<string, any> {
    const program = new Command();
    program.exitOverride().option("--db <path>", "SQLite database path");
    registerAgent(program);
    registerClub(program);
    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      program.parse(["node", "dispatch", "--db", dbPath, ...args]);
    } finally {
      process.stdout.write = realWrite;
    }
    return JSON.parse(chunks.join("")) as Record<string, any>;
  }

  it("club show|set, agent list|rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "squad-cli-"));
    const db = join(dir, "dispatch.sqlite");
    try {
      const wg = Dispatch.open(db);
      const { delivery, reviewer } = seedSquad(wg);
      wg.db.close();

      expect(runCli(db, "club", "show").club).toMatchObject({
        name: null,
        name_effective: "Gaffer",
      });
      const set = runCli(
        db,
        "club",
        "set",
        "--name",
        "Factory Town",
        "--short",
        "FT",
        "--kit-primary",
        "#ff0000",
        "--kit-secondary",
        "#FFF",
      );
      expect(set.club).toMatchObject({
        name: "Factory Town",
        short_name: "FT",
        kit_primary: "#ff0000",
        kit_secondary: "#ffffff",
      });
      expect(runCli(db, "club", "show").club.name_effective).toBe("Factory Town");
      expect(() => runCli(db, "club", "set")).toThrow(/Nothing to set/);
      expect(() => runCli(db, "club", "set", "--kit-primary", "red")).toThrow(/hex colour/);

      const list = runCli(db, "agent", "list").agents as Array<Record<string, unknown>>;
      expect(list.map((a) => a.display_name_effective)).toEqual([
        "Delivery 1",
        "Reviewer",
        "Security reviewer",
        "Tester",
        "Delivery 2",
      ]);
      expect(list[0]).toMatchObject({ agent_id: delivery.id, registered_name: "gaffer-factory" });

      const renamed = runCli(db, "agent", "rename", delivery.id, "--name", "Kev", "--number", "9");
      expect(renamed.agent).toMatchObject({
        agent_id: delivery.id,
        display_name: "Kev",
        shirt_number: 9,
      });
      expect(() => runCli(db, "agent", "rename", reviewer.id, "--number", "9")).toThrow(
        /already worn/,
      );
      expect(() => runCli(db, "agent", "rename", reviewer.id, "--number", "x")).toThrow(
        /Shirt number/,
      );
      expect(() => runCli(db, "agent", "rename", reviewer.id)).toThrow(/Nothing to change/);
      expect(
        runCli(db, "agent", "rename", delivery.id, "--no-number").agent.shirt_number,
      ).toBeNull();
      expect(runCli(db, "agent", "list").agents[0]).toMatchObject({
        display_name_effective: "Kev",
        shirt_number: null,
      });

      const after = Dispatch.open(db);
      expect(listEvents(after.db, "agent", delivery.id).map((e) => e.event_type)).toEqual([
        "agent.registered",
        "agent.display_updated",
        "agent.display_updated",
      ]);
      expect(listEvents(after.db, "club", "club")).toHaveLength(1);
      after.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("squad: MCP is read-only", () => {
  it("no tool accepts a name, number or club field; get_squad reads the squad", () => {
    const writeFields =
      /^(display_name|shirt_number|squad_name|short_name|kit_primary|kit_secondary|club|name)$/;
    for (const [tool, schema] of Object.entries(toolSchemas)) {
      if (tool === "create_epic") continue; // `epic.name` is the epic's own title, nested.
      const keys = Object.keys(schema as Record<string, unknown>);
      expect(
        keys.filter((k) => writeFields.test(k)),
        tool,
      ).toEqual([]);
      expect(tool).not.toMatch(/rename|club|set_.*name|shirt/);
    }
    expect(Object.keys(toolSchemas.get_squad)).toEqual([]);

    const wg = fresh();
    const { delivery } = seedSquad(wg);
    wg.updateClub({ name: "Factory FC" }, operator);
    wg.updateAgentDisplay(delivery.id, { display_name: "Kev", shirt_number: 9 }, operator);
    const before = wg.events.latestSeq();
    process.env.DISPATCH_AUDIT_OFF = "1";
    const h = makeHandlers(wg, { type: "agent", id: delivery.id });
    const res = h.get_squad({ display_name: "Me", shirt_number: 1 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      club: { name: "Factory FC", short_name: "FF" },
      agents: expect.arrayContaining([
        { agent_id: delivery.id, display_name: "Kev", shirt_number: 9, role: "delivery" },
      ]),
    });
    // Reading wrote nothing, and stray args did not rename anyone.
    expect(wg.events.latestSeq()).toBe(before);
    expect(wg.listSquad()[0]).toMatchObject({ display_name: "Kev", shirt_number: 9 });
  });
});
