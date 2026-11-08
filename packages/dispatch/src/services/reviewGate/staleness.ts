/**
 * Revision staleness and pins: the delivery heads an approval is checked against (the
 * commits the approver saw must still be the heads), the reviewed-commit and reject pins
 * recorded as system evidence, and the approved-unchanged signal (delivery SHA vs merge SHA).
 */
import { type Actor, type Ticket } from "../../domain/types.js";
import { DispatchError } from "../../util/errors.js";
import { newId } from "../../util/id.js";
import { REJECT_PIN_PREFIX, REVIEW_PIN_PREFIX } from "../landingStatus.js";
import type { ReviewGateInternals } from "./internals.js";
import type {
  ReviewedHead,
  ApproveReviewOptions,
  UnavailableWriteRepo,
  ShownCommit,
} from "../reviewGateService.js";

/** The facade's private state these functions read. */
export type StalenessInternals = Pick<
  ReviewGateInternals,
  "approvalShaResolver" | "clock" | "evidence" | "reviewedHeadsResolver"
>;

/**
 * Decide whether an approval was UNCHANGED (`true`), edited (`false`), or
 * indeterminate (`null`). When either SHA is missing we return `null` — the signal
 * is unknown, and the recommendation must NOT count an unknown as agreement (doing
 * so would overstate how often the operator approves an agent's work verbatim).
 */
export function approvalUnchanged(
  deliverySha: string | null | undefined,
  mergeSha: string | null | undefined,
): boolean | null {
  if (!deliverySha || !mergeSha) return null;
  return deliverySha === mergeSha;
}

/** Best-effort head lookup (a throw resolves no head: nothing to compare or pin). */
export function resolveReviewedHeads(
  internals: Pick<StalenessInternals, "reviewedHeadsResolver">,
  ticket: Ticket,
): readonly ReviewedHead[] {
  try {
    return internals.reviewedHeadsResolver?.(ticket) ?? [];
  } catch {
    return [];
  }
}

/**
 * STALE REVISION: compare the commits the approver saw with the current heads, and
 * return the pins to record. Refuses (STATE_CONFLICT, details.reason `stale_revision`)
 * when any write repo's head differs from what was shown, a repo was not shown at all,
 * or a shown repo no longer resolves; and (`revision_required`) when the entry point
 * requires named commits and none were given while a head exists.
 */
export function checkShownCommits(
  ticket: Ticket,
  heads: readonly ReviewedHead[],
  actor: Actor,
  opts: ApproveReviewOptions,
  unavailable: readonly UnavailableWriteRepo[] = [],
): readonly ReviewedHead[] {
  const commits = opts.commits;
  if (commits === undefined || commits.length === 0) {
    if (opts.requireCommits && heads.length > 0) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `Approve names the commit you reviewed. Current head${heads.length > 1 ? "s" : ""}: ` +
          heads.map((h) => `${h.repo}=${h.sha}`).join(", ") +
          ". Look at the diff, then approve with those commits (the dashboard sends them; " +
          "on the CLI pass --commit <repo>=<sha> for each repo).",
        {
          reason: "revision_required",
          ticket_number: ticket.number,
          current: heads.map((h) => ({ repo: h.repo, repo_id: h.repoId, sha: h.sha })),
        },
      );
    }
    // Legacy library path: a human approval pins what is there now; an agent's is
    // pinned by the runner.
    return actor.type === "human" || actor.type === "admin" ? heads : [];
  }
  const matches = (c: ShownCommit, h: ReviewedHead): boolean =>
    c.repo === null ? heads.length === 1 : c.repo === h.repoId || c.repo === h.repo;
  // DUPLICATE PINS (exploratory finding api/F12): one commit per repository. With two
  // entries for one repo the first decided the outcome, so [head, other] approved and
  // [other, head] read as a stale revision: the order of the list chose the answer.
  const named = (c: ShownCommit): string =>
    c.repo === null
      ? (heads[0]?.repoId ?? "(unnamed)")
      : (heads.find((h) => matches(c, h))?.repoId ?? c.repo);
  const seen = new Map<string, number>();
  for (const c of commits) seen.set(named(c), (seen.get(named(c)) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length > 0) {
    const label = (k: string): string => heads.find((h) => h.repoId === k)?.repo ?? k;
    throw new DispatchError(
      "VALIDATION_ERROR",
      `Each repository can be approved at one commit only; ${dupes.map(label).join(", ")} ` +
        "was named more than once. Nothing was approved.",
      { reason: "duplicate_repo", repos: dupes.map(label) },
    );
  }
  const moved: Array<{ repo: string; shown: string | null; current: string | null }> = [];
  for (const h of heads) {
    const shown = commits.find((c) => matches(c, h));
    const sha = shown ? shown.sha.trim().toLowerCase() : null;
    if (sha !== h.sha) moved.push({ repo: h.repo, shown: sha, current: h.sha });
  }
  // A shown repo that is UNAVAILABLE now is the coverage refusal's to name
  // (repo_unavailable), not a stale revision.
  const isUnavailable = (c: ShownCommit): boolean =>
    c.repo !== null && unavailable.some((u) => u.repoId === c.repo || u.repo === c.repo);
  for (const c of commits) {
    if (!heads.some((h) => matches(c, h)) && !isUnavailable(c))
      moved.push({
        repo: c.repo ?? "(unnamed)",
        shown: c.sha.trim().toLowerCase(),
        current: null,
      });
  }
  if (moved.length > 0) {
    const what = moved
      .map((m) =>
        m.current === null
          ? `${m.repo} no longer has a delivery head to approve`
          : m.shown === null
            ? `${m.repo} (${m.current.slice(0, 12)}) was not in what you approved`
            : `${m.repo} is now ${m.current.slice(0, 12)} (you reviewed ${m.shown.slice(0, 12)})`,
      )
      .join("; ");
    throw new DispatchError(
      "STATE_CONFLICT",
      moved.every((m) => m.shown === null)
        ? `The approval does not cover every repository this ticket changes: ${what}. Nothing was approved — review every repository's diff and approve them together.`
        : `The change moved since it was shown: ${what}. Nothing was approved — reload the diff and review it again.`,
      { reason: "stale_revision", ticket_number: ticket.number, repos: moved },
    );
  }
  return heads;
}

/**
 * Record the commit(s) an approval covers as REVIEW PINS — one SYSTEM `commit` evidence
 * row per write repo (agents record evidence as `agent` and cannot forge one) that the
 * landing check reads on every path (the merge lane, the dashboard Merge, `gaffer
 * merge`) and the done gate requires to have landed. Without them an approval bound
 * nothing: commits pushed to a branch between the approve and the merge landed
 * unreviewed, and a second repo's change could be left behind.
 */
export function recordApprovalPins(
  internals: Pick<StalenessInternals, "clock" | "evidence">,
  ticket: Ticket,
  actor: Actor,
  pins: readonly ReviewedHead[],
): void {
  const who = actor.type === "agent" ? "agent review" : "human review";
  for (const pin of pins) {
    internals.evidence.insert({
      id: newId(),
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: pin.repoId,
      decision_id: null,
      evidence_type: "commit",
      summary: `${who} (${actor.id ?? actor.type}) approved commit ${pin.sha} of ${pin.branch} in ${pin.repo}`,
      uri: `${REVIEW_PIN_PREFIX}${pin.sha}`,
      payload_json: JSON.stringify({
        kind: "review_pin",
        approver_type: actor.type,
        repo: pin.repo,
      }),
      created_by: "dispatch",
      recorded_by_actor_type: "system",
      created_at: internals.clock.now(),
    });
  }
}

/**
 * REJECT PINS (review comments A2/A3): one SYSTEM `commit` evidence row per write repo
 * naming the commit a rejection sent back (uri `gaffer-rejected-commit:<sha>`). The
 * "changes since your review" interdiff starts from it. A distinct prefix from the review
 * pin, so the landing check and the tester binding never read it as an approval.
 */
export function recordRejectPins(
  internals: Pick<StalenessInternals, "clock" | "evidence">,
  ticket: Ticket,
  actor: Actor,
  heads: readonly ReviewedHead[],
  attempt: number,
): void {
  const who =
    actor.type === "agent"
      ? "agent review"
      : actor.type === "system"
        ? "the runner"
        : "human review";
  for (const pin of heads) {
    internals.evidence.insert({
      id: newId(),
      ticket_id: ticket.id,
      ac_id: null,
      repo_id: pin.repoId,
      decision_id: null,
      evidence_type: "commit",
      summary: `${who} (${actor.id ?? actor.type}) sent back commit ${pin.sha} of ${pin.branch} in ${pin.repo}`,
      uri: `${REJECT_PIN_PREFIX}${pin.sha}`,
      payload_json: JSON.stringify({
        kind: "reject_pin",
        rejecter_type: actor.type,
        repo: pin.repo,
        attempt,
      }),
      created_by: "dispatch",
      recorded_by_actor_type: "system",
      created_at: internals.clock.now(),
    });
  }
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 1): resolve the delivery-vs-merge SHAs and
 * decide whether the approval is UNCHANGED (`true`), edited (`false`) or unknown
 * (`null`). Wrapped so a resolver failure degrades to `null` — an approval must
 * never fail because the (advisory) telemetry probe threw.
 */
export function computeApprovedUnchanged(
  internals: Pick<StalenessInternals, "approvalShaResolver">,
  ticket: Ticket,
): boolean | null {
  if (!internals.approvalShaResolver) return null;
  try {
    const shas = internals.approvalShaResolver(ticket);
    if (!shas) return null;
    return approvalUnchanged(shas.deliverySha, shas.mergeSha);
  } catch {
    return null;
  }
}
