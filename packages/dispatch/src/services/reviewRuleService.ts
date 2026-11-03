/**
 * REVIEW-RULE DRAFTS (D6): read a person's review feedback from the database, propose each
 * new candidate rule as a lore `convention` draft through the memory CLI, and record the
 * proposal so a rule is proposed once. The aggregation itself is health/reviewRules.ts.
 *
 *  - Feedback: a human or admin send-back reason (health/sendBacks.ts isReviewSendBack;
 *    the retry cap's `retry_cap_reached:` prefix dropped; "Fix these:" left out, its
 *    comments count), and a human or admin must-fix review comment that was not
 *    withdrawn. The repo is the comment's repo, else the ticket's first write repo.
 *  - `review_rule.proposed` {repo, key, count, tickets, lore_id, threshold} on the
 *    repository: the audit, and the record that this key was proposed in this repo. A key
 *    whose draft could not be filed (memory unavailable) is not recorded, so it is tried
 *    again next time.
 *  - The draft goes through the memory CLI `suggest` with MEMORY_AUTO_APPROVE removed from
 *    the child's environment, tagged `review-rule` (memory keeps that tag a draft whatever
 *    the environment): a person approves it with `gaffer lore approve` or the Memory view.
 *  - Who proposes: a person (human or admin) or the server on a person's behalf (system);
 *    never an agent. The safety hook denies `wg review-rules propose` to agent shells.
 */
import type { Db } from "../db/connection.js";
import type { Actor } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { reviewRounds } from "../health/reviewTime.js";
import {
  reviewRuleCandidates,
  reviewRuleMeasure,
  type FeedbackItem,
  type ReviewRuleCandidate,
  type ReviewRuleMeasure,
} from "../health/reviewRules.js";
import { isReviewSendBack } from "../health/sendBacks.js";
import { DispatchError } from "../util/errors.js";

export const REVIEW_RULE_PROPOSED_EVENT = "review_rule.proposed" as const;
export const REVIEW_RULE_TAG = "review-rule";

/** Refuse an agent: review rules come from a person's feedback, proposed by a person. */
export function assertMayProposeReviewRules(actor: Actor): void {
  if (actor.type === "agent")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a person (or the server on a person's behalf) proposes review rules; an agent proposes lore through the memory MCP.",
      { actor_type: actor.type },
    );
}

const ms = (iso: string): number => Date.parse(iso) || 0;

/** ticket id -> its first write repo { id, name } (confirmed or the single-repo default). */
function writeRepoByTicket(db: Db): Map<string, { id: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT tr.ticket_id AS ticketId, r.id AS repoId, r.name AS name
         FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
        WHERE tr.access = 'write' AND tr.relation IN ('confirmed','implicit_single_repo')
        ORDER BY tr.created_at, tr.rowid`,
    )
    .all() as Array<{ ticketId: string; repoId: string; name: string }>;
  const out = new Map<string, { id: string; name: string }>();
  for (const r of rows)
    if (!out.has(r.ticketId)) out.set(r.ticketId, { id: r.repoId, name: r.name });
  return out;
}

/** Every piece of a person's review feedback (see the module comment). */
export function readFeedbackItems(db: Db): FeedbackItem[] {
  const repoOf = writeRepoByTicket(db);
  const numbers = new Map(
    (
      db.prepare("SELECT id, number FROM tickets").all() as Array<{
        id: string;
        number: number | null;
      }>
    ).map((t) => [t.id, t.number]),
  );
  const items: FeedbackItem[] = [];
  const sendBacks = db
    .prepare(
      `SELECT entity_id AS ticketId, actor_type AS actorType, actor_id AS actorId,
              json_extract(payload_json, '$.from')   AS fromStatus,
              json_extract(payload_json, '$.to')     AS toStatus,
              json_extract(payload_json, '$.reason') AS reason,
              created_at AS at
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type = 'ticket.transitioned'
          AND actor_type IN ('human','admin')
        ORDER BY rowid`,
    )
    .all() as Array<{
    ticketId: string;
    actorType: string;
    actorId: string | null;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    at: string;
  }>;
  for (const t of sendBacks) {
    if (!isReviewSendBack({ ...t, at: t.at })) continue;
    const reason = (t.reason ?? "").replace(/^retry_cap_reached:/, "").trim();
    if (!reason || reason.startsWith("Fix these:")) continue;
    const repo = repoOf.get(t.ticketId);
    if (!repo) continue;
    items.push({
      ticketId: t.ticketId,
      ticketNumber: numbers.get(t.ticketId) ?? null,
      repo: repo.name,
      source: "send_back_reason",
      text: reason,
      actorType: t.actorType,
      actorId: t.actorId,
      atMs: ms(t.at),
    });
  }
  const comments = db
    .prepare(
      `SELECT c.ticket_id AS ticketId, c.body AS body, c.author_type AS actorType,
              c.author_id AS actorId, c.created_at AS at, r.name AS repo
         FROM review_comments c LEFT JOIN repositories r ON r.id = c.repo_id
        WHERE c.severity = 'must_fix' AND c.status != 'withdrawn'
          AND c.author_type IN ('human','admin')
        ORDER BY c.created_at, c.rowid`,
    )
    .all() as Array<{
    ticketId: string;
    body: string;
    actorType: string;
    actorId: string | null;
    at: string;
    repo: string | null;
  }>;
  for (const c of comments) {
    const repo = c.repo ?? repoOf.get(c.ticketId)?.name ?? null;
    if (!repo) continue;
    items.push({
      ticketId: c.ticketId,
      ticketNumber: numbers.get(c.ticketId) ?? null,
      repo,
      source: "must_fix_comment",
      text: c.body,
      actorType: c.actorType,
      actorId: c.actorId,
      atMs: ms(c.at),
    });
  }
  return items;
}

/** Every review round a person decided, by the decision's time and the ticket's repo. */
export function readPersonRounds(db: Db): Array<{ ticketId: string; repo: string; atMs: number }> {
  const repoOf = writeRepoByTicket(db);
  const transitions = (
    db
      .prepare(
        `SELECT entity_id AS ticketId, actor_type AS actorType,
                json_extract(payload_json, '$.from') AS fromStatus,
                json_extract(payload_json, '$.to')   AS toStatus,
                created_at AS at
           FROM work_events
          WHERE entity_type = 'ticket' AND event_type = 'ticket.transitioned'
          ORDER BY rowid`,
      )
      .all() as Array<{
      ticketId: string;
      actorType: string;
      fromStatus: string | null;
      toStatus: string | null;
      at: string;
    }>
  ).map((t) => ({ ...t, atMs: ms(t.at) }));
  return reviewRounds(transitions)
    .filter((r) => r.exitActor === "human" || r.exitActor === "admin")
    .flatMap((r) => {
      const repo = repoOf.get(r.ticketId);
      return repo ? [{ ticketId: r.ticketId, repo: repo.name, atMs: r.exitMs }] : [];
    });
}

/** A rule already proposed (one `review_rule.proposed` row). */
export interface ProposedRule {
  readonly repo: string;
  readonly key: string;
  readonly count: number;
  readonly tickets: readonly (number | null)[];
  readonly lore_id: string | null;
  readonly proposed_at: string;
  readonly proposed_by: string;
  readonly rule_text: string;
}

export function readProposedRules(db: Db): ProposedRule[] {
  const rows = db
    .prepare(
      `SELECT payload_json AS p, created_at AS at, actor_type AS actorType, actor_id AS actorId
         FROM work_events WHERE event_type = ? ORDER BY rowid`,
    )
    .all(REVIEW_RULE_PROPOSED_EVENT) as Array<{
    p: string | null;
    at: string;
    actorType: string;
    actorId: string | null;
  }>;
  const out: ProposedRule[] = [];
  for (const r of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.p ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof p.repo !== "string" || typeof p.key !== "string") continue;
    out.push({
      repo: p.repo,
      key: p.key,
      count: typeof p.count === "number" ? p.count : 0,
      tickets: Array.isArray(p.tickets) ? (p.tickets as Array<number | null>) : [],
      lore_id: typeof p.lore_id === "string" ? p.lore_id : null,
      proposed_at: r.at,
      proposed_by: r.actorId ?? r.actorType,
      rule_text: typeof p.rule_text === "string" ? p.rule_text : "",
    });
  }
  return out;
}

/** The lore draft a candidate becomes. */
export interface RuleDraft {
  readonly repo: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly kind: "convention";
  readonly tags: readonly string[];
}

const SOURCE_LABEL = { send_back_reason: "send-back reason", must_fix_comment: "must-fix comment" };

export function ruleDraft(c: ReviewRuleCandidate, threshold: number): RuleDraft {
  const lines = [
    `Proposed review rule for ${c.repo}, from a person's review feedback repeated on ${c.count} tickets (the threshold is ${threshold}).`,
    "",
    `Rule (the latest wording): ${c.rule_text}`,
    "",
    "Where it came from (newest first):",
    ...c.examples.map(
      (e) =>
        `- #${e.ticket ?? "?"} ${SOURCE_LABEL[e.source]} by ${e.by}, ${e.at.slice(0, 10)}: ${e.text}`,
    ),
    "",
    `Scope: repository ${c.repo}. Matched on the normalised text: "${c.key}".`,
    "Approve it to prime future deliveries in this repository; reject it if it is not a rule.",
  ];
  return {
    repo: c.repo,
    title: `Review rule (${c.repo}): ${c.rule_text}`.slice(0, 190),
    summary:
      `${c.rule_text} (asked for on ${c.count} tickets: ${c.tickets.map((n) => `#${n ?? "?"}`).join(", ")})`.slice(
        0,
        780,
      ),
    body: lines.join("\n").slice(0, 20_000),
    kind: "convention",
    tags: [REVIEW_RULE_TAG],
  };
}

export type RuleProposer = (
  draft: RuleDraft,
) => { ok: true; id: string | null } | { ok: false; reason: string };

export interface ProposeResult {
  readonly threshold: number;
  readonly proposed: ReadonlyArray<{
    repo: string;
    key: string;
    count: number;
    lore_id: string | null;
  }>;
  readonly already: number;
  readonly failed: ReadonlyArray<{ repo: string; key: string; reason: string }>;
}

/**
 * Propose every candidate not proposed yet (optionally in one repo). Each filed draft is
 * recorded as `review_rule.proposed` on the repository. Never throws on a memory failure:
 * the key is reported in `failed` and tried again next time.
 */
export function proposeReviewRules(
  db: Db,
  actor: Actor,
  opts: { threshold: number; proposer: RuleProposer; repo?: string | null },
): ProposeResult {
  assertMayProposeReviewRules(actor);
  const done = new Set(readProposedRules(db).map((r) => `${r.repo}\u0000${r.key}`));
  const candidates = reviewRuleCandidates(readFeedbackItems(db), opts.threshold).filter(
    (c) => !opts.repo || c.repo === opts.repo,
  );
  const repoIds = new Map(
    (
      db.prepare("SELECT id, name FROM repositories").all() as Array<{ id: string; name: string }>
    ).map((r) => [r.name, r.id]),
  );
  const proposed: Array<{ repo: string; key: string; count: number; lore_id: string | null }> = [];
  const failed: Array<{ repo: string; key: string; reason: string }> = [];
  let already = 0;
  for (const c of candidates) {
    if (done.has(`${c.repo}\u0000${c.key}`)) {
      already += 1;
      continue;
    }
    let res: ReturnType<RuleProposer>;
    try {
      res = opts.proposer(ruleDraft(c, opts.threshold));
    } catch (e) {
      res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok) {
      failed.push({ repo: c.repo, key: c.key, reason: res.reason });
      continue;
    }
    writeEvent(db, {
      entity_type: "repository",
      entity_id: repoIds.get(c.repo) ?? c.repo,
      actor,
      event_type: REVIEW_RULE_PROPOSED_EVENT,
      payload: {
        repo: c.repo,
        key: c.key,
        count: c.count,
        tickets: c.tickets,
        rule_text: c.rule_text,
        lore_id: res.id,
        threshold: opts.threshold,
      },
    });
    proposed.push({ repo: c.repo, key: c.key, count: c.count, lore_id: res.id });
  }
  return { threshold: opts.threshold, proposed, already, failed };
}

/** One proposed rule as the report shows it: its draft's status and its measure. */
export interface ProposedRuleView extends ProposedRule {
  /** The lore record's status (draft, active, rejected, ...), or null when unknown. */
  readonly lore_status: string | null;
  readonly approved_at: string | null;
  readonly measure: ReviewRuleMeasure;
}

export interface ReviewRulesReport {
  readonly threshold: number;
  /** Candidates not proposed yet (proposed after the next person's send-back or comment). */
  readonly candidates: readonly ReviewRuleCandidate[];
  readonly proposed: readonly ProposedRuleView[];
  readonly note: string;
}

export const REVIEW_RULES_NOTE =
  "Only a person's feedback seeds a rule: their send-back reasons and must-fix comments, never an agent's or the tester's. A rule is a lore draft until a person approves it, and it never auto-approves.";

/** At most this many proposed rules have their lore status read per report. */
const MAX_LOOKUPS = 20;

/** A proposed rule's lore status as memory reports it. */
export interface LoreStatus {
  readonly status: string;
  readonly approvedAt: string | null;
}

/** How long a lore status memory reported is reused (a person's approval shows within it). */
export const LORE_STATUS_TTL_MS = 60_000;
/** After memory could not answer, how long no report asks it again. */
export const LORE_STATUS_BACKOFF_MS = 60_000;

/**
 * BOUNDED MEMORY READS for the review-rules report (measure review O2). Each lore status
 * is a synchronous memory CLI call with a 10 s timeout, and a report read up to 20 of
 * them, so a slow or hung memory held the request (and the server's event loop) for up
 * to 200 s. This cache reuses an answer for {@link LORE_STATUS_TTL_MS}; once memory
 * cannot answer, the rest of that report asks nothing and later reports wait
 * {@link LORE_STATUS_BACKOFF_MS} before asking again. An unknown status reads null
 * ("not approved"), never a stale one.
 */
export function createLoreStatusCache(
  opts: { ttlMs?: number; backoffMs?: number; now?: () => number } = {},
): {
  lookup(base: (loreId: string) => LoreStatus | null): (loreId: string) => LoreStatus | null;
  forget(loreId: string): void;
} {
  const ttl = opts.ttlMs ?? LORE_STATUS_TTL_MS;
  const backoff = opts.backoffMs ?? LORE_STATUS_BACKOFF_MS;
  const now = opts.now ?? Date.now;
  const known = new Map<string, { at: number; value: LoreStatus }>();
  let quietUntil = 0;
  return {
    forget(loreId) {
      known.delete(loreId);
    },
    lookup(base) {
      let missed = false; // one report: after one miss, ask nothing more
      return (loreId) => {
        const t = now();
        const hit = known.get(loreId);
        if (hit && t - hit.at < ttl) return hit.value;
        if (missed || t < quietUntil) return null;
        let value: LoreStatus | null;
        try {
          value = base(loreId);
        } catch {
          value = null;
        }
        if (!value) {
          missed = true;
          quietUntil = t + backoff;
          return null;
        }
        known.set(loreId, { at: t, value });
        if (known.size > 500) known.delete(known.keys().next().value as string);
        return value;
      };
    },
  };
}

/** The report: candidates, proposed rules with their status and before/after measure. */
export function reviewRulesReport(
  db: Db,
  opts: {
    threshold: number;
    nowMs: number;
    /** The lore record's status and approval time, or null when memory cannot say. */
    lookup: (loreId: string) => { status: string; approvedAt: string | null } | null;
  },
): ReviewRulesReport {
  const items = readFeedbackItems(db);
  const proposedRows = readProposedRules(db);
  const done = new Set(proposedRows.map((r) => `${r.repo}\u0000${r.key}`));
  const rounds = readPersonRounds(db);
  const proposed = proposedRows.map((r, i): ProposedRuleView => {
    const found = r.lore_id && i < MAX_LOOKUPS ? opts.lookup(r.lore_id) : null;
    const approvedAt = found && found.status === "active" ? found.approvedAt : null;
    return {
      ...r,
      lore_status: found ? found.status : null,
      approved_at: approvedAt,
      measure: reviewRuleMeasure({
        repo: r.repo,
        key: r.key,
        approvedAtMs: approvedAt ? Date.parse(approvedAt) || null : null,
        items,
        rounds,
        nowMs: opts.nowMs,
      }),
    };
  });
  return {
    threshold: opts.threshold,
    candidates: reviewRuleCandidates(items, opts.threshold).filter(
      (c) => !done.has(`${c.repo}\u0000${c.key}`),
    ),
    proposed,
    note: REVIEW_RULES_NOTE,
  };
}
