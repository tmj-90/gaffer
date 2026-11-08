// View: Health / ROI.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { svgSpark } from "../charts.js";
import { emptyState, kpiCard, panelHead, viewHead } from "../components.js";
import { el } from "../dom.js";
import { fmtDuration, fmtTime, money, plural } from "../format.js";
import { icon } from "../icons.js";
import { hlWork } from "../matchday.js";
import { waitingNote } from "../panels.js";
import { fitnessRoomPanels } from "./fitness.js";

// --- Health / ROI view ------------------------------------------------------

/** One labelled figure in the recall-effectiveness panel. */
function recallStat(label, value) {
  return el("div", { class: "recall-stat" }, [
    el("span", { class: "recall-stat-val tabnum" }, value),
    el("span", { class: "recall-stat-label" }, label),
  ]);
}

/** A generic name · value · progress-bar row (reused for kinds + skills). */
function healthBarRow(name, valueText, ratio, tone) {
  const pct = Math.max(2, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100));
  return el("div", { class: `hrow tone-${tone || "accent"}` }, [
    el("span", { class: "hrow-name", title: name }, name),
    el("span", { class: "hrow-val tabnum" }, valueText),
    el("span", { class: "df-bar" }, el("i", { style: `width:${pct}%` })),
  ]);
}

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

/**
 * The four top-level measures every feature must move (Release A metrics): first-pass
 * acceptance, human review time (the median per accepted ticket), accepted-change cost
 * and the escaped-defect rate. Each reads a server figure as served (null shows a dash,
 * never a zero) with the sentence that says what it counts; the escaped-defect rate
 * counts only the regression links a person filed, and says so.
 */
/**
 * The active (approximate) review time beside the basis note: the last open in a round to
 * the decision, capped, labelled as an approximation. Empty when the server has none.
 */
function activeNote(a) {
  if (!a || !a.per_accepted_ticket || a.per_accepted_ticket.median_ms == null) return "";
  return ` Active, approximate: median ${fmtDuration(a.per_accepted_ticket.median_ms)} per accepted ticket (last open to decision, capped at ${fmtDuration(a.cap_ms)}).`;
}

function fourMeasures(health) {
  const fp = health.first_pass || null;
  const rt = health.review_time || null;
  const ac = health.accepted_change || null;
  const esc = health.escaped_defects || null;
  const pct = (v) => (typeof v === "number" ? `${v}%` : "—");
  const per = rt && rt.per_accepted_ticket ? rt.per_accepted_ticket : null;
  const cell = (label, value, note) =>
    el("div", {}, [el("dt", {}, label), el("dd", {}, [value, el("small", {}, note)])]);
  const fpNote = !fp
    ? "not served by this server"
    : fp.done
      ? `${fp.first_pass} of ${fp.done} done with no send-back after review · human-approved ${pct(fp.by_approver?.human?.rate_pct)} of ${fp.by_approver?.human?.done ?? 0}, agent-approved ${pct(fp.by_approver?.agent?.rate_pct)} of ${fp.by_approver?.agent?.done ?? 0}`
      : "nothing has been accepted yet";
  const rtNote = !rt
    ? "not served by this server"
    : per && per.n
      ? `median of ${per.n} accepted · p75 ${fmtDuration(per.p75_ms)} · p90 ${fmtDuration(per.p90_ms)}. ${rt.basis_note || ""}${activeNote(rt.active)}`
      : rt.basis_note || "no accepted ticket has a human review decision yet";
  const acNote =
    ac && ac.cost_per_accepted_change_usd != null
      ? `every attempt counted${ac.attempts_per_accepted_change != null ? ` · ${ac.attempts_per_accepted_change} attempts each` : ""}`
      : "nothing has been accepted yet";
  return el("section", { class: "card panel measures-panel", "aria-label": "The four measures" }, [
    panelHead("The four measures", "what every feature has to move", null, { kit: "ink" }),
    el("dl", { class: "measures-facts" }, [
      cell("First-pass acceptance", fp ? pct(fp.rate_pct) : "—", fpNote),
      cell(
        "Human review time",
        per && per.median_ms != null ? fmtDuration(per.median_ms) : "—",
        rtNote,
      ),
      cell(
        "Accepted-change cost",
        ac && ac.cost_per_accepted_change_usd != null
          ? money(ac.cost_per_accepted_change_usd)
          : "—",
        acNote,
      ),
      cell(
        "Escaped-defect rate",
        !esc
          ? "—"
          : esc.recorded && typeof esc.rate_pct === "number"
            ? `${esc.rate_pct}%`
            : esc.recorded
              ? "—"
              : "Not recorded yet",
        !esc
          ? "not served by this server"
          : esc.recorded
            ? `${esc.escaped ?? 0} of ${esc.accepted_changes ?? 0} accepted in the last ${esc.window_days ?? 30} days linked to a later regression · ${esc.all_time && typeof esc.all_time.rate_pct === "number" ? `${esc.all_time.rate_pct}%` : "—"} all time. ${esc.note || ""}`
            : (esc.note || "").replace(/^Not recorded yet:\s*/, ""),
      ),
    ]),
    // ADAPTIVE TESTER LANE: where the independent tester is off and why (the server's
    // one-line notice per repository with no registered test command).
    // LANE-SETTING CONSISTENCY: the runner's recorded lane differs from this dashboard's
    // (the server puts that notice first); said as a warning, not a dim note.
    ...(health.tester_lane && Array.isArray(health.tester_lane.notices)
      ? health.tester_lane.notices.map((n, i) =>
          el(
            "p",
            {
              class:
                i === 0 && health.tester_lane.runner_differs
                  ? "measures-notice warn-text"
                  : "measures-notice dim",
            },
            n,
          ),
        )
      : []),
  ]);
}

/**
 * WHAT EACH LANE CHANGED (D1): per judging lane, how often its verdict differed from the
 * person's decision on the same attempt, how often it was the only lane on a send-back,
 * and its ledger cost per attempt; "no verdicts recorded" where a lane has none. Counts
 * only: the footnote says nothing here recommends switching a lane off, and that a safety
 * lane is never switched off by telemetry. Null when the server does not serve it.
 */
function laneValueCard(health) {
  const lv = health.lane_value || null;
  if (!lv || !Array.isArray(lv.lanes)) return null;
  const line = (l) => {
    if (l.note)
      return el("li", { dataset: { lane: l.lane } }, [
        el("strong", {}, l.label),
        el("span", { class: "dim" }, ` ${l.note}`),
      ]);
    // BLINDING: the eval judge's comparisons, split by whether the person had opened its
    // view before deciding. Only the blind ones are independent of the grade.
    const b = l.blinding;
    const facts = [
      `${plural(l.verdicts_recorded, "verdict")}`,
      l.compared
        ? `differed from the person ${l.differed} of ${l.compared} (${l.differed_lane_blocked} it blocked and the person passed, ${l.differed_lane_passed} it passed and the person sent back)`
        : "no attempt a person also decided",
      ...(b && l.compared
        ? [
            `blind decisions: differed ${b.blind.differed} of ${b.blind.compared}; after the judge's view was opened: ${b.revealed.differed} of ${b.revealed.compared} (the grade may have swayed those)`,
          ]
        : []),
      `only lane on ${plural(l.unique_catches, "send-back")}`,
      l.cost_per_attempt_usd == null
        ? "no ledger spend of its own"
        : `${money(l.cost_per_attempt_usd)} per attempt over ${plural(l.ledger_attempts, "ledger attempt")}`,
    ];
    return el("li", { dataset: { lane: l.lane } }, [
      el("strong", {}, l.label),
      l.safety ? el("span", { class: "lane-value-safety" }, " safety lane") : null,
      el("span", {}, ` ${facts.join(" · ")}`),
    ]);
  };
  return el(
    "section",
    { class: "card panel lane-value-panel", "aria-label": "What each lane changed" },
    [
      panelHead(
        "What each lane changed",
        `${plural(lv.attempts, "attempt")} · ${lv.attempts_with_person_decision} decided by a person`,
        null,
        { kit: "ink" },
      ),
      el("ul", { class: "lane-value-list" }, lv.lanes.map(line)),
      el(
        "p",
        { class: "lane-value-foot" },
        `${lv.send_backs_no_lane_caught} of ${plural(lv.send_backs, "send-back")} no lane asked for. ${lv.footnote || ""}`,
      ),
    ],
  );
}

/**
 * CODE INDEX (delta gap 1): each repo's index coverage (files, exported symbols, imports
 * resolved, test links, when built and at which commit) and how often the Review's
 * callers row listed callers. Counts as served; null when the server sends neither.
 */
function codeIndexCard(health) {
  const ic = health.impact_callers || null;
  const ci = health.code_index || null;
  if (!ic && !ci) return null;
  const repos = ci && ci.available && Array.isArray(ci.repos) ? ci.repos : [];
  const repoLine = (r) => {
    const st = r.stats || {};
    return el("li", { dataset: { repo: r.repo } }, [
      el("strong", {}, r.repo),
      el(
        "span",
        {},
        ` ${plural(st.files || 0, "file")} (${st.testFiles || 0} tests) · ${plural(st.exportedSymbols || 0, "exported symbol")} · ${st.refs || 0} imports resolved, ${st.unresolved || 0} unresolved · ${plural(st.testLinks || 0, "test link")} over ${plural(st.modulesWithTests || 0, "module")}`,
      ),
      el(
        "small",
        { class: "dim" },
        ` built ${r.builtAt ? fmtTime(r.builtAt) : "?"} at ${r.commit ? String(r.commit).slice(0, 8) : "an unknown commit"}${st.capsHit && st.capsHit.length ? ` · cap hit: ${st.capsHit.join(", ")}` : ""}`,
      ),
    ]);
  };
  const callersLine = !ic
    ? "not served by this server"
    : ic.known
      ? `The Review's callers row listed callers in ${ic.listed} of ${plural(ic.known, "review open")} (${ic.none_changed} had no changed symbol to list, ${ic.not_analysed} were not analysed)${ic.opens > ic.known ? `; ${ic.opens - ic.known} earlier opens did not record it` : ""}.`
      : "No review open has recorded the callers row yet.";
  return el("section", { class: "card panel code-index-panel", "aria-label": "Code index" }, [
    panelHead("Code index", "files, symbols, imports and tests, by import text", null, {
      kit: "ink",
    }),
    el("p", { class: "code-index-callers" }, callersLine),
    repos.length
      ? el("ul", { class: "lane-value-list code-index-list" }, repos.map(repoLine))
      : el(
          "p",
          { class: "dim" },
          ci && !ci.available
            ? `Index coverage: ${ci.reason || "Memory is not configured."}`
            : "No repo has a code index yet (it is built at onboard and refreshed after each merge).",
        ),
  ]);
}

/**
 * PRE-WORK SCOUT (delta gap 3): what the runner's scout gave the delivery attempts (items
 * from the code index vs named only, risk raised, model scout runs and their cost) and
 * first-pass acceptance split by what it found. Counts as served, no recommendation;
 * null when the server sends none.
 */
function scoutCard(health) {
  const sc = health.scout || null;
  if (!sc) return null;
  const pct = (v) => (v === null || v === undefined ? "n/a" : `${v}%`);
  const fp = sc.first_pass || {};
  const arm = (k, label) => {
    const c = fp[k] || { done: 0, first_pass: 0, rate_pct: null };
    return el("li", { dataset: { arm: k } }, [
      el("strong", {}, label),
      el(
        "span",
        {},
        ` ${pct(c.rate_pct)} first-pass (${c.first_pass} of ${plural(c.done, "done ticket")})`,
      ),
    ]);
  };
  const ms = sc.model_scout || { runs: 0 };
  const usd = "$" + Number(ms.cost_usd || 0).toFixed(4);
  const head = sc.attempts
    ? `${plural(sc.attempts, "delivery attempt")} scouted on ${plural(sc.tickets, "ticket")}: the code index added files in ${sc.with_index_items}, named files and stack frames only in ${sc.named_only}, nothing found in ${sc.empty}. The risk was raised in ${sc.risk_raised}.`
    : "No delivery has been scouted yet (the runner scouts before each delivery).";
  const model = ms.runs
    ? `Model scout: ${plural(ms.runs, "run")}, ${plural(ms.kept_files, "file")} kept, ${ms.dropped} dropped as not in the checkout, ${usd}${ms.cost_unknown ? ` (${ms.cost_unknown} of unknown cost)` : ""}.`
    : "Model scout: no run (the read-only model scout is off by default).";
  return el("section", { class: "card panel scout-panel", "aria-label": "Pre-work scout" }, [
    panelHead("Pre-work scout", "what each delivery started with, and how it went", null, {
      kit: "ink",
    }),
    el("p", { class: "scout-coverage" }, head),
    el("p", { class: "scout-model dim" }, model),
    el("ul", { class: "lane-value-list scout-first-pass" }, [
      arm("index_items", "Index added files:"),
      arm("named_only", "Named only:"),
      arm("nothing_found", "Nothing found:"),
      arm("no_record", "Not scouted:"),
    ]),
    el("p", { class: "lane-value-foot" }, (sc.limits || []).join("; ")),
  ]);
}

/**
 * ROUTING SCORECARD (delta gap 4): per provider x model x role x work class, what each
 * routed model did, with n on every figure; a cell under the minimum reads "too few to
 * compare" and shows no rate. Cells come in the server's fixed order, never ranked, and
 * there is no composite score. The one Routing line says whether `wg routing recommend`
 * has an advisory registry change to show; nothing is applied from here. Null when the
 * server sends no scorecard.
 */
function routingCard(health) {
  const rs = health.routing_scorecard || null;
  if (!rs || !Array.isArray(rs.cells)) return null;
  const rate = (r, unit) => {
    if (!r) return "n/a";
    if (r.value === null || r.value === undefined) return `too few to compare (n=${r.n})`;
    const v = unit === "$" ? money(r.value) : unit === "%" ? `${r.value}%` : `${r.value}`;
    return `${v} (n=${r.n})`;
  };
  const line = (c) => {
    const head = `${c.role} · ${c.provider} · ${c.model} · risk ${c.risk} · stack ${c.stack}`;
    if (c.too_few)
      return el("li", { dataset: { role: c.role, model: c.model } }, [
        el("strong", {}, head),
        el("span", { class: "dim" }, ` n=${c.n} · ${c.note || "too few to compare"}`),
      ]);
    const spend = `${money(c.spend_usd || 0)} over ${plural(c.calls, "call")}${c.estimated_rows ? `, ${c.estimated_rows} estimated` : ""}${c.unknown_rows ? `, ${c.unknown_rows} of unknown cost left out` : ""}`;
    const facts =
      c.role === "implement"
        ? [
            `n=${c.n}`,
            `submitted ${rate(c.submission_pct, "%")}`,
            `rework ${rate(c.rework_pct, "%")}`,
            `first pass ${rate(c.first_pass_pct, "%")}`,
            `attempts per accepted change ${rate(c.attempts_per_accepted_change, "")}`,
            `cost per accepted change ${rate(c.cost_per_accepted_change_usd, "$")}${c.cost_unknown_rows ? ` (${plural(c.cost_unknown_rows, "call")} of unknown cost left out)` : ""}`,
            `escaped ${rate(c.escaped_defect_pct, "%")}`,
            `tester false greens ${rate(c.tester_false_greens, "")}`,
            spend,
          ]
        : [`n=${c.n}`, spend];
    return el("li", { dataset: { role: c.role, model: c.model } }, [
      el("strong", {}, head),
      el("span", {}, ` ${facts.join(" · ")}`),
    ]);
  };
  const r = health.routing || null;
  return el("section", { class: "card panel routing-panel", "aria-label": "Routing scorecard" }, [
    panelHead(
      "Routing scorecard",
      `${plural(rs.rows, "ledger row")} · ${plural(rs.manifests, "replay manifest")} · minimum n ${rs.min_n}`,
      null,
      { kit: "ink" },
    ),
    rs.cells.length
      ? el("ul", { class: "lane-value-list routing-cells" }, rs.cells.map(line))
      : el("p", { class: "dim" }, "No routed call is in the usage ledger yet."),
    r ? el("p", { class: "routing-line" }, r.line) : null,
    el("p", { class: "lane-value-foot" }, rs.footnote || ""),
  ]);
}

/**
 * Factory Health / ROI surface. Reads the ONE authoritative /api/health envelope
 * and renders the ROI KPI row (cost/feature, skill hit-rate, spend-by-kind,
 * rework-cost share, measured-coverage %) plus the two newly-wired dead sources:
 * the skill selected-vs-applied hit-rate detail and the recall-effectiveness
 * trend. Every source degrades gracefully — a missing one renders a clean "—" /
 * "not wired" cell rather than a broken card.
 */
async function renderHealth() {
  const health = await api("GET", "/api/health").catch(() => null);

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
  const byKind = Array.isArray(health.by_kind) ? health.by_kind : [];
  const skillList = Array.isArray(skills.by_skill) ? skills.by_skill : [];
  const dailySpend = Array.isArray(health.daily_spend) ? health.daily_spend : [];
  const totalUsd = typeof health.total_usd === "number" ? health.total_usd : 0;
  const eventLog =
    health.event_log && typeof health.event_log.chain_ok === "boolean" ? health.event_log : null;

  // --- ROI KPI row ----------------------------------------------------------
  const costPerFeature = health.cost_per_shipped_usd; // ticket-level (epic deferred)
  const hitRate =
    typeof skills.overall_hit_rate_pct === "number" ? skills.overall_hit_rate_pct : null;
  const topKind = byKind[0] || null;
  const kindShare =
    topKind && totalUsd > 0 ? Math.round(((topKind.total_cost_usd || 0) / totalUsd) * 100) : 0;
  const reworkShare =
    health.rework && typeof health.rework.rework_cost_share_pct === "number"
      ? health.rework.rework_cost_share_pct
      : 0;
  const coveragePct =
    health.coverage && typeof health.coverage.coverage_pct === "number"
      ? health.coverage.coverage_pct
      : 0;

  const spendSeries = dailySpend.map((d) => d.total_cost_usd || 0);
  const skillSeries = skillList.map((s) => s.hit_rate_pct || 0);
  const kindSeries = byKind.map((k) => k.total_cost_usd || 0);
  const recallSeries =
    recall.available && Array.isArray(recall.by_day)
      ? recall.by_day.map((d) => d.effectiveness_pct || 0)
      : [];

  const kpis = el("div", { class: "sb-cells kpi-row", role: "group", "aria-label": "Fitness" }, [
    kpiCard({
      label: "Cost / feature",
      value: costPerFeature == null ? "—" : money(costPerFeature),
      unit: "per shipped",
      tone: "accent",
      delta: 0,
      goodWhenDown: true,
      series: spendSeries.length ? spendSeries : [0],
    }),
    kpiCard({
      label: "Skill hit-rate",
      value: hitRate == null ? "—" : String(hitRate),
      unit: hitRate == null ? "not wired" : "%",
      tone: "ok",
      delta: 0,
      series: skillSeries.length ? skillSeries : [0],
    }),
    kpiCard({
      label: "Spend by kind",
      value: topKind ? String(kindShare) : "—",
      unit: topKind ? `% ${topKind.kind}` : "no spend",
      tone: "amber",
      delta: 0,
      series: kindSeries.length ? kindSeries : [0],
    }),
    kpiCard({
      label: "Rework cost",
      value: String(reworkShare),
      unit: "% of spend",
      tone: "danger",
      delta: 0,
      goodWhenDown: true,
      series: [reworkShare],
    }),
    kpiCard({
      label: "Measured coverage",
      value: String(coveragePct),
      unit: "%",
      tone: "accent",
      delta: 0,
      series: [coveragePct],
    }),
    // TAMPER-EVIDENT LOG: the work_events hash chain, re-derived server-side.
    // A break means an event was rewritten, deleted or re-ordered after the fact —
    // every rollup on this page is derived from that log, so it is shown first-class.
    eventLog
      ? kpiCard({
          label: "Event log",
          value: eventLog.chain_ok ? "intact" : "BROKEN",
          unit: eventLog.chain_ok
            ? `${eventLog.events} events chained`
            : `at seq ${eventLog.broken_at_seq} (${eventLog.reason})`,
          tone: eventLog.chain_ok ? "ok" : "danger",
          delta: 0,
          series: [eventLog.chain_ok ? 1 : 0],
        })
      : null,
  ]);

  // --- The deep reads: skill hit-rate and recall. Each is drawn only with data to
  // show; a source that has measured nothing yet is one clause in the line below.
  const unmeasured = [];
  const skillPanel = skillList.length
    ? el("section", { class: "card panel skill-panel", "aria-label": "Skill hit-rate" }, [
        panelHead(
          "Skill hit-rate",
          `${plural(skills.total_records || 0, "delivery", "deliveries")} · applied of selected`,
          null,
          { kit: "ink" },
        ),
        el(
          "div",
          { class: "hlist" },
          skillList.map((s) =>
            healthBarRow(
              s.skill,
              // A refused read (the hook blocked it: the agent never saw the skill) is
              // shown beside the hit-rate, never counted as use.
              `${s.applied}/${s.selected} · ${s.hit_rate_pct}%` +
                (s.refused ? ` · ${s.refused} refused` : ""),
              (s.hit_rate_pct || 0) / 100,
              s.refused ? "amber" : s.hit_rate_pct >= 50 ? "ok" : "amber",
            ),
          ),
        ),
      ])
    : (unmeasured.push([
        "Skill hit-rate",
        "no skill telemetry yet: it appears once deliveries mount skills",
      ]),
      null);
  const recallHas =
    recall.available &&
    (recallSeries.length ||
      recall.effectiveness_pct != null ||
      (recall.clean || 0) + (recall.reworked || 0) + (recall.blocked || 0) > 0);
  const recallPanel = recallHas
    ? el("section", { class: "card panel recall-panel", "aria-label": "Recall effectiveness" }, [
        panelHead("Recall effectiveness", "memory feedback", null, { kit: "ink" }),
        el("div", { class: "recall-figures" }, [
          recallStat(
            "Effectiveness",
            recall.effectiveness_pct == null ? "—" : `${recall.effectiveness_pct}%`,
          ),
          recallStat("Clean", String(recall.clean || 0)),
          recallStat("Reworked", String(recall.reworked || 0)),
          recallStat("Blocked", String(recall.blocked || 0)),
        ]),
        recallSeries.length
          ? el("div", { class: "health-spark", html: svgSpark(recallSeries) })
          : null,
      ])
    : (unmeasured.push([
        "Recall effectiveness",
        recall.available
          ? "no recall outcomes recorded yet"
          : recall.reason || "memory is not wired, so recall effectiveness is unavailable",
      ]),
      null);

  // The flow panels (form guide, governance, development flow, treatment table,
  // running now, bouncing, wages) — the physio's charts, read from their own endpoints.
  const panels = await fitnessRoomPanels(health).catch((e) => {
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
  const wages = pick("wages-panel");
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
          kpis,
        ]),
      ],
    ),
  );
  // USAGE WINDOW: the runner paused admission after the model refused a call on its
  // usage window / a rate limit. Say so first: it is why nothing is moving.
  const usagePause = health.usage_pause && health.usage_pause.active ? health.usage_pause : null;
  if (usagePause) wrap.appendChild(usagePauseNote(usagePause));
  // The four top-level measures, under the verdict: what every feature has to move.
  wrap.appendChild(fourMeasures(health));
  const lanes = laneValueCard(health);
  if (lanes) wrap.appendChild(lanes);
  const codeIndex = codeIndexCard(health);
  if (codeIndex) wrap.appendChild(codeIndex);
  const scout = scoutCard(health);
  if (scout) wrap.appendChild(scout);
  const routing = routingCard(health);
  if (routing) wrap.appendChild(routing);
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

export { healthBarRow, renderHealth };
