/**
 * A ticket's delivery as git sees it: the review diff and its change impact, each write
 * repo's delivery head, the review and landing pins compared with it, and whether an
 * approved change is on a default branch. Reads only (git runs through the facade's
 * injectable runner, or a real `git` spawn when none was given).
 */
import { existsSync } from "node:fs";
import { type Ticket, isActiveTicketRepoRelation } from "../domain/types.js";
import {
  computeTicketDiff,
  type TicketDiffOptions,
  defaultGitRunner,
  type RepoDiff,
  resolveBranchHead,
  type TicketDiff,
} from "./diffService.js";
import { type CommentRepoContext } from "./reviewCommentService.js";
import { computeSinceDiff, type SinceDiff } from "./sinceReview.js";
import {
  type ApprovalShas,
  type ReviewedHead,
  type UnavailableWriteRepo,
} from "./reviewGateService.js";
import {
  type ObservedRisk,
  observedRisk,
  runnerIntegrityHolds,
  withRunnerIntegrityHolds,
} from "./observedRisk.js";
import type { DispatchInternals } from "./dispatchInternals.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type TicketGitHost = Pick<
  Dispatch,
  | "commentRepoContexts"
  | "db"
  | "downstreamRepos"
  | "events"
  | "latestDodSummary"
  | "repoDeliveries"
  | "repos"
  | "resolveTicket"
  | "ticketDiff"
  | "tickets"
  | "writeRepoHeads"
>;
/** The facade's private state these functions read. */
export type TicketGitInternals = Pick<
  DispatchInternals,
  "codeIndex" | "gitRunner" | "lastCallersRow"
>;

/**
 * GATE INTEGRITY: the latest DoD checklist the runner recorded on a ticket (a
 * `test_output` evidence row whose summary starts `DoD: `), ignoring rows an agent
 * recorded (an agent cannot mask the runner's FLAG with a cleaner checklist).
 * Null when there is none. Pure read.
 */
export function latestDodSummary(host: TicketGitHost, ticketId: string): string | null {
  const row = host.db
    .prepare(
      `SELECT summary FROM evidence
        WHERE ticket_id = ? AND evidence_type = 'test_output' AND summary LIKE 'DoD: %'
          AND (recorded_by_actor_type IS NULL OR recorded_by_actor_type <> 'agent')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ticketId) as { summary: string } | undefined;
  return row?.summary ?? null;
}

/**
 * OBSERVED RISK of a delivery as the auto-ship gate reads it (enforceObservedRiskCeiling):
 * the real diff's risk annotations, plus — unless a human allowed test changes on the
 * ticket — the runner's integrity FLAG from the latest trusted DoD record. Its `holds`
 * are the GATE INTEGRITY hard holds: an agent or auto approval is refused while any is
 * present; a human approval is not. `repos` reuses a diff already read.
 */
export function observedRiskFor(
  host: TicketGitHost,
  ticket: Ticket,
  repos?: readonly RepoDiff[],
): ObservedRisk {
  const observed = observedRisk(repos ?? host.ticketDiff(ticket.id).repos);
  if (ticket.allow_test_changes === 1) return observed;
  return withRunnerIntegrityHolds(observed, runnerIntegrityHolds(host.latestDodSummary(ticket.id)));
}

/**
 * Diff-in-review: the real `git diff <default-branch>...<delivery-branch>` for
 * each WRITE repo on the ticket, so a reviewer reads the change inline before
 * approving (and re-reads the resolved diff after a reopen-for-review). Pure
 * read; every failure mode (no branch, repo not on disk, empty, git error) is
 * reported per-repo rather than thrown. See {@link computeTicketDiff}.
 */
export function ticketDiff(
  host: TicketGitHost,
  internals: TicketGitInternals,
  ref: string,
  opts: TicketDiffOptions = {},
): TicketDiff {
  const ticket = host.resolveTicket(ref);
  const diff = computeTicketDiff(
    {
      repos: host.repos,
      tickets: host.tickets,
      repoDeliveries: host.repoDeliveries,
      ...(internals.gitRunner ? { runGit: internals.gitRunner } : {}),
      downstreamRepos: (repoId) => host.downstreamRepos(repoId),
      codeIndex: internals.codeIndex,
    },
    ticket.id,
    opts,
  );
  if (opts.impact) noteCallersRow(host, internals, ticket.id, diff);
  return diff;
}

/**
 * The callers row a review saw: `listed` when any repo listed callers, else
 * `none_changed` when every analysed repo had none to list, else `not_analysed`.
 */
export function noteCallersRow(
  host: Pick<TicketGitHost, "events" | "resolveTicket">,
  internals: Pick<TicketGitInternals, "lastCallersRow">,
  ticketId: string,
  diff: TicketDiff,
): void {
  const rows = diff.repos.map((r) => r.impact?.callers?.status).filter((s) => s !== undefined);
  if (rows.length === 0) return;
  const status = rows.includes("listed")
    ? "listed"
    : rows.every((s) => s === "none_changed")
      ? "none_changed"
      : "not_analysed";
  if (internals.lastCallersRow.size > 500) internals.lastCallersRow.clear();
  // Keyed to the review round it was computed in: a later round (a new head after a
  // send-back) must not record the previous round's row.
  const t = host.resolveTicket(ticketId);
  const round =
    t.status === "in_review"
      ? (host.events.enteredStatusAt(ticketId, "in_review")?.at ?? null)
      : null;
  internals.lastCallersRow.set(ticketId, { status, round });
}

/**
 * CHANGE IMPACT: the repos whose scope `depends_on` a scope this repo owns or is part of
 * (scope_edges + scope_repos). A repo that merely uses or reads a scope is not that
 * scope, so only owning/containing/shared/deployed/write-target links count. Pure read.
 */
export function downstreamRepos(
  host: TicketGitHost,
  repoId: string,
): Array<{ repo: string; via: string }> {
  const IS_SCOPE = "('owns','contains','shared_by','deployed_with','write_target')";
  const rows = host.db
    .prepare(
      `SELECT DISTINCT r.name AS repo, dep.name AS dep_name, mine.name AS mine_name
         FROM scope_repos sr
         JOIN scope_nodes mine ON mine.id = sr.scope_node_id
         JOIN scope_edges e ON e.to_node_id = sr.scope_node_id AND e.relation = 'depends_on'
         JOIN scope_nodes dep ON dep.id = e.from_node_id
         JOIN scope_repos sd ON sd.scope_node_id = e.from_node_id AND sd.relation IN ${IS_SCOPE}
         JOIN repositories r ON r.id = sd.repo_id
        WHERE sr.repo_id = ? AND sr.relation IN ${IS_SCOPE} AND sd.repo_id <> ?
        ORDER BY r.name LIMIT 20`,
    )
    .all(repoId, repoId) as Array<{ repo: string; dep_name: string; mine_name: string }>;
  return rows.map((r) => ({ repo: r.repo, via: `${r.dep_name} depends_on ${r.mine_name}` }));
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve the delivery-vs-merge SHAs for a
 * ticket's WRITE repos so {@link ReviewGateService.approveReview} can emit an honest
 * `approved_unchanged` signal. The delivery SHA is the recorded per-repo
 * `commit_sha`; the merge SHA is the current head of the delivery branch
 * (`git rev-parse <branch>`). Returns a representative pair the pure
 * {@link approvalUnchanged} helper maps to unchanged/edited/unknown:
 *   - any write repo edited (both SHAs known and differing) → an unequal pair;
 *   - else every write repo known-and-unchanged → an equal pair;
 *   - any repo indeterminate (no delivery SHA / branch / on-disk repo / git error)
 *     → a null pair (unknown — never overstate agreement).
 * Pure read; a missing git runner or no write repos yields `null` (unknown).
 */
export function resolveApprovalShas(
  host: Pick<TicketGitHost, "repoDeliveries" | "repos">,
  internals: Pick<TicketGitInternals, "gitRunner">,
  ticket: Ticket,
): ApprovalShas | null {
  // Fall back to a real `git` spawn when no runner was injected — EVERY production
  // entrypoint (api/bin, cli, mcp/server) opens Dispatch without one, so gating this on
  // an injected runner made `approved_unchanged` ALWAYS null in prod (the merge half of
  // graduated autonomy could never fire). Mirrors computeTicketDiff's defaultGitRunner
  // fallback. Indeterminate repos still yield an unknown pair below (never overstate).
  const runGit = internals.gitRunner ?? defaultGitRunner;
  const links = host.repos.accessLinksForTicket(ticket.id);
  const writeRepos = links.filter(
    (l) => isActiveTicketRepoRelation(l.relation) && l.access === "write",
  );
  if (writeRepos.length === 0) return null;

  const pairs: ApprovalShas[] = writeRepos.map((repo) => {
    const delivery = host.repoDeliveries.find(ticket.id, repo.id);
    const deliverySha = delivery?.commit_sha ?? null;
    const branch =
      delivery?.branch_name ??
      host.repos.ticketRepoBranch(ticket.id, repo.id) ??
      ticket.branch_name;
    if (!deliverySha || !branch || !repo.local_path || !existsSync(repo.local_path)) {
      return { deliverySha, mergeSha: null };
    }
    const res = runGit(repo.local_path, ["rev-parse", branch]);
    const mergeSha = res.status === 0 ? res.stdout.trim() || null : null;
    return { deliverySha, mergeSha };
  });

  const known = (p: ApprovalShas): boolean => p.deliverySha !== null && p.mergeSha !== null;
  const edited = pairs.find((p) => known(p) && p.deliverySha !== p.mergeSha);
  if (edited) return edited; // a real edited pair → helper returns false.
  if (pairs.some((p) => !known(p))) return { deliverySha: null, mergeSha: null }; // unknown.
  return pairs[0] ?? null; // all known-and-equal → an unchanged pair.
}

/**
 * REVIEW PIN: the current delivery-branch head of EVERY active write repo on the ticket
 * (the same repos, branch resolution and `rev-parse` the review diff uses — see
 * diffService.resolveBranchHead — so the commit the Review view showed and the commit
 * compared here are resolved one way). A repo that is not on disk or whose branch does
 * not resolve yields no entry (nothing to compare, pin or land). Pure read.
 */
export function resolveApprovedHeads(
  host: Pick<TicketGitHost, "writeRepoHeads">,
  ticket: Ticket,
): ReviewedHead[] {
  return host.writeRepoHeads(ticket).heads;
}

/**
 * Every ACTIVE write repo's delivery head, and the write repos whose head cannot be read
 * now (no checkout on this machine, an unreadable path, no delivery branch, a branch git
 * cannot find). The approval pins the heads and is refused while any repo is unavailable
 * (an approval covers every write repo); the Review button's outcome reads the same list.
 */
export function writeRepoHeads(
  host: TicketGitHost,
  internals: TicketGitInternals,
  ticket: Ticket,
): { heads: ReviewedHead[]; unavailable: UnavailableWriteRepo[] } {
  const runGit = internals.gitRunner ?? defaultGitRunner;
  const heads: ReviewedHead[] = [];
  const unavailable: UnavailableWriteRepo[] = [];
  for (const repo of host.repos.accessLinksForTicket(ticket.id)) {
    if (!isActiveTicketRepoRelation(repo.relation) || repo.access !== "write") continue;
    const miss = (kind: NonNullable<UnavailableWriteRepo["kind"]>, why: string) =>
      unavailable.push({ repoId: repo.id, repo: repo.name, why, kind });
    if (!repo.local_path) {
      miss("no_checkout", "it has no checkout on this machine");
      continue;
    }
    if (!existsSync(repo.local_path)) {
      miss("unreadable_checkout", `its checkout ${repo.local_path} cannot be read`);
      continue;
    }
    const branch =
      host.repos.ticketRepoBranch(ticket.id, repo.id) ??
      host.repoDeliveries.find(ticket.id, repo.id)?.branch_name ??
      ticket.branch_name;
    if (!branch || branch.trim() === "") {
      miss("no_branch", "it has no delivery branch");
      continue;
    }
    const sha = resolveBranchHead(runGit, repo.local_path, branch);
    if (sha) heads.push({ repoId: repo.id, repo: repo.name, branch, sha });
    else miss("branch_missing", `its delivery branch ${branch} cannot be resolved`);
  }
  return { heads, unavailable };
}

/**
 * REVIEW COMMENTS: every ACTIVE write repo with a checkout and a delivery branch, with
 * its head now (null when the branch does not resolve). The comments anchor to these;
 * the since-your-review interdiff and the anchor states read them. Pure read.
 */
export function commentRepoContexts(
  host: TicketGitHost,
  internals: TicketGitInternals,
  ticket: Ticket,
): CommentRepoContext[] {
  const runGit = internals.gitRunner ?? defaultGitRunner;
  const out: CommentRepoContext[] = [];
  for (const repo of host.repos.accessLinksForTicket(ticket.id)) {
    if (!isActiveTicketRepoRelation(repo.relation) || repo.access !== "write") continue;
    if (!repo.local_path || !existsSync(repo.local_path)) continue;
    const branch =
      host.repos.ticketRepoBranch(ticket.id, repo.id) ??
      host.repoDeliveries.find(ticket.id, repo.id)?.branch_name ??
      ticket.branch_name;
    if (!branch || branch.trim() === "") continue;
    out.push({
      repoId: repo.id,
      repo: repo.name,
      localPath: repo.local_path,
      baseBranch: repo.default_branch || "main",
      branch,
      head: resolveBranchHead(runGit, repo.local_path, branch),
    });
  }
  return out;
}

/**
 * {@link writeRepoHeads} as one list in the ticket's write-repo order (primary first):
 * a resolved head carries its sha, an unreadable one says why. The review packet's
 * same-candidate check reads it.
 */
export function orderedWriteRepoHeads(
  host: Pick<TicketGitHost, "repos" | "writeRepoHeads">,
  ticket: Ticket,
): Array<{ repoId: string; repo: string; sha: string | null; why: string | null }> {
  const { heads, unavailable } = host.writeRepoHeads(ticket);
  const out: Array<{ repoId: string; repo: string; sha: string | null; why: string | null }> = [];
  for (const repo of host.repos.accessLinksForTicket(ticket.id)) {
    if (!isActiveTicketRepoRelation(repo.relation) || repo.access !== "write") continue;
    const h = heads.find((x) => x.repoId === repo.id);
    const u = unavailable.find((x) => x.repoId === repo.id);
    if (h) out.push({ repoId: h.repoId, repo: h.repo, sha: h.sha, why: null });
    else if (u) out.push({ repoId: u.repoId, repo: u.repo, sha: null, why: u.why });
  }
  return out;
}

/**
 * LIVE HEAD CHECK (A3): the delivery head of every write repo, and the ones that cannot
 * be read, from `resolveBranchHead` alone (no diff), so the Review view can poll it.
 */
export function ticketHeads(
  host: TicketGitHost,
  ref: string,
): {
  ticketId: string;
  heads: Array<{ repo: string; repo_id: string; sha: string }>;
  unavailable: Array<{ repo: string; repo_id: string; why: string }>;
} {
  const ticket = host.resolveTicket(ref);
  const { heads, unavailable } = host.writeRepoHeads(ticket);
  return {
    ticketId: ticket.id,
    heads: heads.map((h) => ({ repo: h.repo, repo_id: h.repoId, sha: h.sha })),
    unavailable: unavailable.map((u) => ({ repo: u.repo, repo_id: u.repoId, why: u.why })),
  };
}

/** SINCE YOUR REVIEW (A3): the interdiff from a person's latest reject pin per write repo. */
export function ticketDiffSince(
  host: TicketGitHost,
  internals: TicketGitInternals,
  ref: string,
): SinceDiff {
  const ticket = host.resolveTicket(ref);
  return computeSinceDiff(
    host.db,
    internals.gitRunner ?? defaultGitRunner,
    ticket.id,
    host.commentRepoContexts(ticket),
  );
}

/** True when `sha` is contained in the repo's default branch (a verified landing). */
export function commitOnDefaultBranch(
  host: Pick<TicketGitHost, "repos">,
  internals: Pick<TicketGitInternals, "gitRunner">,
  repoId: string,
  sha: string,
): boolean {
  const repo = host.repos.findById(repoId);
  if (!repo || !repo.local_path || !existsSync(repo.local_path)) return false;
  const runGit = internals.gitRunner ?? defaultGitRunner;
  const res = runGit(repo.local_path, [
    "merge-base",
    "--is-ancestor",
    sha,
    `refs/heads/${repo.default_branch || "main"}`,
  ]);
  return res.status === 0;
}

/**
 * PR LANDINGS (exploratory finding cli-wg/F-01): does any of `refs` carry the change of
 * `sha`? "default" is the local default branch, "remote-default" every remote-tracking
 * ref of it. A ref carries it when `sha` is its ancestor (a merge commit) or when merging
 * `sha` into it changes nothing (`git merge-tree --write-tree` gives the ref's own tree:
 * a squash or rebase merge of that change already applied). → null when none of the
 * refs exists here (or the checkout is missing), else true/false.
 */
export function changeOnRefs(
  host: Pick<TicketGitHost, "repos">,
  internals: Pick<TicketGitInternals, "gitRunner">,
  repoId: string,
  sha: string,
  refs: ReadonlyArray<"default" | "remote-default">,
): boolean | null {
  const repo = host.repos.findById(repoId);
  if (!repo || !repo.local_path || !existsSync(repo.local_path)) return null;
  const cwd = repo.local_path;
  const runGit = internals.gitRunner ?? defaultGitRunner;
  const def = repo.default_branch || "main";
  const names: string[] = [];
  for (const r of refs) {
    if (r === "default") names.push(`refs/heads/${def}`);
    else {
      const listed = runGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]);
      if (listed.status === 0)
        for (const line of listed.stdout.split("\n")) {
          // refs/remotes/<remote>/<branch>: the branch is everything after the remote,
          // slashes included (`release/v1`), and must BE the default branch exactly.
          const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(line.trim());
          if (m && m[1] === def) names.push(m[0]);
        }
    }
  }
  let anyRef = false;
  for (const ref of names) {
    const tip = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (tip.status !== 0 || tip.stdout.trim() === "") continue;
    anyRef = true;
    if (runGit(cwd, ["merge-base", "--is-ancestor", sha, ref]).status === 0) return true;
    const tree = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
    const merged = runGit(cwd, ["merge-tree", "--write-tree", ref, sha]);
    if (
      tree.status === 0 &&
      merged.status === 0 &&
      merged.stdout.split("\n")[0]?.trim() === tree.stdout.trim()
    )
      return true;
  }
  return anyRef ? false : null;
}

/**
 * The repo ids a ticket actually WRITES to (active relation + write access) — the
 * set the autonomy policy must cover for an auto grant. Mirrors the write-repo
 * filter used by {@link resolveApprovalShas}. A ticket with no write repo yields an
 * empty set, which the enforcement treats as "never auto" (fail-closed).
 */
export function writeRepoIdsForTicket(
  host: Pick<TicketGitHost, "repos">,
  ticket: Ticket,
): string[] {
  return host.repos
    .accessLinksForTicket(ticket.id)
    .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write")
    .map((l) => l.id);
}
