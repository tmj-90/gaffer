// The fitness room panels (Overview and Health): the test lane, bouncing tickets.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { svgBars } from "../charts.js";
import { ensureSquad } from "../club.js";
import { band, panelHead, statCell } from "../components.js";
import { el } from "../dom.js";
import { fmtDuration, money, moneyW, plural } from "../format.js";
import { agentChip, glyph, ycard } from "../icons.js";
import { allTickets } from "../matchday.js";
import { devFlowPanel, needsPanel } from "../panels.js";
import { healthBarRow, runActivityPanel } from "../../app.js";

/**
 * The physio room's flow panels (moved off the Overview, which is the comp's
 * programme now): the Form guide, Governance ROI, the cost line, Development
 * flow, the treatment table (at risk / stale), cycle time and flow efficiency,
 * the "keeps bouncing" list and Running now. Returns the panels in order.
 */
async function fitnessRoomPanels(healthRes) {
  const [{ summary }, ticketsRes, decisionsRes, costRes, bouncingRes, claimsRes, settingsRes] =
    await Promise.all([
      api("GET", "/api/dashboard"),
      allTickets().catch(() => ({ tickets: [] })),
      api("GET", "/decisions").catch(() => ({ decisions: [] })),
      api("GET", "/api/cost").catch(() => null),
      api("GET", "/api/rework/bouncing").catch(() => ({ bouncing: [] })),
      api("GET", "/claims").catch(() => null),
      api("GET", "/api/settings").catch(() => null),
      ensureSquad(),
    ]);

  const byStatus = summary.ticketsByStatus || {};
  const tickets = ticketsRes.tickets || [];
  const decisions = decisionsRes.decisions || [];
  const staleClaims = summary.staleClaims || 0;
  const doneTickets = tickets.filter((t) => t.status === "done");

  // --- real time-series, bucketed by day from ticket + event timestamps -----
  const DAY = 86_400_000;
  const now = Date.now();
  const N = 14;
  const days = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    days.push({ key: d.toISOString().slice(0, 10), lbl: `${d.getDate()}/${d.getMonth() + 1}` });
  }
  // AUTHORITATIVE cycle-time / throughput: read the ONE server-side definition
  // from /api/health (src/health/deliveryFlow.ts) instead of recomputing it here.
  // The server reproduces the former client maths, so displayed numbers are
  // unchanged. Falls back to a zeroed 14-day shape when the endpoint is
  // unavailable, so the KPI cards still render.
  const health = healthRes || {};
  const flowCycle = health.cycle_time || {};
  const flowThr = health.throughput || {};
  const zeroSeries = () => days.map(() => 0);
  const cycleLine =
    Array.isArray(flowCycle.series) && flowCycle.series.length === N
      ? flowCycle.series
      : zeroSeries();
  const doneByDay =
    Array.isArray(flowThr.series) && flowThr.series.length === N ? flowThr.series : zeroSeries();

  // --- distinct, real per-metric daily series (each KPI gets its own shape) --
  // deployments: cumulative tickets shipped (a monotonic delivery curve)
  let depAcc = 0;
  const deploySeries = doneByDay.map((v) => (depAcc += v));
  // lead time: 7-day trailing mean of daily cycle (a smoothed lead trend)
  const leadSeries = cycleLine.map((_, i) => {
    const w = cycleLine.slice(Math.max(0, i - 6), i + 1).filter((x) => x > 0);
    return w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2) : 0;
  });
  // --- headline metrics -----------------------------------------------------
  // Cycle time + throughput are server-authoritative (from /api/health above).
  // cycleVals is retained ONLY to derive the Lead-time percentile below.
  const cycleVals = doneTickets
    .map((t) => (Date.parse(t.updated_at) - Date.parse(t.created_at)) / DAY)
    .filter((x) => x >= 0);
  const cycleTime = typeof flowCycle.median_days === "number" ? flowCycle.median_days : 0;
  const leadTime = cycleVals.length
    ? Math.max(
        ...cycleVals
          .slice()
          .sort((a, b) => a - b)
          .slice(0, Math.ceil(cycleVals.length / 2)),
      ) || cycleTime
    : 0;
  const last7 = typeof flowThr.last7 === "number" ? flowThr.last7 : 0;
  const prev7 = typeof flowThr.prev7 === "number" ? flowThr.prev7 : 0;
  // Flow efficiency is SERVER-ONLY: the median (time an agent worked the ticket /
  // lead time) over shipped tickets, from the transition log (src/health/deliveryFlow.ts).
  // Review, testing, the merge queue, send-backs and holds are waiting, served as
  // `waiting`; time before work began is the backlog. There
  // is no client fallback: the old one was a WIP ratio (done / done + in flight) that
  // read 100% for a single shipped ticket however long it had waited to merge.
  const flowEffServer = health.flow_efficiency || {};
  const flowEff = typeof flowEffServer.median_pct === "number" ? flowEffServer.median_pct : null;
  const flowEffText =
    flowEff == null ? "—" : flowEff > 0 && flowEff < 1 ? "<1" : String(Math.round(flowEff));
  const waiting = health.waiting || {};
  const waitRow = (label, ms, extra) =>
    el("div", {}, [
      el("dt", {}, label),
      el("dd", { class: "tabnum" }, [fmtDuration(ms), extra ? el("small", {}, extra) : null]),
    ]);
  const waitingList =
    waiting.sample > 0
      ? el("dl", { class: "fg-wait", "aria-label": "Where shipped tickets waited, the median" }, [
          waitRow(
            "Waiting to merge",
            waiting.merge_wait_ms,
            waiting.merge_wait_max_ms != null
              ? `longest ${fmtDuration(waiting.merge_wait_max_ms)}`
              : null,
          ),
          waitRow("In review or testing", waiting.review_ms),
          waitRow("Sent back, waiting for rework", waiting.requeued_ms),
          waitRow("Blocked or paused", waiting.held_ms),
          waitRow("Before work started", waiting.backlog_ms),
          el("div", {}, [
            el("dt", {}, "Queued after work began"),
            el("dd", { class: "tabnum" }, [
              waiting.queue_pct != null ? `${Math.round(waiting.queue_pct)}%` : "—",
              el("small", {}, "of lead time: review, merge queue, send-backs, holds"),
            ]),
          ]),
        ])
      : el("p", { class: "section-note" }, "No shipped ticket has a transition history yet.");
  const right = el("div", { class: "fitness-panels stack" });
  const left = right;

  // --- Form guide: the flow numbers, each from the server's one definition ------
  right.appendChild(
    el("section", { class: "card panel form-guide", "aria-label": "Flow" }, [
      panelHead("Form guide", "last 14 days", null, { kit: "claret" }),
      el("div", { class: "kpi-row" }, [
        statCell({
          label: "Cycle time",
          value: cycleTime.toFixed(1),
          unit: "days",
          series: cycleLine,
          flip: "cycle",
        }),
        statCell({
          label: "Throughput",
          value: String(last7),
          unit: "shipped / 7d",
          sub: `${prev7} the week before`,
          series: doneByDay,
          flip: "thr",
        }),
        statCell({
          label: "Flow efficiency",
          value: flowEffText,
          unit: flowEff == null ? null : "%",
          sub: flowEff == null ? "nothing shipped yet" : "of lead time an agent worked",
          flip: "eff",
        }),
        statCell({
          label: "Deployments",
          value: String(doneTickets.length),
          unit: "all-time",
          series: deploySeries,
          flip: "dep",
        }),
        statCell({
          label: "Lead time",
          value: leadTime.toFixed(1),
          unit: "days",
          series: leadSeries,
          flip: "lead",
        }),
      ]),
      // The results by day: the cycle time as a bar per day, and what flow efficiency means.
      el("div", { class: "fg-detail" }, [
        el("div", { class: "fg-chart" }, [
          el("h3", { class: "fg-h" }, "Cycle time, by day"),
          el("div", {
            class: "chart",
            html: svgBars(cycleLine, {
              labels: days.map((d) => d.lbl),
              fmt: (v) => `${(+v).toFixed(1)}d`,
              label: "Median cycle time by day",
              today: true,
              // Drawn at the width it shows at, so its tick labels stay readable.
              ...(window.matchMedia && window.matchMedia("(max-width: 760px)").matches
                ? { width: 360, height: 130 }
                : { width: 720, height: 150 }),
            }),
          }),
        ]),
        el("div", { class: "fg-eff flow-eff" }, [
          el("h3", { class: "fg-h" }, [
            "Flow efficiency ",
            el("b", { class: "tabnum" }, flowEff == null ? "—" : `${flowEffText}%`),
          ]),
          band(
            flowEff ?? 0,
            100,
            flowEff == null
              ? "Flow efficiency not measured yet"
              : `Flow efficiency ${flowEffText}% of lead time with an agent working on the ticket`,
          ),
          el(
            "p",
            { class: "section-note" },
            "The share of each shipped ticket's lead time with an agent working on it (claimed or in progress), the median. Review, testing, the merge queue and holds count as waiting: the transition log shows how long a ticket sat in review, not how long anyone actively reviewed it.",
          ),
          waitingList,
        ]),
      ]),
    ]),
  );

  // --- Governance-ROI panel: does the oversight machinery EARN its cost? -------
  // Merge / rework / unattended-safe rates from /api/health.governance, computed
  // server-side from REAL ticket transitions (src/health/governanceRoi.ts) — never
  // the demo dataset. Window-selectable. Every rate is shown WITH the raw counts it
  // derives from, and an empty window renders an explicit note, never a fake 0%.
  {
    const govPanel = el("section", {
      class: "card panel gov-panel",
      "aria-label": "Referee's record",
    });
    const pct = (r) => (r && typeof r.rate === "number" ? Math.round(r.rate * 100) : null);
    const tile = (label, r, subFn) => {
      const p = pct(r);
      const has = p !== null;
      return el("div", { class: "gov-tile" + (has ? "" : " gov-tile-empty") }, [
        el("div", { class: "gov-tile-label" }, label),
        el("div", { class: "gov-tile-val tabnum" }, has ? p + "%" : "—"),
        el("div", { class: "gov-tile-sub" }, has ? subFn(r) : "no eligible deliveries yet"),
      ]);
    };
    const paint = (gov) => {
      govPanel.replaceChildren();
      const wd = gov && gov.windowDays ? gov.windowDays : 30;
      const sel = el(
        "select",
        {
          class: "gov-window",
          title: "Time window for the governance rates",
          onchange: async (e) => {
            const v = e.target.value;
            const res = await api("GET", "/api/health?window_days=" + v).catch(() => null);
            paint(res && res.governance ? res.governance : { empty: true, windowDays: Number(v) });
          },
        },
        [7, 30, 90, 365].map((n) => {
          const o = el("option", { value: String(n) }, `last ${n}d`);
          if (n === wd) o.selected = true;
          return o;
        }),
      );
      govPanel.appendChild(
        panelHead("Referee's record", "does review earn its keep", null, { kit: "sky" }),
      );
      govPanel.appendChild(
        el("div", { class: "gov-head" }, [
          el(
            "p",
            { class: "gov-note" },
            "Governance ROI, from the factory's own ticket transitions: how often review lets a change through, and whether what it lets through stays shipped.",
          ),
          el("label", { class: "gov-win" }, [el("span", { class: "sr-only" }, "Window"), sel]),
        ]),
      );
      if (!gov || gov.empty) {
        govPanel.appendChild(
          el(
            "div",
            { class: "gov-emptystate" },
            `No deliveries reached a review decision in the last ${wd} days — governance ROI needs shipped/rejected history to measure. Ship some tickets to done first.`,
          ),
        );
        return;
      }
      govPanel.appendChild(
        el("div", { class: "gov-tiles" }, [
          tile(
            "Merge rate",
            gov.mergeRate,
            (r) => `${r.numerator} merged of ${r.denominator} reviewed`,
          ),
          tile(
            "Rework rate",
            gov.reworkRate,
            (r) =>
              `${r.numerator} of ${r.denominator} merged in ${wd} days had been sent back first, by a reviewer, the tester or a failed gate`,
          ),
          tile(
            "Unattended-safe",
            gov.unattendedSafeRate,
            (r) =>
              `${r.numerator} of ${r.denominator} agent-approved merge cycle${r.denominator === 1 ? "" : "s"} stayed shipped` +
              // Observation age: a cycle merged minutes ago is "not reopened YET".
              (Number.isFinite(gov.counts?.youngestUnattendedMergeAgeMs) &&
              gov.counts.youngestUnattendedMergeAgeMs !== null
                ? ` · newest ${fmtDuration(gov.counts.youngestUnattendedMergeAgeMs)} ago`
                : ""),
          ),
        ]),
      );
    };
    paint(health.governance);
    right.appendChild(govPanel);
  }

  // --- Where the wages go: the usage ledger by kind, the top earners, the totals.
  // HONESTY: an API-equivalent estimate from Claude Code usage, not real charges on a
  // Max/Pro subscription. A killed or timed-out call carries a labelled estimate.
  {
    const byKind = Array.isArray(health.by_kind) ? health.by_kind : [];
    const maxKind = Math.max(1, ...byKind.map((k) => k.total_cost_usd || 0));
    const top =
      costRes && Array.isArray(costRes.top_tickets) ? costRes.top_tickets.slice(0, 3) : [];
    const byNum = new Map(tickets.map((t) => [t.number, t]));
    const total =
      costRes && typeof costRes.total_usd === "number" ? costRes.total_usd : health.total_usd;
    const est = costRes ? costRes.estimated_usd : health.estimated_usd;
    const costed = costRes ? costRes.ticket_count : health.ticket_count;
    if (byKind.length || top.length || total > 0)
      right.appendChild(
        el(
          "section",
          {
            class: "card panel wages-panel",
            "aria-label": "Where the wages go",
            title:
              "API-equivalent estimate from Claude Code usage, not real charges on a Max/Pro subscription. Killed or timed-out calls carry a labelled estimate.",
          },
          [
            panelHead(
              "Where the wages go",
              typeof total === "number"
                ? `${money(total)} all-time${est > 0 ? ` incl. ${money(est)} est.` : ""} · ${plural(costed || 0, "ticket")} costed`
                : "usage ledger",
              null,
              { kit: "claret" },
            ),
            el("div", { class: "wg-cols" }, [
              byKind.length
                ? el("div", { class: "hlist" }, [
                    el("h3", { class: "fg-h" }, "By kind of call"),
                    ...byKind.map((k) =>
                      healthBarRow(
                        k.kind,
                        money(k.total_cost_usd),
                        (k.total_cost_usd || 0) / maxKind,
                        "amber",
                      ),
                    ),
                  ])
                : null,
              top.length
                ? el("div", { class: "wg-top" }, [
                    el("h3", { class: "fg-h" }, "Top earners"),
                    el(
                      "ol",
                      { class: "clean wg-earners" },
                      top.map((x) => {
                        const tk = byNum.get(x.ticket);
                        return el("li", {}, [
                          tk
                            ? el(
                                "a",
                                { class: "wg-num tabnum", href: `#/ticket/${tk.id}` },
                                `#${x.ticket}`,
                              )
                            : el("span", { class: "wg-num tabnum" }, `#${x.ticket}`),
                          el("span", { class: "wg-title" }, tk ? tk.title : ""),
                          el("span", { class: "wg-cost tabnum" }, money(x.total_cost_usd)),
                          el("span", { class: "wg-turns" }, plural(x.num_turns || 0, "turn")),
                        ]);
                      }),
                    ),
                  ])
                : null,
            ]),
          ],
        ),
      );
  }

  // --- Development flow + Needs your attention (2-up) -----------------------
  right.appendChild(
    el("div", { class: "ov-grid ov-2" }, [
      devFlowPanel(tickets, byStatus, now),
      needsPanel({ tickets, byStatus, summary, decisions, claims: claimsRes }),
    ]),
  );

  // --- Fitness test: load, queue and faults for the squad, the wage bill and deliveries.
  {
    const setting = (k) => {
      const x = ((settingsRes && settingsRes.settings) || []).find((y) => y.key === k);
      const v = x ? Number(x.effective ?? x.value) : NaN;
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const activeClaims = claimsRes
      ? (claimsRes.claims || []).filter((c) => !c.status || c.status === "active").length
      : null;
    right.appendChild(
      fitnessTestPanel({
        claims: activeClaims,
        onPitch: claimsRes
          ? (claimsRes.claims || []).filter((c) => !c.status || c.status === "active")
          : [],
        slots: setting("GAFFER_CONCURRENCY"),
        ready: byStatus.ready || 0,
        stale: staleClaims,
        budget: setting("GAFFER_DAILY_BUDGET_USD"),
        cost: costRes,
        health,
        last7,
        tickets,
      }),
    );
  }

  // --- "Running now" — what's in flight right now (RUN-ACTIVITY) -----------
  // Polls GET /api/runs every ~3s so a triggered background run (Suggest work /
  // onboard / poll-work / merge) is visible while it churns, with its captured
  // log a click away when it finishes. Quiet empty state when nothing's running.
  left.appendChild(runActivityPanel());

  // --- FAILURE-DIAGNOSIS: "these keep bouncing" quality signal --------------
  // Cross-ticket read model: tickets whose rework trail keeps growing, ranked so
  // the ones repeatedly failing the SAME gate lead. Only shown when something is
  // actually bouncing (a quiet factory shows no panel).
  const bouncing = (bouncingRes && bouncingRes.bouncing) || [];
  if (bouncing.length) {
    right.appendChild(renderBouncingPanel(bouncing));
  }

  return [...right.children];
}

/**
 * The fitness test: for each of the factory's three limits (agent slots, the daily
 * budget, the delivery line) how loaded it is, what queues behind it and what has
 * gone wrong — the USE / RED numbers, each from a response, each with its words.
 */
function fitnessTestPanel({
  claims,
  onPitch = [],
  slots,
  ready,
  stale,
  budget,
  cost,
  health,
  last7,
  tickets = [],
}) {
  const h = health || {};
  const today = cost && typeof cost.today_usd === "number" ? cost.today_usd : null;
  const todayEst =
    cost && typeof cost.today_estimated_usd === "number" ? cost.today_estimated_usd : 0;
  const days = Array.isArray(h.daily_spend) ? h.daily_spend : [];
  const overDays = budget ? days.filter((d) => (d.total_cost_usd || 0) > budget).length : null;
  const rework =
    h.rework && typeof h.rework.rework_cost_share_pct === "number"
      ? h.rework.rework_cost_share_pct
      : null;
  const reworkRows = h.rework && Array.isArray(h.rework.by_ticket) ? h.rework.by_ticket : null;
  const reworked = reworkRows ? reworkRows.length : null;
  // Which tickets were sent back (all-time, from the ledger), and whether any shipped:
  // the referee's record counts only tickets merged in its window.
  const statusOf = new Map(tickets.map((t) => [t.number, t.status]));
  const named = (reworkRows || []).filter((r) => typeof r.ticket === "number");
  const shippedBack = named.filter((r) => statusOf.get(r.ticket) === "done").length;
  const reworkSub =
    rework == null
      ? "no rework data"
      : [
          named.length
            ? `all-time: ${named
                .slice(0, 3)
                .map((r) => `#${r.ticket} ×${r.rework_count}`)
                .join(", ")}${named.length > 3 ? "…" : ""}`
            : "tickets, all-time",
          named.length && statusOf.size
            ? shippedBack
              ? `${shippedBack} since shipped`
              : "none shipped yet"
            : null,
          `${rework}% of spend`,
        ]
          .filter(Boolean)
          .join(" · ");
  const dur = h.duration && h.duration.measured_calls ? h.duration.avg_ms : null;
  const cell = (label, value, sub, opts = {}) =>
    el("div", { class: `ft-cell${opts.bad ? " is-bad" : ""}${opts.needs ? " is-needs" : ""}` }, [
      el("span", { class: "ft-l" }, label),
      el("span", { class: "ft-v tabnum" }, [
        opts.bad ? glyph("failed", 16) : null,
        opts.needs ? ycard(16) : null,
        value,
      ]),
      sub ? el("span", { class: "ft-s" }, sub) : null,
      opts.after || null,
    ]);
  const row = (name, what, cells) =>
    el("div", { class: "ft-row", role: "group", "aria-label": name }, [
      el("div", { class: "ft-name" }, [el("b", {}, name), el("span", {}, what)]),
      ...cells,
    ]);
  const slotsFull = slots && claims != null && claims >= slots;
  const overBudget = budget && today != null && today > budget;
  return el("section", { class: "card prog fitness-test", "aria-label": "Fitness test" }, [
    panelHead("Fitness test", "load · queue · faults", null, { kit: "ink" }),
    el("div", { class: "ft-grid" }, [
      row("Squad", "agent slots", [
        cell(
          "In use",
          claims == null ? "—" : slots ? `${claims}/${slots}` : String(claims),
          slots ? (slotsFull ? "every slot taken" : `${slots - claims} free`) : "no slot limit set",
          {
            after: [
              slots && claims != null
                ? band(claims, slots, `${claims} of ${slots} agent slots in use`)
                : null,
              // Who is in those slots: each agent's shirt and name, and the ticket it holds.
              onPitch.length
                ? el(
                    "ul",
                    { class: "ft-agents", "aria-label": "On the pitch" },
                    onPitch.map((c) =>
                      el("li", {}, [
                        agentChip(c.agent_id, c.agent_display_name, 20),
                        c.ticket_number != null
                          ? el(
                              "a",
                              { class: "ft-agent-t tabnum", href: `#/ticket/${c.ticket_id}` },
                              `#${c.ticket_number}`,
                            )
                          : null,
                      ]),
                    ),
                  )
                : null,
            ],
          },
        ),
        cell(
          "Waiting",
          String(ready),
          ready
            ? `ready, ${slotsFull ? "queued for a slot" : "not yet claimed"}`
            : "nothing queued",
        ),
        cell(
          "Faults",
          String(stale || 0),
          stale ? "stale claims, leases past expiry" : "no stale claims",
          {
            bad: stale > 0,
          },
        ),
      ]),
      row("Wage bill", "daily budget", [
        cell(
          "Spent today",
          today == null ? "—" : money(today),
          budget ? `of ${moneyW(budget)} a day` : "no daily budget set",
          {
            bad: !!overBudget,
            after:
              budget && today != null
                ? band(today, budget, `${money(today)} of ${moneyW(budget)} daily budget spent`)
                : null,
          },
        ),
        cell(
          "Days over",
          overDays == null ? "—" : String(overDays),
          overDays == null
            ? "set a daily budget to measure"
            : `of ${plural(days.length, "day")} with spend`,
          { bad: overDays > 0 },
        ),
        cell(
          "Estimated",
          money(todayEst),
          todayEst ? "today, for killed or timed-out calls" : "no estimates today",
        ),
      ]),
      row("Deliveries", "the delivery line", [
        cell("Rate", String(last7 || 0), "shipped in 7 days"),
        cell("Reworked", reworked == null ? "—" : String(reworked), reworkSub),
        cell(
          "Per call",
          dur == null ? "—" : fmtDuration(dur),
          dur == null
            ? "no measured calls"
            : `mean over ${plural(h.duration.measured_calls, "call")}`,
        ),
      ]),
    ]),
  ]);
}

/**
 * FAILURE-DIAGNOSIS: the cross-ticket "these keep bouncing" panel. Each row is a
 * ticket with a growing rework trail; the "same gate ×N" chip is the key signal —
 * a ticket stuck failing one gate repeatedly is the operator's cue to intervene.
 */
function renderBouncingPanel(bouncing) {
  return el("div", { class: "card panel bouncing-panel" }, [
    panelHead(
      "Recurring injuries",
      `${plural(bouncing.length, "ticket")} ${bouncing.length === 1 ? "keeps" : "keep"} bouncing`,
      null,
      {
        kit: "red",
      },
    ),
    el(
      "p",
      { class: "dim bouncing-sub" },
      "Tickets sent back the most. One that fails the same gate again and again needs a human.",
    ),
    el(
      "ul",
      { class: "bouncing-list" },
      bouncing.map((b) => {
        const ref = b.number != null ? `#${b.number}` : b.ticket_id.slice(0, 8);
        const sameGate =
          b.top_gate && b.top_gate_count > 1
            ? el(
                "span",
                {
                  class: "bounce-samegate",
                  title: `Failed the ${b.top_gate} gate ${b.top_gate_count} times`,
                },
                `${b.top_gate} ×${b.top_gate_count}`,
              )
            : null;
        return el(
          "li",
          {},
          el("a", { class: "bounce-row", href: `#/ticket/${b.ticket_id}` }, [
            el("span", { class: "bounce-num" }, ref),
            el("span", { class: "bounce-title" }, b.title || "(untitled)"),
            el("span", { class: "bounce-count", title: "Total rework attempts" }, [
              el("b", { class: "tabnum" }, `${b.rework_count}×`),
              " sent back",
            ]),
            sameGate,
          ]),
        );
      }),
    ),
  ]);
}

export { fitnessRoomPanels };
