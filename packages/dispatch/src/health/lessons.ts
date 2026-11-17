/**
 * LESSONS, MEASURED (backlog 59, part 5): does an approved lesson stop the same kind of
 * thing going wrong again on its paths? Pure; services/lessonReportService.ts feeds it.
 *
 * For one lesson approved at `a`, in its repo:
 *  - a CHANGE on its paths is a ticket that landed (reached done) whose recorded delivery
 *    touched a path overlapping one of the lesson's paths (the lesson's own change left out);
 *  - a RECURRENCE is such a change that later got a standing post-merge finding or a
 *    standing regression link (something went wrong after it was done);
 *  - before = changes landed in [a - span, a), after = changes landed in [a, now], span =
 *    now - a (the same length either side, as review rules measure).
 * A rate is shown only once a side has at least {@link LESSON_MEASURE_MIN_CHANGES} changes;
 * below that the counts stand alone ("not enough data"). Counts are distinct tickets.
 */

/** Fewer changes on a lesson's paths than this on a side: no rate for that side. */
export const LESSON_MEASURE_MIN_CHANGES = 5;

/** One landed change, as the measure reads it. */
export interface LandedChange {
  readonly ticketId: string;
  readonly repo: string;
  readonly landedAtMs: number;
  /** Repo-relative paths its recorded delivery touched. */
  readonly paths: readonly string[];
  /** True when it later got a standing finding or a standing regression link. */
  readonly recurred: boolean;
}

export interface LessonMeasure {
  readonly state: "not_approved" | "not_enough_data" | "measured";
  readonly window_days: number | null;
  readonly changes_before: number;
  readonly recurrences_before: number;
  readonly rate_before_pct: number | null;
  readonly changes_after: number;
  readonly recurrences_after: number;
  readonly rate_after_pct: number | null;
  /** The after-window changes (ticket ids), so a report can count them once overall. */
  readonly after_ids: readonly string[];
  readonly after_recurred_ids: readonly string[];
  readonly note: string;
}

const isGlob = (p: string): boolean => /[*?[]/.test(p);

function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const norm = (p: string): string =>
  p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");

/**
 * Does a lesson path overlap a touched path? The same rule memory serves lessons by
 * (packages/memory/src/core/lessons.ts pathsOverlap): a glob matches the path, or its
 * literal stem lies under a touched directory; a plain path overlaps when one is the other
 * or a directory holding it, on whole segments.
 */
export function lessonPathOverlaps(lessonPath: string, touched: string): boolean {
  const l = norm(lessonPath);
  const t = norm(touched);
  if (!l || !t || l.split("/").includes("..") || t.split("/").includes("..")) return false;
  if (isGlob(l)) {
    if (globRegex(l).test(t.replace(/\/$/, ""))) return true;
    const stem = l.slice(0, l.search(/[*?[]/)).replace(/[^/]*$/, "");
    const dir = t.endsWith("/") ? t : `${t}/`;
    return stem !== "" && stem.startsWith(dir);
  }
  const lp = l.replace(/\/$/, "");
  const tp = t.replace(/\/$/, "");
  return lp === tp || tp.startsWith(`${lp}/`) || lp.startsWith(`${tp}/`);
}

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

/** The measure of one lesson (see the header). */
export function lessonMeasure(input: {
  repo: string;
  paths: readonly string[];
  /** The change the lesson came from: never counted. */
  sourceTicketId: string;
  approvedAtMs: number | null;
  changes: readonly LandedChange[];
  nowMs: number;
}): LessonMeasure {
  const empty = {
    window_days: null,
    changes_before: 0,
    recurrences_before: 0,
    rate_before_pct: null,
    changes_after: 0,
    recurrences_after: 0,
    rate_after_pct: null,
    after_ids: [],
    after_recurred_ids: [],
  };
  if (input.approvedAtMs === null)
    return {
      state: "not_approved",
      ...empty,
      note: "Not live yet: a lesson is measured once a person approves it.",
    };
  const a = input.approvedAtMs;
  const span = Math.max(0, input.nowMs - a);
  const onPaths = input.changes.filter(
    (c) =>
      c.repo === input.repo &&
      c.ticketId !== input.sourceTicketId &&
      c.paths.some((t) => input.paths.some((l) => lessonPathOverlaps(l, t))),
  );
  const before = onPaths.filter((c) => c.landedAtMs >= a - span && c.landedAtMs < a);
  const after = onPaths.filter((c) => c.landedAtMs >= a && c.landedAtMs <= input.nowMs);
  const rb = before.filter((c) => c.recurred).length;
  const ra = after.filter((c) => c.recurred).length;
  const enoughBefore = before.length >= LESSON_MEASURE_MIN_CHANGES;
  const enoughAfter = after.length >= LESSON_MEASURE_MIN_CHANGES;
  return {
    state: enoughAfter ? "measured" : "not_enough_data",
    window_days: Math.round((span / 86_400_000) * 10) / 10,
    changes_before: before.length,
    recurrences_before: rb,
    rate_before_pct: enoughBefore ? pct(rb, before.length) : null,
    changes_after: after.length,
    recurrences_after: ra,
    rate_after_pct: enoughAfter ? pct(ra, after.length) : null,
    after_ids: after.map((c) => c.ticketId),
    after_recurred_ids: after.filter((c) => c.recurred).map((c) => c.ticketId),
    note: enoughAfter
      ? `Since it went live, ${ra} of ${after.length} changes on its paths had something go wrong after they were done.`
      : `${after.length} change${after.length === 1 ? "" : "s"} on its paths since it went live: a rate needs ${LESSON_MEASURE_MIN_CHANGES}.`,
  };
}
