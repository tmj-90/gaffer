/**
 * REVIEW-RULE DRAFTS (delta roadmap gap 5; gap-specialists D6; strategy "Learn review
 * preferences"): repeated human review feedback becomes a proposed repository rule.
 *
 * Deterministic, no model call:
 *   feedback items  a person's (human or admin) send-back reason, and a person's must-fix
 *                   review comment that was not withdrawn. An agent's, the tester's and the
 *                   runner's send-backs never seed a rule (agent text is an injection
 *                   vector, and a rule should say what a person keeps asking for). A
 *                   "Fix these:" reason only lists comment ids, so it is left out (the
 *                   comments themselves count).
 *   key             the text normalised (lower case; links, paths, file names, ticket refs,
 *                   hex ids and numbers dropped; punctuation to spaces); fewer than three
 *                   words is not a rule.
 *   candidate       the same key on N or more distinct tickets in one repo (N =
 *                   GAFFER_REVIEW_RULE_REPEAT, default 3, 2..20), with the source items as
 *                   examples, newest first, and the latest wording as the rule text.
 *
 * A candidate is proposed as a lore `convention` DRAFT tagged review-rule (see
 * services/reviewRuleService.ts): a person approves it through the existing lore gate,
 * and it never auto-approves. Each proposed rule is then measured: rejections citing it
 * (the same key) per person-decided review round in the repo, over equal windows before
 * and after its approval; "not enough data" below five rounds after. Pure.
 */

export type FeedbackSource = "send_back_reason" | "must_fix_comment";

export interface FeedbackItem {
  readonly ticketId: string;
  readonly ticketNumber: number | null;
  readonly repo: string;
  readonly source: FeedbackSource;
  readonly text: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly atMs: number;
}

export interface RuleExample {
  readonly ticket: number | null;
  readonly source: FeedbackSource;
  readonly text: string;
  readonly by: string;
  readonly at: string;
}

export interface ReviewRuleCandidate {
  readonly repo: string;
  readonly key: string;
  /** Distinct tickets the feedback appeared on. */
  readonly count: number;
  readonly tickets: readonly (number | null)[];
  /** The latest wording, the rule's proposed text. */
  readonly rule_text: string;
  readonly examples: readonly RuleExample[];
  readonly first_seen: string;
  readonly last_seen: string;
}

export const REVIEW_RULE_REPEAT_ENV = "GAFFER_REVIEW_RULE_REPEAT";
export const DEFAULT_REVIEW_RULE_REPEAT = 3;
const MIN_REPEAT = 2;
const MAX_REPEAT = 20;
const MAX_EXAMPLES = 8;
const MAX_TEXT = 300;

/** The repeat threshold (GAFFER_REVIEW_RULE_REPEAT, default 3, clamped 2..20). */
export function reviewRuleThreshold(env: NodeJS.ProcessEnv | Record<string, string>): number {
  const raw = Number.parseInt(String(env[REVIEW_RULE_REPEAT_ENV] ?? ""), 10);
  if (!Number.isFinite(raw)) return DEFAULT_REVIEW_RULE_REPEAT;
  return Math.min(MAX_REPEAT, Math.max(MIN_REPEAT, raw));
}

/** The normalised key of a piece of feedback, or null when it is too short to be a rule. */
export function normaliseFeedback(text: string): string | null {
  const s = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    // Paths (anything with a slash or a backslash) and file names with an extension.
    .replace(/\S*[/\\]\S*/g, " ")
    .replace(/\b[\w-]+\.[a-z][a-z0-9]{0,4}\b(?::\d+)?/g, " ")
    // Ticket refs (#12, T-12) and uuids, then hex ids with a digit in them.
    .replace(/#\d+\b|\bt-\d+\b/g, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, " ")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^a-z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return s.split(" ").filter(Boolean).length >= 3 ? s : null;
}

const isPerson = (t: string): boolean => t === "human" || t === "admin";
const iso = (ms: number): string => new Date(ms).toISOString();
const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

/** Every candidate rule (see the module comment), most repeated first. */
export function reviewRuleCandidates(
  items: readonly FeedbackItem[],
  threshold: number,
): ReviewRuleCandidate[] {
  const groups = new Map<string, { repo: string; key: string; items: FeedbackItem[] }>();
  for (const it of items) {
    if (!isPerson(it.actorType) || !it.repo) continue;
    const key = normaliseFeedback(it.text);
    if (key === null) continue;
    const g = `${it.repo}\u0000${key}`;
    const group = groups.get(g) ?? { repo: it.repo, key, items: [] };
    group.items.push(it);
    groups.set(g, group);
  }
  const out: ReviewRuleCandidate[] = [];
  for (const g of groups.values()) {
    const tickets = new Map<string, number | null>();
    for (const it of g.items) tickets.set(it.ticketId, it.ticketNumber);
    if (tickets.size < threshold) continue;
    const newest = [...g.items].sort((a, b) => b.atMs - a.atMs);
    out.push({
      repo: g.repo,
      key: g.key,
      count: tickets.size,
      tickets: [...tickets.values()].sort((a, b) => (a ?? 0) - (b ?? 0)),
      rule_text: oneLine(newest[0]!.text),
      examples: newest.slice(0, MAX_EXAMPLES).map((it) => ({
        ticket: it.ticketNumber,
        source: it.source,
        text: oneLine(it.text),
        by: it.actorId ?? it.actorType,
        at: iso(it.atMs),
      })),
      first_seen: iso(newest[newest.length - 1]!.atMs),
      last_seen: iso(newest[0]!.atMs),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

/** Fewer person-decided review rounds than this after approval: not enough data. */
export const RULE_MEASURE_MIN_ROUNDS = 5;

export interface ReviewRuleMeasure {
  readonly state: "not_approved" | "not_enough_data" | "measured";
  readonly window_days: number | null;
  readonly citing_before: number;
  readonly rounds_before: number;
  readonly rate_before_pct: number | null;
  readonly citing_after: number;
  readonly rounds_after: number;
  readonly rate_after_pct: number | null;
  readonly note: string;
}

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

/**
 * Rejections citing a rule (feedback with its key, distinct tickets) per person-decided
 * review round in its repo, over the window since approval and the same length before.
 */
export function reviewRuleMeasure(input: {
  repo: string;
  key: string;
  approvedAtMs: number | null;
  items: readonly FeedbackItem[];
  /** Person-decided review rounds, by the decision's time and the ticket's repo. */
  rounds: readonly { ticketId: string; repo: string; atMs: number }[];
  nowMs: number;
}): ReviewRuleMeasure {
  if (input.approvedAtMs === null)
    return {
      state: "not_approved",
      window_days: null,
      citing_before: 0,
      rounds_before: 0,
      rate_before_pct: null,
      citing_after: 0,
      rounds_after: 0,
      rate_after_pct: null,
      note: "Not approved yet: a draft is measured once a person approves it.",
    };
  const a = input.approvedAtMs;
  const span = Math.max(0, input.nowMs - a);
  const from = a - span;
  const citing = (lo: number, hi: number, inclusiveHi: boolean): number =>
    new Set(
      input.items
        .filter(
          (it) =>
            it.repo === input.repo &&
            isPerson(it.actorType) &&
            it.atMs >= lo &&
            (inclusiveHi ? it.atMs <= hi : it.atMs < hi) &&
            normaliseFeedback(it.text) === input.key,
        )
        .map((it) => it.ticketId),
    ).size;
  const rounds = (lo: number, hi: number, inclusiveHi: boolean): number =>
    input.rounds.filter(
      (r) => r.repo === input.repo && r.atMs >= lo && (inclusiveHi ? r.atMs <= hi : r.atMs < hi),
    ).length;
  const cb = citing(from, a, false);
  const rb = rounds(from, a, false);
  const ca = citing(a, input.nowMs, true);
  const ra = rounds(a, input.nowMs, true);
  const enough = ra >= RULE_MEASURE_MIN_ROUNDS;
  return {
    state: enough ? "measured" : "not_enough_data",
    window_days: Math.round((span / 86_400_000) * 10) / 10,
    citing_before: cb,
    rounds_before: rb,
    rate_before_pct: pct(cb, rb),
    citing_after: ca,
    rounds_after: ra,
    rate_after_pct: enough ? pct(ca, ra) : null,
    note: enough
      ? "Rejections citing this rule per review round a person decided in the repo, over the time since approval and the same length before."
      : `Not enough data: ${ra} review round(s) a person decided in the repo since approval (${RULE_MEASURE_MIN_ROUNDS} needed).`,
  };
}
