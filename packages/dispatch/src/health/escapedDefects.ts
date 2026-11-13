/**
 * ESCAPED-DEFECT RATE (the fourth top-level measure; delta roadmap gap 5, gap-specialists
 * MF5).
 *
 *   accepted changes = tickets that are done now, by the time of their last move to done
 *   escaped          = accepted changes that at least one person linked a later ticket to
 *                      as its regression (`ticket.defect_escaped`, not withdrawn)
 *   rate             = escaped / accepted changes, over the window (accepted in the last N
 *                      days) and over all time. Null with no accepted change.
 *
 * It counts only what a person filed: Gaffer does not guess a defect from a revert, a red
 * CI run or a reopen. A recent change has had less time for a defect to be found, so the
 * windowed rate reads low at first and grows as links are filed. Pure: the caller
 * supplies the links and the transitions.
 *
 * Beside each rate, `upper_95_pct` is the Wilson 95% upper bound on it: at zero escaped
 * it says how high the true rate could still be (0 of 11 could be up to 25.9%). `previous`
 * is the same count over the equal window before; `by_month` is the last 6 calendar
 * months as cohorts by acceptance time, and a cohort that ends less than 30 days ago is
 * `maturing`: its defects have not had the time to be found yet.
 */
import type { RegressionLink } from "../services/escapedDefects.js";
import {
  inRange,
  monthGrid,
  pct1,
  previousRange,
  rangeIso,
  windowRange,
  wilsonUpperPct,
  DAY_MS,
  type MonthBucket,
} from "./measurePeriods.js";

export interface EscapedDefectCount {
  readonly accepted_changes: number;
  readonly escaped: number;
  readonly rate_pct: number | null;
  /** Wilson 95% upper bound on the rate (null with nothing accepted). */
  readonly upper_95_pct: number | null;
}

/** The count over the equal window before this one. */
export interface EscapedDefectPrevious extends EscapedDefectCount {
  readonly since: string;
  readonly until: string;
}

/** One calendar month's cohort of accepted changes. */
export interface EscapedDefectMonth extends MonthBucket {
  readonly accepted: number;
  readonly escaped: number;
  readonly rate_pct: number | null;
  /** True when the cohort ends less than `maturing_days` ago: still collecting links. */
  readonly maturing: boolean;
}

/** A cohort younger than this has had too little time for its defects to be found. */
export const ESCAPED_MATURING_DAYS = 30;

export interface EscapedDefects extends EscapedDefectCount {
  readonly measure: "escaped_defect_rate";
  /** True: the link is recordable. The rate is still null with nothing accepted. */
  readonly recorded: true;
  readonly window_days: number;
  readonly all_time: EscapedDefectCount;
  /** The equal window before. */
  readonly previous: EscapedDefectPrevious;
  readonly maturing_days: number;
  /** The last 6 months by acceptance time; an empty month has accepted 0 and a null rate. */
  readonly by_month: readonly EscapedDefectMonth[];
  /** Every current link (one defect may regress two changes; two defects one change). */
  readonly links: number;
  readonly filed_by: { readonly human: number; readonly admin: number };
  readonly note: string;
  readonly limits: readonly string[];
}

export const ESCAPED_DEFECTS_NOTE =
  "Counts only what a person filed: a later ticket linked as a regression of an accepted change (wg ticket regression-of, or the ticket page). Gaffer never guesses one from a revert or a red build.";

export const ESCAPED_DEFECTS_LIMITS: readonly string[] = [
  "only links a person filed are counted, so the rate is as complete as the habit of filing them",
  "a change accepted recently has had less time for a defect to be found",
  "a change that left done (reopened) is not an accepted change until it is done again",
  "the upper bound is the Wilson 95% interval's: a small sample with no escapes can still hide a high rate",
  "monthly cohorts count changes by when they were accepted; a cohort that ended less than 30 days ago is still maturing",
];

const pct = pct1;
const count = (accepted: number, escaped: number): EscapedDefectCount => ({
  accepted_changes: accepted,
  escaped,
  rate_pct: pct(escaped, accepted),
  upper_95_pct: wilsonUpperPct(escaped, accepted),
});

/** The report (see the module comment). */
export function escapedDefectReport(input: {
  links: readonly RegressionLink[];
  transitions: readonly {
    ticketId: string;
    toStatus: string | null;
    atMs: number;
  }[];
  tickets: readonly { id: string; status: string }[];
  nowMs: number;
  windowDays: number;
}): EscapedDefects {
  const done = new Set(input.tickets.filter((t) => t.status === "done").map((t) => t.id));
  const acceptedAt = new Map<string, number>();
  for (const t of input.transitions)
    if (t.toStatus === "done" && done.has(t.ticketId))
      acceptedAt.set(t.ticketId, Math.max(acceptedAt.get(t.ticketId) ?? 0, t.atMs));
  // A done ticket with no recorded move to done (an import) is accepted at an unknown
  // time: all time only.
  for (const id of done) if (!acceptedAt.has(id)) acceptedAt.set(id, Number.NaN);

  // Only a person's link counts (the service refuses anyone else; this is the reader's
  // own check on older or hand-written rows).
  const links = input.links.filter((l) => l.filedBy.type === "human" || l.filedBy.type === "admin");
  const regressed = new Set(links.map((l) => l.regressionOf));
  const winRange = windowRange(input.nowMs, input.windowDays);
  const prevRange = previousRange(input.nowMs, input.windowDays)!;
  const months = monthGrid(input.nowMs);
  const monthAccepted = new Array<number>(months.buckets.length).fill(0);
  const monthEscaped = new Array<number>(months.buckets.length).fill(0);
  let all = 0;
  let allEscaped = 0;
  let win = 0;
  let winEscaped = 0;
  let prev = 0;
  let prevEscaped = 0;
  // One pass: every accepted change into all time, the window, the previous window and
  // its month.
  for (const [id, at] of acceptedAt) {
    all += 1;
    const escaped = regressed.has(id);
    if (escaped) allEscaped += 1;
    if (inRange(winRange, at)) {
      win += 1;
      if (escaped) winEscaped += 1;
    }
    if (inRange(prevRange, at)) {
      prev += 1;
      if (escaped) prevEscaped += 1;
    }
    const m = months.indexOf(at);
    if (m >= 0) {
      monthAccepted[m]! += 1;
      if (escaped) monthEscaped[m]! += 1;
    }
  }
  const maturingSince = input.nowMs - ESCAPED_MATURING_DAYS * DAY_MS;
  return {
    measure: "escaped_defect_rate",
    recorded: true,
    window_days: input.windowDays,
    ...count(win, winEscaped),
    all_time: count(all, allEscaped),
    previous: { ...rangeIso(prevRange), ...count(prev, prevEscaped) },
    maturing_days: ESCAPED_MATURING_DAYS,
    by_month: months.buckets.map((b, i) => ({
      month: b.month,
      partial: b.partial,
      accepted: monthAccepted[i]!,
      escaped: monthEscaped[i]!,
      rate_pct: pct(monthEscaped[i]!, monthAccepted[i]!),
      maturing: b.endMs > maturingSince,
    })),
    links: links.length,
    filed_by: {
      human: links.filter((l) => l.filedBy.type === "human").length,
      admin: links.filter((l) => l.filedBy.type === "admin").length,
    },
    note: ESCAPED_DEFECTS_NOTE,
    limits: ESCAPED_DEFECTS_LIMITS,
  };
}
