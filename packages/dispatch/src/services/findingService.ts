/**
 * POST-MERGE FINDINGS (backlog 59): a person says what went wrong on a change that is done.
 *
 *  - `ticket.finding_added` {finding_id, text, category, paths, paths_source, criteria,
 *    repo, source, regression_ticket_id, regression_ticket_number}: on the done ticket
 *    (the change). The work_events actor columns say who wrote it. `source` is `person`
 *    (the ticket page, `wg ticket finding add`, REST) or `regression` (a regression link's
 *    note, filed on the later ticket, becomes a finding on the change it names).
 *  - `ticket.finding_withdrawn` {finding_id, reason}: a person takes a finding back. Soft:
 *    the finding stays in the log and in the list, marked withdrawn; nothing is deleted.
 *  - `ticket.finding_lesson_proposed` {finding_id, lore_id, repo, paths}: a person turned
 *    the finding into a lore draft (a lesson) for a person to approve in the Memory view.
 *  - `ticket.finding_fix_opened` {finding_id, fix_ticket_id, fix_ticket_number}: a person
 *    opened a fix ticket from it (linked as a regression of the change).
 *
 * Every write here is a PERSON'S act (human or admin): an agent, the runner and the
 * server are refused. Finding text is untrusted: it reaches an agent only inside the
 * quarantine envelope (the MCP get_ticket field, the lessons block of the live prompts).
 * The default paths are the ones the change touched, read from its recorded delivery.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { inTransaction, type Db } from "../db/connection.js";
import type { Actor, Ticket } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { newId } from "../util/id.js";
import { DispatchError } from "../util/errors.js";

export const FINDING_ADDED_EVENT = "ticket.finding_added" as const;
export const FINDING_WITHDRAWN_EVENT = "ticket.finding_withdrawn" as const;
export const FINDING_LESSON_EVENT = "ticket.finding_lesson_proposed" as const;
export const FINDING_FIX_EVENT = "ticket.finding_fix_opened" as const;

/** The lore tag a lesson carries (memory keeps it a draft until a person approves it). */
export const LESSON_TAG = "post-merge-finding";

import {
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABEL,
  type FindingCategory,
} from "../domain/findingCategories.js";

export { FINDING_CATEGORIES, FINDING_CATEGORY_LABEL, type FindingCategory };

export const FINDING_TEXT_MAX = 2_000;
export const FINDING_REASON_MAX = 500;
export const FINDING_PATHS_MAX = 50;
const PATH_MAX = 500;

/** Only a person (a human or admin principal) writes, withdraws or acts on a finding. */
export function assertMayWriteFinding(actor: Actor): void {
  if (actor.type !== "human" && actor.type !== "admin")
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      "Only a person (a human or admin principal) records what went wrong on a done ticket, withdraws it, or acts on it; an agent may read findings.",
      { actor_type: actor.type },
    );
}

/** A finding's text: trimmed, 1 to 2000 characters (newlines kept). */
export function findingText(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
  if (!s)
    throw new DispatchError("VALIDATION_ERROR", "Say what went wrong (the finding's text).", {
      field: "text",
    });
  if (s.length > FINDING_TEXT_MAX)
    throw new DispatchError(
      "VALIDATION_ERROR",
      `A finding is at most ${FINDING_TEXT_MAX} characters.`,
      { field: "text", length: s.length },
    );
  return s;
}

/** A category or null; anything outside the closed list is refused. */
export function findingCategory(v: unknown): FindingCategory | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((FINDING_CATEGORIES as readonly string[]).includes(s)) return s as FindingCategory;
  throw new DispatchError(
    "VALIDATION_ERROR",
    `A finding's category is one of ${FINDING_CATEGORIES.join(", ")}.`,
    { field: "category", value: String(v) },
  );
}

/**
 * One repo-relative path or glob, normalised (`./` and leading `/` dropped, `\` to `/`,
 * repeated slashes collapsed, a trailing slash kept as a directory). Null for an empty
 * one; a `..` segment, a control character or an over-long path is refused.
 */
export function normaliseFindingPath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/^\/+/, "");
  if (!s || s === ".") return null;
  // eslint-disable-next-line no-control-regex -- control bytes never belong in a path
  if (/[\x00-\x1f]/.test(s) || s.length > PATH_MAX || s.split("/").includes(".."))
    throw new DispatchError(
      "VALIDATION_ERROR",
      "A path is repo-relative, at most 500 characters, with no `..` and no control characters.",
      { field: "paths", value: s.slice(0, 80) },
    );
  return s;
}

/** Normalised, de-duplicated paths (at most 50). */
export function findingPaths(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const p of list) {
    const n = normaliseFindingPath(p);
    if (n && !out.includes(n)) out.push(n);
  }
  if (out.length > FINDING_PATHS_MAX)
    throw new DispatchError(
      "VALIDATION_ERROR",
      `A finding names at most ${FINDING_PATHS_MAX} paths.`,
      { field: "paths", count: out.length },
    );
  return out;
}

/** The file paths a `git diff --stat` summary names (a truncated `.../x` is left out). */
export function pathsFromDiffStat(stat: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of String(stat ?? "").split("\n")) {
    const m = /^\s*(.+?)\s+\|\s+(?:\d+|Bin\b)/.exec(line);
    if (!m) continue;
    let p = m[1]!.trim();
    // A rename `old => new` or `dir/{a => b}/f`: the new name.
    p = p.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/^.*=>\s*/, "");
    p = p.replace(/\/{2,}/g, "/");
    if (!p || p.startsWith("...")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** What these functions read from the Dispatch facade. */
export interface FindingHost {
  readonly db: Db;
  resolveTicket(ref: string): Ticket;
}

/** The ticket's first write repo { id, name, local_path } (confirmed or single-repo). */
export function writeRepoOf(
  db: Db,
  ticketId: string,
): { id: string; name: string; local_path: string | null } | null {
  const row = db
    .prepare(
      `SELECT r.id AS id, r.name AS name, r.local_path AS local_path
         FROM ticket_repos tr JOIN repositories r ON r.id = tr.repo_id
        WHERE tr.ticket_id = ? AND tr.access = 'write'
          AND tr.relation IN ('confirmed','implicit_single_repo')
        ORDER BY tr.created_at, tr.rowid LIMIT 1`,
    )
    .get(ticketId) as { id: string; name: string; local_path: string | null } | undefined;
  return row ?? null;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * The paths the change touched, from its recorded delivery: `git diff --name-only` between
 * the base and the commit the runner recorded for the ticket's write repo (when the repo
 * is on this machine), else the paths the recorded diff summary names. Empty when there
 * is no recorded delivery. Fail-soft: a git error reads as no paths from git.
 */
export function deliveredPaths(db: Db, ticketId: string): string[] {
  const repo = writeRepoOf(db, ticketId);
  if (repo) {
    const d = db
      .prepare(
        `SELECT base_sha, commit_sha FROM ticket_repo_delivery WHERE ticket_id = ? AND repo_id = ?`,
      )
      .get(ticketId, repo.id) as { base_sha: string | null; commit_sha: string | null } | undefined;
    if (
      d &&
      d.base_sha &&
      d.commit_sha &&
      SHA_RE.test(d.base_sha) &&
      SHA_RE.test(d.commit_sha) &&
      repo.local_path &&
      existsSync(repo.local_path)
    ) {
      try {
        const out = execFileSync(
          "git",
          ["-C", repo.local_path, "diff", "--name-only", "--no-renames", d.base_sha, d.commit_sha],
          { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
        );
        const paths = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (paths.length) return paths.slice(0, FINDING_PATHS_MAX);
      } catch {
        // fall through to the recorded summary
      }
    }
  }
  return recordedDiffPaths(db, ticketId).slice(0, FINDING_PATHS_MAX);
}

/** The paths the latest recorded diff summary (`ticket.delivery_recorded`) names. */
export function recordedDiffPaths(db: Db, ticketId: string): string[] {
  const row = db
    .prepare(
      `SELECT json_extract(payload_json, '$.diff_summary') AS stat FROM work_events
        WHERE entity_type = 'ticket' AND entity_id = ? AND event_type = 'ticket.delivery_recorded'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(ticketId) as { stat: string | null } | undefined;
  return pathsFromDiffStat(row?.stat ?? null);
}

/** One finding as every surface shows it (the event log folded). */
export interface FindingView {
  readonly id: string;
  readonly ticket_id: string;
  readonly number: number | null;
  readonly text: string;
  readonly category: FindingCategory | null;
  readonly paths: readonly string[];
  /** `given` (the person named them), `delivery` (the change's recorded delivery) or `none`. */
  readonly paths_source: "given" | "delivery" | "none";
  readonly criteria: ReadonlyArray<{ id: string; text: string }>;
  readonly repo: string | null;
  readonly source: "person" | "regression";
  readonly regression_ticket: { ticket_id: string; number: number | null } | null;
  readonly filed_by: { type: string; id: string | null };
  readonly filed_at: string;
  readonly withdrawn: {
    by: { type: string; id: string | null };
    at: string;
    reason: string;
  } | null;
  readonly lesson: { lore_id: string | null; proposed_at: string; proposed_by: string } | null;
  readonly fix_ticket: { ticket_id: string; number: number | null } | null;
}

interface EventRow {
  entity_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: string | null;
  created_at: string;
}

const parse = (s: string | null): Record<string, unknown> => {
  try {
    const v = JSON.parse(s ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Fold finding events (insertion order) into findings. Pure. */
export function foldFindings(
  rows: readonly EventRow[],
  numberOf: (ticketId: string) => number | null,
): FindingView[] {
  const byId = new Map<string, FindingView>();
  const order: string[] = [];
  for (const r of rows) {
    const p = parse(r.payload_json);
    const fid = str(p.finding_id);
    if (!fid) continue;
    if (r.event_type === FINDING_ADDED_EVENT) {
      if (byId.has(fid)) continue;
      const regId = str(p.regression_ticket_id);
      const category = (FINDING_CATEGORIES as readonly string[]).includes(String(p.category))
        ? (p.category as FindingCategory)
        : null;
      const ps = str(p.paths_source);
      byId.set(fid, {
        id: fid,
        ticket_id: r.entity_id,
        number: numberOf(r.entity_id),
        text: str(p.text) ?? "",
        category,
        paths: strs(p.paths),
        paths_source: ps === "given" || ps === "delivery" ? ps : "none",
        criteria: Array.isArray(p.criteria)
          ? (p.criteria as Array<Record<string, unknown>>).flatMap((c) =>
              c && typeof c.id === "string"
                ? [{ id: c.id, text: typeof c.text === "string" ? c.text : "" }]
                : [],
            )
          : [],
        repo: str(p.repo),
        source: p.source === "regression" ? "regression" : "person",
        regression_ticket: regId
          ? {
              ticket_id: regId,
              number:
                typeof p.regression_ticket_number === "number"
                  ? p.regression_ticket_number
                  : numberOf(regId),
            }
          : null,
        filed_by: { type: r.actor_type, id: r.actor_id },
        filed_at: r.created_at,
        withdrawn: null,
        lesson: null,
        fix_ticket: null,
      });
      order.push(fid);
      continue;
    }
    const f = byId.get(fid);
    if (!f) continue;
    if (r.event_type === FINDING_WITHDRAWN_EVENT && !f.withdrawn) {
      byId.set(fid, {
        ...f,
        withdrawn: {
          by: { type: r.actor_type, id: r.actor_id },
          at: r.created_at,
          reason: str(p.reason) ?? "",
        },
      });
    } else if (r.event_type === FINDING_LESSON_EVENT) {
      byId.set(fid, {
        ...f,
        lesson: {
          lore_id: str(p.lore_id),
          proposed_at: r.created_at,
          proposed_by: r.actor_id ?? r.actor_type,
        },
      });
    } else if (r.event_type === FINDING_FIX_EVENT && !f.fix_ticket) {
      const id = str(p.fix_ticket_id);
      if (id)
        byId.set(fid, {
          ...f,
          fix_ticket: {
            ticket_id: id,
            number: typeof p.fix_ticket_number === "number" ? p.fix_ticket_number : numberOf(id),
          },
        });
    }
  }
  return order.map((id) => byId.get(id)!);
}

const FINDING_EVENTS = [
  FINDING_ADDED_EVENT,
  FINDING_WITHDRAWN_EVENT,
  FINDING_LESSON_EVENT,
  FINDING_FIX_EVENT,
];

/** Every finding (optionally on one ticket), oldest first. */
export function readFindings(db: Db, ticketId?: string): FindingView[] {
  const rows = db
    .prepare(
      `SELECT entity_id, event_type, actor_type, actor_id, payload_json, created_at
         FROM work_events
        WHERE entity_type = 'ticket' AND event_type IN (?, ?, ?, ?)
          ${ticketId ? "AND entity_id = ?" : ""}
        ORDER BY rowid`,
    )
    .all(...FINDING_EVENTS, ...(ticketId ? [ticketId] : [])) as EventRow[];
  const numbers = new Map<string, number | null>();
  const numberOf = (id: string): number | null => {
    if (!numbers.has(id)) {
      const r = db.prepare("SELECT number FROM tickets WHERE id = ?").get(id) as
        { number: number | null } | undefined;
      numbers.set(id, r?.number ?? null);
    }
    return numbers.get(id)!;
  };
  return foldFindings(rows, numberOf);
}

export interface AddFindingInput {
  readonly text: unknown;
  readonly category?: unknown;
  readonly paths?: unknown;
  readonly criteria?: unknown;
}

/**
 * Record what went wrong on a DONE ticket. Paths default to the change's recorded
 * delivery; criteria are the ticket's own acceptance criteria (ids). A person's act.
 * `fromRegression` is set only by the regression link (its note becomes the finding).
 */
export function addFinding(
  host: FindingHost,
  ref: string,
  input: AddFindingInput,
  actor: Actor,
  fromRegression?: { ticketId: string; number: number | null },
): { finding: FindingView; eventId: string } {
  assertMayWriteFinding(actor);
  const ticket = host.resolveTicket(ref);
  if (ticket.status !== "done")
    throw new DispatchError(
      "STATE_CONFLICT",
      `#${ticket.number ?? "?"} is ${ticket.status}: a finding is about a change that reached done (review feedback covers work still in flight).`,
      { ticket_id: ticket.id, status: ticket.status },
    );
  const text = findingText(input.text);
  const category = findingCategory(input.category);
  const given = findingPaths(input.paths);
  const criteriaIds = Array.isArray(input.criteria)
    ? [...new Set(input.criteria.map((c) => String(c).trim()).filter(Boolean))]
    : [];
  const acs = host.db
    .prepare("SELECT id, text FROM acceptance_criteria WHERE ticket_id = ?")
    .all(ticket.id) as Array<{ id: string; text: string }>;
  const criteria = criteriaIds.map((id) => {
    const ac = acs.find((a) => a.id === id || a.id.startsWith(id));
    if (!ac)
      throw new DispatchError(
        "VALIDATION_ERROR",
        `#${ticket.number ?? "?"} has no acceptance criterion ${id}.`,
        { field: "criteria", value: id },
      );
    return { id: ac.id, text: ac.text.slice(0, 300) };
  });
  const delivered = given.length ? [] : deliveredPaths(host.db, ticket.id);
  const paths = given.length ? given : delivered;
  const repo = writeRepoOf(host.db, ticket.id);
  const findingId = newId();
  return inTransaction(host.db, () => {
    const eventId = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: ticket.id,
      actor,
      event_type: FINDING_ADDED_EVENT,
      payload: {
        finding_id: findingId,
        text,
        category,
        paths,
        paths_source: given.length ? "given" : delivered.length ? "delivery" : "none",
        criteria,
        repo: repo?.name ?? null,
        source: fromRegression ? "regression" : "person",
        regression_ticket_id: fromRegression?.ticketId ?? null,
        regression_ticket_number: fromRegression?.number ?? null,
      },
    });
    const finding = readFindings(host.db, ticket.id).find((f) => f.id === findingId)!;
    return { finding, eventId };
  });
}

/** The finding `fid` (its full id or a unique prefix of 6+) on ticket `ref`. */
export function findFinding(host: FindingHost, ref: string, fid: string): FindingView {
  const ticket = host.resolveTicket(ref);
  const id = String(fid ?? "").trim();
  const all = readFindings(host.db, ticket.id);
  const exact = all.find((f) => f.id === id);
  const matches = exact ? [exact] : id.length >= 6 ? all.filter((f) => f.id.startsWith(id)) : [];
  if (matches.length !== 1)
    throw new DispatchError(
      "NOT_FOUND",
      matches.length > 1
        ? `More than one finding on #${ticket.number ?? "?"} starts with ${id}.`
        : `#${ticket.number ?? "?"} has no finding ${id}.`,
      { ticket_id: ticket.id, finding_id: id },
    );
  return matches[0]!;
}

/**
 * Retire the lesson a finding became (memory: `deprecate`), so it stops reaching later
 * agents. `absent`: memory no longer holds it. A failure says why (memory unreachable).
 */
export type LessonRetirer = (
  loreId: string,
) => { ok: true; outcome: "deprecated" | "absent" } | { ok: false; reason: string };

/**
 * Take a finding back (soft, with a reason). Already withdrawn: STATE_CONFLICT.
 *
 * A finding that was proposed as a lesson takes its lesson with it (backlog 59 review: a
 * withdrawn finding's approved lesson kept reaching every later delivery, reviewer and
 * tester on its paths). The lesson is retired in memory FIRST, through `retire`; when
 * memory cannot do it (or no retirer is given) nothing is recorded (NOT_CONFIGURED) so
 * the person can try again: the finding is never shown as withdrawn while its lesson is
 * still served. The event records what happened to the lesson.
 */
export function withdrawFinding(
  host: FindingHost,
  ref: string,
  fid: string,
  reason: unknown,
  actor: Actor,
  retire?: LessonRetirer,
): { finding: FindingView; eventId: string } {
  assertMayWriteFinding(actor);
  const why = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (!why)
    throw new DispatchError("VALIDATION_ERROR", "Say why the finding is withdrawn.", {
      field: "reason",
    });
  const f = findFinding(host, ref, fid);
  if (f.withdrawn)
    throw new DispatchError("STATE_CONFLICT", "That finding was already withdrawn.", {
      finding_id: f.id,
    });
  let lessonRetired: { lore_id: string; outcome: "deprecated" | "absent" } | null = null;
  const loreId = f.lesson?.lore_id ?? null;
  if (loreId) {
    let res: ReturnType<LessonRetirer>;
    if (!retire) res = { ok: false, reason: "memory is not reachable from here" };
    else {
      try {
        res = retire(loreId);
      } catch (e) {
        res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    }
    if (!res.ok)
      throw new DispatchError(
        "NOT_CONFIGURED",
        `The finding was not withdrawn: it was proposed as lesson ${loreId}, and withdrawing it retires that lesson so later agents stop seeing it, which memory could not do (${res.reason}). Try again when memory answers.`,
        { finding_id: f.id, lore_id: loreId },
      );
    lessonRetired = { lore_id: loreId, outcome: res.outcome };
  }
  return inTransaction(host.db, () => {
    const eventId = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: f.ticket_id,
      actor,
      event_type: FINDING_WITHDRAWN_EVENT,
      payload: {
        finding_id: f.id,
        reason: why.slice(0, FINDING_REASON_MAX),
        ...(lessonRetired ? { lesson_retired: lessonRetired } : {}),
      },
    });
    return { finding: findFinding(host, f.ticket_id, f.id), eventId };
  });
}

/** Refuse an action on a withdrawn finding. */
export function assertStanding(f: FindingView): void {
  if (f.withdrawn)
    throw new DispatchError("STATE_CONFLICT", "That finding was withdrawn.", {
      finding_id: f.id,
    });
}

/** The lore draft a finding becomes ("Propose as a lesson now"). */
export interface LessonDraft {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly repo: string;
  readonly paths: readonly string[];
  readonly tags: readonly string[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The draft for finding `f` on ticket `ticket` (pure). */
export function lessonDraft(
  f: FindingView,
  ticket: { number: number | null; title: string },
): LessonDraft {
  const ref = `#${ticket.number ?? "?"}`;
  const cat = f.category ? ` (${FINDING_CATEGORY_LABEL[f.category]})` : "";
  const text = oneLine(f.text);
  const by = f.filed_by.id ?? f.filed_by.type;
  return {
    title: `Lesson from ${ref}${cat}: ${text}`.slice(0, 190),
    summary: text.slice(0, 780),
    body: [
      `What went wrong after ${ref} "${oneLine(ticket.title)}" was done, in the words of ${by} (${f.filed_at.slice(0, 10)}):`,
      "",
      f.text,
      "",
      `Category: ${f.category ? FINDING_CATEGORY_LABEL[f.category] : "none given"}.`,
      ...(f.criteria.length
        ? [`Acceptance criteria it concerns: ${f.criteria.map((c) => oneLine(c.text)).join("; ")}.`]
        : []),
      `Scope: repository ${f.repo ?? "?"}, paths ${f.paths.join(", ")}.`,
      "Approve it to show it to later changes on these paths in this repository (the delivery, the reviewer and the tester see it as untrusted data); reject it if it is not a lesson.",
    ]
      .join("\n")
      .slice(0, 20_000),
    repo: f.repo ?? "",
    paths: f.paths,
    // from-ticket-<n> names the change it came from (memory reads it back for the
    // "Lessons from earlier changes here" block; lore's source column takes a URL only).
    tags: ticket.number !== null ? [LESSON_TAG, `from-ticket-${ticket.number}`] : [LESSON_TAG],
  };
}

export type LessonProposer = (
  draft: LessonDraft,
) => { ok: true; id: string | null } | { ok: false; reason: string };

/**
 * "Propose as a lesson now": file ONE standing finding as a lore draft scoped to its repo
 * and paths, waiting for a person's approval in the Memory view (never auto-approved, and
 * no agent can approve it). Recorded as `ticket.finding_lesson_proposed` once memory filed
 * it; a memory failure records nothing (NOT_CONFIGURED, 503) so a person can try again. A
 * finding becomes at most one lesson.
 */
export function proposeLesson(
  host: FindingHost,
  ref: string,
  fid: string,
  actor: Actor,
  proposer: LessonProposer,
): { finding: FindingView; loreId: string | null; eventId: string } {
  assertMayWriteFinding(actor);
  const f = findFinding(host, ref, fid);
  assertStanding(f);
  if (f.lesson)
    throw new DispatchError(
      "STATE_CONFLICT",
      `That finding was already proposed as a lesson${f.lesson.lore_id ? ` (lore ${f.lesson.lore_id})` : ""}.`,
      { finding_id: f.id, lore_id: f.lesson.lore_id },
    );
  if (!f.repo || f.paths.length === 0)
    throw new DispatchError(
      "VALIDATION_ERROR",
      "A lesson is served to later changes by repository and path, and this finding names no " +
        (f.repo ? "path" : "repository") +
        " (its change has no recorded delivery). Write a new finding that names the paths.",
      { finding_id: f.id },
    );
  const ticket = host.resolveTicket(f.ticket_id);
  let res: ReturnType<LessonProposer>;
  try {
    res = proposer(lessonDraft(f, ticket));
  } catch (e) {
    res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok)
    throw new DispatchError(
      "NOT_CONFIGURED",
      `The lesson was not filed (memory did not answer): ${res.reason}`,
      {
        finding_id: f.id,
      },
    );
  const loreId = res.id;
  return inTransaction(host.db, () => {
    const eventId = writeEvent(host.db, {
      entity_type: "ticket",
      entity_id: f.ticket_id,
      actor,
      event_type: FINDING_LESSON_EVENT,
      payload: { finding_id: f.id, lore_id: loreId, repo: f.repo, paths: f.paths },
    });
    return { finding: findFinding(host, f.ticket_id, f.id), loreId, eventId };
  });
}

// ── "Open a fix ticket" (backlog 59, part 4) ─────────────────────────────────

/** One row a fix ticket's regression link would step down, with the repo's name. */
export interface FixStepDownRow {
  readonly repo: string;
  readonly risk_level: string;
  readonly gate: string;
  readonly cascade: boolean;
}

/** What opening a fix ticket from a finding would do, asked before a person confirms. */
export interface FixTicketPreview {
  readonly finding_id: string;
  readonly regression_of: { ticket_id: string; number: number | null };
  /** True when the link takes automatic approval or merge back (an agent's change). */
  readonly steps_down: boolean;
  readonly step_downs: readonly FixStepDownRow[];
  /** One sentence for the confirm: what the link does to autonomy. */
  readonly message: string;
}

/** The step-down rows a regression link of a change would write (autonomyStepDownService). */
export type StepDownPreviewer = (
  ofTicketId: string,
) => ReadonlyArray<{ repoId: string; riskLevel: string; gate: string; cascade: boolean }>;

function repoName(db: Db, repoId: string): string {
  const r = db.prepare("SELECT name FROM repositories WHERE id = ?").get(repoId) as
    { name: string } | undefined;
  return r?.name ?? repoId;
}

/** The confirm's sentence for these rows (grouped by repo and risk, plain words). */
export function fixStepDownMessage(ref: string, rows: readonly FixStepDownRow[]): string {
  if (rows.length === 0)
    return `Linking it as a regression of ${ref} takes no automatic approval back: a person approved and landed ${ref}, or it is already taken back.`;
  const groups = new Map<string, { repo: string; risk: string; gates: string[] }>();
  for (const r of rows) {
    const k = `${r.repo}\u0000${r.risk_level}`;
    const g = groups.get(k) ?? { repo: r.repo, risk: r.risk_level, gates: [] };
    if (!g.gates.includes(r.gate)) g.gates.push(r.gate);
    groups.set(k, g);
  }
  const parts = [...groups.values()].map(
    (g) =>
      `${g.repo} at ${g.risk} risk (${g.gates.map((x) => (x === "approve" ? "approval" : "merge")).join(" and ")})`,
  );
  return `This also takes automatic approval back for ${parts.join("; ")}, because ${ref} was approved or landed automatically. A person can give it back on Settings, Autonomy.`;
}

/** The finding must be standing and have no fix ticket yet. */
function assertNoFixYet(f: FindingView): void {
  assertStanding(f);
  if (f.fix_ticket)
    throw new DispatchError(
      "STATE_CONFLICT",
      `A fix ticket was already opened from that finding (#${f.fix_ticket.number ?? "?"}).`,
      { finding_id: f.id, fix_ticket_id: f.fix_ticket.ticket_id },
    );
}

/**
 * What "Open a fix ticket" would do to autonomy, written nowhere. A person's read before a
 * person's act (the confirm), so it is refused for an agent like the act itself.
 */
export function fixTicketPreview(
  host: FindingHost,
  ref: string,
  fid: string,
  actor: Actor,
  preview: StepDownPreviewer,
): FixTicketPreview {
  assertMayWriteFinding(actor);
  const f = findFinding(host, ref, fid);
  assertNoFixYet(f);
  const original = host.resolveTicket(f.ticket_id);
  const rows: FixStepDownRow[] = preview(original.id).map((r) => ({
    repo: repoName(host.db, r.repoId),
    risk_level: r.riskLevel,
    gate: r.gate,
    cascade: r.cascade,
  }));
  return {
    finding_id: f.id,
    regression_of: { ticket_id: original.id, number: original.number ?? null },
    steps_down: rows.length > 0,
    step_downs: rows,
    message: fixStepDownMessage(`#${original.number ?? "?"}`, rows),
  };
}

/** The fix ticket's title and description, the finding quoted (pure). */
export function fixTicketDraft(
  f: FindingView,
  ticket: { number: number | null; title: string },
): { title: string; description: string } {
  const ref = `#${ticket.number ?? "?"}`;
  const quoted = f.text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const by = f.filed_by.id ?? f.filed_by.type;
  return {
    title: `Fix after ${ref}: ${oneLine(f.text)}`.slice(0, 200),
    description: [
      `Something was wrong with ${ref} "${oneLine(ticket.title)}" after it was done. ${by} wrote (${f.filed_at.slice(0, 10)}):`,
      "",
      quoted,
      "",
      `Category: ${f.category ? FINDING_CATEGORY_LABEL[f.category] : "none given"}.`,
      ...(f.paths.length ? [`Paths it concerns: ${f.paths.join(", ")}.`] : []),
      ...(f.criteria.length
        ? [
            `Acceptance criteria of ${ref} it concerns: ${f.criteria.map((c) => oneLine(c.text)).join("; ")}.`,
          ]
        : []),
      `This ticket is linked as a regression of ${ref}. The quoted text is a person's report of what went wrong: the acceptance criteria of this ticket say what to deliver.`,
    ]
      .join("\n")
      .slice(0, 20_000),
  };
}

/** What the facade hands openFixTicket: the normal ticket create and the regression link. */
export interface FixTicketActs {
  create(
    raw: { title: string; description: string; risk_level: string; priority: number },
    links: { repoAccess?: ReadonlyArray<{ repo_id: string; access: string }> },
  ): Ticket;
  link(
    fixTicketId: string,
    originalId: string,
    note: string,
    findingId: string,
  ): {
    recorded: boolean;
    steppedDown: ReadonlyArray<{ repoId: string; riskLevel: string; gate: string }>;
  };
}

/**
 * "Open a fix ticket" from a standing finding: a new ticket through the normal ticket
 * service (its risk sealed at creation like any ticket a person creates), at the original's
 * risk, delivering to the original's write repo, the finding quoted in its description, and
 * linked as a regression of the original through the regression service (one link, so the
 * escaped-defect numbers count it once; the link records no second finding). The link steps
 * autonomy down when the original worked automatically (the preview says so first). The
 * caller runs this in one transaction. A person's act.
 */
export function openFixTicket(
  host: FindingHost,
  ref: string,
  fid: string,
  actor: Actor,
  acts: FixTicketActs,
): {
  finding: FindingView;
  ticket: { id: string; number: number | null };
  stepped_down: ReadonlyArray<{ repoId: string; riskLevel: string; gate: string }>;
  eventId: string;
} {
  assertMayWriteFinding(actor);
  const f = findFinding(host, ref, fid);
  assertNoFixYet(f);
  const original = host.resolveTicket(f.ticket_id);
  const draft = fixTicketDraft(f, original);
  const repo = writeRepoOf(host.db, original.id);
  const fix = acts.create(
    {
      title: draft.title,
      description: draft.description,
      risk_level: original.risk_level,
      priority: original.priority ?? 0,
    },
    repo ? { repoAccess: [{ repo_id: repo.id, access: "write" }] } : {},
  );
  const linked = acts.link(fix.id, original.id, f.text, f.id);
  const eventId = writeEvent(host.db, {
    entity_type: "ticket",
    entity_id: f.ticket_id,
    actor,
    event_type: FINDING_FIX_EVENT,
    payload: { finding_id: f.id, fix_ticket_id: fix.id, fix_ticket_number: fix.number ?? null },
  });
  return {
    finding: findFinding(host, f.ticket_id, f.id),
    ticket: { id: fix.id, number: fix.number ?? null },
    stepped_down: linked.steppedDown,
    eventId,
  };
}
