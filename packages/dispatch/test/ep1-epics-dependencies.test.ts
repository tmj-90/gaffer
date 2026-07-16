import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { migrate } from "../src/db/connection.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const systemActor: Actor = { type: "system" };

function freshWg(clock = new TestClock()): Dispatch {
  // Inject a non-empty-diff git runner so driveToDone's real delivery satisfies
  // the recomputed-diff done-gate (now enforced for solo_loose too).
  return Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
}

/** Create a ready (claimable) ticket; returns its id. */
function readyTicket(wg: Dispatch, title = "Task"): string {
  const t = wg.createTicket({ title, policy_pack: "solo_loose", risk_level: "low" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
  wg.markReady(t.id, human);
  return t.id;
}

/** Drive a claimed ticket all the way to `done` (claim → submit → approve). */
function driveToDone(wg: Dispatch, ticketId: string, agentId: string): void {
  const claim = wg.claimTicket(
    { ticket_id: ticketId, agent_id: agentId, ttl_seconds: 300 },
    agentActor,
  );
  // solo_loose now runs the recomputed-diff done-gate: register a real on-disk
  // write repo + delivery branch so the gate sees genuine git output. The repo
  // name is per-ticket so driving several tickets to done can't collide.
  giveTicketRealDelivery(wg, ticketId, human, { repoName: `delivery-${ticketId}` });
  wg.recordDeliveryArtifact(
    { claim_token: claim.claimToken, ticket_id: ticketId, branch_name: "feat/x" },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: ticketId }, agentActor);
  // Approve now lands in `ready_for_merge`; the merge-complete callback (system)
  // takes it the rest of the way to `done`.
  wg.approveReview(ticketId, human);
  wg.markMerged(ticketId, systemActor);
}

// --- Ticket dependencies: add / list / remove + guards ---------------------

describe("EP-001: ticket dependency repository + core", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("adds and lists a dependency with the depended-on status + satisfied flag", () => {
    const a = wg.createTicket({ title: "A" }, human);
    const b = wg.createTicket({ title: "B" }, human);
    const res = wg.addDependency({ ticket: a.id, depends_on: b.id }, human);
    expect(res.ticketId).toBe(a.id);
    expect(res.dependsOnTicketId).toBe(b.id);

    const deps = wg.listDependencies(a.id);
    expect(deps).toHaveLength(1);
    expect(deps[0]?.depends_on_ticket_id).toBe(b.id);
    expect(deps[0]?.number).toBe(b.number);
    expect(deps[0]?.satisfied).toBe(false); // B is draft, not done.
  });

  it("resolves dependencies by #number as well as id", () => {
    const a = wg.createTicket({ title: "A" }, human);
    const b = wg.createTicket({ title: "B" }, human);
    wg.addDependency({ ticket: `#${a.number}`, depends_on: `#${b.number}` }, human);
    expect(wg.listDependencies(a.id)).toHaveLength(1);
  });

  it("rejects a self-dependency", () => {
    const a = wg.createTicket({ title: "A" }, human);
    expect(() => wg.addDependency({ ticket: a.id, depends_on: a.id }, human)).toThrowError(
      DispatchError,
    );
    try {
      wg.addDependency({ ticket: a.id, depends_on: a.id }, human);
    } catch (err) {
      expect((err as DispatchError).code).toBe("INVALID_DEPENDENCY");
    }
  });

  it("rejects a duplicate dependency edge", () => {
    const a = wg.createTicket({ title: "A" }, human);
    const b = wg.createTicket({ title: "B" }, human);
    wg.addDependency({ ticket: a.id, depends_on: b.id }, human);
    try {
      wg.addDependency({ ticket: a.id, depends_on: b.id }, human);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("DUPLICATE");
    }
  });

  it("rejects a dependency that would create a cycle", () => {
    const a = wg.createTicket({ title: "A" }, human);
    const b = wg.createTicket({ title: "B" }, human);
    const c = wg.createTicket({ title: "C" }, human);
    // a -> b -> c, then c -> a would close a cycle.
    wg.addDependency({ ticket: a.id, depends_on: b.id }, human);
    wg.addDependency({ ticket: b.id, depends_on: c.id }, human);
    try {
      wg.addDependency({ ticket: c.id, depends_on: a.id }, human);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("INVALID_DEPENDENCY");
    }
  });

  it("removes a dependency and reports NOT_FOUND for an absent one", () => {
    const a = wg.createTicket({ title: "A" }, human);
    const b = wg.createTicket({ title: "B" }, human);
    wg.addDependency({ ticket: a.id, depends_on: b.id }, human);
    const res = wg.removeDependency(a.id, b.id, human);
    expect(res.ticketId).toBe(a.id);
    expect(wg.listDependencies(a.id)).toHaveLength(0);

    try {
      wg.removeDependency(a.id, b.id, human);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("NOT_FOUND");
    }
  });

  it("surfaces dependencies on the ticket view", () => {
    const a = wg.createTicket({ title: "A" }, human);
    const b = wg.createTicket({ title: "B" }, human);
    wg.addDependency({ ticket: a.id, depends_on: b.id }, human);
    expect(wg.view(a.id).dependencies).toHaveLength(1);
  });
});

// --- Dependency-aware claimability -----------------------------------------

describe("EP-001: dependency-aware claimability", () => {
  let clock: TestClock;
  let wg: Dispatch;
  beforeEach(() => {
    clock = new TestClock();
    wg = freshWg(clock);
  });

  it("claimTicket refuses a dependency-blocked ticket with DEPENDENCY_BLOCKED", () => {
    const blocker = readyTicket(wg, "blocker");
    const dependent = readyTicket(wg, "dependent");
    wg.addDependency({ ticket: dependent, depends_on: blocker }, human);
    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);

    try {
      wg.claimTicket({ ticket_id: dependent, agent_id: agent.id, ttl_seconds: 300 }, agentActor);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const e = err as DispatchError;
      expect(e.code).toBe("DEPENDENCY_BLOCKED");
      // The "blocked by #N" reason names the blocking ticket.
      expect(Array.isArray(e.details.blocked_by)).toBe(true);
      expect((e.details.blocked_by as unknown[]).length).toBe(1);
    }
  });

  it("claimNextTicket never selects a dependency-blocked ticket (picks the unblocked one)", () => {
    // Blocked ticket has higher priority but must be skipped.
    const blocker = readyTicket(wg, "blocker");
    const dependentHi = wg.createTicket(
      { title: "dependent-hi", policy_pack: "solo_loose", risk_level: "low", priority: 100 },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: dependentHi.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.markReady(dependentHi.id, human);
    wg.addDependency({ ticket: dependentHi.id, depends_on: blocker }, human);

    const agent = wg.registerAgent({ display_name: "a", max_risk: "high" }, human);
    const claimed = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor);
    // The only claimable ticket is the blocker itself (the dependent is gated).
    expect(claimed?.ticketId).toBe(blocker);
  });

  it("claimability() reports the dependent as blocked until the dependency is done", () => {
    const blocker = readyTicket(wg, "blocker");
    const dependent = readyTicket(wg, "dependent");
    wg.addDependency({ ticket: dependent, depends_on: blocker }, human);

    const before = wg.claimability(dependent);
    expect(before.ready).toBe(false);
    expect(before.blockers.some((b) => b.code === "DEPENDENCY_BLOCKED")).toBe(true);
  });

  it("a ticket becomes claimable once ALL its dependencies are done", () => {
    const blockerA = readyTicket(wg, "blockerA");
    const blockerB = readyTicket(wg, "blockerB");
    const dependent = readyTicket(wg, "dependent");
    wg.addDependency({ ticket: dependent, depends_on: blockerA }, human);
    wg.addDependency({ ticket: dependent, depends_on: blockerB }, human);

    const worker = wg.registerAgent({ display_name: "w", max_risk: "high" }, human);

    // First dependency done — still blocked by the second.
    driveToDone(wg, blockerA, worker.id);
    expect(wg.claimability(dependent).ready).toBe(false);
    expect(() =>
      wg.claimTicket({ ticket_id: dependent, agent_id: worker.id, ttl_seconds: 300 }, agentActor),
    ).toThrowError(DispatchError);

    // Second dependency done — now claimable.
    driveToDone(wg, blockerB, worker.id);
    expect(wg.claimability(dependent).ready).toBe(true);
    const claim = wg.claimTicket(
      { ticket_id: dependent, agent_id: worker.id, ttl_seconds: 300 },
      agentActor,
    );
    expect(claim.ticketId).toBe(dependent);
  });
});

// --- create_epic ------------------------------------------------------------

describe("EP-001: create_epic", () => {
  let wg: Dispatch;
  beforeEach(() => {
    wg = freshWg();
  });

  it("creates an epic node, draft tickets with ACs, and dependency edges (atomic)", () => {
    const res = wg.createEpic(
      {
        epic: { name: "Build the thing", description: "greenfield app" },
        tickets: [
          {
            title: "bootstrap repo",
            acceptanceCriteria: ["repo exists", "initial commit"],
            bootstrap: true,
            dependsOn: [],
          },
          { title: "data model", acceptanceCriteria: ["schema migrated"], dependsOn: [0] },
          { title: "feature X", dependsOn: [1] },
        ],
      },
      human,
    );

    expect(res.ticketNumbers).toHaveLength(3);

    // The epic node exists and is of type 'epic'.
    const node = wg.getScopeNode(res.epicNodeId);
    expect(node.node.type).toBe("epic");
    expect(node.node.name).toBe("Build the thing");

    // Resolve created tickets by number.
    const [t0, t1, t2] = res.ticketNumbers.map((n) => wg.resolveTicket(`#${n}`));

    // All created as draft.
    expect(t0?.status).toBe("draft");
    expect(t1?.status).toBe("draft");
    expect(t2?.status).toBe("draft");

    // Bootstrap marker set on the first ticket only.
    expect(t0?.bootstrap).toBe(1);
    expect(t1?.bootstrap).toBe(0);

    // ACs attached.
    expect(wg.view(t0!.id).acceptanceCriteria).toHaveLength(2);
    expect(wg.view(t1!.id).acceptanceCriteria).toHaveLength(1);

    // Dependency edges resolved by index: t1 depends on t0, t2 depends on t1.
    expect(wg.listDependencies(t1!.id)[0]?.depends_on_ticket_id).toBe(t0!.id);
    expect(wg.listDependencies(t2!.id)[0]?.depends_on_ticket_id).toBe(t1!.id);

    // The epic node contains every ticket (ticket↔scope link).
    for (const t of [t0, t1, t2]) {
      const scoped = wg.listTicketScopes(t!.id).some((s) => s.id === res.epicNodeId);
      expect(scoped).toBe(true);
    }
  });

  it("carries a bootstrap ticket's `source` (intended repo name) onto the created ticket", () => {
    // Greenfield seam: the target repo does not exist yet, so it can't be linked via
    // `repo`; the intended NAME rides on `source` so the runner bootstraps a cleanly-
    // named repo instead of a slug of the title. Prove the field flows through.
    const res = wg.createEpic(
      {
        epic: { name: "Greenfield calculator" },
        tickets: [
          {
            title: "Bootstrap the calculator repo (CommonJS)",
            acceptanceCriteria: ["repo exists"],
            bootstrap: true,
            source: "calculator",
          },
        ],
      },
      human,
    );
    const t0 = wg.resolveTicket(`#${res.ticketNumbers[0]}`);
    expect(t0?.bootstrap).toBe(1);
    // The intended repo name is persisted on the ticket's free-text source column —
    // exactly what runner/lib/greenfield.sh gaffer_bootstrap_repo_name reads.
    expect(t0?.source).toBe("calculator");
  });

  it("links a repo with an access boundary when a ticket names one", () => {
    wg.registerRepository({ name: "app-repo" }, human);
    const res = wg.createEpic(
      {
        epic: { name: "E" },
        tickets: [{ title: "t", repo: "app-repo", access: "write", dependsOn: [] }],
      },
      human,
    );
    const t = wg.resolveTicket(`#${res.ticketNumbers[0]}`);
    const packet = wg.workPacketRepos(t.id);
    expect(packet.writeRepos.some((r) => r.name === "app-repo")).toBe(true);
  });

  it("rejects an out-of-range dependsOn index and writes nothing (atomic rollback)", () => {
    const before = wg.list().length;
    expect(() =>
      wg.createEpic({ epic: { name: "E" }, tickets: [{ title: "t", dependsOn: [5] }] }, human),
    ).toThrowError(DispatchError);
    expect(wg.list().length).toBe(before);
    expect(wg.listScopeNodes().some((n) => n.type === "epic")).toBe(false);
  });

  it("rejects a cyclic plan", () => {
    try {
      wg.createEpic(
        {
          epic: { name: "E" },
          tickets: [
            { title: "a", dependsOn: [1] },
            { title: "b", dependsOn: [0] },
          ],
        },
        human,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DispatchError).code).toBe("INVALID_DEPENDENCY");
    }
  });

  it("a created epic's tickets are dependency-gated end-to-end", () => {
    const res = wg.createEpic(
      {
        epic: { name: "E" },
        tickets: [
          { title: "phase0", dependsOn: [] },
          { title: "phase1", dependsOn: [0] },
        ],
      },
      human,
    );
    const [p0, p1] = res.ticketNumbers.map((n) => wg.resolveTicket(`#${n}`));
    // Ready both, then confirm p1 is gated until p0 is done.
    wg.addAcceptanceCriterion({ ticket_id: p0!.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.addAcceptanceCriterion({ ticket_id: p1!.id, text: "AC" }, human); // Guard A: ≥1 AC required to ready
    wg.markReady(p0!.id, human);
    wg.markReady(p1!.id, human);

    const worker = wg.registerAgent({ display_name: "w", max_risk: "high" }, human);
    expect(() =>
      wg.claimTicket({ ticket_id: p1!.id, agent_id: worker.id, ttl_seconds: 300 }, agentActor),
    ).toThrowError(DispatchError);

    driveToDone(wg, p0!.id, worker.id);
    const claim = wg.claimTicket(
      { ticket_id: p1!.id, agent_id: worker.id, ttl_seconds: 300 },
      agentActor,
    );
    expect(claim.ticketId).toBe(p1!.id);
  });
});

// --- Bootstrap marker -------------------------------------------------------

describe("EP-001: bootstrap marker", () => {
  it("persists and exposes the bootstrap flag set via createTicket", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "greenfield", bootstrap: true }, human);
    expect(t.bootstrap).toBe(1);
    expect(wg.resolveTicket(t.id).bootstrap).toBe(1);

    const plain = wg.createTicket({ title: "normal" }, human);
    expect(plain.bootstrap).toBe(0);
  });
});

// --- Migration additivity ---------------------------------------------------

describe("EP-001: additive migration (v4 → v5)", () => {
  it("upgrades a simulated v4 DB without data loss and enables epic + bootstrap + deps", () => {
    // Build a minimal v4-shaped DB: tickets WITHOUT bootstrap, scope_nodes whose
    // type CHECK omits 'epic', a stamped schema_version of 4, and one pre-existing row.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'draft','refining','ready','claimed','in_progress',
          'blocked','in_review','done','failed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        policy_pack TEXT NOT NULL DEFAULT 'solo_loose',
        source TEXT, created_by TEXT, reviewer TEXT, branch_name TEXT, pr_url TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 0,
        scheduled_after TEXT, due_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE scope_nodes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'factory','domain','product','capability','system','service','library','external_dependency')),
        description TEXT, risk_level TEXT NOT NULL DEFAULT 'medium',
        owner TEXT, tags_json TEXT, lore_tags_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare("INSERT INTO schema_meta(key,value) VALUES ('schema_version','4')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status) VALUES ('legacy-1', 1, 'old ticket', 'done')",
    ).run();
    db.prepare(
      "INSERT INTO scope_nodes (id, name, type) VALUES ('node-1','Existing','product')",
    ).run();

    // Run the real migration.
    migrate(db);

    // Pre-existing data preserved.
    const legacy = db.prepare("SELECT * FROM tickets WHERE id = 'legacy-1'").get() as {
      bootstrap: number;
      title: string;
    };
    expect(legacy.title).toBe("old ticket");
    // Backfilled column default.
    expect(legacy.bootstrap).toBe(0);
    const node = db.prepare("SELECT name, type FROM scope_nodes WHERE id = 'node-1'").get() as {
      name: string;
      type: string;
    };
    expect(node.name).toBe("Existing");
    expect(node.type).toBe("product");

    // Version stamped to current (the migration chain always lands on HEAD).
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);

    // The widened CHECK now accepts an 'epic' node, and ticket_dependencies works.
    db.prepare("INSERT INTO scope_nodes (id, name, type) VALUES ('epic-1','Epic','epic')").run();
    db.prepare(
      "INSERT INTO tickets (id, number, title, status, bootstrap) VALUES ('t2', 2, 'new', 'draft', 1)",
    ).run();
    db.prepare(
      "INSERT INTO ticket_dependencies (ticket_id, depends_on_ticket_id) VALUES ('t2','legacy-1')",
    ).run();
    const dep = db
      .prepare("SELECT depends_on_ticket_id FROM ticket_dependencies WHERE ticket_id='t2'")
      .get() as { depends_on_ticket_id: string };
    expect(dep.depends_on_ticket_id).toBe("legacy-1");

    db.close();
  });

  it("re-running migrate() on an already-current DB is a no-op (idempotent)", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // must not throw or duplicate-rebuild.
    const ver = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
    db.close();
  });
});
