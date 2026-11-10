import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { CLI_BUILT, oneLineError, runBin } from "./helpers/cliBin.js";

/**
 * PACKAGE H1, through the real CLI binary (`gaffer wg`): a person's tester verdict is
 * accepted only with an active human or admin principal's token. The tokenless operator
 * CLI, `--as human|admin|system` without a principal, a revoked token and a principal
 * asking to record another identity are refused; the principal's own verdict is recorded
 * as the principal and bound to the real git head.
 */

const human: Actor = { type: "human", id: "operator" };
const agentActor: Actor = { type: "agent", id: "agent-runner" };
let dir = "";
let db = "";
let n = 0;
let head = "";
const ENV = {
  // The runner's isolation probe, stubbed: no OS sandbox wraps agents on this host.
  GAFFER_SANDBOX_STATUS_CMD: JSON.stringify([
    "echo",
    '{"provider":"docker","available":false,"wrapped":false}',
  ]),
  GAFFER_PRINCIPAL_TOKEN: undefined,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "h1-cli-"));
  const repo = join(dir, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feat/x");
  writeFileSync(join(repo, "a.txt"), "a change\n");
  git(repo, "commit", "-q", "-am", "change");
  head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  db = join(dir, "dispatch.sqlite");
  const wg = Dispatch.open(db, undefined, undefined, { testingEnabled: true });
  const r = wg.registerRepository({ name: "app", default_branch: "main", local_path: repo }, human);
  const t = wg.createTicket(
    { title: "Ship it", description: "d", policy_pack: "solo_loose" },
    human,
  );
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: r.id, access: "write", relation: "confirmed" },
    human,
  );
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Returns 200" }, human);
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "Shows the banner" }, human);
  wg.setTestable(t.id, true, human);
  wg.markReady(t.id, human);
  const agent = wg.registerAgent({ display_name: "a" }, human);
  const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, agentActor)!;
  wg.recordEvidence(
    {
      claimToken: claim.claimToken,
      ticket_id: t.id,
      ac_id: ac.id,
      evidence_type: "test_output",
      summary: "ok",
    },
    agentActor,
  );
  wg.recordRepoDelivery({ ticket_id: t.id, repo_id: r.id, branch_name: "feat/x" }, human);
  wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id, reason: "done" }, agentActor);
  const [route] = wg.routeToTester(t.id, { type: "system" });
  expect(route!.routed).toBe(true);
  n = t.number!;
  wg.db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function status(): string {
  const wg = Dispatch.open(db);
  try {
    return wg.resolveTicket(String(n)).status;
  } finally {
    wg.db.close();
  }
}

function mint(name: string, extra: string[] = []): string {
  const r = runBin(db, ["principal", "create", name, ...extra], { env: ENV });
  expect(r.status).toBe(0);
  return (JSON.parse(r.stdout) as { token: string }).token;
}

describe.skipIf(!CLI_BUILT)("H1 CLI: a person's tester verdict needs a principal's token", () => {
  it("the tokenless CLI with --as human, --as admin or nothing is refused; --as system needs the replay", () => {
    for (const as of ["human", "admin"]) {
      for (const verb of ["tester-pass", "tester-fail"]) {
        const r = runBin(db, ["ticket", verb, String(n), "--summary", "by hand", "--as", as], {
          env: ENV,
        });
        expect(r.status).toBe(1);
        const e = oneLineError(r.stderr);
        expect(e.code).toBe("ACTOR_NOT_PERMITTED");
        expect(e.message).toMatch(/principal create/);
        expect(e.message).toMatch(/GAFFER_PRINCIPAL_TOKEN=<token> gaffer wg ticket tester-/);
      }
    }
    for (const as of [[], ["--as", "system"], ["--as", "agent"]]) {
      const r = runBin(db, ["ticket", "tester-pass", String(n), "--summary", "x", ...as], {
        env: ENV,
      });
      expect(r.status).toBe(1);
      expect(oneLineError(r.stderr).code).toBe("BINDING_REQUIRED");
    }
    expect(status()).toBe("in_testing");
  }, 30_000);

  it("a revoked principal's token is refused before anything runs", () => {
    const token = mint("tom");
    expect(runBin(db, ["principal", "revoke", "tom"], { env: ENV }).status).toBe(0);
    const r = runBin(db, ["ticket", "tester-pass", String(n), "--summary", "x"], {
      env: { ...ENV, GAFFER_PRINCIPAL_TOKEN: token },
    });
    expect(r.status).toBe(1);
    expect(oneLineError(r.stderr).message).toMatch(/not an active principal token/);
    expect(status()).toBe("in_testing");
  }, 30_000);

  it("a principal asking to record the system or an agent is refused", () => {
    const token = mint("tom");
    for (const as of ["system", "agent"]) {
      const r = runBin(
        db,
        ["--as-principal", token, "ticket", "tester-pass", String(n), "--summary", "x", "--as", as],
        { env: ENV },
      );
      expect(r.status).toBe(1);
      expect(oneLineError(r.stderr).code).toBe("ACTOR_NOT_PERMITTED");
    }
    expect(status()).toBe("in_testing");
  }, 30_000);

  it("the principal's waiver is recorded as the principal, bound to the real head, and loud without isolation", () => {
    const token = mint("tom");
    const r = runBin(
      db,
      [
        "ticket",
        "tester-pass",
        String(n),
        "--summary",
        "checked AC2 in a browser",
        "--criterion",
        "2",
      ],
      { env: { ...ENV, GAFFER_PRINCIPAL_TOKEN: token } },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(status()).toBe("in_review");
    const show = runBin(db, ["ticket", "show", String(n)], { env: ENV });
    const view = JSON.parse(show.stdout) as { testerWaiver?: { label: string } | null };
    expect(view.testerWaiver?.label).toBe(
      `tester verdict waived by tom for criteria 2 on ${head.slice(0, 12)}: checked AC2 in a browser (recorded without OS isolation)`,
    );
    const wg = Dispatch.open(db);
    try {
      const row = wg.db
        .prepare("SELECT created_by, payload_json FROM evidence WHERE summary = ?")
        .get("checked AC2 in a browser") as { created_by: string; payload_json: string };
      expect(row.created_by).toBe("tom");
      const p = JSON.parse(row.payload_json) as {
        tested_commit: string;
        waiver: { heads: Array<{ sha: string }>; isolation: string };
      };
      expect(p.tested_commit).toBe(head);
      expect(p.waiver.heads.map((h) => h.sha)).toEqual([head]);
      expect(p.waiver.isolation).toBe("none");
    } finally {
      wg.db.close();
    }
  }, 30_000);

  it("a person's FAIL with the principal's token is recorded; tokenless it is refused", () => {
    const token = mint("ops-admin", ["--admin"]);
    const r = runBin(
      db,
      ["--as-principal", token, "ticket", "tester-fail", String(n), "--summary", "AC1 is 500"],
      { env: ENV },
    );
    expect(r.status).toBe(0);
    expect(status()).toBe("refining");
  }, 30_000);
});
