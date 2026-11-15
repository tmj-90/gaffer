// View: Health / ROI.
// The quality story first: the four measures are the scoreboard (one measure tile each,
// over the window the Referee's record select sets), what is behind them under it, then
// the comparison tables (routing, lanes, scout), the physio's flow panels and the deep
// reads. The module map is in app.js.

import { api } from "../api.js";
import {
  dataTable,
  emptyState,
  measureTile,
  meterRow,
  panelHead,
  segBar,
  statCell,
  viewHead,
} from "../components.js";
import { el } from "../dom.js";
import { fmtDuration, fmtTime, money, pct, plural } from "../format.js";
import { glyph, icon } from "../icons.js";
import { hlWork } from "../matchday.js";
import { waitingNote } from "../panels.js";
import { fitnessRoomPanels } from "./fitness.js";

// --- Health / ROI view ------------------------------------------------------

const DAY = 86_400_000;
/** The windows the Referee's record offers; the four measures follow the same one. */
const WINDOWS = [7, 30, 90, 365];
/** The window shown: kept for this page's life, so a repaint keeps the viewer's choice. */
let windowDays = 30;
/** Below this n a rate reads as counts, greyed, with no delta (routing_scorecard.min_n). */
const MIN_N = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A UTC date as "24 Aug" (the server's weeks and months are UTC buckets). */
function utcDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
/** A UTC month as "Oct 2026". */
function utcMonth(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const weekT = (b) => Date.parse(`${b.start}T00:00:00Z`);
const monthT = (b) => Date.parse(`${b.month}-01T00:00:00Z`);

/**
 * The Health banner for a usage-window pause (/api/health `usage_pause`, read from
 * the runner's $GAFFER_DATA/usage-pause.json): "Paused until <time>: usage limit",
 * what the model said, and that it lifts on its own. The ticket a refused delivery
 * hit went back to Ready without counting an attempt; a refused review or test
 * leaves its ticket where it was.
 */
function usagePauseNote(p) {
  const label = p.kind === "rate_limit" ? "rate limit" : "usage limit";
  const when = fmtTime(p.paused_until);
  const said = p.message ? ` The model said: "${p.message}".` : "";
  const why = p.unreadable
    ? " The pause file could not be read, so the factory holds for the default wait."
    : p.basis === "reset"
      ? " The time is the reset the model reported, plus a minute."
      : " No reset time was reported, so this is the default wait.";
  return el(
    "div",
    {
      class: "warn-box usage-pause-note",
      role: "status",
      "aria-label": `The factory is paused until ${when} because of a ${label}.`,
    },
    [
      icon("alert"),
      el("span", {}, [
        el("strong", {}, `Paused until ${when}: ${label}. `),
        "No new work starts until then, and it resumes on its own." +
          (p.ticket == null
            ? ""
            : p.lane === "review" || p.lane === "tester"
              ? ` Ticket #${p.ticket} stays where it was and is picked up again after the pause.`
              : ` Ticket #${p.ticket} went back to Ready without counting an attempt.`) +
          said +
          why,
      ]),
    ],
  );
}

/** A served history as sparkline points: {t, v} per bucket, null where it has no value. */
function history(buckets, timeOf, valueOf) {
  if (!Array.isArray(buckets)) return undefined;
  const pts = buckets
    .map((b) => {
      const t = timeOf(b);
      const v = valueOf(b);
      return Number.isFinite(t)
        ? { t, v: typeof v === "number" && Number.isFinite(v) ? v : null }
        : null;
    })
    .filter(Boolean);
  return pts.length ? pts : undefined;
}

/** A disclosure for the long words (A-54): a short summary line, the detail inside. */
function more(summary, body, cls) {
  return el("details", { class: cls ? `hx-more ${cls}` : "hx-more" }, [
    el("summary", {}, summary),
    ...[].concat(body),
  ]);
}

/**
 * The sparkline of a tile names its grid as UTC (the server buckets weeks from Monday
 * 00:00 UTC and months as UTC months): in its accessible name and its title.
 */
function utcSpark(tile, unit) {
  const s = tile.querySelector(".spark");
  if (!s) return tile;
  const said = s.getAttribute("aria-label") || "";
  s.setAttribute("aria-label", said.replace(` ${unit},`, ` UTC ${unit},`));
  const box = tile.querySelector(".mt-spark");
  if (box)
    box.title =
      unit === "weeks"
        ? "By UTC week (from Monday 00:00 UTC); the last week is still running."
        : "By UTC month; the last month is still running.";
  return tile;
}

/** Why a tile shows no change: too few in either period, or nothing before. */
function noDeltaWhy(n, prevN, prevLabel) {
  if (typeof prevN !== "number") return "";
  if (prevN === 0) return ` No change shown: nothing in ${prevLabel}.`;
  if (prevN < MIN_N || (typeof n === "number" && n < MIN_N))
    return ` No change shown: under ${MIN_N} in one of the two periods.`;
  return "";
}

/** The board's period words: "last 30 days". */
const periodOf = (wd) => (wd ? `last ${wd} days` : "all time");
const beforeOf = (wd) => (wd ? `the ${wd} days before` : "the period before");

/** First-pass acceptance: k of n with no send-back, the strict rate in its note. */
function firstPassTile(fp, wd) {
  const label = "First-pass acceptance";
  if (!fp) return measureTile({ label, value: null, note: "Not served by this server." });
  const prev = fp.previous || null;
  const strict = fp.strict || null;
  const notes = [];
  if (fp.done && strict && typeof strict.first_pass === "number")
    notes.push(
      `${pct(strict.rate_pct)} counting the runner's own retries (${strict.first_pass} of ${fp.done}).`,
    );
  const h = fp.by_approver?.human;
  const a = fp.by_approver?.agent;
  if (fp.done && h && a)
    notes.push(
      `Approved by a person: ${h.first_pass} of ${h.done}; by an agent: ${a.first_pass} of ${a.done}.`,
    );
  const why = fp.done ? noDeltaWhy(fp.done, prev?.done, beforeOf(wd)) : "";
  return utcSpark(
    measureTile({
      label,
      k: fp.first_pass ?? 0,
      n: fp.done ?? 0,
      nLabel: "with no send-back",
      period: periodOf(fp.window_days ?? wd),
      delta: prev
        ? { prev: prev.rate_pct, prevN: prev.done, goodWhen: "up", label: beforeOf(wd) }
        : null,
      series: history(fp.by_week, weekT, (b) => b.rate_pct),
      note: fp.done ? `${notes.join(" ")}${why}`.trim() : "Nothing was accepted in this window.",
      definition:
        "Of the tickets accepted (moved to done) in the window, how many went through with no send-back after review and were never reopened. The strict rate also counts the runner's own retries after a failed gate.",
      cls: "mt-first-pass",
    }),
    "weeks",
  );
}

/** Human review time: the median per accepted ticket, p75 and p90 in its note. */
function reviewTimeTile(rt, wd) {
  const label = "Human review time";
  if (!rt) return measureTile({ label, value: null, note: "Not served by this server." });
  const per = rt.per_accepted_ticket || {};
  const prev = rt.previous?.per_accepted_ticket || null;
  const has = per.median_ms != null;
  const why = has ? noDeltaWhy(per.n, prev?.n, beforeOf(wd)) : "";
  return utcSpark(
    measureTile({
      label,
      value: has ? per.median_ms : null,
      format: fmtDuration,
      n: has ? per.n : undefined,
      period: periodOf(rt.window_days ?? wd),
      delta: prev
        ? { prev: prev.median_ms, prevN: prev.n, goodWhen: "down", label: beforeOf(wd) }
        : null,
      series: history(rt.by_week, weekT, (b) => b.median_ms),
      note: has
        ? `Median per accepted ticket; p75 ${fmtDuration(per.p75_ms)}, p90 ${fmtDuration(per.p90_ms)}.${why}`
        : rt.basis_note || "No accepted ticket has a human review decision in this window.",
      definition:
        `${rt.basis_note || ""} All of a ticket's human review rounds are summed and counted at its last human decision.`.trim(),
      cls: "mt-review-time",
    }),
    "weeks",
  );
}

/** Accepted-change cost: every attempt's spend over the changes accepted. */
function acceptedCostTile(ac, wd) {
  const label = "Accepted-change cost";
  if (!ac) return measureTile({ label, value: null, note: "Not served by this server." });
  const prev = ac.previous || null;
  const has = typeof ac.cost_per_accepted_change_usd === "number";
  const notes = [];
  if (has && ac.attempts_per_accepted_change != null)
    notes.push(`${ac.attempts_per_accepted_change} attempts per accepted change.`);
  if (typeof ac.unattributed_usd === "number" && ac.unattributed_usd > 0)
    notes.push(`${money(ac.unattributed_usd)} of spend no ticket claims is not in the price.`);
  const why = has ? noDeltaWhy(ac.accepted_changes, prev?.accepted_changes, beforeOf(wd)) : "";
  return utcSpark(
    measureTile({
      label,
      value: has ? ac.cost_per_accepted_change_usd : null,
      format: money,
      n: has ? ac.accepted_changes : undefined,
      period: periodOf(ac.window_days ?? wd),
      delta: prev
        ? {
            prev: prev.cost_per_accepted_change_usd,
            prevN: prev.accepted_changes,
            goodWhen: "down",
            label: beforeOf(wd),
          }
        : null,
      series: history(ac.by_week, weekT, (b) => b.cost_per_accepted_change_usd),
      note: has ? `${notes.join(" ")}${why}`.trim() : "Nothing was accepted in this window.",
      definition:
        "Every attempt's spend on the tickets whose outcome settled in the window (accepted, parked, failed or abandoned), over the changes accepted: failed work is part of the price. Each ticket counts where its outcome last settled; work still in flight is in no period.",
      cls: "mt-accepted-cost",
    }),
    "weeks",
  );
}

/** Escaped-defect rate: the regression links a person filed, the upper bound at zero. */
function escapedTile(esc, wd) {
  const label = "Escaped-defect rate";
  if (!esc) return measureTile({ label, value: null, note: "Not served by this server." });
  if (!esc.recorded)
    return measureTile({
      label,
      value: null,
      note: `Not recorded yet: ${(esc.note || "").replace(/^Not recorded yet:\s*/, "")}`,
    });
  const prev = esc.previous || null;
  const n = esc.accepted_changes ?? 0;
  const k = esc.escaped ?? 0;
  const months = Array.isArray(esc.by_month) ? esc.by_month : [];
  const maturing = months
    .filter((m) => m.maturing && m.accepted > 0)
    .map((m) => utcMonth(monthT(m)));
  const notes = [];
  if (n && typeof esc.upper_95_pct === "number")
    notes.push(
      k === 0
        ? `None filed, but it could be up to ${pct(esc.upper_95_pct)} (the 95% upper bound).`
        : `It could be up to ${pct(esc.upper_95_pct)} (the 95% upper bound).`,
    );
  const at = esc.all_time;
  if (at && at.accepted_changes > 0 && typeof at.rate_pct === "number")
    notes.push(`All time: ${pct(at.rate_pct)} (${at.escaped} of ${at.accepted_changes}).`);
  if (maturing.length)
    notes.push(
      `Still maturing: ${maturing.join(" and ")} (accepted under ${esc.maturing_days ?? 30} days ago, so defects may still surface).`,
    );
  const why = n ? noDeltaWhy(n, prev?.accepted_changes, beforeOf(wd)) : "";
  return utcSpark(
    measureTile({
      label,
      k,
      n,
      nLabel: "came back as a regression",
      period: periodOf(esc.window_days ?? wd),
      delta: prev
        ? {
            prev: prev.rate_pct,
            prevN: prev.accepted_changes,
            goodWhen: "down",
            label: beforeOf(wd),
          }
        : null,
      series: history(months, monthT, (b) => b.rate_pct),
      note: n ? `${notes.join(" ")}${why}`.trim() : "Nothing was accepted in this window.",
      definition:
        `${esc.note || ""} A change accepted recently has had less time for a defect to surface.`.trim(),
      cls: "mt-escaped",
    }),
    "months",
  );
}

/** The four measures, as the board's tiles, all the same size. */
function measureTiles(h, wd) {
  return [
    firstPassTile(h.first_pass || null, wd),
    reviewTimeTile(h.review_time || null, wd),
    acceptedCostTile(h.accepted_change || null, wd),
    escapedTile(h.escaped_defects || null, wd),
  ];
}

// --- behind the four measures (the detail under the board) --------------------

/** A served weekly history as a small table: the sparkline's table twin, UTC weeks. */
function weekTable(buckets, caption, columns) {
  if (!Array.isArray(buckets) || !buckets.length) return null;
  return more(
    "Week by week (UTC weeks)",
    dataTable({
      caption,
      columns: [
        {
          key: "start",
          label: "Week of (UTC)",
          format: (v, r) =>
            `${utcDay(Date.parse(`${v}T00:00:00Z`))}${r.partial ? " (so far)" : ""}`,
        },
        ...columns,
      ],
      rows: buckets.slice().reverse(),
      stackOnPhone: true,
    }),
  );
}

/** A rate cell: counts always; the rate greyed and plain counts under MIN_N. */
function rateText(k, n) {
  if (!n) return null;
  return n < MIN_N
    ? el("span", { class: "rt-few", title: `Only ${n}: too few to read as a rate` }, `${k} of ${n}`)
    : `${pct((k / n) * 100)} · ${k} of ${n}`;
}

function firstPassDetail(fp) {
  if (!fp) return null;
  const ap = fp.by_approver || {};
  const rows = [
    ["A person", ap.human],
    ["An agent", ap.agent],
    ["The system", ap.system],
  ]
    .filter(([, x]) => x && x.done)
    .map(([who, x]) => ({ who, done: x.done, rate: x }));
  return el("div", { class: "md-col" }, [
    panelHead("First-pass acceptance", "by who approved", null, { level: 3 }),
    rows.length
      ? dataTable({
          caption: "First-pass acceptance by approver",
          stackOnPhone: true,
          columns: [
            { key: "who", label: "Approved by" },
            { key: "done", label: "Accepted", numeric: true },
            {
              key: "rate",
              label: "First pass",
              numeric: true,
              format: (x) => rateText(x.first_pass, x.done),
            },
          ],
          rows,
        })
      : emptyState("Nothing accepted in this window.", null, null, null, { inline: true }),
    weekTable(fp.by_week, "First-pass acceptance by UTC week", [
      { key: "done", label: "Accepted", numeric: true },
      {
        key: "first_pass",
        label: "First pass",
        numeric: true,
        format: (v, r) => rateText(v, r.done),
        missing: "nothing accepted that week",
      },
    ]),
  ]);
}

function reviewTimeDetail(rt) {
  if (!rt) return null;
  const span = (label, x, missing) => ({
    label,
    median: x?.median_ms ?? null,
    p75: x?.p75_ms ?? null,
    p90: x?.p90_ms ?? null,
    n: x?.n ?? null,
    missing,
  });
  const rows = [
    span("Per accepted ticket", rt.per_accepted_ticket),
    span("Waiting to be opened", rt.queue_wait),
    span("Open to decision", rt.decision),
    span("Ready to decision (clock time)", rt.review_ready_to_decision),
    span("Active, approximate", rt.active?.per_accepted_ticket),
  ].filter((r) => r.n);
  const dur = (v) => (v == null ? null : fmtDuration(v));
  const raw = rt.approved_without_raw_logs;
  return el("div", { class: "md-col" }, [
    panelHead("Human review time", "where the time went", null, { level: 3 }),
    rows.length
      ? dataTable({
          caption: "Review time: waiting to be opened against deciding",
          stackOnPhone: true,
          columns: [
            { key: "label", label: "Span" },
            { key: "median", label: "Median", numeric: true, format: dur },
            { key: "p75", label: "p75", numeric: true, format: dur },
            { key: "p90", label: "p90", numeric: true, format: dur },
            { key: "n", label: "n", numeric: true },
          ],
          rows,
        })
      : emptyState("No human review decision in this window.", null, null, null, { inline: true }),
    raw && raw.instrumented
      ? el(
          "p",
          { class: "md-note" },
          `Approved without opening the raw logs: ${raw.count} of ${raw.instrumented} recorded approvals.`,
        )
      : null,
    rt.active?.note
      ? more("What active time means", el("p", { class: "md-note" }, rt.active.note))
      : null,
    weekTable(rt.by_week, "Median review time by UTC week", [
      { key: "n", label: "Accepted", numeric: true },
      {
        key: "median_ms",
        label: "Median",
        numeric: true,
        format: (v) => (v == null ? null : fmtDuration(v)),
        missing: "no decision that week",
      },
    ]),
  ]);
}

function acceptedCostDetail(ac) {
  if (!ac) return null;
  const bo = ac.by_outcome || {};
  const parts = [
    ["Accepted", bo.accepted],
    ["In flight", bo.in_flight],
    ["Parked or failed", bo.parked_or_failed],
    ["Abandoned", bo.abandoned],
  ].map(([label, x]) => ({ label, usd: x?.spend_usd ?? 0, tickets: x?.tickets ?? 0 }));
  const total = parts.reduce((a, p) => a + p.usd, 0);
  return el("div", { class: "md-col" }, [
    panelHead("Accepted-change cost", "where the spend went", null, { level: 3 }),
    total > 0
      ? el("div", { class: "md-spend" }, [
          segBar(
            parts.map((p) => ({ label: p.label, value: Math.round(p.usd * 100) / 100 })),
            { label: "Spend by how each ticket ended, in dollars", legend: false },
          ),
          el(
            "ul",
            { class: "seg-legend md-legend" },
            parts.map((p, i) =>
              el("li", {}, [
                el("span", { class: `seg-key seg-${i + 1}` }),
                `${p.label} `,
                el("b", {}, money(p.usd)),
                ` (${plural(p.tickets, "ticket")})`,
              ]),
            ),
          ),
        ])
      : emptyState("No spend on a settled ticket in this window.", null, null, null, {
          inline: true,
        }),
    typeof ac.accepted_only_cost_per_change_usd === "number"
      ? el(
          "p",
          { class: "md-note" },
          `For reference: ${money(ac.accepted_only_cost_per_change_usd)} per change counting the accepted tickets' own spend only (failed and abandoned work left out).`,
        )
      : null,
    typeof ac.unattributed_usd === "number"
      ? el(
          "p",
          { class: "md-note" },
          `${money(ac.unattributed_usd)} of spend in the window has no ticket and is not in either price.`,
        )
      : null,
    weekTable(ac.by_week, "Accepted-change cost by UTC week", [
      { key: "accepted", label: "Accepted", numeric: true },
      { key: "spend_usd", label: "Spend", numeric: true, format: money },
      {
        key: "cost_per_accepted_change_usd",
        label: "Per change",
        numeric: true,
        format: (v) => (v == null ? null : money(v)),
        missing: "nothing accepted that week",
      },
    ]),
  ]);
}

function escapedDetail(esc) {
  if (!esc || !esc.recorded) return null;
  const months = Array.isArray(esc.by_month) ? esc.by_month : [];
  return el("div", { class: "md-col" }, [
    panelHead("Escaped-defect rate", "by the month a change was accepted", null, { level: 3 }),
    months.length
      ? dataTable({
          caption: "Escaped defects by UTC month of acceptance",
          stackOnPhone: true,
          columns: [
            {
              key: "month",
              label: "Month (UTC)",
              // A cohort accepted under maturing_days ago is marked: defects may still surface.
              format: (v, r) =>
                el("span", {}, [
                  `${utcMonth(monthT(r))}${r.partial ? " (so far)" : ""}`,
                  r.maturing && r.accepted
                    ? el("span", { class: "md-maturing" }, " still maturing")
                    : null,
                ]),
            },
            { key: "accepted", label: "Accepted", numeric: true },
            {
              key: "escaped",
              label: "Escaped",
              numeric: true,
              format: (v, r) => rateText(v, r.accepted),
              missing: "nothing accepted that month",
            },
          ],
          rows: months.slice().reverse(),
        })
      : null,
    Array.isArray(esc.limits) && esc.limits.length
      ? more(
          "What it leaves out",
          el(
            "ul",
            { class: "md-limits" },
            esc.limits.map((x) => el("li", {}, x)),
          ),
        )
      : null,
  ]);
}

/**
 * What is behind the four measures: who approved, where review time went, where the
 * spend went (the accepted-only price for reference), the monthly cohorts with the
 * maturing ones marked, and each history as a table. Plus the tester lane notices.
 */
function measuresDetail(h) {
  const notices =
    h.tester_lane && Array.isArray(h.tester_lane.notices)
      ? h.tester_lane.notices.map((n, i) =>
          el(
            "p",
            {
              class:
                i === 0 && h.tester_lane.runner_differs
                  ? "measures-notice warn-text"
                  : "measures-notice dim",
            },
            n,
          ),
        )
      : [];
  return el(
    "section",
    { class: "card panel measures-detail", "aria-label": "Behind the four measures" },
    [
      panelHead("Behind the four measures", null, null, { level: 2 }),
      ...notices,
      el(
        "div",
        { class: "md-grid" },
        [
          firstPassDetail(h.first_pass || null),
          reviewTimeDetail(h.review_time || null),
          acceptedCostDetail(h.accepted_change || null),
          escapedDetail(h.escaped_defects || null),
        ].filter(Boolean),
      ),
    ],
  );
}

// --- the comparison tables ------------------------------------------------------

/** What each lane's verdicts did against the person: a diverging bar about a midline. */
function differedBar(l, max) {
  const a = l.differed_lane_blocked || 0;
  const b = l.differed_lane_passed || 0;
  const said = `Differed from the person ${l.differed} of ${l.compared}: ${a} it blocked and the person passed, ${b} it passed and the person sent back`;
  const side = (v, cls) =>
    el(
      "span",
      { class: `dv-side ${cls}` },
      v > 0 ? el("i", { style: `width:${((v / max) * 100).toFixed(1)}%` }) : null,
    );
  return el("span", { class: "dv", role: "img", "aria-label": said, title: said }, [
    el("span", { class: "dv-n" }, String(a)),
    side(a, "dv-left"),
    side(b, "dv-right"),
    el("span", { class: "dv-n" }, String(b)),
    el("span", { class: "dv-of" }, `${l.differed} of ${l.compared}`),
  ]);
}

/**
 * WHAT EACH LANE CHANGED (D1, F-C2): one row per lane that recorded verdicts (verdicts,
 * attempts a person also decided, a diverging bar of how it differed, send-backs only it
 * asked for, cost per attempt; the eval judge's blind decisions); lanes with no verdicts
 * on one muted line. Counts only: nothing here recommends switching a lane off.
 */
function laneValueCard(health) {
  const lv = health.lane_value || null;
  if (!lv || !Array.isArray(lv.lanes)) return null;
  const judged = lv.lanes.filter((l) => !l.note);
  const quiet = lv.lanes.filter((l) => l.note);
  const max = Math.max(
    1,
    ...judged.map((l) => Math.max(l.differed_lane_blocked || 0, l.differed_lane_passed || 0)),
  );
  const anyBlind = judged.some((l) => l.blinding);
  const columns = [
    {
      key: "label",
      label: "Lane",
      format: (v, l) =>
        l.safety
          ? el("span", {}, [v, el("span", { class: "lane-value-safety" }, " safety lane")])
          : v,
    },
    { key: "verdicts_recorded", label: "Verdicts", numeric: true },
    { key: "compared", label: "A person decided too", numeric: true },
    {
      key: "differed",
      label: "Differed: it blocked | it passed",
      format: (v, l) => (l.compared ? differedBar(l, max) : null),
      missing: "no attempt a person also decided",
    },
    ...(anyBlind
      ? [
          {
            key: "blinding",
            label: "Blind decisions differed",
            numeric: true,
            format: (b, l) =>
              b && l.compared
                ? el(
                    "span",
                    {
                      title: `After the judge's view was opened: ${b.revealed.differed} of ${b.revealed.compared} (the grade may have swayed those)`,
                    },
                    `${b.blind.differed} of ${b.blind.compared}`,
                  )
                : null,
            missing: "not split: only the eval judge's view can be opened before deciding",
          },
        ]
      : []),
    { key: "unique_catches", label: "Only lane on a send-back", numeric: true },
    {
      key: "cost_per_attempt_usd",
      label: "Cost per attempt",
      numeric: true,
      format: (v, l) =>
        v == null
          ? null
          : el("span", { title: `over ${plural(l.ledger_attempts, "ledger attempt")}` }, money(v)),
      missing: "no ledger spend of its own",
    },
  ];
  return el(
    "section",
    { class: "card panel lane-value-panel", "aria-label": "What each lane changed" },
    [
      panelHead(
        "What each lane changed",
        `${plural(lv.attempts, "attempt")} · ${lv.attempts_with_person_decision} decided by a person`,
        null,
        { level: 2 },
      ),
      judged.length
        ? dataTable({
            columns,
            rows: judged,
            caption:
              "Each lane's verdicts against the person's decision on the same attempt. The bar's left side: the lane blocked and the person passed; right: the lane passed and the person sent it back.",
            cls: "lane-value-table",
          })
        : emptyState("No lane has recorded a verdict yet.", null, null, null, { inline: true }),
      quiet.length
        ? el(
            "p",
            { class: "lane-value-quiet" },
            `No verdicts recorded: ${quiet.map((l) => `${l.label}${l.safety ? " (safety lane)" : ""}`).join(", ")}.`,
          )
        : null,
      el(
        "p",
        { class: "lane-value-foot" },
        `${lv.send_backs_no_lane_caught} of ${plural(lv.send_backs, "send-back")} no lane asked for. ${lv.footnote || ""}`,
      ),
      Array.isArray(lv.limits) && lv.limits.length
        ? more(
            "How these are counted",
            el(
              "ul",
              { class: "md-limits" },
              lv.limits.map((x) => el("li", {}, x)),
            ),
          )
        : null,
    ],
  );
}

/**
 * CODE INDEX (delta gap 1): each repo's index coverage as a table (files, exported
 * symbols, imports resolved, test links, when built and at which commit) and, as a
 * measure tile, how often the Review's callers row listed callers. Counts as served;
 * null when the server sends neither.
 */
function codeIndexCard(health) {
  const ic = health.impact_callers || null;
  const ci = health.code_index || null;
  if (!ic && !ci) return null;
  const repos = ci && ci.available && Array.isArray(ci.repos) ? ci.repos : [];
  const anyCaps = repos.some((r) => r.stats && r.stats.capsHit && r.stats.capsHit.length);
  const columns = [
    { key: "repo", label: "Repo" },
    { key: "files", label: "Files", numeric: true },
    { key: "testFiles", label: "Test files", numeric: true },
    { key: "exportedSymbols", label: "Exported symbols", numeric: true },
    { key: "refs", label: "Imports resolved", numeric: true },
    { key: "unresolved", label: "Unresolved", numeric: true },
    { key: "testLinks", label: "Test links", numeric: true },
    { key: "modulesWithTests", label: "Modules with tests", numeric: true },
    {
      key: "builtAt",
      label: "Built",
      format: (v) => (v ? fmtTime(v) : null),
      missing: "build time not recorded",
    },
    {
      key: "commit",
      label: "Commit",
      format: (v) => (v ? el("code", { class: "mono" }, String(v).slice(0, 8)) : null),
      missing: "commit not recorded",
    },
    ...(anyCaps
      ? [
          {
            key: "capsHit",
            label: "Cap hit",
            format: (v) => (v && v.length ? v.join(", ") : "none"),
          },
        ]
      : []),
  ];
  const rows = repos.map((r) => {
    const st = r.stats || {};
    return {
      repo: r.repo,
      files: st.files ?? null,
      testFiles: st.testFiles ?? null,
      exportedSymbols: st.exportedSymbols ?? null,
      refs: st.refs ?? null,
      unresolved: st.unresolved ?? null,
      testLinks: st.testLinks ?? null,
      modulesWithTests: st.modulesWithTests ?? null,
      builtAt: r.builtAt || null,
      commit: r.commit || null,
      capsHit: st.capsHit || [],
    };
  });
  const callers = !ic
    ? measureTile({
        label: "Callers listed on Review",
        value: null,
        note: "Not served by this server.",
      })
    : ic.known
      ? measureTile({
          label: "Callers listed on Review",
          k: ic.listed,
          n: ic.known,
          nLabel: "review opens",
          period: "all time",
          note: `${ic.none_changed} had no changed symbol to list, ${ic.not_analysed} were not analysed${ic.opens > ic.known ? `; ${ic.opens - ic.known} earlier opens did not record it` : ""}.`,
          definition:
            "Of the review opens that recorded it, how many showed callers of a changed symbol in the Review's callers row (found by import text, not a full call graph).",
        })
      : measureTile({
          label: "Callers listed on Review",
          value: null,
          note: "No review open has recorded the callers row yet.",
        });
  return el("section", { class: "card panel code-index-panel", "aria-label": "Code index" }, [
    panelHead("Code index", "files, symbols, imports and tests, by import text", null, {
      level: 2,
    }),
    callers,
    repos.length
      ? dataTable({
          columns,
          rows,
          caption: "Index coverage by repository",
          cls: "code-index-table",
          // Ten columns: on a phone each repo is a labelled card, not a sideways scroll.
          stackOnPhone: true,
        })
      : emptyState(
          ci && !ci.available
            ? `Index coverage: ${ci.reason || "Memory is not configured."}`
            : "No repo has a code index yet.",
          ci && !ci.available ? null : "It is built at onboard and refreshed after each merge.",
          null,
          null,
          { inline: true },
        ),
  ]);
}

/**
 * PRE-WORK SCOUT (delta gap 3, F-C3): what each scouted attempt started with (a thin
 * segmented bar: items from the code index, named only, nothing found) and first-pass
 * acceptance by what it found (a rate row per arm with its count and a Wilson whisker;
 * arms with no done ticket on one muted line). Observational, never a recommendation.
 */
function scoutCard(health) {
  const sc = health.scout || null;
  if (!sc) return null;
  const fp = sc.first_pass || {};
  const arms = [
    ["index_items", "Index added files"],
    ["named_only", "Named only"],
    ["nothing_found", "Nothing found"],
    ["no_record", "Not scouted"],
  ].map(([k, label]) => ({ k, label, c: fp[k] || { done: 0, first_pass: 0 } }));
  const withDone = arms.filter((a) => a.c.done > 0);
  const empty = arms.filter((a) => !(a.c.done > 0));
  const ms = sc.model_scout || { runs: 0 };
  const head = sc.attempts
    ? `${plural(sc.attempts, "delivery attempt")} scouted on ${plural(sc.tickets, "ticket")}. The risk was raised in ${sc.risk_raised}.`
    : "No delivery has been scouted yet (the runner scouts before each delivery).";
  const model = ms.runs
    ? `Model scout: ${plural(ms.runs, "run")}, ${plural(ms.kept_files, "file")} kept, ${ms.dropped} dropped as not in the checkout, ${money(Number(ms.cost_usd || 0))}${ms.cost_unknown ? ` (${ms.cost_unknown} of unknown cost)` : ""}.`
    : "Model scout: no run (the read-only model scout is off by default).";
  return el("section", { class: "card panel scout-panel", "aria-label": "Pre-work scout" }, [
    panelHead("Pre-work scout", "what each delivery started with, and how it went", null, {
      level: 2,
    }),
    el("p", { class: "scout-coverage" }, head),
    sc.attempts
      ? segBar(
          [
            { label: "Index added files", value: sc.with_index_items },
            { label: "Named files and stack frames only", value: sc.named_only },
            { label: "Nothing found", value: sc.empty },
          ],
          { label: "What each scouted attempt started with" },
        )
      : null,
    el("p", { class: "scout-model dim" }, model),
    panelHead("First-pass acceptance, by what the scout found", "done tickets", null, {
      level: 3,
    }),
    el(
      "p",
      { class: "scout-caption" },
      "Observational: which tickets name code differs, so this is not a controlled experiment.",
    ),
    withDone.length
      ? el(
          "div",
          { class: "meter-list scout-first-pass" },
          withDone.map((a) => {
            const small = a.c.done < MIN_N;
            const row = meterRow({
              name: a.label,
              k: a.c.first_pass,
              n: a.c.done,
              whisker: true,
              fmt: small ? (k, n) => `${k} of ${n}` : undefined,
            });
            row.dataset.arm = a.k;
            if (small) row.classList.add("is-small");
            return row;
          }),
        )
      : null,
    empty.length
      ? el(
          "p",
          { class: "scout-empty" },
          `No done ticket yet: ${empty.map((a) => a.label).join(", ")}.`,
        )
      : null,
    Array.isArray(sc.limits) && sc.limits.length
      ? more(
          "How these are counted",
          el(
            "ul",
            { class: "md-limits" },
            sc.limits.map((x) => el("li", {}, x)),
          ),
        )
      : null,
  ]);
}

/** A routing figure ({ value, n }): the value with its n under it; "too few" under min n. */
function routingRate(r, show) {
  if (!r) return null;
  if (r.value === null || r.value === undefined)
    return el("span", { class: "rt-few" }, `too few (n=${r.n})`);
  return el("span", { class: "rt" }, [show(r.value), el("small", { class: "rt-n" }, `n ${r.n}`)]);
}

/**
 * ROUTING SCORECARD (delta gap 4, F-C1): per provider x model x role x work class, what
 * each routed model did, as two tables (the implement role's outcomes; the other roles'
 * calls and spend), n under every figure, cells under the minimum on one muted line.
 * Server order, never ranked, no composite score; the definitions behind a disclosure.
 */
function routingCard(health) {
  const rs = health.routing_scorecard || null;
  if (!rs || !Array.isArray(rs.cells)) return null;
  const providers = new Set(rs.cells.map((c) => c.provider));
  const who = (c) => (providers.size > 1 ? `${c.provider} ${c.model}` : c.model);
  // Spend with its calls (the implement table counts attempts, not calls) and what it
  // leaves out; the other roles' table already has a Calls column.
  const spend = (c, withCalls = true) => {
    const extra = [
      withCalls ? plural(c.calls, "call") : null,
      c.estimated_rows ? `${c.estimated_rows} estimated` : null,
      c.unknown_rows ? `${c.unknown_rows} of unknown cost left out` : null,
    ].filter(Boolean);
    return el("span", { class: "rt" }, [
      money(c.spend_usd || 0),
      extra.length ? el("small", { class: "rt-n" }, extra.join(", ")) : null,
    ]);
  };
  const impl = rs.cells.filter((c) => c.role === "implement");
  const implOk = impl.filter((c) => !c.too_few);
  const implFew = impl.filter((c) => c.too_few);
  const others = rs.cells.filter((c) => c.role !== "implement");
  const pctOf = (v) => pct(v);
  const implTable = implOk.length
    ? dataTable({
        caption: `Implement role${providers.size === 1 ? `, ${[...providers][0]}` : ""}`,
        cls: "routing-table routing-implement",
        columns: [
          { key: "model", label: "Model", format: (v, c) => who(c) },
          { key: "risk", label: "Risk" },
          { key: "stack", label: "Stack" },
          { key: "n", label: "Attempts", numeric: true },
          {
            key: "submission_pct",
            label: "Submitted",
            numeric: true,
            format: (r) => routingRate(r, pctOf),
          },
          {
            key: "rework_pct",
            label: "Rework",
            numeric: true,
            format: (r) => routingRate(r, pctOf),
          },
          {
            key: "first_pass_pct",
            label: "First pass",
            numeric: true,
            format: (r) => routingRate(r, pctOf),
          },
          {
            key: "attempts_per_accepted_change",
            label: "Attempts per accepted",
            numeric: true,
            format: (r) => routingRate(r, String),
          },
          {
            key: "cost_per_accepted_change_usd",
            label: "Cost per accepted",
            numeric: true,
            format: (r, c) =>
              r && c.cost_unknown_rows
                ? el(
                    "span",
                    { title: `${plural(c.cost_unknown_rows, "call")} of unknown cost left out` },
                    [routingRate(r, money)],
                  )
                : routingRate(r, money),
          },
          {
            key: "escaped_defect_pct",
            label: "Escaped",
            numeric: true,
            format: (r) => routingRate(r, pctOf),
          },
          {
            key: "tester_false_greens",
            label: "Tester false greens",
            numeric: true,
            format: (r) => routingRate(r, String),
          },
          { key: "spend_usd", label: "Spend", numeric: true, format: (v, c) => spend(c) },
        ].map((col) => ({ ...col, missing: col.missing || "not served for this cell" })),
        rows: implOk,
      })
    : null;
  const otherTable = others.length
    ? dataTable({
        caption: "Other roles: calls and spend",
        stackOnPhone: true,
        cls: "routing-table routing-other",
        columns: [
          { key: "role", label: "Role" },
          { key: "model", label: "Model", format: (v, c) => who(c) },
          { key: "risk", label: "Risk" },
          { key: "stack", label: "Stack" },
          { key: "n", label: "Calls", numeric: true },
          { key: "spend_usd", label: "Spend", numeric: true, format: (v, c) => spend(c, false) },
        ],
        rows: others,
      })
    : null;
  const r = health.routing || null;
  const defs =
    rs.definitions && typeof rs.definitions === "object" ? Object.entries(rs.definitions) : [];
  return el("section", { class: "card panel routing-panel", "aria-label": "Routing scorecard" }, [
    panelHead(
      "Routing scorecard",
      `${plural(rs.rows, "ledger row")} · ${plural(rs.manifests, "replay manifest")} · minimum n ${rs.min_n}`,
      null,
      { level: 2 },
    ),
    rs.cells.length
      ? null
      : emptyState("No routed call is in the usage ledger yet.", null, null, null, {
          inline: true,
        }),
    implTable
      ? el(
          "p",
          { class: "routing-cap" },
          "What the tickets whose first delivery attempt ran in each cell did; on a phone the table scrolls sideways.",
        )
      : null,
    implTable,
    implFew.length
      ? el(
          "p",
          { class: "routing-few" },
          `Too few to compare (under ${rs.min_n}): ${implFew.map((c) => `${who(c)} · risk ${c.risk} · ${c.stack} (n ${c.n})`).join("; ")}.`,
        )
      : null,
    otherTable,
    r ? el("p", { class: "routing-line" }, r.line) : null,
    el("p", { class: "lane-value-foot" }, rs.footnote || ""),
    defs.length || (Array.isArray(rs.limits) && rs.limits.length)
      ? more("What each column counts", [
          el(
            "dl",
            { class: "md-defs" },
            defs.map(([k, v]) =>
              el("div", {}, [el("dt", {}, k.replace(/_/g, " ")), el("dd", {}, v)]),
            ),
          ),
          Array.isArray(rs.limits)
            ? el(
                "ul",
                { class: "md-limits" },
                rs.limits.map((x) => el("li", {}, x)),
              )
            : null,
        ])
      : null,
  ]);
}

// --- the wage bill's quiet row and the deep reads ------------------------------------

/**
 * The ledger figures that used to fill the scoreboard, as one quiet row for "Where the
 * wages go" (F-A1): skill hit-rate, spend by kind, rework cost share and measured
 * coverage. No sparkline (they are categories, not time: F-B1); a missing figure is a
 * dash with its reason, never a zero (F-E3). The cost per shipped ticket is gone (F-A4):
 * the accepted-change tile carries the price.
 */
function roiRow(health) {
  const skills = health.skills || {};
  const byKind = Array.isArray(health.by_kind) ? health.by_kind : [];
  const total = typeof health.total_usd === "number" ? health.total_usd : 0;
  const top = byKind[0] || null;
  const rework = health.rework || null;
  const cov = health.coverage || null;
  const hit = typeof skills.overall_hit_rate_pct === "number" ? skills.overall_hit_rate_pct : null;
  return el(
    "div",
    { class: "kpi-row roi-row", role: "group", "aria-label": "The wage bill in figures" },
    [
      statCell({
        label: "Skill hit-rate",
        value: hit == null ? null : pct(hit),
        sub:
          hit == null
            ? null
            : `${skills.total_applied ?? 0} of ${skills.total_selected ?? 0} mounted skills applied`,
        reason: "no skill telemetry yet",
        size: "inline",
      }),
      statCell({
        label: "Spend by kind",
        value: top && total > 0 ? pct(((top.total_cost_usd || 0) / total) * 100) : null,
        sub: top && total > 0 ? `on ${top.kind} calls, of ${money(total)}` : null,
        reason: "no spend recorded",
        size: "inline",
      }),
      statCell({
        label: "Rework cost",
        value:
          rework && typeof rework.rework_cost_share_pct === "number" && total > 0
            ? pct(rework.rework_cost_share_pct)
            : null,
        sub:
          rework && total > 0 && typeof rework.total_rework_cost_usd === "number"
            ? `${money(rework.total_rework_cost_usd)} of spend went on rework`
            : null,
        reason: total > 0 ? "no rework data" : "no spend recorded",
        size: "inline",
      }),
      statCell({
        label: "Measured coverage",
        value:
          cov && cov.total_count > 0 && typeof cov.coverage_pct === "number"
            ? pct(cov.coverage_pct)
            : null,
        sub:
          cov && cov.total_count > 0
            ? `${cov.measured_count} of ${cov.total_count} calls measured`
            : null,
        reason: "no ledger rows yet",
        size: "inline",
      }),
    ],
  );
}

/** Recall's weekly effectiveness (UTC weeks from Monday), a gap for a week with none. */
function recallWeeks(byDay) {
  const map = new Map();
  for (const d of Array.isArray(byDay) ? byDay : []) {
    const t = Date.parse(`${d.date}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    const mon = t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
    const b = map.get(mon) || { clean: 0, total: 0 };
    b.clean += d.clean || 0;
    b.total += d.total || 0;
    map.set(mon, b);
  }
  if (!map.size) return [];
  const ks = [...map.keys()].sort((a, b) => a - b);
  const out = [];
  for (let t = ks[0]; t <= ks[ks.length - 1]; t += 7 * DAY) {
    const b = map.get(t);
    out.push({ t, v: b && b.total ? (b.clean / b.total) * 100 : null });
  }
  return out;
}

// --- the page ----------------------------------------------------------------

/**
 * Factory Health / ROI surface. Reads the one /api/health envelope over the chosen
 * window; every source degrades to a dash with its reason, never a broken card.
 */
async function renderHealth() {
  const health = await api("GET", `/api/health?window_days=${windowDays}`).catch(() => null);

  const wrap = el("div", { class: "view health-view" });

  if (!health) {
    wrap.appendChild(viewHead("Health", "The physio room"));
    // The flow panels read their own endpoints, so they still stand without it.
    const panels = await fitnessRoomPanels(null).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return [];
    });
    wrap.appendChild(
      emptyState(
        "Health data unavailable",
        "The health API did not respond. The usage ledger may be unconfigured.",
        "alert",
      ),
    );
    for (const p of panels) wrap.appendChild(p);
    return wrap;
  }

  const skills = health.skills || {};
  const recall = health.recall || { available: false };
  const skillList = Array.isArray(skills.by_skill) ? skills.by_skill : [];
  const eventLog =
    health.event_log && typeof health.event_log.chain_ok === "boolean" ? health.event_log : null;

  // --- The four measures: the board's tiles and the detail under it, repainted when
  // the Referee's record window changes.
  const strip = el("div", {
    class: "sb-cells measure-strip",
    role: "group",
    "aria-label": "The four measures",
  });
  const stripHead = el("div", { class: "measure-head" });
  const detailHost = el("div", { class: "measures-detail-host" });
  const paintMeasures = (h) => {
    const wd = (h.first_pass && h.first_pass.window_days) || windowDays;
    stripHead.replaceChildren(
      panelHead(
        "The four measures",
        `${periodOf(wd)}, against ${beforeOf(wd)} · weeks and months are UTC`,
        { href: "#health-window", text: "Change the window" },
        { level: 2, tone: "reference" },
      ),
    );
    strip.replaceChildren(...measureTiles(h, wd));
    detailHost.replaceChildren(measuresDetail(h));
  };
  paintMeasures(health);
  const onWindow = async (days) => {
    windowDays = WINDOWS.includes(days) ? days : 30;
    const res = await api("GET", `/api/health?window_days=${windowDays}`).catch(() => null);
    if (res) paintMeasures(res);
    return res;
  };

  // --- The deep reads: skill hit-rate and recall. Each is drawn only with data to
  // show; a source that has measured nothing yet is one clause in the line below.
  const unmeasured = [];
  const appliedSkills = skillList
    .filter((s) => (s.applied || 0) > 0 || (s.refused || 0) > 0)
    .sort((a, b) => (b.applied || 0) - (a.applied || 0) || (b.selected || 0) - (a.selected || 0));
  const neverSkills = skillList.filter((s) => !((s.applied || 0) > 0 || (s.refused || 0) > 0));
  const skillPanel = skillList.length
    ? el("section", { class: "card panel skill-panel", "aria-label": "Skill hit-rate" }, [
        panelHead(
          "Skill hit-rate",
          `${plural(skills.total_records || 0, "delivery", "deliveries")} · applied of selected`,
          null,
          { level: 2 },
        ),
        appliedSkills.length
          ? el(
              "div",
              { class: "meter-list skill-list" },
              appliedSkills.map((s) => {
                const n = s.selected || 0;
                const k = s.applied || 0;
                const small = n < MIN_N;
                // A refused read (the hook blocked it: the agent never saw the skill) is
                // shown beside the hit-rate, never counted as use.
                const row = meterRow({
                  name: s.skill,
                  k,
                  n,
                  fmt: () =>
                    `${small ? `${k} of ${n}` : `${pct((k / n) * 100)} · ${k} of ${n}`}${s.refused ? ` · ${s.refused} refused` : ""}`,
                });
                row.dataset.skill = s.skill;
                if (small) row.classList.add("is-small");
                return row;
              }),
            )
          : null,
        neverSkills.length
          ? more(
              `${plural(neverSkills.length, "skill")} selected but never applied`,
              el(
                "p",
                { class: "skill-never-list" },
                neverSkills.map((s) => `${s.skill} (${s.selected})`).join(", "),
              ),
              "skill-never",
            )
          : null,
      ])
    : (unmeasured.push([
        "Skill hit-rate",
        "no skill telemetry yet: it appears once deliveries mount skills",
      ]),
      null);
  const rTotal = (recall.clean || 0) + (recall.reworked || 0) + (recall.blocked || 0);
  const recallHas = recall.available && (recall.effectiveness_pct != null || rTotal > 0);
  const recallPanel = recallHas
    ? el("section", { class: "card panel recall-panel", "aria-label": "Recall effectiveness" }, [
        panelHead("Recall effectiveness", "memory feedback", null, { level: 2 }),
        utcSpark(
          measureTile({
            label: "Recall effectiveness",
            k: recall.clean || 0,
            n: rTotal,
            nLabel: "clean",
            period: "all time",
            series: recallWeeks(recall.by_day),
            note: `Of the deliveries that were served memory, ${recall.reworked || 0} were reworked and ${recall.blocked || 0} blocked${typeof recall.items_adjusted === "number" ? `; ${plural(recall.items_adjusted, "memory item")} adjusted from the outcomes` : ""}.`,
            definition:
              "Of the deliveries Memory served knowledge to, how many went through clean (no rework, not blocked). The memory items behind a reworked or blocked one are marked down.",
            cls: "mt-recall",
          }),
          "weeks",
        ),
        segBar(
          [
            { label: "Clean", value: recall.clean || 0 },
            { label: "Reworked", value: recall.reworked || 0 },
            { label: "Blocked", value: recall.blocked || 0 },
          ],
          { label: "How the deliveries served memory went" },
        ),
      ])
    : (unmeasured.push([
        "Recall effectiveness",
        recall.available
          ? "no recall outcomes recorded yet"
          : recall.reason || "memory is not wired, so recall effectiveness is unavailable",
      ]),
      null);

  // The flow panels (form guide, governance, development flow, treatment table,
  // running now, bouncing, wages): the physio's charts, read from their own endpoints.
  const panels = await fitnessRoomPanels(health, {
    windowDays,
    onWindow,
    roi: roiRow(health),
  }).catch((e) => {
    if (e && e.code === "ABORTED") throw e;
    return [];
  });
  const flat = panels.flatMap((p) => (p.classList.contains("ov-grid") ? [...p.children] : [p]));
  const pick = (cls) => flat.find((p) => p.classList.contains(cls)) || null;
  const formGuide = pick("form-guide");
  const treatment = pick("needs-hero");
  const devFlow = pick("pipeline-panel");
  const gov = pick("gov-panel");
  const running = pick("run-activity");
  const bouncing = pick("bouncing-panel");
  // The wage bill carries the ledger row; if the flow panels could not be read, the row
  // still stands in a card of its own.
  const wages =
    pick("wages-panel") ||
    el("section", { class: "card panel wages-panel", "aria-label": "Where the wages go" }, [
      panelHead("Where the wages go", "usage ledger", null, { level: 2 }),
      roiRow(health),
    ]);
  const fitness = pick("fitness-test");
  const rest = flat.filter(
    (p) => ![formGuide, treatment, devFlow, gov, running, bouncing, wages, fitness].includes(p),
  );

  // The verdict, in one sentence: the ledger first, then how much is on the table.
  // The number is the sum of the lines below it (each ticket counted once).
  const lines = treatment ? [...treatment.querySelectorAll(".needs-item")] : [];
  const onTable = treatment ? Number(treatment.dataset.total || 0) : 0;
  const injured = bouncing ? [...bouncing.querySelectorAll(".bounce-row")] : [];
  const ledgerBroken = eventLog && !eventLog.chain_ok;
  const verdict = ledgerBroken
    ? "The ledger has been altered."
    : onTable
      ? `${plural(onTable, "thing")} on the treatment table.`
      : injured.length
        ? `Fit to play, with ${injured.length === 1 ? "a recurring injury" : "recurring injuries"}.`
        : "Fit to play.";
  // What is on the table, each clause a link to where it is treated; then who keeps
  // coming back, by number (not counted again: they are tickets already above or fit).
  const clauses = [
    ...lines.map((li) => {
      const a = li.querySelector("a.ni-link");
      return el(
        "a",
        { href: a.getAttribute("href"), class: `is-${li.dataset.sev}` },
        a.querySelector(".ni-title")?.textContent || "",
      );
    }),
    injured.length
      ? el("a", { href: "#health-injuries", class: "is-injury" }, [
          // The work first, its number after (muted): "Webhook delivery for task events #4, …".
          injured.slice(0, 3).flatMap((row, i) => {
            const t = {
              number: (row.querySelector(".bounce-num")?.textContent || "").replace(/^#/, ""),
              title: row.querySelector(".bounce-title")?.textContent || "",
            };
            return [i ? ", " : "", ...hlWork(t, `#${t.number}`)];
          }),
          injured.length > 3 ? ` and ${injured.length - 3} more` : "",
          injured.length === 1 ? " keeps coming back" : " keep coming back",
        ])
      : null,
  ].filter(Boolean);
  const lastRead = health.last_record_at ? fmtTime(health.last_record_at) : null;
  const facts = [
    "read from the usage ledger and the event log",
    lastRead
      ? el("span", {}, ["last ledger record ", el("span", { class: "u-nowrap" }, lastRead)])
      : null,
  ].filter(Boolean);
  // TAMPER-EVIDENT LOG: the work_events hash chain, re-derived server-side; every figure
  // on this page is derived from that log. Board small print, as on the Overview; a
  // break reads red, with its glyph and the word.
  const logLine = eventLog
    ? el("p", { class: `view-hero-status physio-log${eventLog.chain_ok ? " ok" : ""}` }, [
        eventLog.chain_ok ? glyph("done", 14) : glyph("failed", 14),
        el(
          "span",
          {},
          eventLog.chain_ok
            ? `Event log intact: ${eventLog.events} events chained`
            : `Event log BROKEN at seq ${eventLog.broken_at_seq} (${eventLog.reason}): every figure here is read from it`,
        ),
      ])
    : null;
  wrap.appendChild(
    el(
      "section",
      {
        class: `scoreboard bleed physio-board${ledgerBroken ? " is-broken" : ""}`,
        "aria-label": "Fitness",
      },
      [
        el("div", { class: "scoreboard-in" }, [
          el("div", { class: "sb-main" }, [
            el("h1", { class: "hl" }, verdict),
            clauses.length
              ? el(
                  "p",
                  { class: "hl-clauses" },
                  clauses.flatMap((c, i) => (i ? [" · ", c] : [c])),
                )
              : null,
            el("p", { class: "hl-sub" }, [
              "Health, the physio room",
              ...facts.flatMap((f) => [" · ", f]),
            ]),
          ]),
          el("section", { class: "measures-board", "aria-label": "The four measures" }, [
            stripHead,
            strip,
          ]),
          logLine ? el("div", { class: "physio-small" }, logLine) : null,
        ]),
      ],
    ),
  );
  // USAGE WINDOW: the runner paused admission after the model refused a call on its
  // usage window / a rate limit. Say so first: it is why nothing is moving.
  const usagePause = health.usage_pause && health.usage_pause.active ? health.usage_pause : null;
  if (usagePause) wrap.appendChild(usagePauseNote(usagePause));
  // Behind the four measures, then the comparison tables: the rest of the quality story.
  wrap.appendChild(detailHost);
  for (const card of [routingCard(health), laneValueCard(health), scoutCard(health)])
    if (card) wrap.appendChild(card);
  if (bouncing) bouncing.id = "health-injuries";
  const wait = treatment ? waitingNote(treatment._waiting) : null;
  if (wait && devFlow) devFlow.appendChild(wait);
  const span = (n, ...nodes) => {
    const kids = nodes.filter(Boolean);
    return kids.length
      ? el("div", { class: `hx-span hx-${n}${kids.length > 1 ? " hx-stack" : ""}` }, kids)
      : null;
  };
  // Failures first, in two columns that each stack. Of three arrangements, take the
  // one whose columns come out nearest in height, counting a hole (a short column
  // ending in a page that cannot stretch) as worse than a stretch (the pitch strip
  // and the fitness rows can take slack).
  const hurt = onTable > 0 ? treatment : null;
  const hT = hurt ? 64 + lines.length * 58 : 0;
  const hB = bouncing ? 100 + injured.length * 64 : 0;
  const hP = devFlow ? 200 : 0;
  const hF = fitness ? 350 : 0;
  const G = 24;
  const sum = (...h) => h.filter(Boolean).reduce((a, x) => a + x + G, -G);
  const plans = [
    // the table beside the injuries and the fitness test; the phases full width under
    {
      cost: hT >= sum(hB, hF) ? hT - sum(hB, hF) : 3 * (sum(hB, hF) - hT),
      grid: () => [span(7, hurt), span(5, bouncing, fitness), span(12, devFlow)],
    },
    // the table and the phases of play beside the injuries and the fitness test
    {
      cost: Math.abs(sum(hT, hP) - sum(hB, hF)),
      grid: () => [span(7, hurt, devFlow), span(5, bouncing, fitness)],
    },
    // a short table stacked with the injuries beside the fitness test; phases under
    {
      cost: sum(hT, hB) >= hF ? 3 * (sum(hT, hB) - hF) : 3 * (hF - sum(hT, hB)),
      grid: () => [span(5, hurt, bouncing), span(7, fitness), span(12, devFlow)],
    },
    // a short table stacked with the injuries and the phases, beside the fitness test
    {
      cost: Math.abs(sum(hT, hB, hP) - hF),
      grid: () => [span(5, hurt, bouncing, devFlow), span(7, fitness)],
    },
  ];
  const plan = hurt ? plans.reduce((a, b) => (b.cost < a.cost ? b : a)) : plans[3];
  const deep = [skillPanel, recallPanel].filter(Boolean);
  wrap.appendChild(
    el("div", { class: "hx-grid" }, [
      ...plan.grid(),
      span(12, formGuide),
      // The wage bill beside the referee's record, then what is running.
      span(7, wages),
      span(5, gov),
      span(12, running),
      span(12, codeIndexCard(health)),
      ...deep.map((p) => span(deep.length > 1 ? 6 : 12, p)),
      ...rest.map((r) => span(12, r)),
    ]),
  );
  if (unmeasured.length)
    wrap.appendChild(
      el("p", { class: "hx-unmeasured" }, [
        el("b", {}, "Not measured yet: "),
        ...unmeasured.flatMap(([k, v], i) => [i ? " · " : "", el("span", {}, `${k}, ${v}`)]),
        ".",
      ]),
    );

  return wrap;
}

export { renderHealth };
