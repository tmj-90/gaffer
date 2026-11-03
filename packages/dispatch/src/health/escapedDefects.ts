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
 */
import type { RegressionLink } from "../services/escapedDefects.js";

export interface EscapedDefectCount {
  readonly accepted_changes: number;
  readonly escaped: number;
  readonly rate_pct: number | null;
}

export interface EscapedDefects extends EscapedDefectCount {
  readonly measure: "escaped_defect_rate";
  /** True: the link is recordable. The rate is still null with nothing accepted. */
  readonly recorded: true;
  readonly window_days: number;
  readonly all_time: EscapedDefectCount;
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
];

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

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
  const since = input.nowMs - input.windowDays * 86_400_000;
  let all = 0;
  let allEscaped = 0;
  let win = 0;
  let winEscaped = 0;
  for (const [id, at] of acceptedAt) {
    all += 1;
    const escaped = regressed.has(id);
    if (escaped) allEscaped += 1;
    if (Number.isFinite(at) && at >= since) {
      win += 1;
      if (escaped) winEscaped += 1;
    }
  }
  return {
    measure: "escaped_defect_rate",
    recorded: true,
    window_days: input.windowDays,
    accepted_changes: win,
    escaped: winEscaped,
    rate_pct: pct(winEscaped, win),
    all_time: { accepted_changes: all, escaped: allEscaped, rate_pct: pct(allEscaped, all) },
    links: links.length,
    filed_by: {
      human: links.filter((l) => l.filedBy.type === "human").length,
      admin: links.filter((l) => l.filedBy.type === "admin").length,
    },
    note: ESCAPED_DEFECTS_NOTE,
    limits: ESCAPED_DEFECTS_LIMITS,
  };
}
