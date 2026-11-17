/**
 * LESSONS REPORT (backlog 59, part 5): every lesson a person proposed from a post-merge
 * finding (`ticket.finding_lesson_proposed`), its lore status and approval time read from
 * memory, and its measure (health/lessons.ts): recurrences on its paths before vs after it
 * went live. Read by `wg lessons`, GET /api/lessons and the Health section. A read.
 *
 * Memory unavailable: every status reads null and every measure "not live yet"; the counts
 * of live lessons and drafts say what memory could not answer (`unknown`).
 */
import type { Db } from "../db/connection.js";
import {
  LESSON_MEASURE_MIN_CHANGES,
  lessonMeasure,
  type LandedChange,
  type LessonMeasure,
} from "../health/lessons.js";
import {
  currentRegressionLinks,
  DEFECT_ESCAPED_EVENT,
  DEFECT_ESCAPED_WITHDRAWN_EVENT,
  type RegressionEventRow,
} from "./escapedDefects.js";
import {
  FINDING_LESSON_EVENT,
  readFindings,
  recordedDiffPaths,
  writeRepoOf,
} from "./findingService.js";

/** At most this many lessons have their lore status read per report (as review rules). */
const MAX_LOOKUPS = 20;

export interface LessonView {
  readonly lore_id: string | null;
  readonly finding_id: string;
  readonly ticket_id: string;
  readonly number: number | null;
  readonly repo: string | null;
  readonly paths: readonly string[];
  readonly proposed_at: string;
  readonly proposed_by: string;
  /** draft | active | rejected | ... as memory says, or null when it could not say. */
  readonly lore_status: string | null;
  readonly approved_at: string | null;
  readonly measure: Omit<LessonMeasure, "after_ids" | "after_recurred_ids">;
}

export interface LessonsReport {
  readonly live: number;
  readonly drafts_waiting: number;
  /** Lessons whose status memory could not give. */
  readonly unknown: number;
  /** Over every live lesson, each change counted once: k of n changes on lesson paths since. */
  readonly recurrences_after: { readonly k: number; readonly n: number };
  readonly min_changes: number;
  readonly lessons: readonly LessonView[];
  readonly note: string;
}

/**
 * What the measure cannot see (backlog 59 review): a change's paths are read from its
 * recorded diff summary (`git diff --stat`, its last 14 file lines, names shortened to fit
 * 80 columns), which leaves out shortened names and the files of a large change. On this
 * repository's last 200 commits it missed 176 of 926 paths, in 62 commits. Both windows lose
 * the same kind of change, so counts read low rather than in the lesson's favour.
 */
export const LESSONS_PATHS_CAVEAT =
  "Counts can read low: each change's paths come from its recorded diff summary, which leaves out long, shortened file names and the files of a large change.";

export const LESSONS_NOTE =
  "A lesson is a person's post-merge finding a person approved; later changes on its paths see it. A recurrence is a later change on those paths that had something go wrong after it was done (a finding or a regression link). No rate below " +
  `${LESSON_MEASURE_MIN_CHANGES} changes. ` +
  LESSONS_PATHS_CAVEAT;

/** Every landed change with its paths and whether something went wrong after it. */
export function landedChanges(db: Db): LandedChange[] {
  const done = db
    .prepare(
      `SELECT t.id AS id,
              (SELECT MAX(e.created_at) FROM work_events e
                WHERE e.entity_type = 'ticket' AND e.entity_id = t.id
                  AND e.event_type = 'ticket.transitioned'
                  AND json_extract(e.payload_json, '$.to') = 'done') AS landed_at,
              t.updated_at AS updated_at
         FROM tickets t WHERE t.status = 'done'`,
    )
    .all() as Array<{ id: string; landed_at: string | null; updated_at: string }>;
  const recurred = new Set<string>();
  for (const f of readFindings(db)) if (!f.withdrawn) recurred.add(f.ticket_id);
  const linkRows = db
    .prepare(
      `SELECT entity_id AS ticketId, event_type AS eventType, actor_type AS actorType,
              actor_id AS actorId, created_at AS at,
              json_extract(payload_json, '$.regression_of') AS regressionOf,
              json_extract(payload_json, '$.note') AS note
         FROM work_events WHERE entity_type = 'ticket' AND event_type IN (?, ?) ORDER BY rowid`,
    )
    .all(DEFECT_ESCAPED_EVENT, DEFECT_ESCAPED_WITHDRAWN_EVENT) as RegressionEventRow[];
  for (const l of currentRegressionLinks(linkRows)) recurred.add(l.regressionOf);
  const out: LandedChange[] = [];
  for (const t of done) {
    const repo = writeRepoOf(db, t.id);
    if (!repo) continue;
    const at = Date.parse(t.landed_at ?? t.updated_at);
    if (!Number.isFinite(at)) continue;
    out.push({
      ticketId: t.id,
      repo: repo.name,
      landedAtMs: at,
      paths: recordedDiffPaths(db, t.id),
      recurred: recurred.has(t.id),
    });
  }
  return out;
}

interface ProposedRow {
  entity_id: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: string | null;
  created_at: string;
}

/** The report (see the header). `lookup` asks memory for one lore record. */
export function lessonsReport(
  db: Db,
  opts: {
    nowMs: number;
    lookup: (loreId: string) => { status: string; approvedAt: string | null } | null;
  },
): LessonsReport {
  const rows = db
    .prepare(
      `SELECT entity_id, actor_type, actor_id, payload_json, created_at FROM work_events
        WHERE entity_type = 'ticket' AND event_type = ? ORDER BY rowid DESC`,
    )
    .all(FINDING_LESSON_EVENT) as ProposedRow[];
  const changes = landedChanges(db);
  const numberOf = db.prepare("SELECT number FROM tickets WHERE id = ?");
  let live = 0;
  let drafts = 0;
  let unknown = 0;
  const afterAll = new Set<string>();
  const afterRecurred = new Set<string>();
  const lessons = rows.map((r, i): LessonView => {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(r.payload_json ?? "{}") as Record<string, unknown>;
    } catch {
      p = {};
    }
    const loreId = typeof p.lore_id === "string" && p.lore_id ? p.lore_id : null;
    const repo = typeof p.repo === "string" && p.repo ? p.repo : null;
    const paths = Array.isArray(p.paths)
      ? p.paths.filter((x): x is string => typeof x === "string")
      : [];
    const found = loreId && i < MAX_LOOKUPS ? opts.lookup(loreId) : null;
    if (!found) unknown += 1;
    else if (found.status === "active") live += 1;
    else if (found.status === "draft") drafts += 1;
    const approvedAt = found && found.status === "active" ? found.approvedAt : null;
    const m = lessonMeasure({
      repo: repo ?? "",
      paths,
      sourceTicketId: r.entity_id,
      approvedAtMs: approvedAt ? Date.parse(approvedAt) || null : null,
      changes,
      nowMs: opts.nowMs,
    });
    for (const id of m.after_ids) afterAll.add(id);
    for (const id of m.after_recurred_ids) afterRecurred.add(id);
    const { after_ids: _a, after_recurred_ids: _b, ...measure } = m;
    void _a;
    void _b;
    return {
      lore_id: loreId,
      finding_id: typeof p.finding_id === "string" ? p.finding_id : "",
      ticket_id: r.entity_id,
      number: (numberOf.get(r.entity_id) as { number: number | null } | undefined)?.number ?? null,
      repo,
      paths,
      proposed_at: r.created_at,
      proposed_by: r.actor_id ?? r.actor_type,
      lore_status: found ? found.status : null,
      approved_at: approvedAt,
      measure,
    };
  });
  return {
    live,
    drafts_waiting: drafts,
    unknown,
    recurrences_after: { k: afterRecurred.size, n: afterAll.size },
    min_changes: LESSON_MEASURE_MIN_CHANGES,
    lessons,
    note: LESSONS_NOTE,
  };
}
