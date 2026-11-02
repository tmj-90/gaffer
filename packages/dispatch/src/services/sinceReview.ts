import type { Db } from "../db/connection.js";
import {
  capUtf8,
  type GitRunner,
  MAX_DIFF_BYTES,
  parseNumstat,
  type RepoDiff,
} from "./diffService.js";
import { REJECT_PIN_PREFIX } from "./landingStatus.js";
import type { CommentRepoContext } from "./reviewCommentService.js";

/**
 * SINCE YOUR REVIEW (review comments A3): what changed on each write repo since the
 * commit a reviewer last sent back (the latest reject pin, `gaffer-rejected-commit:<sha>`).
 *
 * Deterministic and git-only:
 *  - the pin is an ancestor of the head → the interdiff `git diff <pin> <head>`;
 *  - the pin is no longer an ancestor (the branch was reset or rebuilt, e.g. a fresh
 *    branch on retry) or the commit is gone → the FACT `history_rewritten: true` and no
 *    diff: an interdiff across a rewrite would be a guess;
 *  - no pin (never sent back, or sent back before pins were recorded) → `available: false`.
 *
 * This is a reading aid. It never feeds a landing or an approval: an approval still binds
 * to the whole change's heads (GET /tickets/:id/diff without `since`).
 */

export interface SinceRepo {
  repo: string;
  repoId: string;
  /** The commit the reviewer sent back, or null when none is on record. */
  from_sha: string | null;
  /** The head now, or null when it does not resolve. */
  to_sha: string | null;
  /** False when there is nothing to compare (no reject pin, no head). */
  available: boolean;
  /** True when the sent-back commit is not an ancestor of the head (or is gone). */
  history_rewritten: boolean;
  /** Why it is unavailable: `no_reject_pin` | `no_head` | `git_error`. */
  reason?: string;
  /** The attempt the send-back started (the pin's round), when recorded. */
  attempt?: number | null;
  /** When the pin was recorded. */
  sent_back_at?: string | null;
}

export interface SinceDiff {
  ticketId: string;
  /** One interdiff per write repo with a comparable pin (RepoDiff shape, no risk scan). */
  repos: RepoDiff[];
  since: SinceRepo[];
}

/** The latest reject pin per repo for a ticket: repoId → {sha, at, attempt}. Pure read. */
export function latestRejectPins(
  db: Db,
  ticketId: string,
): Map<string, { sha: string; at: string; attempt: number | null }> {
  const rows = db
    .prepare(
      `SELECT repo_id, uri, created_at, payload_json FROM evidence
        WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system'
          AND repo_id IS NOT NULL AND uri LIKE '${REJECT_PIN_PREFIX}%'
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(ticketId) as Array<{
    repo_id: string;
    uri: string;
    created_at: string;
    payload_json: string | null;
  }>;
  const out = new Map<string, { sha: string; at: string; attempt: number | null }>();
  for (const r of rows) {
    const sha = r.uri.slice(REJECT_PIN_PREFIX.length).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) continue;
    let attempt: number | null;
    try {
      const p = JSON.parse(r.payload_json ?? "{}") as { attempt?: unknown };
      attempt = typeof p.attempt === "number" ? p.attempt : null;
    } catch {
      attempt = null;
    }
    out.set(r.repo_id, { sha, at: r.created_at, attempt });
  }
  return out;
}

const SAFE = ["--no-ext-diff", "--no-textconv"] as const;

/** Compute the since-your-review interdiff for every write repo context given. */
export function computeSinceDiff(
  db: Db,
  runGit: GitRunner,
  ticketId: string,
  contexts: readonly CommentRepoContext[],
): SinceDiff {
  const pins = latestRejectPins(db, ticketId);
  const repos: RepoDiff[] = [];
  const since: SinceRepo[] = [];
  for (const ctx of contexts) {
    const pin = pins.get(ctx.repoId);
    const base: SinceRepo = {
      repo: ctx.repo,
      repoId: ctx.repoId,
      from_sha: pin?.sha ?? null,
      to_sha: ctx.head,
      available: false,
      history_rewritten: false,
      attempt: pin?.attempt ?? null,
      sent_back_at: pin?.at ?? null,
    };
    if (!pin) {
      since.push({ ...base, reason: "no_reject_pin" });
      continue;
    }
    if (!ctx.head) {
      since.push({ ...base, reason: "no_head" });
      continue;
    }
    const exists = runGit(ctx.localPath, ["cat-file", "-e", `${pin.sha}^{commit}`]).status === 0;
    const anc = exists
      ? runGit(ctx.localPath, ["merge-base", "--is-ancestor", pin.sha, ctx.head]).status
      : 1;
    if (anc === 1) {
      since.push({ ...base, available: true, history_rewritten: true });
      continue;
    }
    if (anc !== 0) {
      since.push({ ...base, reason: "git_error" });
      continue;
    }
    const range = [pin.sha, ctx.head];
    const stat = runGit(ctx.localPath, ["diff", "--numstat", ...SAFE, ...range], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const patch = runGit(ctx.localPath, ["diff", ...SAFE, ...range]);
    if (stat.status !== 0 || patch.status !== 0) {
      since.push({ ...base, reason: "git_error" });
      continue;
    }
    const { files, additions, deletions } = parseNumstat(stat.stdout);
    const raw = patch.stdout;
    const truncated = patch.truncated === true || Buffer.byteLength(raw, "utf8") > MAX_DIFF_BYTES;
    since.push({ ...base, available: true });
    repos.push({
      repo: ctx.repo,
      branch: ctx.branch,
      baseBranch: ctx.baseBranch,
      diff: capUtf8(raw, MAX_DIFF_BYTES),
      files,
      additions,
      deletions,
      truncated,
      riskAnnotations: [],
      repoId: ctx.repoId,
      headSha: ctx.head,
      ...(raw.trim() === ""
        ? { unavailable: "empty" as const, message: "Nothing changed since you sent it back." }
        : {}),
    });
  }
  return { ticketId, repos, since };
}
