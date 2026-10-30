// doctor-orphan-check-wrong: the "working ticket with no active claim" check must not
//   flag a ticket a human took by hand (no claim by design), and its fix must be one
//   that actually clears a real orphan.
// upgrade-hint-wrong-package: the "DB too new" remediation must never tell anyone to
//   `npm i -g dispatch` — that npm name is an unrelated third-party package.
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/cli/ops.js";
import { Dispatch } from "../src/core.js";
import { DatabaseTooNewError } from "../src/db/connection.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };
const system: Actor = { type: "system" };

function integrityCheck(wg: Dispatch) {
  const report = runDoctor(wg.db, ":memory:");
  const check = report.checks.find((c) => /working ticket|Working tickets/i.test(c.label));
  expect(check).toBeDefined();
  return check!;
}

function readyTicket(wg: Dispatch): { id: string; number: number } {
  const t = wg.createTicket({ title: "t", description: "d", policy_pack: "solo_loose" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
  wg.markReady(t.id, human);
  return { id: t.id, number: t.number! };
}

describe("doctor-orphan-check-wrong", () => {
  it("a ticket taken by hand is not an integrity warning", () => {
    const wg = Dispatch.open(":memory:");
    const t = readyTicket(wg);
    wg.humanClaimTicket(t.id, human);
    expect(wg.view(t.id).ticket.status).toBe("in_progress");
    expect(integrityCheck(wg).level).toBe("ok");
    wg.db.close();
  });

  it("an agent orphan is flagged by ref, and the recommended hand-back clears it", () => {
    const wg = Dispatch.open(":memory:");
    const t = readyTicket(wg);
    const agent = wg.registerAgent({ display_name: "a" }, human);
    wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, { type: "agent", id: agent.id });
    // The lease vanished without the ticket moving (the stranded-ticket shape).
    wg.db.prepare("UPDATE ticket_claims SET status = 'released' WHERE ticket_id = ?").run(t.id);

    const warn = integrityCheck(wg);
    expect(warn.level).toBe("warn");
    expect(warn.detail).toContain(`#${t.number}`);
    expect(warn.fix).toContain("runner-release");
    expect(warn.fix).not.toContain("expire-claims");
    // expire-claims really cannot fix it (no lease to expire) ...
    expect(wg.expireStaleClaims(system).expired).toBe(0);
    expect(integrityCheck(wg).level).toBe("warn");
    // ... the recommended `dispatch runner-release <ref> --to ready` does.
    wg.runnerRelease({ ticket_id: t.id, to: "ready" }, system);
    expect(integrityCheck(wg).level).toBe("ok");
    wg.db.close();
  });
});

describe("upgrade-hint-wrong-package", () => {
  const badHint = /npm i(nstall)? -g dispatch(@|\s|$)/;

  it("DatabaseTooNewError points at the real upgrade path", () => {
    const msg = new DatabaseTooNewError(99, 5).message;
    expect(msg).not.toMatch(badHint);
    expect(msg).toContain("git pull && pnpm install");
    expect(msg).toContain("github.com/tmj-90/gaffer/releases");
  });

  it("doctor's too-new fix points at the real upgrade path", () => {
    const wg = Dispatch.open(":memory:");
    wg.db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run();
    const check = runDoctor(wg.db, ":memory:").checks.find((c) => /NEWER/.test(c.label));
    expect(check?.fix).toBeDefined();
    expect(check!.fix).not.toMatch(badHint);
    expect(check!.fix).toContain("github.com/tmj-90/gaffer/releases");
    wg.db.close();
  });
});
