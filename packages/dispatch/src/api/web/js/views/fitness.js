// The fitness room panels (Overview and Health): the test lane, bouncing tickets.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { barChart, chartFigure } from "../charts.js";
import { ensureSquad } from "../club.js";
import { band, measureTile, meter, meterRow, panelHead, statCell } from "../components.js";
import { el } from "../dom.js";
import { MISSING, fmtDuration, money, moneyW, pct, plural } from "../format.js";
import { agentChip, glyph, ycard } from "../icons.js";
import { allTickets } from "../matchday.js";
import { devFlowPanel, needsPanel } from "../panels.js";
import { runActivityPanel } from "../runs.js";

/**
 * The physio room's flow panels (moved off the Overview, which is the comp's
 * programme now): the Form guide, Governance ROI, the cost line, Development
 * flow, the treatment table (at risk / stale), cycle time and flow efficiency,
 * the "keeps bouncing" list and Running now. Returns the panels in order.
 *   opts: { windowDays, onWindow(days) -> Promise<health | null>, roi }: the window the
 *   page shows, what the Referee's record select calls to re-read every measure over a
 *   new window (it repaints the governance tiles from what comes back), and the wage
 *   bill's row of ledger figures.
 */
async function fitnessRoomPanels(healthRes, opts = {}) {
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

  // --- real time-series, bucketed by day from ticket + event timestamps -----
  const DAY = 86_400_000;
  const now = Date.now();
  const N = 14;
  const days = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    // UTC days, as the server buckets them (one convention: the weeks are UTC too).
    days.push({
      key: d.toISOString().slice(0, 10),
      lbl: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`,
    });
  }
  // AUTHORITATIVE cycle time and throughput: the ONE server-side definition from
  // /api/health (src/health/deliveryFlow.ts). A figure the server did not send is no
  // figure: a dash with its reason, never a zero.
  const health = healthRes || {};
  const flowCycle = health.cycle_time || {};
  const flowThr = health.throughput || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // The median over every shipped ticket (null when nothing has shipped), with p75/p90.
  const cycleTime = num(flowCycle.median_days);
  const p75 = num(flowCycle.p75_days);
  const p90 = num(flowCycle.p90_days);
  const last7 = num(flowThr.last7);
  const prev7 = num(flowThr.prev7);
  // Flow efficiency is SERVER-ONLY: the median (time an agent worked the ticket /
  // lead time) over shipped tickets, from the transition log (src/health/deliveryFlow.ts).
  // Review, testing, the merge queue, send-backs and holds are waiting, served as
  // `waiting`; time before work began is the backlog. There
  // is no client fallback: the old one was a WIP ratio (done / done + in flight) that
  // read 100% for a single shipped ticket however long it had waited to merge.
  const flowEffServer = health.flow_efficiency || {};
  const flowEff = typeof flowEffServer.median_pct === "number" ? flowEffServer.median_pct : null;
  const effN = typeof flowEffServer.sample === "number" ? flowEffServer.sample : null;
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
              pct(waiting.queue_pct),
              el("small", {}, "of lead time: review, merge queue, send-backs, holds"),
            ]),
          ]),
        ])
      : el("p", { class: "section-note" }, "No shipped ticket has a transition history yet.");
  const right = el("div", { class: "fitness-panels stack" });
  const left = right;

  // --- Form guide: the flow numbers, each from the server's one definition ------
  // The daily series as {t, v} on the 14-day UTC grid: the sparklines and the chart
  // read time, never categories (F-B1); a day with no completion is a gap (F-B2).
  // A series the server did not serve is no series (never a zeroed fallback drawn as
  // if it were data): no sparkline, and the chart's days read "no data".
  const dayT = days.map((d) => Date.parse(`${d.key}T00:00:00Z`));
  const served = (s) => Array.isArray(s) && s.length === N;
  const timed = (s) => (served(s) ? s.map((v, i) => ({ t: dayT[i], v })) : undefined);
  // The readout names the UTC day, as the chart and its table do (never the local date).
  const utcDayWords = (t) => {
    const d = new Date(t);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1} (UTC)`;
  };
  const phone = !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
  const cycleRows = days.map((d, i) => ({
    label: d.lbl,
    value: served(flowCycle.series) ? flowCycle.series[i] : null,
    n: Array.isArray(flowCycle.series_n) ? flowCycle.series_n[i] : null,
  }));
  // The window each figure covers, as a chip on its cell (F-E2).
  const chip = (text) => el("span", { class: "fg-period" }, text);
  const daysTxt = (v) => (v == null ? "" : `${v.toFixed(1)}d`);
  right.appendChild(
    el("section", { class: "card panel form-guide", "aria-label": "Flow" }, [
      panelHead("Form guide", "how work flows to done", null, { level: 2 }),
      el("div", { class: "kpi-row" }, [
        statCell({
          label: "Cycle time",
          value: cycleTime == null ? null : cycleTime.toFixed(1),
          unit: "days",
          reason: "nothing has shipped yet",
          sub: [
            chip("every shipped ticket"),
            cycleTime == null
              ? null
              : ` median; p75 ${daysTxt(p75) || MISSING}, p90 ${daysTxt(p90) || MISSING}`,
          ],
          series: timed(flowCycle.series),
          seriesFmt: (v) => fmtDuration(v * DAY),
          seriesFmtT: utcDayWords,
          flip: "cycle",
          size: "row",
          cls: "fg-cycle",
        }),
        statCell({
          label: "Throughput",
          value: last7 == null ? null : String(last7),
          unit: "shipped",
          reason: "not served by this server",
          sub: [chip("last 7 days"), prev7 == null ? null : ` ${prev7} the 7 days before`],
          series: timed(flowThr.series),
          seriesFmt: (v) => `${v} shipped`,
          seriesFmtT: utcDayWords,
          flip: "thr",
          size: "row",
          cls: "fg-throughput",
        }),
        statCell({
          label: "Flow efficiency",
          value: flowEff == null ? null : flowEffText,
          unit: "%",
          reason: "nothing has shipped yet",
          sub: [
            chip("every shipped ticket"),
            flowEff == null
              ? null
              : ` median of ${plural(effN ?? 0, "ticket")}: time an agent worked`,
          ],
          flip: "eff",
          size: "row",
          cls: "fg-eff-cell",
        }),
      ]),
      // The results by day: the cycle time as a bar per day, and what flow efficiency means.
      el("div", { class: "fg-detail" }, [
        // The shared chart figure: bars capped at 24px with nice ticks in a unit that
        // fits (minutes for a 2-minute cycle, never "0.0 days"), focusable bars with one
        // tooltip, and a table view (F-B4). It plots the mean of each day's completions,
        // and says so.
        chartFigure({
          title: "Cycle time, by day",
          caption:
            "The mean of the tickets completed each UTC day over the last 14 days; a day with none has no bar. Today's bar, once there is one, is picked out.",
          cls: "fg-chart",
          chart: barChart({
            rows: cycleRows,
            unit: "days",
            label: "Mean cycle time by UTC day",
            current: cycleRows.length - 1,
            // Drawn at the width it shows at, so its tick labels stay readable.
            ...(phone ? { width: 360, height: 170 } : { width: 720, height: 190 }),
          }),
          columns: [
            { key: "label", label: "Day (UTC)" },
            {
              key: "value",
              label: "Mean cycle time",
              numeric: true,
              missing: "no completion that day",
            },
            { key: "n", label: "Completed", numeric: true },
          ],
          rows: cycleRows.map((r) => ({
            label: r.label,
            value: r.value == null ? null : fmtDuration(r.value * DAY),
            n: r.n,
          })),
        }),
        el("div", { class: "fg-eff flow-eff" }, [
          panelHead("Flow efficiency", flowEff == null ? null : `${flowEffText}% median`, null, {
            level: 3,
          }),
          // A share with no limit: a meter on a 0-100 track, no limit tick (F-D2).
          meter({
            value: flowEff ?? 0,
            max: 100,
            ariaLabel:
              flowEff == null
                ? "Flow efficiency not measured yet"
                : `Flow efficiency ${flowEffText}% of lead time with an agent working on the ticket`,
          }),
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
  // server-side from REAL ticket transitions (src/health/governanceRoi.ts), never
  // the demo dataset. Each rate is a measure tile with its counts, its window chip and
  // its Wilson interval; an empty window renders an explicit note, never a fake 0%.
  // The window select drives this panel AND the four measures on the board (the page's
  // onWindow re-reads them all and hands the governance back here).
  {
    const govPanel = el("section", {
      class: "card panel gov-panel",
      "aria-label": "Referee's record",
    });
    const tile = (label, r, wd, nLabel, definition) =>
      r && typeof r.denominator === "number" && r.denominator > 0
        ? measureTile({
            label,
            k: r.numerator,
            n: r.denominator,
            nLabel,
            period: `last ${wd} days`,
            definition,
            cls: "gov-tile",
          })
        : measureTile({
            label,
            value: null,
            period: `last ${wd} days`,
            note: "No eligible deliveries in this window.",
            cls: "gov-tile gov-tile-empty",
          });
    // The newest change wins: a slower, older read never repaints over a newer choice.
    let asked = 0;
    const paint = (gov, failedDays = null) => {
      // A repaint replaces the select: keep the keyboard on it.
      const refocus = !!document.activeElement && document.activeElement.id === "health-window";
      govPanel.replaceChildren();
      const wd = gov && gov.windowDays ? gov.windowDays : opts.windowDays || 30;
      const sel = el(
        "select",
        {
          id: "health-window",
          class: "gov-window",
          title: "Time window for the referee's record and the four measures",
          onchange: async (e) => {
            const v = Number(e.target.value);
            const mine = ++asked;
            const res = opts.onWindow
              ? await opts.onWindow(v)
              : await api("GET", "/api/health?window_days=" + v).catch(() => null);
            if (mine !== asked || (res && res.superseded)) return;
            // A failed read is not an empty window: keep what is showing and say so.
            if (!res) return paint(gov, v);
            paint(res.governance ? res.governance : { empty: true, windowDays: v });
          },
        },
        [7, 30, 90, 365].map((n) => {
          const o = el("option", { value: String(n) }, `last ${n}d`);
          if (n === wd) o.selected = true;
          return o;
        }),
      );
      govPanel.appendChild(
        panelHead("Referee's record", "does review earn its keep", null, { level: 2 }),
      );
      govPanel.appendChild(
        el("div", { class: "gov-head" }, [
          el(
            "p",
            { class: "gov-note" },
            "From the factory's own ticket transitions: how often review lets a change through, and whether what it lets through stays shipped. The window also sets the four measures.",
          ),
          el("label", { class: "gov-win" }, [el("span", { class: "sr-only" }, "Window"), sel]),
        ]),
      );
      if (refocus) sel.focus();
      if (failedDays)
        govPanel.appendChild(
          el(
            "p",
            { class: "gov-failed", role: "status" },
            `Could not read the last ${failedDays} days; still showing the last ${wd} days.`,
          ),
        );
      if (!gov || gov.empty) {
        govPanel.appendChild(
          el(
            "div",
            { class: "gov-emptystate" },
            `No deliveries reached a review decision in the last ${wd} days: governance needs shipped or rejected history to measure. Ship some tickets to done first.`,
          ),
        );
        return;
      }
      govPanel.appendChild(
        el("div", { class: "gov-tiles" }, [
          tile(
            "Merge rate",
            gov.mergeRate,
            wd,
            "reviewed were merged",
            "Of the deliveries that reached a review decision in the window, how many were merged.",
          ),
          tile(
            "Rework rate",
            gov.reworkRate,
            wd,
            "merged had been sent back",
            "Of the tickets merged in the window, how many had been sent back first, by a reviewer, the tester or a failed gate (the runner's own retries count here, unlike first-pass acceptance).",
          ),
          tile(
            "Unattended-safe",
            gov.unattendedSafeRate,
            wd,
            "agent-approved stayed shipped",
            `Of the agent-approved merge cycles in the window, how many were never reopened.${
              Number.isFinite(gov.counts?.youngestUnattendedMergeAgeMs)
                ? ` The newest merged ${fmtDuration(gov.counts.youngestUnattendedMergeAgeMs)} ago, so it has had little time to be reopened.`
                : ""
            }`,
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
    const maxKind = Math.max(0, ...byKind.map((k) => k.total_cost_usd || 0));
    const top =
      costRes && Array.isArray(costRes.top_tickets) ? costRes.top_tickets.slice(0, 3) : [];
    const byNum = new Map(tickets.map((t) => [t.number, t]));
    const total =
      costRes && typeof costRes.total_usd === "number" ? costRes.total_usd : health.total_usd;
    const est = costRes ? costRes.estimated_usd : health.estimated_usd;
    const costed = costRes ? costRes.ticket_count : health.ticket_count;
    if (byKind.length || top.length || total > 0 || opts.roi)
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
              { level: 2 },
            ),
            // The ledger figures in one quiet row (they left the scoreboard: F-A1).
            opts.roi || null,
            el("div", { class: "wg-cols" }, [
              byKind.length
                ? el("div", { class: "wg-kinds" }, [
                    panelHead("By kind of call", null, null, { level: 3 }),
                    // Bars against the largest kind; a kind at zero draws no sliver (F-D1).
                    el(
                      "div",
                      { class: "meter-list" },
                      byKind.map((k) =>
                        meterRow({
                          name: k.kind,
                          k: k.total_cost_usd || 0,
                          n: maxKind,
                          fmt: () => money(k.total_cost_usd),
                        }),
                      ),
                    ),
                  ])
                : null,
              top.length
                ? el("div", { class: "wg-top" }, [
                    panelHead("Top earners", null, null, { level: 3 }),
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
    panelHead("Fitness test", "load · queue · faults", null, { level: 2 }),
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
        cell(
          "Rate",
          last7 == null ? MISSING : String(last7),
          last7 == null ? "not served by this server" : "shipped in 7 days",
        ),
        cell("Sent back (all time)", reworked == null ? MISSING : String(reworked), reworkSub),
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
      { level: 2 },
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
