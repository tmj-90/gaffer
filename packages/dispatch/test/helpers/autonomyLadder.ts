import type { Dispatch } from "../../src/core.js";
import type { Actor, RiskLevel } from "../../src/domain/types.js";
import { writeEvent } from "../../src/events/eventWriter.js";

/**
 * THE AUTONOMY LADDER test helpers: tickets on a repo at a risk, and review decisions and
 * landings written the way the log records them (the same rows the recommendation engine
 * and the step-down triggers read), so a test can stage any track record quickly.
 */
export const humanActor: Actor = { type: "human", id: "tom" };
export const agentApprover: Actor = { type: "agent", id: "gaffer-factory" };
const system: Actor = { type: "system" };

export function repoNamed(wg: Dispatch, name: string): string {
  const known = wg.repos.findByName(name);
  if (known) return known.id;
  return wg.registerRepository(
    { name, default_branch: "main", local_path: process.cwd() },
    humanActor,
  ).id;
}

/** A ticket whose primary write repo is `repo`, at `risk`. */
export function ticketOn(
  wg: Dispatch,
  repo: string,
  risk: RiskLevel,
  title = "Change",
): { id: string; number: number } {
  repoNamed(wg, repo);
  const t = wg.createTicket({ title, risk_level: risk }, humanActor);
  wg.linkRepository(t.id, repo, "primary", humanActor);
  return { id: t.id, number: t.number ?? 0 };
}

/**
 * One review decision on a fresh ticket: an approval (`unchanged` true/false/null) or a
 * rejection, by `actor` (a person by default: only people's decisions are evidence).
 */
export function decision(
  wg: Dispatch,
  repo: string,
  risk: RiskLevel,
  outcome: "approve" | "reject",
  opts: { unchanged?: boolean | null; actor?: Actor } = {},
): string {
  const t = ticketOn(wg, repo, risk);
  const actor = opts.actor ?? humanActor;
  if (outcome === "approve") {
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor,
      event_type: "ticket.transitioned",
      payload: {
        from: "in_review",
        to: "ready_for_merge",
        reason: "review_approved",
        approved_unchanged: opts.unchanged === undefined ? true : opts.unchanged,
      },
    });
  } else {
    writeEvent(wg.db, {
      entity_type: "ticket",
      entity_id: t.id,
      actor,
      event_type: "ticket.transitioned",
      payload: { from: "in_review", to: "ready", reason: "changes requested" },
    });
  }
  return t.id;
}

/** `count` decisions of one kind. */
export function decisions(
  wg: Dispatch,
  repo: string,
  risk: RiskLevel,
  count: number,
  outcome: "approve" | "reject" = "approve",
  opts: { unchanged?: boolean | null; actor?: Actor } = {},
): void {
  for (let i = 0; i < count; i += 1) decision(wg, repo, risk, outcome, opts);
}

/**
 * A change that was approved by `approver` and then landed (done), the way the log has it:
 * the review approval, the move to done. An agent approver makes it an automatic change.
 */
export function landedChange(
  wg: Dispatch,
  repo: string,
  risk: RiskLevel,
  approver: Actor = agentApprover,
  title = "Shipped",
): { id: string; number: number } {
  const t = ticketOn(wg, repo, risk, title);
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: t.id,
    actor: approver,
    event_type: "ticket.transitioned",
    payload: { from: "in_review", to: "ready_for_merge", reason: "review_approved" },
  });
  wg.db.prepare(`UPDATE tickets SET status='done' WHERE id=?`).run(t.id);
  writeEvent(wg.db, {
    entity_type: "ticket",
    entity_id: t.id,
    actor: system,
    event_type: "ticket.transitioned",
    payload: { from: "ready_for_merge", to: "done", reason: "merge_completed" },
  });
  return t;
}
