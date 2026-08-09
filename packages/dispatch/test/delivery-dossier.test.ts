import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { deriveReadToken } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { canonicalize } from "../src/util/canonicalJson.js";
import { TestClock } from "../src/util/clock.js";
import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };

/**
 * Drive a fresh team_light ticket all the way to APPROVED (ready_for_merge) with a
 * recorded delivery artifact + a satisfied AC + a real delivery diff, so the dossier
 * has a full set of recorded facts to reflect. Returns the ticket id.
 */
function deliveredReviewedTicket(wg: Dispatch): string {
  wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "deliver", policy_pack: "team_light" },
    human,
  );
  wg.linkRepository(t.id, "svc", "primary", human);
  const { ac } = wg.addAcceptanceCriterion(
    { ticket_id: t.id, text: "Returns 200", evidence_required: true },
    human,
  );
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor);
  wg.recordEvidence(
    {
      claimToken: claim!.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "12 passed",
      uri: "ci://run/42",
    },
    agentActor,
  );
  wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, agentActor);
  giveTicketRealDelivery(wg, t.id, human);
  wg.recordDeliveryArtifact(
    {
      ticket_id: t.id,
      branch_name: "feat/ship-it",
      pr_url: "https://example.test/pr/7",
      commit: "abc1234",
      diff_summary: "+10 -2 across 1 file",
    },
    human,
  );
  wg.approveReview(t.id, human);
  return t.id;
}

describe("DELIVERY-DOSSIER assembler", () => {
  it("assembles a JSON dossier from recorded state, each field sourced (not fabricated)", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const d = wg.dossier(id);
      const s = d.subject;

      // identity
      expect(s.schema).toBe("dossier.v1");
      expect(s.identity.title).toBe("Ship it");
      expect(s.identity.policy_pack).toBe("team_light");
      expect(s.identity.status).toBe("ready_for_merge");

      // acceptance criteria + linked evidence
      expect(s.acceptance_criteria).toHaveLength(1);
      const ac = s.acceptance_criteria[0]!;
      expect(ac.text).toBe("Returns 200");
      expect(ac.status).toBe("satisfied");
      expect(ac.evidence_required).toBe(true);
      expect(ac.verified_by).not.toBeNull();
      expect(ac.evidence.map((e) => e.evidence_type)).toContain("test_output");

      // delivery artifacts (branch/pr/commit/diff_summary + per-repo)
      expect(s.delivery.recorded).toMatchObject({
        branch_name: "feat/ship-it",
        pr_url: "https://example.test/pr/7",
        commit: "abc1234",
        diff_summary: "+10 -2 across 1 file",
      });
      expect(s.delivery.per_repo.length).toBeGreaterThan(0);

      // review verdict (WHO approved + WHEN + transition)
      expect(s.review_verdict).not.toBeNull();
      expect(s.review_verdict!.approved).toBe(true);
      expect(s.review_verdict!.actor_type).toBe("human");
      expect(s.review_verdict!.actor_id).toBe("tom");
      expect(s.review_verdict!.to).toBe("ready_for_merge");
      expect(s.review_verdict!.at).toBeTruthy();

      // DoD / test-gate evidence
      expect(s.dod_evidence.map((e) => e.evidence_type)).toContain("test_output");

      // gate config
      expect(s.gate_config.policy_pack).toBe("team_light");
      expect(s.gate_config.risk_level).toBe(s.identity.risk_level);
    } finally {
      wg.db.close();
    }
  });

  it("FABRICATION GUARD: diff_hash is always null/unknown and no live git diff leaks in", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const d = wg.dossier(id);
      expect(d.subject.delivery.diff_hash).toBeNull();
      expect(d.subject.delivery.diff_hash_status).toBe("unknown");
      expect(d.warnings.some((w) => w.startsWith("diff_hash:"))).toBe(true);
      // The nondeterministic live git diff patch text must NEVER enter the payload.
      expect(canonicalize(d.subject)).not.toContain("diff --git");
    } finally {
      wg.db.close();
    }
  });

  it("HASH DETERMINISM: regenerating unchanged state yields the SAME hash (timestamp excluded)", () => {
    const clock = new TestClock();
    const wg = Dispatch.open(":memory:", clock, nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const first = wg.dossier(id);
      clock.advanceSeconds(120); // time moves on
      const second = wg.dossier(id);
      expect(second.generated_at).not.toBe(first.generated_at); // proves time advanced
      expect(second.hash).toBe(first.hash); // ...but the hash is unchanged
    } finally {
      wg.db.close();
    }
  });

  it("HASH SENSITIVITY: mutating a recorded fact changes the hash", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const before = wg.dossier(id).hash;
      // Record a further delivery artifact (a new recorded fact).
      wg.recordDeliveryArtifact(
        { ticket_id: id, branch_name: "feat/ship-it", commit: "def5678" },
        human,
      );
      const after = wg.dossier(id).hash;
      expect(after).not.toBe(before);
    } finally {
      wg.db.close();
    }
  });

  it("records exactly one ticket.dossier_recorded event carrying the hash; re-run is idempotent", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const statusBefore = wg.resolveTicket(id).status;

      const { dossier, eventId } = wg.recordDossier(id, human);
      expect(eventId).not.toBeNull();

      const events = wg
        .listTicketEvents(id)
        .filter((e) => e.event_type === "ticket.dossier_recorded");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload_json!) as {
        dossier_hash: string;
        hash_algo: string;
        schema: string;
      };
      expect(payload).toEqual({
        dossier_hash: dossier.hash,
        hash_algo: "sha256",
        schema: "dossier.v1",
      });

      // Recording does NOT change ticket status / lifecycle.
      expect(wg.resolveTicket(id).status).toBe(statusBefore);

      // Idempotent: unchanged state records no second event, hash still matches.
      const again = wg.recordDossier(id, human);
      expect(again.eventId).toBeNull();
      expect(again.dossier.hash).toBe(dossier.hash);
      expect(
        wg.listTicketEvents(id).filter((e) => e.event_type === "ticket.dossier_recorded"),
      ).toHaveLength(1);
    } finally {
      wg.db.close();
    }
  });

  it("the dossier event is EXCLUDED from the hash (hash stable across recording)", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const before = wg.dossier(id).hash;
      wg.recordDossier(id, human); // writes a ticket.dossier_recorded event
      const after = wg.dossier(id).hash;
      expect(after).toBe(before);
    } finally {
      wg.db.close();
    }
  });

  it("NO-DELIVERY-YET: a thin ticket assembles a well-formed dossier (no crash), unknowns noted", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const t = wg.createTicket({ title: "Fresh", description: "" }, human);
      const d = wg.dossier(t.id);
      expect(d.subject.identity.title).toBe("Fresh");
      expect(d.subject.acceptance_criteria).toEqual([]);
      expect(d.subject.delivery.recorded).toBeNull();
      expect(d.subject.delivery.per_repo).toEqual([]);
      expect(d.subject.review_verdict).toBeNull();
      expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
      // warnings explicitly flag the missing delivery / review / diff hash.
      expect(d.warnings.some((w) => w.startsWith("delivery:"))).toBe(true);
      expect(d.warnings.some((w) => w.startsWith("review_verdict:"))).toBe(true);
      expect(d.warnings.some((w) => w.startsWith("diff_hash:"))).toBe(true);
      // A second generation of the same thin ticket is stable.
      expect(wg.dossier(t.id).hash).toBe(d.hash);
    } finally {
      wg.db.close();
    }
  });

  it("renderMarkdown is a faithful human-readable view of the same data", () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    try {
      const id = deliveredReviewedTicket(wg);
      const d = wg.dossier(id);
      const md = wg.dossierSvc.renderMarkdown(d);
      expect(md).toContain("# Delivery Dossier");
      expect(md).toContain(d.hash);
      expect(md).toContain("## Acceptance Criteria");
      expect(md).toContain("Returns 200");
      expect(md).toContain("feat/ship-it");
      expect(md).toContain("## Review Verdict");
      expect(md).toContain("human:tom");
      // Unknown data renders as the literal unknown marker, never blank-filled.
      const thin = wg.dossier(wg.createTicket({ title: "Thin", description: "" }, human).id);
      expect(wg.dossierSvc.renderMarkdown(thin)).toContain("_unknown (not recorded)_");
    } finally {
      wg.db.close();
    }
  });
});

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
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

describe("DELIVERY-DOSSIER REST surface", () => {
  let h: Harness;
  const original = process.env.DISPATCH_API_TOKEN;
  afterEach(async () => {
    await h.close();
    if (original === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = original;
  });

  it("GET /tickets/:id/dossier returns 200 JSON, ?format=markdown returns text/markdown, no write", async () => {
    h = await startHarness();
    const id = deliveredReviewedTicket(h.wg);

    const before = h.wg.listTicketEvents(id).length;

    const jsonRes = await fetch(`${h.baseUrl}/tickets/${id}/dossier`);
    expect(jsonRes.status).toBe(200);
    const body = (await jsonRes.json()) as {
      hash: string;
      subject: { identity: { title: string } };
    };
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.subject.identity.title).toBe("Ship it");

    const mdRes = await fetch(`${h.baseUrl}/tickets/${id}/dossier?format=markdown`);
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toContain("text/markdown");
    expect(await mdRes.text()).toContain("# Delivery Dossier");

    const acceptRes = await fetch(`${h.baseUrl}/tickets/${id}/dossier`, {
      headers: { accept: "text/markdown" },
    });
    expect(acceptRes.headers.get("content-type")).toContain("text/markdown");

    // The GET is a pure read — no tamper-evidence event (or any event) was written.
    expect(h.wg.listTicketEvents(id).length).toBe(before);
    expect(
      h.wg.listTicketEvents(id).filter((e) => e.event_type === "ticket.dossier_recorded"),
    ).toHaveLength(0);
  });

  it("a READ-scoped token can GET the dossier (read-only), and a full token too", async () => {
    const FULL = "operator-secret";
    process.env.DISPATCH_API_TOKEN = FULL;
    h = await startHarness();
    const id = deliveredReviewedTicket(h.wg);
    const readToken = deriveReadToken(FULL);

    const readRes = await fetch(`${h.baseUrl}/tickets/${id}/dossier`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(readRes.status).toBe(200);

    const fullRes = await fetch(`${h.baseUrl}/tickets/${id}/dossier`, {
      headers: { authorization: `Bearer ${FULL}` },
    });
    expect(fullRes.status).toBe(200);
  });
});
