import type { Db } from "../db/connection.js";
import { TICKET_REPO_ACTIVE_RELATIONS } from "../domain/types.js";

/**
 * PER-REPOSITORY LANDING (external review #3). A ticket that writes to several
 * repositories is approved as one change but lands as several merges: one per write
 * repo. Every approval records a REVIEW PIN per repo (a SYSTEM `commit` evidence row,
 * uri `gaffer-reviewed-commit:<sha>`, `repo_id` set) and every landing path records a
 * LANDING per repo (uri `gaffer-landed-commit:<sha>`, same repo). This module reads the
 * two and answers "which approved revisions have landed?" — the done gate (markMerged)
 * refuses while any is pending, the merge paths skip a repo that already landed (a retry
 * after a partial merge never re-merges it), and the human queue shows a partial landing
 * as its own held state.
 *
 * Only SYSTEM rows count (agents record evidence as `agent` and cannot forge either kind),
 * and only pins recorded since the ticket last entered in_review (a rework or a conflict
 * resolution re-enters review, which makes older pins describe an older candidate) and
 * that no later move off the approval's path withdrew (a reject, a won't-do, a reopen). A
 * legacy pin with no repo (recorded before per-repo pins existed) imposes no per-repo
 * requirement here; the landing check still applies it.
 *
 * EVERY WRITE REPO (external review #7). A per-repo approval covers every write repo on
 * the ticket — approveReview refuses while any write repo's head cannot be read. A write
 * repo with NO current pin under a per-repo approval (an approval made before that rule,
 * or a write repo added after it) is listed here too, `pinned: false` and never landed: it
 * keeps the ticket out of done (markMerged's partial_landing names it) and the landing
 * paths hold on it instead of merging the other repos and calling the ticket done.
 */

/**
 * EVERY RECORDED PR LANDS UPSTREAM (external review #8). A write repo whose delivery record
 * carries a PR (`ticket_repo_delivery.pr_url`) is landed only by that PR merging upstream:
 * its landing counts when it was recorded via `pr` / `pr-stale` (the provider merged it),
 * or via `local-fallback` (the operator's explicit runner setting to
 * land it locally instead). A plain local merge into the checkout is not a landing for
 * such a repo: the ticket used to read done while that repo's upstream main still had the
 * original code.
 */
export const PR_LANDING_VIAS: ReadonlySet<string> = new Set(["pr", "pr-stale", "local-fallback"]);

export const REVIEW_PIN_PREFIX = "gaffer-reviewed-commit:";
export const LANDING_PREFIX = "gaffer-landed-commit:";

export interface LandingRepoState {
  repoId: string;
  repo: string;
  /** The approved commit (the current review pin) for this repo; "" when unpinned. */
  sha: string;
  /** False for a write repo the approval did not pin (it can never land as approved). */
  pinned: boolean;
  /**
   * True when a landing of exactly that commit is on record — for a repo with a recorded
   * PR, a landing through that PR (see PR_LANDING_VIAS).
   */
  landed: boolean;
  /** The PR the repo's delivery record carries, or null (lands locally). */
  prUrl: string | null;
  /** Where to land it: the repo's checkout, default branch and delivery branch. */
  localPath: string | null;
  defaultBranch: string;
  branch: string | null;
}

export interface LandingStatus {
  repos: LandingRepoState[];
  landed: number;
  pending: number;
  /** At least one repo landed and at least one did not: a held, visible state. */
  partial: boolean;
  /** Write repos with no current review pin under a per-repo approval (never landed). */
  unpinned: string[];
}

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** The statuses an approval moves through on its way to landing (and its holds). */
const APPROVAL_PATH = ["in_testing", "ready_for_merge", "blocked", "done"] as const;

function shaOf(uri: unknown, prefix: string): string | null {
  const s = String(uri ?? "");
  if (!s.startsWith(prefix)) return null;
  const sha = s.slice(prefix.length).toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

/**
 * PARTLY LANDED, whatever happened to the approval since (exploratory finding
 * cli-runner/F-02): every repository with a landing of this ticket on record (a SYSTEM
 * `gaffer-landed-commit:` row). A merge on a default branch stays there when the ticket is
 * sent back for rework, reopened for review or parked, so unlike the review pins above a
 * landing never goes stale: it is what keeps such a ticket from being cancelled or quietly
 * re-queued. Sorted repo names. Pure read.
 */
export function recordedLandingRepos(db: Db, ticketId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.name AS repo FROM evidence e JOIN repositories r ON r.id = e.repo_id
       WHERE e.ticket_id = ? AND e.evidence_type = 'commit' AND e.recorded_by_actor_type = 'system'
         AND e.repo_id IS NOT NULL AND e.uri LIKE '${LANDING_PREFIX}%'
       ORDER BY r.name`,
    )
    .all(ticketId) as Array<{ repo: string }>;
  return rows.map((r) => r.repo);
}

/** The current per-repo review pins and whether each has landed. Pure read. */
export function computeLandingStatus(db: Db, ticketId: string): LandingStatus {
  // A pin describes the approved candidate only until the ticket leaves the approval's
  // path (in_testing → ready_for_merge → done, or a hold in blocked). Re-entering review
  // makes it an older candidate (a pin is recorded AFTER that entry, so only earlier pins
  // are stale); a reject, a won't-do, a reopen or any other move off the path withdraws
  // the approval (exploratory finding cli-wg/F-10: `ticket landing` kept showing the
  // withdrawn pin as pending), so every pin recorded up to that move is stale.
  const entered = db
    .prepare(
      `SELECT created_at AS at, json_extract(payload_json, '$.to') AS to_status
       FROM work_events
       WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.transitioned'
         AND json_extract(payload_json, '$.to') NOT IN (${APPROVAL_PATH.map(() => "?").join(", ")})
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticketId, ...APPROVAL_PATH) as { at: string; to_status: string } | undefined;
  const stale = (pinAt: string): boolean =>
    entered !== undefined &&
    (entered.to_status === "in_review"
      ? String(entered.at) > String(pinAt)
      : String(entered.at) >= String(pinAt));
  const pins = db
    .prepare(
      `SELECT e.repo_id AS repo_id, r.name AS repo, e.uri AS uri, e.created_at AS created_at,
              r.local_path AS local_path, r.default_branch AS default_branch,
              COALESCE(NULLIF(tr.branch_name, ''), NULLIF(d.branch_name, ''), t.branch_name)
                AS branch,
              COALESCE(NULLIF(d.pr_url, ''), NULLIF(tr.pr_url, '')) AS pr_url
       FROM evidence e JOIN repositories r ON r.id = e.repo_id
       JOIN tickets t ON t.id = e.ticket_id
       LEFT JOIN ticket_repos tr ON tr.ticket_id = e.ticket_id AND tr.repo_id = e.repo_id
       LEFT JOIN ticket_repo_delivery d ON d.ticket_id = e.ticket_id AND d.repo_id = e.repo_id
       WHERE e.ticket_id = ? AND e.evidence_type = 'commit'
         AND e.recorded_by_actor_type = 'system' AND e.repo_id IS NOT NULL
         AND e.uri LIKE '${REVIEW_PIN_PREFIX}%'
       ORDER BY e.created_at DESC, e.rowid DESC`,
    )
    .all(ticketId) as Array<{
    repo_id: string;
    repo: string;
    uri: string;
    created_at: string;
    local_path: string | null;
    default_branch: string | null;
    branch: string | null;
    pr_url: string | null;
  }>;
  const landings = db
    .prepare(
      `SELECT repo_id, uri, json_extract(payload_json, '$.via') AS via FROM evidence
       WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system'
         AND repo_id IS NOT NULL AND uri LIKE '${LANDING_PREFIX}%'`,
    )
    .all(ticketId) as Array<{ repo_id: string; uri: string; via: string | null }>;
  // key → the vias it was recorded with (a PR repo needs a PR landing, see PR_LANDING_VIAS).
  const landedVias = new Map<string, string[]>();
  for (const l of landings) {
    const sha = shaOf(l.uri, LANDING_PREFIX);
    if (!sha) continue;
    const key = `${l.repo_id}\u0000${sha}`;
    landedVias.set(key, [...(landedVias.get(key) ?? []), String(l.via ?? "")]);
  }
  const isLanded = (repoId: string, sha: string, prUrl: string | null): boolean => {
    const vias = landedVias.get(`${repoId}\u0000${sha}`);
    if (!vias) return false;
    return prUrl ? vias.some((v) => PR_LANDING_VIAS.has(v)) : true;
  };
  const seen = new Set<string>();
  const repos: LandingRepoState[] = [];
  for (const p of pins) {
    if (seen.has(p.repo_id)) continue; // the latest pin per repo is the approved revision
    seen.add(p.repo_id);
    if (stale(String(p.created_at))) continue; // an older or withdrawn candidate
    const sha = shaOf(p.uri, REVIEW_PIN_PREFIX);
    if (!sha) continue;
    repos.push({
      repoId: p.repo_id,
      repo: p.repo,
      sha,
      pinned: true,
      landed: isLanded(p.repo_id, sha, p.pr_url ?? null),
      prUrl: p.pr_url ?? null,
      localPath: p.local_path ?? null,
      defaultBranch: p.default_branch || "main",
      branch: p.branch ?? null,
    });
  }
  // EVERY WRITE REPO: under a per-repo approval, a write repo without a current pin is
  // pending too (it was never approved, so it can never land as approved).
  const unpinned: string[] = [];
  if (repos.length > 0) {
    const writes = db
      .prepare(
        `SELECT r.id AS repo_id, r.name AS repo, r.local_path AS local_path,
                r.default_branch AS default_branch,
                COALESCE(NULLIF(tr.branch_name, ''), NULLIF(d.branch_name, ''), t.branch_name)
                  AS branch,
                COALESCE(NULLIF(d.pr_url, ''), NULLIF(tr.pr_url, '')) AS pr_url
         FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
         JOIN tickets t ON t.id = tr.ticket_id
         LEFT JOIN ticket_repo_delivery d ON d.ticket_id = tr.ticket_id AND d.repo_id = tr.repo_id
         WHERE tr.ticket_id = ? AND tr.access = 'write'
           AND tr.relation IN (${TICKET_REPO_ACTIVE_RELATIONS.map(() => "?").join(", ")})`,
      )
      .all(ticketId, ...TICKET_REPO_ACTIVE_RELATIONS) as Array<{
      repo_id: string;
      repo: string;
      local_path: string | null;
      default_branch: string | null;
      branch: string | null;
      pr_url: string | null;
    }>;
    for (const w of writes) {
      if (repos.some((r) => r.repoId === w.repo_id)) continue;
      unpinned.push(w.repo);
      repos.push({
        repoId: w.repo_id,
        repo: w.repo,
        sha: "",
        pinned: false,
        landed: false,
        prUrl: w.pr_url ?? null,
        localPath: w.local_path ?? null,
        defaultBranch: w.default_branch || "main",
        branch: w.branch ?? null,
      });
    }
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  const landed = repos.filter((r) => r.landed).length;
  const pending = repos.length - landed;
  return { repos, landed, pending, partial: landed > 0 && pending > 0, unpinned: unpinned.sort() };
}
