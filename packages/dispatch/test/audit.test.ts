import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAuditPathCache } from "../src/audit/audit.js";
import { resultIdsFor, sanitiseRequest } from "../src/audit/redact.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers, type ToolName } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const agentActor: Actor = { type: "agent", id: "mcp-agent" };

/** Read all audit lines as parsed JSON records. */
function readAudit(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("audit redaction (pure)", () => {
  it("never echoes a claim token — records presence only", () => {
    const out = sanitiseRequest("record_ac_evidence", {
      claim_token: "super-secret-bearer-token",
      ticket_id: "t-1",
      ac_id: "ac-1",
      evidence_type: "test_output",
      summary: "an evidence body that must not leak",
    });
    expect(out.claim_token).toBe(true);
    expect(JSON.stringify(out)).not.toContain("super-secret-bearer-token");
  });

  it("reduces free-text bodies to character counts", () => {
    const out = sanitiseRequest("create_ticket", {
      title: "A title",
      description: "a long sensitive description",
    });
    expect(out.title).toBe("A title");
    expect(out.description_chars).toBe("a long sensitive description".length);
    expect(JSON.stringify(out)).not.toContain("sensitive");
  });

  it("reduces block reason and decision question to lengths", () => {
    const block = sanitiseRequest("mark_ticket_blocked", {
      claim_token: "tok",
      ticket_id: "t",
      reason: "secret outage detail",
    });
    expect(block.reason_chars).toBe("secret outage detail".length);
    expect(JSON.stringify(block)).not.toContain("secret outage");

    const decision = sanitiseRequest("request_decision", {
      title: "Pick provider",
      question: "Stripe or Adyen for EU?",
    });
    expect(decision.question_chars).toBe("Stripe or Adyen for EU?".length);
    expect(JSON.stringify(decision)).not.toContain("Adyen");
  });

  it("extracts entity ids for the audit trail", () => {
    expect(resultIdsFor({ ticket_id: "t-1", number: 3 })).toEqual(["t-1"]);
    expect(resultIdsFor({ evidence_id: "e-1", event_id: "ev-1" }).sort()).toEqual(
      ["e-1", "ev-1"].sort(),
    );
  });

  // ── No-leak sweep across the ENTIRE tool surface ────────────────────────
  // The redaction allow-list is the security boundary. A new tool added with a
  // careless sanitiser (or a regression that spreads raw args back in) is the
  // exact failure these tests exist to catch. We poison every sensitive field
  // with a unique sentinel and assert NONE survive into the serialised record.

  const SECRET_TOKEN = "TOKEN-SENTINEL-must-never-leak";
  const SECRET_BODY = "BODY-SENTINEL-must-never-leak";

  /** Every tool name and a maximally-poisoned arg payload for it. */
  const poisonedArgsByTool: Record<ToolName, Record<string, unknown>> = {
    create_ticket: { title: "t", description: SECRET_BODY, repo: "r" },
    add_acceptance_criterion: { ticket_id: "t", text: SECRET_BODY },
    mark_ticket_ready: { ticket_id: "t" },
    claim_next_ticket: { agent_id: "a", ttl_seconds: 60, capabilities: ["x"] },
    claim_ticket: { ticket_id: "t", agent_id: "a", ttl_seconds: 60, capabilities: ["x"] },
    get_ticket: { ticket_id: "t" },
    heartbeat_claim: { claim_token: SECRET_TOKEN },
    record_ac_evidence: {
      claim_token: SECRET_TOKEN,
      ticket_id: "t",
      ac_id: "ac",
      evidence_type: "test_output",
      summary: SECRET_BODY,
      uri: "u",
      payload: { secret: SECRET_BODY },
    },
    mark_ticket_blocked: { claim_token: SECRET_TOKEN, ticket_id: "t", reason: SECRET_BODY },
    submit_ticket_for_review: { claim_token: SECRET_TOKEN, ticket_id: "t", reason: SECRET_BODY },
    record_delivery_artifact: {
      claim_token: SECRET_TOKEN,
      ticket_id: "t",
      // branch_name / pr_url / commit are operational metadata kept verbatim by
      // design; only the free-text diff_summary must be reduced to a char count.
      branch_name: "feat/x",
      pr_url: "https://example.test/pr/1",
      commit: "abc123",
      diff_summary: SECRET_BODY,
    },
    record_repo_delivery: {
      // All fields here are operational metadata (no free-text body is stored);
      // none should carry a secret body. Token presence is not part of this tool.
      ticket_id: "t",
      repo_id: "r",
      branch_name: "feat/x",
      commit_sha: "abc123",
      pr_url: "https://example.test/pr/1",
      evidence_ref: "ev-1",
    },
    add_dependency: { ticket: "t", depends_on: "t2" },
    create_epic: {
      // Epic/ticket titles, descriptions and AC text ARE free-text bodies the
      // redactor must drop (only name + counts survive).
      epic: { name: "e", description: SECRET_BODY },
      tickets: [
        { title: SECRET_BODY, description: SECRET_BODY, acceptanceCriteria: [SECRET_BODY] },
      ],
    },
    list_pending_decisions: {},
    request_decision: { title: "tt", question: SECRET_BODY, severity: "human_required" },
    release_claim: { claimToken: SECRET_TOKEN },
    list_scopes: {},
  };

  it("redacts every tool: no token value or body text survives sanitisation", () => {
    for (const [tool, args] of Object.entries(poisonedArgsByTool) as Array<
      [ToolName, Record<string, unknown>]
    >) {
      const serialised = JSON.stringify(sanitiseRequest(tool, args));
      expect(serialised, `${tool} leaked a claim token`).not.toContain(SECRET_TOKEN);
      expect(serialised, `${tool} leaked a free-text body`).not.toContain(SECRET_BODY);
    }
  });

  it("records claim tokens only as a presence boolean, never the value", () => {
    for (const [tool, args] of Object.entries(poisonedArgsByTool) as Array<
      [ToolName, Record<string, unknown>]
    >) {
      const out = sanitiseRequest(tool, args);
      for (const key of ["claim_token"]) {
        if (key in out) {
          expect(typeof out[key], `${tool}.${key} must be a boolean`).toBe("boolean");
        }
      }
    }
  });

  it("never copies an unrecognised argument (allow-list, not deny-list)", () => {
    const out = sanitiseRequest("create_ticket", {
      title: "ok",
      __injected__: SECRET_BODY,
      another_unknown: SECRET_TOKEN,
    });
    expect(Object.keys(out)).not.toContain("__injected__");
    expect(Object.keys(out)).not.toContain("another_unknown");
    expect(JSON.stringify(out)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(out)).not.toContain(SECRET_TOKEN);
  });

  it("falls back to an empty object for an unknown tool — never echoes raw args", () => {
    const out = sanitiseRequest("not_a_real_tool" as ToolName, {
      claim_token: SECRET_TOKEN,
      body: SECRET_BODY,
    });
    expect(out).toEqual({});
  });
});

describe("audit logging (end-to-end through handlers)", () => {
  let dir: string;
  let auditPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-audit-"));
    auditPath = join(dir, "audit.jsonl");
    process.env.DISPATCH_AUDIT = auditPath;
    delete process.env.DISPATCH_AUDIT_OFF;
    resetAuditPathCache();
  });

  afterEach(() => {
    delete process.env.DISPATCH_AUDIT;
    process.env.DISPATCH_AUDIT_OFF = "1";
    resetAuditPathCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one redacted row per tool call with no token or body content", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);

    const ticketId = h.create_ticket({
      title: "Audit me",
      description: "DESCRIPTION-SHOULD-NOT-LEAK",
      policy_pack: "solo_loose",
    }).structuredContent.ticket_id as string;
    const acId = h.add_acceptance_criterion({
      ticket_id: ticketId,
      text: "AC-TEXT-SHOULD-NOT-LEAK",
    }).structuredContent.ac_id as string;
    h.mark_ticket_ready({ ticket_id: ticketId });

    const agent = wg.registerAgent({ display_name: "claude" }, { type: "human", id: "tom" });
    const claimToken = h.claim_next_ticket({ agent_id: agent.id, ttl_seconds: 600 })
      .structuredContent.claim_token as string;
    h.record_ac_evidence({
      claim_token: claimToken,
      ticket_id: ticketId,
      ac_id: acId,
      evidence_type: "test_output",
      summary: "EVIDENCE-BODY-SHOULD-NOT-LEAK",
    });

    const blob = readFileSync(auditPath, "utf8");
    // The claim token and every free-text body are absent from the whole log.
    expect(blob).not.toContain(claimToken);
    expect(blob).not.toContain("DESCRIPTION-SHOULD-NOT-LEAK");
    expect(blob).not.toContain("AC-TEXT-SHOULD-NOT-LEAK");
    expect(blob).not.toContain("EVIDENCE-BODY-SHOULD-NOT-LEAK");

    const rows = readAudit(auditPath);
    const tools = rows.map((r) => r.tool);
    expect(tools).toContain("create_ticket");
    expect(tools).toContain("record_ac_evidence");

    // Each row carries ts, tool, actor, sanitised request.
    for (const r of rows) {
      expect(typeof r.ts).toBe("string");
      expect(typeof r.tool).toBe("string");
      expect(r.actor).toMatchObject({ type: "agent", id: "mcp-agent" });
    }

    // The evidence row records the token only as a presence boolean.
    const evidenceRow = rows.find((r) => r.tool === "record_ac_evidence")!;
    expect((evidenceRow.request as Record<string, unknown>).claim_token).toBe(true);
    expect((evidenceRow.request as Record<string, unknown>).summary_chars).toBe(
      "EVIDENCE-BODY-SHOULD-NOT-LEAK".length,
    );
    expect(evidenceRow.resultIds).toBeDefined();
  });

  it("records a policy-gate refusal in the `blocked` field, not `error`", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);

    // A team_light ticket with no description/repo/AC fails the readiness gate:
    // the state machine deliberately *refuses* the transition (POLICY_DENIED),
    // which is a block, not a crash.
    const ticketId = h.create_ticket({ title: "needs more", policy_pack: "team_light" })
      .structuredContent.ticket_id as string;
    const res = h.mark_ticket_ready({ ticket_id: ticketId });
    expect(res.isError).toBe(true);
    expect((res.structuredContent.error as { code: string }).code).toBe("POLICY_DENIED");

    const rows = readAudit(auditPath);
    const row = rows.find((r) => r.tool === "mark_ticket_ready")!;
    // The refusal is recorded as `blocked`, and `error` is left unset so an
    // operator can tell a fired gate apart from an unexpected failure.
    expect(typeof row.blocked).toBe("string");
    expect(row.blocked as string).toContain("POLICY_DENIED");
    expect(row.error).toBeUndefined();
    // The blocked row records only the gate verdict — no policy `details`
    // object (which can embed AC text) is serialised into the audit line.
    expect(JSON.stringify(row)).not.toContain("failures");
  });

  it("records failures with the error code, not a body", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    const ticketId = h.create_ticket({ title: "x", policy_pack: "solo_loose" }).structuredContent
      .ticket_id as string;
    h.mark_ticket_ready({ ticket_id: ticketId });

    const res = h.record_ac_evidence({
      claim_token: "BOGUS-TOKEN-VALUE",
      ticket_id: ticketId,
      evidence_type: "log",
      summary: "x",
    });
    expect(res.isError).toBe(true);

    const blob = readFileSync(auditPath, "utf8");
    expect(blob).not.toContain("BOGUS-TOKEN-VALUE");
    const rows = readAudit(auditPath);
    const row = rows.find((r) => r.tool === "record_ac_evidence")!;
    expect(typeof row.error).toBe("string");
    expect(row.error).toContain("CLAIM_INVALID");
  });

  it("honours DISPATCH_AUDIT_OFF", () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    resetAuditPathCache();
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, agentActor);
    h.create_ticket({ title: "no audit", policy_pack: "solo_loose" });
    // No file was created.
    expect(() => readFileSync(auditPath, "utf8")).toThrow();
  });
});
