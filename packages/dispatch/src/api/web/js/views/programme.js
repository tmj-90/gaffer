// The programme pages: cup runs, injuries, league table, wage bill, form, full time, fixtures, match report.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentTitle, agentWho, roLock } from "../access.js";
import { actorName, agentNames, squad } from "../club.js";
import { panelHead } from "../components.js";
import { el } from "../dom.js";
import { WEEKDAYS, fmtDay, fmtTime, money, moneyW, parseJsonSafe, plural } from "../format.js";
import { clockTime } from "../freshness.js";
import { agentShirt, glyph, repoTag } from "../icons.js";
import { OFF_PITCH, benchedCampaignLine, svgS } from "../matchday.js";
import { humanizeEvent, renderFeedRow } from "../panels.js";
import { statusBadge, statusLabel } from "../status.js";
import { computePhases, openPlanBuild, pausedInfo, repoRelative } from "../../app.js";

// --- The programme pages -----------------------------------------------------

/** A programme page: a kit-colour title block over a 2px ink frame. */
function progPage(cls, kit, title, aux, body) {
  return el("section", { class: `card prog ${cls}`, "aria-label": title }, [
    panelHead(title, aux, null, { kit }),
    ...[].concat(body),
  ]);
}

/** Cup runs: every epic as rounds (dependency depth); the acceptance ticket is the Final. */
function cupRuns(f) {
  if (!f.epics.length) {
    return progPage("campaigns", "sky", "Cup runs", "epics, by phase", [
      el("p", { class: "quiet" }, [
        "No cup runs yet. ",
        roLock(
          el(
            "button",
            { class: "btn-link", type: "button", onclick: () => openPlanBuild() },
            "Plan a build",
          ),
        ),
        " and the epic lands here as rounds.",
      ]),
    ]);
  }
  return progPage(
    "campaigns",
    "sky",
    "Cup runs",
    "epics, by phase",
    // A held campaign leads: it is the one that needs a look.
    f.epics
      .map((e, i) => ({ e, i, held: e.members.some((t) => OFF_PITCH.has(t.status)) }))
      .sort((a, b) => b.held - a.held || a.i - b.i)
      .map(({ e }) => {
        const deps = new Map(
          e.members.map((t) => [
            t.id,
            (f.details.get(t.id)?.dependencies || []).map((d) => d.depends_on_ticket_id),
          ]),
        );
        const byPhase = computePhases(e.members, deps);
        const phases = [...byPhase.keys()].sort((a, b) => a - b).map((p) => byPhase.get(p));
        const held = e.members
          .filter((t) => OFF_PITCH.has(t.status))
          .sort((a, b) => a.number - b.number);
        const heldIds = new Set(held.map((t) => t.id));
        const waits = e.members
          .filter((t) => (deps.get(t.id) || []).some((d) => heldIds.has(d)))
          .sort((a, b) => a.number - b.number);
        const done = e.members.filter((t) => t.status === "done").length;
        return el("article", { class: `cup${held.length ? " is-held" : ""}` }, [
          el("header", { class: "cup-head" }, [
            el("h3", {}, el("a", { href: `#/epics/${e.node.id}` }, e.node.name)),
            el(
              "p",
              { class: held.length ? "cup-why is-red" : "cup-why" },
              held.length
                ? [
                    glyph("blocked", 16),
                    `Held at #${held[0].number}${waits.length ? `: ${waits.map((t) => "#" + t.number).join(", ")} wait on it.` : "."}`,
                  ]
                : `${done} of ${e.members.length} done. ${benchedCampaignLine(e.members) || "Nothing is holding it."}`,
            ),
          ]),
          el(
            "ol",
            { class: "rounds" },
            phases.map((ph, i) =>
              el("li", { class: "round" }, [
                el(
                  "span",
                  { class: "round-name" },
                  i === phases.length - 1 &&
                    phases.length > 1 &&
                    ph.some((t) => /^Acceptance/i.test(t.title))
                    ? "Final"
                    : `Round ${i + 1}`,
                ),
                el(
                  "ul",
                  {},
                  ph
                    .slice()
                    .sort((a, b) => a.number - b.number)
                    .map((t) =>
                      el("li", { class: `tie st-${t.status}` }, [
                        el(
                          "a",
                          {
                            href: `#/ticket/${t.id}`,
                            "aria-label": `#${t.number} ${statusLabel(t.status, t.landing_state)}: ${t.title}`,
                          },
                          [
                            glyph(t.status, 16),
                            el("b", {}, `#${t.number}`),
                            el("span", { class: "tie-t" }, t.title),
                          ],
                        ),
                      ]),
                    ),
                ),
              ]),
            ),
          ),
        ]);
      }),
  );
}

/** Why a failed or paused ticket is out: the pause event, or the last failing gate. */
function injuryWhy(f, t) {
  const d = f.details.get(t.id);
  if (t.status === "paused") {
    const p = d ? pausedInfo(d.events || []) : {};
    if (p.reason === "budget_cap")
      return `Stopped at its budget cap: ${p.spend || "its spend"} spent${t.delivery_budget_usd != null || d?.ticket?.delivery_budget_usd != null ? ` of ${money(Number(d?.ticket?.delivery_budget_usd ?? t.delivery_budget_usd))}` : ""}.`;
    if (p.reason === "timeout") return "Stopped at the wall-clock timeout.";
    return `Stopped at the turn cap${p.turns != null ? ` (${p.turns} turns)` : ""}.`;
  }
  const trail = d?.rework_trail || [];
  if (trail.length) {
    const last = trail[trail.length - 1];
    const first =
      repoRelative(last.distilled_failure)
        .split("\n")
        .find((l) => l.trim()) || "";
    return `Failed the ${last.gate} gate${first ? `: ${first.slice(0, 140)}` : "."}`;
  }
  const ev = (d?.evidence || []).find((e) => /FAIL/.test(e.summary || ""));
  if (ev) {
    const g = String(ev.summary).match(/\[FAIL\]\s+(\w+)\s*\(([^)]+)\)\s*[—-]\s*([^\n]+)/);
    const err = String(ev.summary)
      .split("\n")
      .find((l) => /^Error/.test(l.trim()));
    if (g)
      return `The ${g[1]} gate failed in ${g[2]} (${g[3].trim()})${err ? `: ${err.trim().slice(0, 120)}` : "."}`;
  }
  return "Failed its gates.";
}
function injuryList(f) {
  const list = f.tickets.filter((t) => t.status === "failed" || t.status === "paused");
  return progPage(
    "injuries",
    "red",
    "Injury list",
    "failed or paused",
    list.length
      ? el(
          "ul",
          { class: "inj-list" },
          list.map((t) =>
            el("li", {}, [
              el("p", { class: "inj-top" }, [
                statusBadge(t.status, t.landing_state),
                el("a", { href: `#/ticket/${t.id}` }, `#${t.number} ${t.title}`),
              ]),
              el("p", { class: "inj-why" }, injuryWhy(f, t)),
              f.repoOf.get(t.id)
                ? el("p", { class: "inj-meta" }, repoTag(f.repoOf.get(t.id), 18))
                : null,
            ]),
          ),
        )
      : el("p", { class: "quiet" }, "No failed or paused tickets."),
  );
}

function leagueTable(f) {
  const spend = new Map(((f.cost && f.cost.by_repo) || []).map((r) => [r.repo, r.total_cost_usd]));
  const rows = (f.summary.repoProgress || [])
    .slice()
    .sort((a, b) => b.pct - a.pct || b.done - a.done);
  const head = ["Pos", "Repo", "Tickets", "Done", "In play", "Blocked", "Spend", "Done %"];
  return progPage(
    "league",
    "claret",
    "League table",
    "repos by share done",
    rows.length
      ? el("div", { class: "lt-wrap" }, [
          el("table", { class: "lt" }, [
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                head.map((h, i) => el("th", { scope: "col", class: i > 1 ? "num" : null }, h)),
              ),
            ),
            el(
              "tbody",
              {},
              rows.map((r, i) =>
                el("tr", {}, [
                  el("td", { class: "pos" }, String(i + 1)),
                  el("th", { scope: "row" }, repoTag(r.repo, 20)),
                  el("td", { class: "num" }, String(r.total)),
                  el("td", { class: "num" }, String(r.done)),
                  el("td", { class: "num" }, String(r.inFlight ?? 0)),
                  el(
                    "td",
                    { class: `num${r.blocked ? " is-red" : ""}` },
                    r.blocked ? [glyph("blocked", 12), " ", String(r.blocked)] : "0",
                  ),
                  el("td", { class: "num" }, spend.has(r.repo) ? money(spend.get(r.repo)) : "—"),
                  el("td", { class: "num" }, [
                    el(
                      "span",
                      { class: "pct-bar", "aria-hidden": "true" },
                      el("span", { style: { width: `${r.pct}%` } }),
                    ),
                    `${r.pct}%`,
                  ]),
                ]),
              ),
            ),
          ]),
        ])
      : el("p", { class: "quiet" }, "No repos with tickets yet."),
  );
}

/** Daily spend bars against the budget line, drawn at real pixel width. */
function wageSvg(f, W) {
  const daily = ((f.health && f.health.daily_spend) || [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const spend = new Map(daily.map((d) => [d.date, d.total_cost_usd]));
  const todayKey = new Date(f.now).toISOString().slice(0, 10);
  const days = [];
  const startKey = daily[0]?.date || todayKey;
  const start = new Date(startKey + "T00:00:00Z");
  const end = new Date(todayKey + "T00:00:00Z");
  // At most the last 21 days, so a long season stays readable.
  for (
    let d = new Date(Math.max(start.getTime(), end.getTime() - 20 * 864e5));
    d <= end;
    d = new Date(d.getTime() + 864e5)
  )
    days.push(d.toISOString().slice(0, 10));
  const budget = f.budget || 0;
  const narrow = W < 480;
  const H = narrow ? 200 : 220,
    padL = 36,
    padR = 4,
    padB = 36,
    padT = 22;
  const max = Math.max(budget, ...days.map((d) => spend.get(d) || 0), 1);
  const bw = (W - padL - padR) / days.length,
    gap = Math.max(3, Math.min(8, bw * 0.18));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const svg = svgS("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    class: "wage-chart",
    role: "img",
    "aria-label": `Daily spend from ${fmtDay(days[0] + "T12:00:00Z", { weekday: false })} to today: ${days
      .map(
        (d) =>
          `${fmtDay(d + "T12:00:00Z", { weekday: false })} ${spend.has(d) ? money(spend.get(d)) : "none recorded"}`,
      )
      .join(", ")}.${budget ? ` Daily budget ${moneyW(budget)}.` : ""}`,
  });
  const stepV = max > 40 ? 10 : 5;
  for (let v = 0; v <= max; v += stepV) {
    svg.append(
      svgS("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }),
      svgS("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, "$" + v),
    );
  }
  if (budget) {
    svg.append(
      svgS("line", { x1: padL, x2: W - padR, y1: y(budget), y2: y(budget), class: "budget-line" }),
      svgS(
        "text",
        { x: W - padR, y: y(budget) - 6, "text-anchor": "end", class: "budget-t" },
        `Daily budget ${moneyW(budget)}`,
      ),
    );
  }
  const topDay = [...spend.entries()]
    .filter(([d]) => d !== todayKey && days.includes(d))
    .sort((p, q) => q[1] - p[1])[0]?.[0];
  days.forEach((d, i) => {
    const v = spend.get(d),
      x = padL + gap / 2 + i * bw,
      today = d === todayKey,
      w = Math.max(1, bw - gap),
      cx = x + w / 2;
    if (v != null) {
      svg.append(
        svgS(
          "rect",
          {
            x,
            y: y(v),
            width: w,
            height: Math.max(1, y(0) - y(v)),
            class: today ? "bar bar-today" : "bar",
          },
          svgS("title", {}, `${fmtDay(d + "T12:00:00Z")}: ${money(v)}`),
        ),
      );
      // Every day carries its figure: in full where the bar is wide enough, to
      // the dollar where it is not (the bar's title keeps the cents).
      const full = today || bw >= 36 || d === topDay;
      if (full || bw >= 22) {
        const anchor = today && cx + 26 > W ? "end" : "middle";
        svg.append(
          svgS(
            "text",
            {
              x: anchor === "end" ? x + w : cx,
              y: y(v) - 6,
              "text-anchor": anchor,
              class: today ? "val val-today" : "val",
            },
            full ? money(v) : v >= 9.5 ? `$${Math.round(v)}` : `$${v.toFixed(1)}`,
          ),
        );
      }
    } else
      svg.append(
        svgS("text", { x: cx, y: y(0) - 5, "text-anchor": "middle", class: "val none" }, "–"),
      );
    const dd = new Date(d + "T12:00:00Z");
    svg.append(
      svgS(
        "text",
        { x: cx, y: H - 20, "text-anchor": "middle", class: "tick" },
        String(dd.getUTCDate()),
      ),
    );
    if (dd.getUTCDay() === 1 || i === 0)
      svg.append(
        svgS(
          "text",
          { x: cx, y: H - 4, "text-anchor": "middle", class: "tick tick-s" },
          WEEKDAYS[dd.getUTCDay()],
        ),
      );
  });
  return svg;
}
function wageBill(f) {
  const h = f.health || {};
  const host = el("div", { class: "wage-host" });
  let lastW = 0;
  const fit = () => {
    const w = Math.floor(host.clientWidth);
    // A host caught mid-layout (narrower than the axis plus a few px a day)
    // would draw negative bars; wait for its real width.
    if (w < 160 || Math.abs(w - lastW) < 2) return;
    lastW = w;
    host.replaceChildren(wageSvg(f, w));
  };
  host.append(wageSvg(f, 360));
  host._fit = fit;
  const kinds = Array.isArray(h.by_kind) ? h.by_kind : [];
  const top = (f.cost && f.cost.top_tickets && f.cost.top_tickets[0]) || null;
  const topT = top ? f.byNo.get(top.ticket) : null;
  const cov =
    h.coverage && typeof h.coverage.coverage_pct === "number" ? h.coverage.coverage_pct : null;
  const est = f.cost && f.cost.estimated_usd > 0 ? f.cost.estimated_usd : 0;
  const sec = progPage(
    "wage",
    "ink",
    "Wage bill",
    f.cost && typeof f.cost.total_usd === "number"
      ? `${money(f.cost.total_usd)} this season`
      : null,
    [
      host,
      el(
        "p",
        { class: "wage-note" },
        `Days with no spend recorded show a dash. API-equivalent cost from the usage ledger${cov != null ? ` (${cov}% of calls measured)` : ""}${est ? `; ${money(est)} is a labelled estimate for killed calls` : ""}.`,
      ),
      el("dl", { class: "wage-facts" }, [
        el("div", {}, [
          el("dt", {}, "Per shipped ticket"),
          el("dd", {}, [
            money(h.cost_per_shipped_usd),
            el("small", {}, h.shipped_count != null ? `over ${h.shipped_count} shipped` : ""),
          ]),
        ]),
        // Every attempt counted (parked, failed and abandoned tickets included) over the
        // tickets that reached done: what an accepted change really cost.
        el("div", {}, [
          el("dt", {}, "Per accepted change"),
          el("dd", {}, [
            money(h.accepted_change?.cost_per_accepted_change_usd),
            el(
              "small",
              {},
              h.accepted_change && h.accepted_change.attempts_per_accepted_change != null
                ? `every attempt counted · ${h.accepted_change.attempts_per_accepted_change} attempts each`
                : "",
            ),
          ]),
        ]),
        el("div", {}, [
          el("dt", {}, "Spent on rework"),
          el("dd", {}, [
            money(h.rework?.total_rework_cost_usd),
            el(
              "small",
              {},
              // Rework = delivery spend on the attempts after a reviewer, the tester
              // or a failed gate sent the ticket back (the ledger's attempt timeline).
              h.rework?.rework_cost_share_pct != null
                ? `${h.rework.rework_cost_share_pct}% of spend, on attempts after a send-back`
                : "",
            ),
          ]),
        ]),
        el("div", {}, [
          el("dt", {}, "Top earner"),
          el(
            "dd",
            {},
            top
              ? [
                  topT
                    ? el("a", { href: `#/ticket/${topT.id}` }, `#${top.ticket}`)
                    : `#${top.ticket}`,
                  el("small", {}, `${money(top.total_cost_usd)}, ${top.num_turns} turns`),
                ]
              : "—",
          ),
        ]),
      ]),
      kinds.length
        ? el(
            "div",
            {
              class: "kind-bar",
              role: "img",
              "aria-label":
                "Spend by kind: " +
                kinds.map((k) => `${k.kind} ${money(k.total_cost_usd)}`).join(", "),
            },
            kinds.map((k, i) =>
              el("span", {
                class: `kb kb-${Math.min(i, 4)}`,
                style: { flexGrow: k.total_cost_usd || 0 },
              }),
            ),
          )
        : null,
      kinds.length
        ? el(
            "ul",
            { class: "kind-key" },
            kinds.map((k, i) =>
              el("li", {}, [
                el("span", { class: `kb-sw kb-${Math.min(i, 4)}` }),
                `${k.kind} ${money(k.total_cost_usd)}`,
              ]),
            ),
          )
        : null,
    ],
  );
  sec._arrive = fit;
  return sec;
}

/** Squad & form: each agent, what it is on now, and every ticket it claimed (where it is now). */
function squadForm(f) {
  const history = new Map();
  for (const e of f.events) {
    if (e.event_type !== "claim.created" || !e.actor_id) continue;
    const nm = e.actor_id;
    (history.get(nm) || history.set(nm, []).get(nm)).push({
      id: e.entity_id,
      n: e.ticket_number,
      at: e.created_at,
    });
  }
  const claimByAgent = new Map(f.claims.map((c) => [c.agent_id, c]));
  // In shirt order (numbered first), then by name: the team sheet's running order.
  const agents = f.agents
    .filter((a) => a.agent_type !== "human")
    .map((a) => ({ a, w: agentWho(a.id, a.display_name) }))
    .sort(
      (x, y) =>
        (x.w.no ? Number(x.w.no) : 1e3) - (y.w.no ? Number(y.w.no) : 1e3) ||
        x.w.name.localeCompare(y.w.name),
    );
  const onPitch = f.claims.length;
  return progPage(
    "squad",
    "sky",
    "Squad & form",
    f.slots ? `${onPitch} of ${f.slots} on the pitch` : `${onPitch} on the pitch`,
    agents.length
      ? [
          el(
            "ul",
            { class: "sq-list" },
            agents.map(({ a, w }) => {
              const claim = claimByAgent.get(a.id);
              const t = claim ? f.byId.get(claim.ticket_id) : null;
              const run = claim ? f.runByTicket.get(claim.ticket_number) : null;
              const rework = t
                ? (f.details.get(t.id)?.events || [])
                    .filter((e) => e.event_type === "ticket.reworking")
                    .pop()
                : null;
              const rw = rework ? parseJsonSafe(rework.payload_json) : null;
              const form = (history.get(a.id) || [])
                .sort((x, y) => x.at.localeCompare(y.at))
                .slice(-6);
              return el("li", { class: `sq-row${claim ? " is-on" : ""}` }, [
                agentShirt(w.name, 56, w.no),
                el("div", { class: "sq-body" }, [
                  el("p", { class: "sq-name", title: agentTitle(w) }, [
                    w.name,
                    w.no ? el("span", { class: "sq-no tabnum" }, ` No. ${Number(w.no)}`) : null,
                  ]),
                  el(
                    "p",
                    { class: "sq-now" },
                    claim
                      ? [
                          t
                            ? el("a", { href: `#/ticket/${t.id}` }, `On #${claim.ticket_number}`)
                            : `On #${claim.ticket_number}`,
                          t ? ` · ${statusLabel(t.status, t.landing_state).toLowerCase()}` : "",
                          run
                            ? run.num_turns
                              ? ` · ${run.phase ? run.phase + " · " : ""}${run.num_turns} turns · ${money(run.cost_usd)}`
                              : " · just claimed"
                            : "",
                          rw && rw.attempt
                            ? el(
                                "span",
                                { class: "is-warn" },
                                ` · rework ${rw.attempt}/${rw.max_attempts} on ${rw.gate || "gates"}`,
                              )
                            : null,
                        ]
                      : `On the bench. Last seen ${a.last_seen_at ? fmtTime(a.last_seen_at) : "never"}.`,
                  ),
                  form.length
                    ? el("p", { class: "sq-form" }, [
                        el("span", { class: "sq-form-l" }, "Form"),
                        el(
                          "span",
                          { class: "form-row" },
                          form.map((x) => {
                            const ft = f.byId.get(x.id);
                            const st = ft ? ft.status : "draft";
                            return el(
                              "a",
                              {
                                href: `#/ticket/${x.id}`,
                                class: `form-chip st-${st}`,
                                title: `#${x.n} ${statusLabel(st)}`,
                                "aria-label": `#${x.n} now ${statusLabel(st)}`,
                              },
                              [glyph(st, 14), String(x.n)],
                            );
                          }),
                        ),
                      ])
                    : null,
                ]),
              ]);
            }),
          ),
          el(
            "p",
            { class: "quiet small" },
            "Form: the tickets each agent claimed recently, oldest first, with where each one is now.",
          ),
        ]
      : el("p", { class: "quiet" }, "No agents registered yet."),
  );
}

function fullTime(f) {
  const done = f.tickets
    .filter((t) => t.status === "done")
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 6);
  const spend = new Map(
    ((f.cost && f.cost.top_tickets) || []).map((t) => [t.ticket, t.total_cost_usd]),
  );
  return progPage(
    "results",
    "ink",
    "Full time",
    "recently done",
    done.length
      ? el(
          "ul",
          { class: "res-list" },
          done.map((t) =>
            el("li", {}, [
              el("span", { class: "res-ft", "aria-hidden": "true" }, "FT"),
              el("time", { datetime: t.updated_at }, fmtDay(t.updated_at, { weekday: false })),
              el("a", { href: `#/ticket/${t.id}` }, [el("b", {}, `#${t.number}`), " ", t.title]),
              el(
                "span",
                { class: "res-cost" },
                spend.has(t.number) ? money(spend.get(t.number)) : "",
              ),
            ]),
          ),
        )
      : el("p", { class: "quiet" }, "Nothing delivered yet."),
  );
}

function fixtures(f) {
  const ready = f.tickets
    .filter((t) => t.status === "ready")
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.number - b.number);
  return progPage(
    "fixtures",
    "sky",
    "Fixtures",
    `${ready.length} ready`,
    ready.length
      ? el(
          "ul",
          { class: "fx-list" },
          ready.slice(0, 8).map((t) => {
            const deps = (f.details.get(t.id)?.dependencies || []).filter(
              (d) => !d.satisfied && d.status !== "done",
            );
            const red = deps.some((d) => OFF_PITCH.has(d.status));
            return el("li", {}, [
              glyph("ready", 16),
              el("a", { href: `#/ticket/${t.id}` }, [el("b", {}, `#${t.number}`), " ", t.title]),
              el(
                "span",
                { class: red ? "fx-gate is-red" : "fx-gate" },
                deps.length
                  ? `waits on ${deps.map((d) => `#${d.number} (${statusLabel(d.status).toLowerCase()})`).join(", ")}`
                  : "next up",
              ),
            ]);
          }),
        )
      : el("p", { class: "quiet" }, "No ticket is ready to be claimed."),
  );
}

/**
 * The match report: the latest moves as commentary, minute by minute. Each line
 * is one real event: when (HH:MM), the state it left the ticket in (§6 glyph),
 * who did it (an agent's shirt and name, priya.raman, the runner) and what, with
 * the from → to read from the ticket's own event payload when the detail cache
 * has it. Book-keeping (evidence rows, criteria added, repo links) is left off
 * the commentary but kept, every event, in the folded full log beneath.
 */
const REPORT_QUIET = new Set([
  "evidence.recorded",
  "ac.added",
  "ac.edited",
  "ac.removed",
  "ticket.repo_linked",
  "ticket.repo_access_set",
  "ticket.testable_set",
  "ticket.test_contract_set",
  "ticket.budget_set",
  "ticket.repo_delivery_recorded",
  "ticket.acceptance_criteria_reset",
]);
const PITCH_WORD = { ready_for_merge: "To merge" };
function reportLine(f, e) {
  const det = f.details.get(e.entity_id);
  const full = det?.events?.find((x) => x.id === e.id);
  const p = full?.payload_json ? parseJsonSafe(full.payload_json) || {} : {};
  const word = (st) => PITCH_WORD[st] || statusLabel(st);
  switch (e.event_type) {
    case "ticket.created":
      return { st: "draft", say: "created" };
    case "ticket.transitioned":
      return p.to
        ? { st: p.to, say: [p.from ? `${word(p.from)} → ` : "→ ", el("b", {}, word(p.to))] }
        : { st: null, say: "moved" };
    case "claim.created":
      return { st: "claimed", say: "claimed" };
    case "claim.completed":
      return { st: null, say: "claim completed" };
    case "claim.released":
      return { st: null, say: "claim released" };
    case "ticket.reworking":
      return {
        st: "failed",
        say: p.attempt
          ? `back for rework ${p.attempt}/${p.max_attempts}${p.gate ? ` on ${p.gate}` : ""}`
          : "back for rework",
      };
    case "ticket.delivery_recorded":
      return { st: "in_review", say: "delivery recorded" };
    case "ticket.blocked":
      return { st: "blocked", say: "parked: it needs you" };
    case "ticket.usage_limited":
      return {
        st: "ready",
        say: p.paused_until
          ? `held back: usage limit, until ${fmtTime(p.paused_until)}`
          : "held back: usage limit",
      };
    case "ticket.paused":
      return {
        st: "paused",
        say: p.reason ? `paused (${String(p.reason).replace(/_/g, " ")})` : "paused",
      };
    case "ticket.routed_to_testing":
      return { st: "in_testing", say: "sent to testing" };
    case "ticket.dependency_added":
      return {
        st: null,
        say: p.depends_on_number ? `now waits on #${p.depends_on_number}` : "gains a dependency",
      };
    case "decision.created":
      return { st: "decision", say: "a question for the gaffer" };
    case "epic.created":
      return { st: null, say: "epic created" };
    default:
      return { st: null, say: humanizeEvent(e.event_type).toLowerCase() };
  }
}
function matchReport(f) {
  // A claim writes two events in the same instant (the claim and the move to
  // Claimed): the report says it once, as the move.
  const movedAt = new Set(
    f.events
      .filter((e) => e.event_type === "ticket.transitioned")
      .map((e) => `${e.entity_id}@${String(e.created_at).slice(0, 19)}`),
  );
  const lines = f.events
    .filter((e) => !REPORT_QUIET.has(e.event_type))
    .filter(
      (e) =>
        e.event_type !== "claim.created" ||
        !movedAt.has(`${e.entity_id}@${String(e.created_at).slice(0, 19)}`),
    )
    .slice(0, 10);
  let day = "";
  const half = Math.ceil(lines.length / 2);
  const rows = lines.map((e, i) => {
    const { st, say } = reportLine(f, e);
    const d = fmtDay(e.created_at);
    const head = d !== day ? (day = d) : null;
    const agent =
      e.actor_type === "agent" &&
      e.actor_id &&
      (squad.byId.has(e.actor_id) || agentNames.has(e.actor_id))
        ? agentWho(e.actor_id)
        : null;
    const who = actorName(e.actor_type, e.actor_id);
    const ref =
      e.ticket_number != null
        ? el(
            "a",
            { class: "mr-ref", href: `#/ticket/${e.entity_id}`, title: e.ticket_title || "" },
            `#${e.ticket_number}`,
          )
        : null;
    const cls = [
      "mr-row",
      st ? `mr-${st}` : "",
      i >= half ? "is-col-b" : "",
      i % half === 0 ? "is-col-top" : "",
    ];
    return el("li", { class: cls.filter(Boolean).join(" ") }, [
      el("time", { class: "mr-min tabnum", datetime: e.created_at }, [
        head ? el("span", { class: "mr-day" }, head) : null,
        clockTime(Date.parse(e.created_at)),
      ]),
      st ? glyph(st, 16) : el("span", { class: "mr-dot", "aria-hidden": "true" }),
      el("p", { class: "mr-say" }, [
        ref,
        ref ? " " : null,
        e.ticket_title ? el("span", { class: "mr-t" }, e.ticket_title) : null,
        el("span", { class: "mr-what" }, [" ", say]),
      ]),
      el("span", { class: "mr-who", title: agent ? agentTitle(agent) : who }, [
        agent ? agentShirt(agent.name, 26, agent.no) : null,
        // A 40-character display name gives way (ellipsis) before the row does.
        el("span", { class: "mr-who-name" }, who),
      ]),
    ]);
  });
  const evs = f.events.slice(0, 30);
  return progPage(
    "report",
    "ink",
    "Match report",
    f.events.length ? `the latest ${plural(lines.length, "event")}` : null,
    lines.length || evs.length
      ? [
          lines.length
            ? el("ol", { class: "mr-list", style: { "--mr-rows": String(half) } }, rows)
            : null,
          el("details", { class: "mr-all" }, [
            el("summary", {}, `Every event, book-keeping included (latest ${evs.length})`),
            el("ul", { class: "feed" }, evs.map(renderFeedRow)),
          ]),
        ]
      : el(
          "p",
          { class: "quiet" },
          "No activity recorded yet. The report starts with the first ticket.",
        ),
  );
}

export {
  progPage,
  cupRuns,
  injuryList,
  leagueTable,
  wageBill,
  squadForm,
  fullTime,
  fixtures,
  matchReport,
};
