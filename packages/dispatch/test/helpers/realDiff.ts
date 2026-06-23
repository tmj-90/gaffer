import type { Dispatch } from "../../src/core.js";
import type { Actor } from "../../src/domain/types.js";
import type { GitRunner } from "../../src/services/diffService.js";

/**
 * Test helper for the P0 real-diff done-gate. The gate (transitionService
 * `hasRealDeliveryDiff`) now recomputes the REAL `git diff base...delivery-branch`
 * for every active write repo and only passes when at least one yields a NON-EMPTY
 * diff — an agent-authored `diff_summary` evidence row alone no longer satisfies it.
 *
 * To exercise the LEGITIMATE operator path in a unit test (no real clone on disk)
 * we inject a scripted git runner that returns a non-empty diff for any
 * `diff ... <range>` invocation, and we register the ticket's write repo with an
 * on-disk `local_path` plus a recorded delivery branch so branch resolution
 * succeeds. This mirrors what the live system sees: a real branch with real diff
 * output.
 */

/**
 * A permissive git runner: every `git diff --numstat ...` reports one changed file
 * and every `git diff ...` returns a small non-empty patch, so branch resolution +
 * the real-diff gate succeed. Intended for tests that just need the gate satisfied.
 */
export const nonEmptyDiffRunner: GitRunner = (_cwd, args) => {
  const joined = args.join(" ");
  if (joined.startsWith("diff --numstat")) {
    return { status: 0, stdout: "5\t1\tsrc/x.ts\n", stderr: "" };
  }
  if (joined.startsWith("diff")) {
    return {
      status: 0,
      stdout: "diff --git a/src/x.ts b/src/x.ts\n+a real change\n-an old line\n",
      stderr: "",
    };
  }
  return { status: 0, stdout: "", stderr: "" };
};

/** A git runner that always reports an EMPTY diff (no changes in the range). */
export const emptyDiffRunner: GitRunner = (_cwd, args) => {
  const joined = args.join(" ");
  if (joined.startsWith("diff")) return { status: 0, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

/**
 * Register a write repo on the ticket with an on-disk local_path and a recorded
 * delivery branch, so {@link nonEmptyDiffRunner} resolves a real, non-empty diff
 * for it. Uses `process.cwd()` (the repo root — guaranteed on disk) as local_path.
 */
export function giveTicketRealDelivery(
  wg: Dispatch,
  ticketId: string,
  actor: Actor,
  opts: { repoName?: string; branch?: string } = {},
): { repoId: string; branch: string } {
  const repoName = opts.repoName ?? "delivery-repo";
  const branch = opts.branch ?? "feat/delivery";
  const repo = wg.registerRepository(
    { name: repoName, default_branch: "main", local_path: process.cwd() },
    actor,
  );
  wg.setTicketRepoAccess(
    { ticket_id: ticketId, repo_id: repo.id, access: "write", relation: "confirmed" },
    actor,
  );
  wg.recordRepoDelivery({ ticket_id: ticketId, repo_id: repo.id, branch_name: branch }, actor);
  return { repoId: repo.id, branch };
}
