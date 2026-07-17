/**
 * Regression tests for the bug-fix batch (fix/dispatch-cli-api).
 * Each describe block maps to one numbered fix.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import {
  createScopeNodeInput,
  createTicketInput,
  PR_URL_SAFE,
  recordDeliveryArtifactInput,
  recordRepoDeliveryInput,
} from "../src/domain/schemas.js";
import { DECISION_SEVERITIES, TICKET_STATUSES, type Actor } from "../src/domain/types.js";
import { readSettingsFile } from "../src/api/settings.js";
import { readAuditTail } from "../src/audit/auditTail.js";
import { resolveDbPath } from "../src/util/paths.js";
import { DispatchError } from "../src/util/errors.js";
import { TestClock } from "../src/util/clock.js";
import {
  createEpicBody,
  createTicketBody,
  createScopeNodeBody,
  recordDeliveryArtifactBody,
  recordRepoDeliveryBody,
} from "../src/api/schemas.js";
import { z } from "zod";

import { giveTicketRealDelivery, nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "runner" };

function freshWg(): Dispatch {
  return Dispatch.open(":memory:", new TestClock());
}

// ---------------------------------------------------------------------------
// Fix 1: dispatch import <missing-file> → structured FILE_NOT_FOUND error
// (tested at the path.ts layer, since we can't easily shell-out the CLI here)
// ---------------------------------------------------------------------------

// Fix 2: dispatch decision --severity <invalid> → VALIDATION_ERROR
// ---------------------------------------------------------------------------
describe("Fix 2: decision --severity validation", () => {
  it("DECISION_SEVERITIES enum rejects an unknown value", () => {
    const result = z.enum(DECISION_SEVERITIES).safeParse("banana");
    expect(result.success).toBe(false);
  });

  it("DECISION_SEVERITIES enum accepts every valid member", () => {
    for (const sev of DECISION_SEVERITIES) {
      const result = z.enum(DECISION_SEVERITIES).safeParse(sev);
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: claim --ttl 0 / --ttl -1 → VALIDATION_ERROR
// ---------------------------------------------------------------------------
describe("Fix 3: claim TTL validation", () => {
  it("claimTicketInput rejects ttl_seconds=0", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "T" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    expect(() =>
      wg.claimTicket({ ticket_id: t.id, agent_id: agent.id, ttl_seconds: 0 }, agentActor),
    ).toThrow();
    wg.db.close();
  });

  it("claimTicketInput rejects negative ttl_seconds", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "T" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    wg.markReady(t.id, human);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    expect(() =>
      wg.claimTicket({ ticket_id: t.id, agent_id: agent.id, ttl_seconds: -1 }, agentActor),
    ).toThrow();
    wg.db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 4: --db "" silently uses default → now treated as unset
// ---------------------------------------------------------------------------
describe("Fix 4: resolveDbPath treats empty string as unset", () => {
  it("passes through a non-empty explicit path unchanged", () => {
    const p = resolveDbPath("/tmp/explicit.sqlite");
    expect(p).toBe("/tmp/explicit.sqlite");
  });

  it("falls back to env when explicit is undefined", () => {
    const old = process.env.DISPATCH_DB;
    process.env.DISPATCH_DB = "/tmp/env.sqlite";
    try {
      const p = resolveDbPath(undefined);
      expect(p).toBe("/tmp/env.sqlite");
    } finally {
      if (old === undefined) delete process.env.DISPATCH_DB;
      else process.env.DISPATCH_DB = old;
    }
  });

  it("falls back to env when explicit is empty string", () => {
    const old = process.env.DISPATCH_DB;
    process.env.DISPATCH_DB = "/tmp/env.sqlite";
    try {
      const p = resolveDbPath("");
      expect(p).toBe("/tmp/env.sqlite");
    } finally {
      if (old === undefined) delete process.env.DISPATCH_DB;
      else process.env.DISPATCH_DB = old;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 5: ticket list --status <invalid> → VALIDATION_ERROR
// ---------------------------------------------------------------------------
describe("Fix 5: ticket list status validation", () => {
  it("TICKET_STATUSES enum rejects an unknown status", () => {
    const result = z.enum(TICKET_STATUSES).safeParse("invalid_status");
    expect(result.success).toBe(false);
  });

  it("TICKET_STATUSES enum accepts every valid member", () => {
    for (const s of TICKET_STATUSES) {
      expect(z.enum(TICKET_STATUSES).safeParse(s).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 6: T-N ref accepted as ticket-number alias
// ---------------------------------------------------------------------------
describe("Fix 6: T-N ticket ref alias", () => {
  it("resolves T-1 to the first ticket", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "First" }, human);
    const resolved = wg.resolveTicket(`T-${t.number}`);
    expect(resolved.id).toBe(t.id);
    wg.db.close();
  });

  it("resolves #1 (existing behaviour) still works", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "First" }, human);
    const resolved = wg.resolveTicket(`#${t.number}`);
    expect(resolved.id).toBe(t.id);
    wg.db.close();
  });

  it("throws NOT_FOUND for a T-N that doesn't exist", () => {
    const wg = freshWg();
    expect(() => wg.resolveTicket("T-9999")).toThrow(DispatchError);
    wg.db.close();
  });
});

// ---------------------------------------------------------------------------
// Fix 7: review approve --as agent sets actor.type="agent"
// (behaviour tested at the facade layer: approveReview with agent actor)
// ---------------------------------------------------------------------------
describe("Fix 7: review approve with agent actor", () => {
  it("approveReview accepts an agent actor when env gate is set", () => {
    const old = process.env.DISPATCH_ALLOW_AGENT_APPROVE;
    process.env.DISPATCH_ALLOW_AGENT_APPROVE = "1";
    try {
      // A non-empty-diff runner + real delivery so the recomputed-diff done-gate
      // (now enforced for solo_loose too) is satisfied — this test is about the
      // agent-approve env gate, not the diff gate.
      const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
      const t = wg.createTicket({ title: "T", policy_pack: "solo_loose" }, human);
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
      wg.markReady(t.id, human);
      giveTicketRealDelivery(wg, t.id, human);
      const agent = wg.registerAgent({ display_name: "a" }, human);
      const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 300 }, agentActor)!;
      wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id }, agentActor);

      const agentReviewer: Actor = { type: "agent", id: "reviewer-bot" };
      const res = wg.approveReview(t.id, agentReviewer);
      expect(res.ticket.status).toBe("ready_for_merge");
      wg.db.close();
    } finally {
      if (old === undefined) delete process.env.DISPATCH_ALLOW_AGENT_APPROVE;
      else process.env.DISPATCH_ALLOW_AGENT_APPROVE = old;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 8: pr_url must start with http:// or https://
// ---------------------------------------------------------------------------
describe("Fix 8: pr_url scheme enforcement", () => {
  it("PR_URL_SAFE allows http:// URLs", () => {
    expect(PR_URL_SAFE("http://example.com/pr/1")).toBe(true);
  });

  it("PR_URL_SAFE allows https:// URLs", () => {
    expect(PR_URL_SAFE("https://github.com/org/repo/pull/1")).toBe(true);
  });

  it("PR_URL_SAFE rejects javascript: scheme", () => {
    expect(PR_URL_SAFE("javascript:alert(1)")).toBe(false);
  });

  it("PR_URL_SAFE rejects data: scheme", () => {
    expect(PR_URL_SAFE("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("recordDeliveryArtifactBody rejects javascript: pr_url", () => {
    const result = recordDeliveryArtifactBody.safeParse({
      branch_name: "feat/x",
      pr_url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("recordDeliveryArtifactBody accepts https: pr_url", () => {
    const result = recordDeliveryArtifactBody.safeParse({
      branch_name: "feat/x",
      pr_url: "https://github.com/org/repo/pull/1",
    });
    expect(result.success).toBe(true);
  });

  it("recordRepoDeliveryBody rejects javascript: pr_url", () => {
    const result = recordRepoDeliveryBody.safeParse({
      repo_id: "r1",
      pr_url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("domain recordDeliveryArtifactInput rejects javascript: pr_url", () => {
    const result = recordDeliveryArtifactInput.safeParse({
      ticket_id: "t1",
      branch_name: "feat/x",
      pr_url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });

  it("domain recordRepoDeliveryInput rejects javascript: pr_url", () => {
    const result = recordRepoDeliveryInput.safeParse({
      ticket_id: "t1",
      repo_id: "r1",
      pr_url: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 9: GET /api/audit does not expose filesystem path
// ---------------------------------------------------------------------------
describe("Fix 9: audit tail omits filesystem path", () => {
  it("readAuditTail returns no path field when log is absent", () => {
    const old = process.env.DISPATCH_AUDIT;
    process.env.DISPATCH_AUDIT = "/tmp/dispatch-audit-absent-xyz.jsonl";
    try {
      const tail = readAuditTail(10);
      expect(tail.available).toBe(false);
      expect("path" in tail).toBe(false);
    } finally {
      if (old === undefined) delete process.env.DISPATCH_AUDIT;
      else process.env.DISPATCH_AUDIT = old;
    }
  });

  it("readAuditTail returns no path field when log exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-audit-"));
    const logPath = join(dir, "audit.jsonl");
    writeFileSync(logPath, '{"ts":"2024-01-01T00:00:00Z","tool":"create_ticket"}\n');
    const old = process.env.DISPATCH_AUDIT;
    process.env.DISPATCH_AUDIT = logPath;
    try {
      const tail = readAuditTail(10);
      expect(tail.available).toBe(true);
      expect("path" in tail).toBe(false);
    } finally {
      if (old === undefined) delete process.env.DISPATCH_AUDIT;
      else process.env.DISPATCH_AUDIT = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 10: corrupt settings.json → error message has no filesystem path
// ---------------------------------------------------------------------------
describe("Fix 10: settings error messages omit path", () => {
  it("reports invalid JSON without embedding the file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-settings-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "THIS IS NOT JSON");
    try {
      expect(() => readSettingsFile(settingsPath)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(settingsPath),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-object JSON value without embedding the file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wg-settings-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, "[1,2,3]");
    try {
      expect(() => readSettingsFile(settingsPath)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(settingsPath),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 11: priority bounded to [0, 1000]
// ---------------------------------------------------------------------------
describe("Fix 11: priority bounds", () => {
  it("createTicketInput rejects priority > 1000", () => {
    const result = createTicketInput.safeParse({ title: "T", priority: 1001 });
    expect(result.success).toBe(false);
  });

  it("createTicketInput rejects negative priority", () => {
    const result = createTicketInput.safeParse({ title: "T", priority: -1 });
    expect(result.success).toBe(false);
  });

  it("createTicketInput accepts priority within [0, 1000]", () => {
    expect(createTicketInput.safeParse({ title: "T", priority: 0 }).success).toBe(true);
    expect(createTicketInput.safeParse({ title: "T", priority: 500 }).success).toBe(true);
    expect(createTicketInput.safeParse({ title: "T", priority: 1000 }).success).toBe(true);
  });

  it("createTicketBody rejects priority > 1000", () => {
    const result = createTicketBody.safeParse({ title: "T", priority: 9999 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 12: scope-node name/description/owner reject control characters
// ---------------------------------------------------------------------------
describe("Fix 12: scope-node control-char rejection", () => {
  it("createScopeNodeInput rejects NUL byte in name", () => {
    const result = createScopeNodeInput.safeParse({
      name: "evil\x00name",
      type: "service",
    });
    expect(result.success).toBe(false);
  });

  it("createScopeNodeInput rejects newline in description", () => {
    // Newline (\n = 0x0a) is a control byte.
    const result = createScopeNodeInput.safeParse({
      name: "clean",
      type: "service",
      description: "bad\ndescription",
    });
    expect(result.success).toBe(false);
  });

  it("createScopeNodeInput rejects control byte in owner", () => {
    const result = createScopeNodeInput.safeParse({
      name: "clean",
      type: "service",
      owner: "evil\x01owner",
    });
    expect(result.success).toBe(false);
  });

  it("createScopeNodeInput accepts clean strings", () => {
    const result = createScopeNodeInput.safeParse({
      name: "my-service",
      type: "service",
      description: "Does something useful.",
      owner: "team-alpha",
    });
    expect(result.success).toBe(true);
  });

  it("createScopeNodeBody rejects NUL byte in name", () => {
    const result = createScopeNodeBody.safeParse({
      name: "evil\x00",
      type: "service",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 13: ticket show / view() returns parsed testContract object
// ---------------------------------------------------------------------------
describe("Fix 13: ticket view returns parsed testContract", () => {
  it("view() returns testContract: null when none has been set", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "T" }, human);
    const v = wg.view(t.id);
    expect(v.testContract).toBeNull();
    wg.db.close();
  });

  it("view() returns a parsed object (not a JSON string) when a contract is set", () => {
    const wg = freshWg();
    const t = wg.createTicket({ title: "T" }, human);
    // setTestContract(ticketRef, rawInput, actor)
    wg.setTestContract(
      t.id,
      {
        changed_surfaces: ["GET /api/foo"],
        runtime_deps: ["Postgres 16"],
        env_vars: ["DATABASE_URL"],
        run_command: "pnpm test",
        harness_ready: false,
      },
      human,
    );
    const v = wg.view(t.id);
    expect(typeof v.testContract).toBe("object");
    expect(v.testContract).not.toBeNull();
    expect(v.testContract?.changed_surfaces).toEqual(["GET /api/foo"]);
    expect(v.testContract?.harness_ready).toBe(false);
    // Crucially: testContract is a parsed object, not a raw JSON string
    expect(typeof v.ticket.test_contract).toBe("string"); // raw column still a string
    expect(typeof v.testContract).not.toBe("string");
    wg.db.close();
  });
});

describe("POST /epics body preserves greenfield `source` + budget (Zod strips unknown keys)", () => {
  it("keeps ticket `source`/`delivery_budget_usd` and epic `delivery_budget_usd`", () => {
    // Regression: the domain schema accepted `source`, but the API-layer body schema
    // did not — so Zod stripped it before the domain schema ran, and a POST /epics
    // greenfield bootstrap ticket silently lost its intended repo name (title-slug
    // fallback). The API body must carry the fields end-to-end.
    const parsed = createEpicBody.parse({
      epic: { name: "Greenfield calc", delivery_budget_usd: 5 },
      tickets: [
        {
          title: "Bootstrap the calculator repo",
          bootstrap: true,
          source: "calculator",
          delivery_budget_usd: 2,
        },
      ],
    });
    const t0 = parsed.tickets[0];
    expect(t0).toBeDefined();
    expect(t0?.source).toBe("calculator");
    expect(t0?.delivery_budget_usd).toBe(2);
    expect(parsed.epic.delivery_budget_usd).toBe(5);
  });
});
