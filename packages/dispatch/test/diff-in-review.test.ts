import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { computeTicketDiff, MAX_DIFF_BYTES, type GitRunner } from "../src/services/diffService.js";
import type { Actor } from "../src/domain/types.js";

const human: Actor = { type: "human", id: "tom" };

/**
 * A scripted git runner: returns a canned result per (cwd, joined-args) so a test
 * drives the diff endpoint with zero real repos on disk. Records every call.
 */
function scriptedGit(
  script: Record<string, { status: number | null; stdout?: string; stderr?: string }>,
): { runGit: GitRunner; calls: Array<{ cwd: string; args: readonly string[] }> } {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const runGit: GitRunner = (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(" ");
    const hit = script[key] ?? { status: 0, stdout: "" };
    return { status: hit.status, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return { runGit, calls };
}

/** Build a ticket with a single write repo (on a temp local_path) + a delivery branch. */
function ticketWithWriteRepo(
  wg: Dispatch,
  opts: {
    localPath?: string | null;
    defaultBranch?: string;
    repoBranch?: string;
    ticketBranch?: string;
  } = {},
): { ticketId: string; repoId: string } {
  const repo = wg.registerRepository(
    {
      name: "svc",
      default_branch: opts.defaultBranch ?? "main",
      local_path: opts.localPath === undefined ? "/tmp/does-not-exist-svc" : opts.localPath,
    },
    human,
  );
  const t = wg.createTicket({ title: "deliver", policy_pack: "solo_loose" }, human);
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
    human,
  );
  if (opts.repoBranch) {
    wg.recordRepoDelivery(
      { ticket_id: t.id, repo_id: repo.id, branch_name: opts.repoBranch },
      human,
    );
  }
  if (opts.ticketBranch) {
    wg.recordDeliveryArtifact({ ticket_id: t.id, branch_name: opts.ticketBranch }, human);
  }
  return { ticketId: t.id, repoId: repo.id };
}

describe("diff-in-review: branch resolution + git", () => {
  it("computes a per-repo diff for a write repo on disk (prefers ticket_repos.branch_name)", () => {
    const wg = Dispatch.open(":memory:");
    // local_path must exist on disk for the git path to run — use the repo root.
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: process.cwd(),
      defaultBranch: "main",
      repoBranch: "feat/x",
      ticketBranch: "ignored-because-repo-branch-wins",
    });
    const { runGit, calls } = scriptedGit({
      "diff --numstat main...feat/x": { status: 0, stdout: "10\t2\tsrc/a.ts\n4\t0\tsrc/b.ts\n" },
      "diff main...feat/x": {
        status: 0,
        stdout: "diff --git a/src/a.ts b/src/a.ts\n+added line\n-removed line\n",
      },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      ticketId,
    );
    expect(out.repos).toHaveLength(1);
    const rd = out.repos[0]!;
    expect(rd.repo).toBe("svc");
    expect(rd.branch).toBe("feat/x"); // repo branch wins over the ticket branch
    expect(rd.baseBranch).toBe("main");
    expect(rd.files).toBe(2);
    expect(rd.additions).toBe(14);
    expect(rd.deletions).toBe(2);
    expect(rd.truncated).toBe(false);
    expect(rd.diff).toContain("+added line");
    // It ran git in the repo's local_path with the resolved range.
    expect(calls.every((c) => c.cwd === process.cwd())).toBe(true);
    wg.db.close();
  });

  it("falls back to tickets.branch_name when the repo has no per-repo branch", () => {
    const wg = Dispatch.open(":memory:");
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: process.cwd(),
      ticketBranch: "feat/from-ticket",
    });
    const { runGit } = scriptedGit({
      "diff --numstat main...feat/from-ticket": { status: 0, stdout: "1\t0\tx\n" },
      "diff main...feat/from-ticket": { status: 0, stdout: "diff\n+a\n" },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      ticketId,
    );
    expect(out.repos[0]!.branch).toBe("feat/from-ticket");
    wg.db.close();
  });

  it("reviews a greenfield BOOTSTRAP via the initial commit (empty-tree → HEAD), no branch needed", () => {
    const wg = Dispatch.open(":memory:");
    const repo = wg.registerRepository(
      { name: "newrepo", default_branch: "main", local_path: process.cwd() },
      human,
    );
    // A bootstrap ticket with NO delivery branch — it committed straight to main.
    const t = wg.createTicket(
      { title: "Bootstrap the app", policy_pack: "solo_loose", bootstrap: true },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
    const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const { runGit, calls } = scriptedGit({
      [`diff --numstat ${EMPTY} HEAD`]: {
        status: 0,
        stdout: "10\t0\tpackage.json\n5\t0\tREADME.md\n",
      },
      [`diff ${EMPTY} HEAD`]: {
        status: 0,
        stdout: "diff --git a/package.json b/package.json\n+everything new\n",
      },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      t.id,
    );
    expect(out.repos).toHaveLength(1);
    const rd = out.repos[0]!;
    expect(rd.unavailable).toBeUndefined(); // reviewable, NOT no_branch
    expect(rd.branch).toBe("initial commit");
    expect(rd.files).toBe(2);
    expect(rd.additions).toBe(15);
    expect(rd.diff).toContain("+everything new");
    // It diffed the empty tree against HEAD — never a base...branch range.
    expect(calls.some((c) => c.args.join(" ") === `diff ${EMPTY} HEAD`)).toBe(true);
    wg.db.close();
  });

  it("reports no_branch when neither a repo nor a ticket branch is recorded", () => {
    const wg = Dispatch.open(":memory:");
    const { ticketId } = ticketWithWriteRepo(wg, { localPath: process.cwd() });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries },
      ticketId,
    );
    expect(out.repos[0]!.unavailable).toBe("no_branch");
    expect(out.repos[0]!.diff).toBe("");
    wg.db.close();
  });

  it("reports repo_not_on_disk when the repo's local_path is missing", () => {
    const wg = Dispatch.open(":memory:");
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: "/tmp/definitely-not-here-xyz",
      repoBranch: "feat/x",
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries },
      ticketId,
    );
    expect(out.repos[0]!.unavailable).toBe("repo_not_on_disk");
    wg.db.close();
  });

  it("reports no_local_path when the repo has no local_path at all", () => {
    const wg = Dispatch.open(":memory:");
    // Register a repo WITHOUT a local_path (it persists as null in the DB).
    const repo = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: repo.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.recordRepoDelivery({ ticket_id: t.id, repo_id: repo.id, branch_name: "feat/x" }, human);
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries },
      t.id,
    );
    expect(out.repos[0]!.unavailable).toBe("no_local_path");
    wg.db.close();
  });

  it("reports empty when the range yields no changes", () => {
    const wg = Dispatch.open(":memory:");
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: process.cwd(),
      repoBranch: "feat/x",
    });
    const { runGit } = scriptedGit({
      "diff --numstat main...feat/x": { status: 0, stdout: "" },
      "diff main...feat/x": { status: 0, stdout: "" },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      ticketId,
    );
    expect(out.repos[0]!.unavailable).toBe("empty");
    wg.db.close();
  });

  it("reports git_error when git exits non-zero (e.g. unknown branch)", () => {
    const wg = Dispatch.open(":memory:");
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: process.cwd(),
      repoBranch: "feat/x",
    });
    const { runGit } = scriptedGit({
      "diff --numstat main...feat/x": {
        status: 128,
        stderr: "fatal: bad revision 'main...feat/x'",
      },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      ticketId,
    );
    expect(out.repos[0]!.unavailable).toBe("git_error");
    expect(out.repos[0]!.message).toContain("bad revision");
    wg.db.close();
  });

  it("truncates a diff larger than the cap and sets truncated", () => {
    const wg = Dispatch.open(":memory:");
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: process.cwd(),
      repoBranch: "feat/x",
    });
    const big = "+".repeat(MAX_DIFF_BYTES + 5000);
    const { runGit } = scriptedGit({
      "diff --numstat main...feat/x": { status: 0, stdout: "1\t0\tx\n" },
      "diff main...feat/x": { status: 0, stdout: big },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      ticketId,
    );
    const rd = out.repos[0]!;
    expect(rd.truncated).toBe(true);
    expect(Buffer.byteLength(rd.diff, "utf8")).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    wg.db.close();
  });

  it("only diffs WRITE repos (read/test repos are excluded)", () => {
    const wg = Dispatch.open(":memory:");
    const write = wg.registerRepository(
      { name: "w", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const read = wg.registerRepository(
      { name: "r", default_branch: "main", local_path: process.cwd() },
      human,
    );
    const t = wg.createTicket({ title: "x", policy_pack: "solo_loose" }, human);
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: write.id, access: "write", relation: "confirmed" },
      human,
    );
    wg.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: read.id, access: "read", relation: "confirmed" },
      human,
    );
    wg.recordRepoDelivery({ ticket_id: t.id, repo_id: write.id, branch_name: "feat/x" }, human);
    const { runGit } = scriptedGit({
      "diff --numstat main...feat/x": { status: 0, stdout: "1\t0\tx\n" },
      "diff main...feat/x": { status: 0, stdout: "diff\n+a\n" },
    });
    const out = computeTicketDiff(
      { repos: wg.repos, tickets: wg.tickets, repoDeliveries: wg.repoDeliveries, runGit },
      t.id,
    );
    expect(out.repos.map((r) => r.repo)).toEqual(["w"]);
    wg.db.close();
  });
});

describe("Dispatch.ticketDiff via injected git runner", () => {
  it("resolves the ticket and uses the constructor git runner", () => {
    const runGit: GitRunner = (_cwd, args) => {
      const key = args.join(" ");
      if (key === "diff --numstat main...feat/y")
        return { status: 0, stdout: "2\t1\ta\n", stderr: "" };
      if (key === "diff main...feat/y") return { status: 0, stdout: "diff\n+x\n-y\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const wg = Dispatch.open(":memory:", undefined, runGit);
    const { ticketId } = ticketWithWriteRepo(wg, {
      localPath: process.cwd(),
      repoBranch: "feat/y",
    });
    const out = wg.ticketDiff(ticketId);
    expect(out.repos[0]!.branch).toBe("feat/y");
    expect(out.repos[0]!.additions).toBe(2);
    wg.db.close();
  });
});
