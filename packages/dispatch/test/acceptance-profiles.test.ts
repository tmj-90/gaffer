import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { parseTestContract, type Actor } from "../src/domain/types.js";
import { profileFromTitle } from "../src/domain/acceptanceProfile.js";
import { seededTestContract } from "../src/services/ticketService.js";
import { contractHash } from "../src/util/contractHash.js";
import { TestClock } from "../src/util/clock.js";
import { DispatchError } from "../src/util/errors.js";
import { listEvents } from "../src/events/eventWriter.js";
import { FAKE_HEAD, giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

/**
 * ACCEPTANCE PROFILES (Release C, C0-C2, C6): "accepted" means the change was exercised the
 * way a user meets it, with evidence the runner recorded.
 *   - the test contract carries a profile (unit by default) and a person-registered spec;
 *   - an agent may raise unit to a profile name through the contract MCP path, never set
 *     the commands or lower/change a person's profile;
 *   - the runner's acceptance evidence is a system row with a reserved uri;
 *   - an automated PASS on a profiled ticket needs that evidence, passed, for the tested
 *     commit and the current contract (ACCEPTANCE_EVIDENCE_REQUIRED);
 *   - the review packet says what backs it.
 */
const human: Actor = { type: "human", id: "tom" };
const admin: Actor = { type: "admin", id: "root" };
const system: Actor = { type: "system" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
const testerAgent: Actor = { type: "agent", id: "tester" };
const SHA = FAKE_HEAD;
const OTHER = "c".repeat(40);

const CLI_SPEC = {
  cases: [{ argv: ["node", "bin/cli.mjs", "--version"], expect: { exit: 0, stdout: ["1.0"] } }],
};
const API_SPEC = {
  boot_argv: ["node", "server.mjs"],
  health_path: "/health",
  probes: [
    { method: "GET", path: "/items", expect: { status: 200, json_keys: ["items"] } },
    { method: "POST", path: "/items", body: {}, expect: { status: 401 } },
  ],
};

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner, { testingEnabled: true });
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DispatchError ? e.code : String(e);
  }
}

/** A testable ticket delivered and in review (its contract still editable). */
function inReview(wg: Dispatch, title = "Ship it"): string {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title, description: "deliver the thing", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "passed",
    },
    agentActor,
  );
  wg.submitForReview(
    { claimToken: claim!.claimToken, ticket_id: t.id, reason: "done" },
    agentActor,
  );
  giveTicketRealDelivery(wg, t.id, human);
  wg.setTestable(t.id, true, human);
  return t.id;
}

function toTesting(wg: Dispatch, id: string): void {
  expect(wg.routeToTester(id, system)[0]!.routed).toBe(true);
  expect(wg.view(id).ticket.status).toBe("in_testing");
}

function evidencePayload(
  wg: Dispatch,
  id: string,
  over: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    kind: "transcript",
    profile: "cli",
    tested_commit: SHA,
    contract_hash: contractHash(wg.db, id),
    passed: true,
    digest: "d".repeat(64),
    signature: "s".repeat(64),
    cases: [{ argv: ["node", "bin/cli.mjs", "--version"], exit: 0, held: true }],
    ...over,
  });
}

const pass = (wg: Dispatch, id: string, extra: Record<string, unknown> = {}) =>
  wg.testerPass(
    id,
    {
      summary: "PASS: every AC demonstrated",
      tested_commit: SHA,
      contract_hash: contractHash(wg.db, id)!,
      replay: "passed",
      ...extra,
    },
    testerAgent,
  );

describe("C0: the profile contract", () => {
  it("with the seed switched on, a title naming a CLI or an endpoint seeds the profile (never the commands)", () => {
    const on = { GAFFER_ACCEPTANCE_PROFILE_SEED: "1" };
    expect(profileFromTitle("Add a --json flag to the export CLI", on)).toBe("cli");
    expect(profileFromTitle("New sub-command: gaffer doctor", on)).toBe("cli");
    expect(profileFromTitle("Rate-limit the /login endpoint", on)).toBe("api");
    expect(profileFromTitle("Expose the REST API for invoices", on)).toBe("api");
    expect(profileFromTitle("Fix the typo on the settings page", on)).toBeNull();
    // Opt-in: unset or 0 seeds nothing (a seeded profile with no commands holds a PASS).
    expect(profileFromTitle("Add a CLI", {})).toBeNull();
    expect(profileFromTitle("Add a CLI", { GAFFER_ACCEPTANCE_PROFILE_SEED: "0" })).toBeNull();
    const c = seededTestContract("Add a --json flag to the export CLI", on);
    expect(c.profile).toBe("cli");
    expect(c.profile_spec).toBeUndefined();
    expect("profile" in seededTestContract("Add a --json flag to the export CLI", {})).toBe(false);
    // An unprofiled title keeps today's contract byte for byte (no profile key).
    expect("profile" in seededTestContract("Show done tasks", on)).toBe(false);
  });

  it("setTestable seeds the title's profile when switched on, and says so on the event", () => {
    const prev = process.env.GAFFER_ACCEPTANCE_PROFILE_SEED;
    process.env.GAFFER_ACCEPTANCE_PROFILE_SEED = "1";
    try {
      const wg = freshWg();
      const id = inReview(wg, "Add a --json flag to the export CLI");
      expect(parseTestContract(wg.view(id).ticket.test_contract)!.profile).toBe("cli");
      const ev = listEvents(wg.db, "ticket", id).find(
        (e) => e.event_type === "ticket.test_contract_set",
      );
      expect(JSON.parse(ev!.payload_json ?? "{}")).toMatchObject({
        profile: "cli",
        profile_seeded_from: "title",
      });
      wg.db.close();
    } finally {
      if (prev === undefined) delete process.env.GAFFER_ACCEPTANCE_PROFILE_SEED;
      else process.env.GAFFER_ACCEPTANCE_PROFILE_SEED = prev;
    }
    // Off (the default): the same title seeds today's unit contract.
    const wg2 = freshWg();
    const id2 = inReview(wg2, "Add a --json flag to the export CLI");
    expect(parseTestContract(wg2.view(id2).ticket.test_contract)!.profile).toBeUndefined();
    wg2.db.close();
  });

  it("a person sets the profile and its spec; the contract hash moves, the dossier hash does not", () => {
    const wg = freshWg();
    const id = inReview(wg);
    const before = contractHash(wg.db, id);
    const dossierBefore = wg.dossier(id).hash;
    const res = wg.setAcceptanceProfile(id, { profile: "cli", spec: CLI_SPEC }, human);
    expect(res.profile).toBe("cli");
    const c = parseTestContract(wg.view(id).ticket.test_contract)!;
    expect(c.profile).toBe("cli");
    expect((c.profile_spec as { cases: unknown[] }).cases).toHaveLength(1);
    // Defaults are applied (expect.exit 0) and the operational fields are kept.
    expect(c.changed_surfaces.length).toBeGreaterThan(0);
    expect(contractHash(wg.db, id)).not.toBe(before);
    expect(wg.dossier(id).hash).toBe(dossierBefore);
    const ev = listEvents(wg.db, "ticket", id).find(
      (e) => e.event_type === "ticket.acceptance_profile_set",
    );
    expect(JSON.parse(ev!.payload_json ?? "{}")).toMatchObject({
      profile: "cli",
      cases: 1,
      spec: true,
    });
    // Admin too; unit clears it.
    wg.setAcceptanceProfile(id, { profile: "api", spec: API_SPEC }, admin);
    expect(parseTestContract(wg.view(id).ticket.test_contract)!.profile).toBe("api");
    wg.setAcceptanceProfile(id, { profile: "unit" }, human);
    const cleared = parseTestContract(wg.view(id).ticket.test_contract)!;
    expect(cleared.profile).toBeUndefined();
    expect(cleared.profile_spec).toBeUndefined();
    wg.db.close();
  });

  it("only a human or admin sets a profile: an agent or the system is refused", () => {
    const wg = freshWg();
    const id = inReview(wg);
    for (const actor of [agentActor, testerAgent, system])
      expect(
        code(() => wg.setAcceptanceProfile(id, { profile: "cli", spec: CLI_SPEC }, actor)),
      ).toBe("ACTOR_NOT_PERMITTED");
    wg.db.close();
  });

  it("a malformed spec, a spec on unit, a shell string or a leaky argv is refused", () => {
    const wg = freshWg();
    const id = inReview(wg);
    expect(code(() => wg.setAcceptanceProfile(id, { profile: "nope" }, human))).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      code(() => wg.setAcceptanceProfile(id, { profile: "cli", spec: { cases: [] } }, human)),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        wg.setAcceptanceProfile(
          id,
          { profile: "cli", spec: { cases: [{ argv: "ls -la" }] } },
          human,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() => wg.setAcceptanceProfile(id, { profile: "unit", spec: CLI_SPEC }, human)),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        wg.setAcceptanceProfile(
          id,
          { profile: "api", spec: { ...API_SPEC, schema_path: "../../etc/passwd" } },
          human,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        wg.setAcceptanceProfile(
          id,
          { profile: "cli", spec: { cases: [{ argv: ["git", "checkout", "gaffer/ticket-3-x"] }] } },
          human,
        ),
      ),
    ).toBe("TEST_CONTRACT_LEAK");
    wg.db.close();
  });

  it("the profile is frozen with the rest of the contract from in_testing on", () => {
    const wg = freshWg();
    const id = inReview(wg);
    toTesting(wg, id);
    expect(code(() => wg.setAcceptanceProfile(id, { profile: "cli", spec: CLI_SPEC }, human))).toBe(
      "CONTRACT_FROZEN",
    );
    wg.db.close();
  });

  it("the contract write keeps a person's profile; an agent may only raise unit to a profile name", () => {
    const wg = freshWg();
    const id = inReview(wg);
    // An agent raises unit -> api (no commands: those are a person's to register).
    const raised = wg.setTestContract(
      id,
      { changed_surfaces: ["GET /items"], profile: "api" },
      agentActor,
    );
    expect(raised.profile).toBe("api");
    expect(raised.profile_spec).toBeUndefined();
    // A person registers the probes; the agent's next contract write keeps them.
    wg.setAcceptanceProfile(id, { profile: "api", spec: API_SPEC }, human);
    const kept = wg.setTestContract(id, { changed_surfaces: ["GET /items v2"] }, agentActor);
    expect(kept.profile).toBe("api");
    expect((kept.profile_spec as { probes: unknown[] }).probes).toHaveLength(2);
    // ... and may neither lower nor change it.
    expect(code(() => wg.setTestContract(id, { profile: "unit" }, agentActor))).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    expect(code(() => wg.setTestContract(id, { profile: "cli" }, agentActor))).toBe(
      "ACTOR_NOT_PERMITTED",
    );
    // Restating the same profile is fine.
    expect(wg.setTestContract(id, { profile: "api" }, agentActor).profile).toBe("api");
    wg.db.close();
  });

  it("the MCP set_test_contract carries the profile name, never a spec", async () => {
    const { toolSchemas } = await import("../src/mcp/tools.js");
    expect(Object.keys(toolSchemas.set_test_contract)).toContain("profile");
    expect(Object.keys(toolSchemas.set_test_contract)).not.toContain("profile_spec");
    expect(Object.keys(toolSchemas.set_test_contract)).not.toContain("spec");
  });
});

describe("C1/C2: the runner's acceptance evidence", () => {
  it("only the system records it, as a log row with the reserved uri", () => {
    const wg = freshWg();
    const id = inReview(wg);
    wg.setAcceptanceProfile(id, { profile: "cli", spec: CLI_SPEC }, human);
    for (const actor of [agentActor, human, admin])
      expect(code(() => wg.recordAcceptanceEvidence(id, evidencePayload(wg, id), actor))).toBe(
        "ACTOR_NOT_PERMITTED",
      );
    const r = wg.recordAcceptanceEvidence(id, evidencePayload(wg, id), system);
    expect(r.passed).toBe(true);
    const row = wg.view(id).evidence.find((e) => e.id === r.evidenceId)!;
    expect(row.evidence_type).toBe("log");
    expect(row.recorded_by_actor_type).toBe("system");
    expect(row.uri).toBe(`gaffer-acceptance:cli:${SHA}`);
    expect(JSON.parse(row.payload_json!).kind).toBe("transcript");
    wg.db.close();
  });

  it("a malformed, mismatched or oversized payload is refused, and the uri is reserved", () => {
    const wg = freshWg();
    const id = inReview(wg);
    expect(code(() => wg.recordAcceptanceEvidence(id, "{", system))).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        wg.recordAcceptanceEvidence(id, evidencePayload(wg, id, { kind: "api_response" }), system),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        wg.recordAcceptanceEvidence(id, evidencePayload(wg, id, { tested_commit: "abc" }), system),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      code(() =>
        wg.recordAcceptanceEvidence(
          id,
          evidencePayload(wg, id, { pad: "x".repeat(70_000) }),
          system,
        ),
      ),
    ).toBe("PAYLOAD_TOO_LARGE");
    expect(
      code(() =>
        wg.attachDeliveryEvidence(
          id,
          { evidenceType: "log", summary: "forged", uri: `gaffer-acceptance:cli:${SHA}` },
          system,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    wg.db.close();
  });
});

describe("C6: a profile's missing evidence means no automated PASS", () => {
  function profiled(wg: Dispatch, profile = "cli", spec: unknown = CLI_SPEC): string {
    const id = inReview(wg);
    wg.setAcceptanceProfile(id, { profile, spec }, human);
    toTesting(wg, id);
    return id;
  }

  it("an agent PASS with a passed replay but no acceptance evidence is refused", () => {
    const wg = freshWg();
    const id = profiled(wg);
    expect(code(() => pass(wg, id))).toBe("ACCEPTANCE_EVIDENCE_REQUIRED");
    expect(wg.view(id).ticket.status).toBe("in_testing");
    wg.db.close();
  });

  it("evidence that failed, is for another commit, another contract or not the runner's is refused", () => {
    const wg = freshWg();
    const id = profiled(wg);
    const failed = wg.recordAcceptanceEvidence(
      id,
      evidencePayload(wg, id, { passed: false }),
      system,
    );
    expect(code(() => pass(wg, id, { acceptance_evidence: failed.evidenceId }))).toBe(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
    );
    const other = wg.recordAcceptanceEvidence(
      id,
      evidencePayload(wg, id, { tested_commit: OTHER }),
      system,
    );
    expect(code(() => pass(wg, id, { acceptance_evidence: other.evidenceId }))).toBe(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
    );
    const stale = wg.recordAcceptanceEvidence(
      id,
      evidencePayload(wg, id, { contract_hash: "e".repeat(64) }),
      system,
    );
    expect(code(() => pass(wg, id, { acceptance_evidence: stale.evidenceId }))).toBe(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
    );
    const plain = wg.attachDeliveryEvidence(id, { evidenceType: "log", summary: "a log" }, system);
    expect(code(() => pass(wg, id, { acceptance_evidence: plain.evidenceId }))).toBe(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
    );
    expect(code(() => pass(wg, id, { acceptance_evidence: "no-such-row" }))).toBe(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
    );
    wg.db.close();
  });

  it("passed runner evidence for the tested commit and contract lets the PASS record, bound to it", () => {
    const wg = freshWg();
    const id = profiled(wg);
    const ok = wg.recordAcceptanceEvidence(id, evidencePayload(wg, id), system);
    const res = pass(wg, id, { acceptance_evidence: ok.evidenceId });
    expect(res.ticket.status).toBe("in_review");
    const verdict = wg
      .view(id)
      .evidence.filter((e) => e.evidence_type === "test_output")
      .map((e) => JSON.parse(e.payload_json ?? "{}"))
      .find((p) => p.verdict === "pass");
    expect(verdict.acceptance).toEqual({ profile: "cli", evidence_id: ok.evidenceId });
    wg.db.close();
  });

  it("a profile the runner cannot run yet (web) can only be passed by a person", () => {
    const wg = freshWg();
    const id = profiled(wg, "web", { base_path: "/" });
    expect(code(() => pass(wg, id))).toBe("ACCEPTANCE_EVIDENCE_REQUIRED");
    const res = wg.testerPass(id, { summary: "I clicked through it" }, human);
    expect(res.ticket.status).toBe("in_review");
    wg.db.close();
  });

  it("a human PASS is a waiver without evidence; a unit ticket is unchanged", () => {
    const wg = freshWg();
    const id = profiled(wg);
    expect(wg.testerPass(id, { summary: "ran it by hand" }, human).ticket.status).toBe("in_review");
    const wg2 = freshWg();
    const unit = inReview(wg2);
    toTesting(wg2, unit);
    expect(pass(wg2, unit).ticket.status).toBe("in_review");
    wg.db.close();
    wg2.db.close();
  });
});

describe("C6: the review packet says what backs runtime acceptance", () => {
  const cost = () => ({
    cost_usd: 0,
    measured_usd: 0,
    estimated_usd: 0,
    num_turns: 0,
    unknown_calls: 0,
    ledger_status: "ok",
  });
  const row = (wg: Dispatch, id: string) =>
    wg.reviewPacket(id, cost).backing.find((b) => b.cell === "evidence")!;

  it("no profile: one row says so", () => {
    const wg = freshWg();
    const id = inReview(wg);
    expect(row(wg, id).fact).toMatch(/^No runtime profile for this ticket/);
    expect(row(wg, id).holds).toBe(false);
    expect(wg.reviewPacket(id, cost).runtime_acceptance.profile).toBe("unit");
    wg.db.close();
  });

  it("a cli profile with no commands, then with a passed transcript", () => {
    const wg = freshWg();
    const id = inReview(wg);
    wg.setAcceptanceProfile(id, { profile: "cli" }, human);
    expect(row(wg, id).fact).toMatch(/no commands are registered for the cli profile/);
    wg.setAcceptanceProfile(id, { profile: "cli", spec: CLI_SPEC }, human);
    expect(row(wg, id).fact).toMatch(/no cli transcript recorded yet/);
    wg.recordAcceptanceEvidence(id, evidencePayload(wg, id), system);
    const r = row(wg, id);
    expect(r.fact).toMatch(/cli transcript replayed on/);
    expect(r.holds).toBe(true);
    expect(r.source).toMatch(/system/);
    const p = wg.reviewPacket(id, cost).runtime_acceptance;
    expect(p.latest).toMatchObject({
      passed: true,
      tested_commit: SHA,
      kind: "transcript",
      cases: 1,
    });
    wg.db.close();
  });

  it("failed api probes and a not-yet-runnable profile are listed as not backed", () => {
    const wg = freshWg();
    const id = inReview(wg);
    wg.setAcceptanceProfile(id, { profile: "api", spec: API_SPEC }, human);
    wg.recordAcceptanceEvidence(
      id,
      evidencePayload(wg, id, {
        kind: "api_response",
        profile: "api",
        passed: false,
        reason: "GET /items answered 500, expected 200",
      }),
      system,
    );
    expect(row(wg, id).fact).toMatch(/api probes did not pass .*answered 500/);
    expect(row(wg, id).holds).toBe(false);
    wg.setAcceptanceProfile(id, { profile: "migration" }, human);
    expect(row(wg, id).fact).toMatch(/migration acceptance profile is not run by the runner yet/);
    wg.db.close();
  });
});
