// Ticket detail cards: regression, evidence, full time, match report, runs, memory primed, testing.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { readOnly } from "../access.js";
import { api } from "../api.js";
import { actorName } from "../club.js";
import { panelHead, statCell } from "../components.js";
import { clear, el } from "../dom.js";
import {
  fmtDay,
  fmtDuration,
  fmtRelative,
  fmtTime,
  money,
  parseJsonSafe,
  plural,
} from "../format.js";
import { clockTime } from "../freshness.js";
import { glyph } from "../icons.js";
import { formatPayload, humanizeEvent } from "../panels.js";
import { routeSignal, router } from "../router.js";
import { runDuration, viewRunDetail, viewRunLog } from "../runs.js";
import { statusLabel } from "../status.js";
import { guard, toast } from "../toast.js";
import {
  parseTesterAgent,
  parseTesterProvenance,
  parseTesterVerdict,
  parseTicketTestContract,
  renderAcceptanceProfile,
  renderRuntimeAcceptance,
  testerRecordedBy,
} from "./acceptance.js";
import {
  evidenceKind,
  noteReviewOpen,
  reviewEvidenceList,
  safeHttpUrl,
  sinceStatus,
} from "../../app.js";

/**
 * ESCAPED DEFECTS (MF5): the accepted changes a person said this ticket regresses, the
 * later tickets linked to this one, and the person's control to file or withdraw a link.
 * Health's escaped-defect rate counts these links and only these: Gaffer never guesses a
 * regression. A read-only token sees the links and no control. Null for a ticket with no
 * link that nobody can file from (read-only).
 */
function regressionCard(t, reg) {
  const of = (reg && reg.regression_of) || [];
  const by = (reg && reg.regressed_by) || [];
  if (readOnly() && !of.length && !by.length) return null;
  const label = (l) =>
    el("a", { href: `#/ticket/${l.ticket_id}` }, [
      `#${l.number ?? "?"}`,
      l.title ? ` ${l.title}` : "",
    ]);
  const filed = (l) =>
    el(
      "small",
      { class: "dim" },
      ` · filed by ${l.filed_by?.id || l.filed_by?.type || "?"} ${fmtTime(l.filed_at)}${l.note ? ` · ${l.note}` : ""}`,
    );
  const rows = [
    ...of.map((l) =>
      el("li", { class: "tk-regression", dataset: { regressionOf: l.ticket_id } }, [
        "Regression of ",
        label(l),
        filed(l),
        readOnly()
          ? null
          : el(
              "button",
              {
                class: "btn small",
                type: "button",
                "aria-label": `Withdraw the regression link to #${l.number ?? "?"}`,
                onclick: () =>
                  guard(async () => {
                    await api("POST", `/tickets/${t.id}/regression-of`, {
                      of: l.ticket_id,
                      withdraw: true,
                    });
                    toast(`Regression link to #${l.number ?? "?"} withdrawn.`, { ok: true });
                    router();
                  }),
              },
              "Withdraw",
            ),
      ]),
    ),
    ...by.map((l) =>
      el("li", { class: "tk-regressed-by", dataset: { regressedBy: l.ticket_id } }, [
        "Regressed by ",
        label(l),
        filed(l),
      ]),
    ),
  ];
  let form = null;
  if (!readOnly()) {
    const input = el("input", {
      class: "input",
      type: "text",
      inputmode: "numeric",
      maxlength: "40",
      placeholder: "#",
      "aria-label": "The accepted change this ticket regresses (its number)",
    });
    const note = el("input", {
      class: "input",
      type: "text",
      maxlength: "300",
      placeholder: "What broke (optional)",
      "aria-label": "What broke",
    });
    form = el(
      "form",
      {
        class: "tk-regression-form",
        onsubmit: (e) => {
          e.preventDefault();
          const ref = input.value.trim().replace(/^#/, "");
          if (!ref) return;
          guard(async () => {
            await api("POST", `/tickets/${t.id}/regression-of`, {
              of: ref,
              ...(note.value.trim() ? { note: note.value.trim() } : {}),
            });
            toast(`Linked as a regression of #${ref}.`, { ok: true });
            router();
          });
        },
      },
      [
        el("label", { class: "dim" }, "This ticket is a regression of accepted change"),
        input,
        note,
        el("button", { class: "btn small", type: "submit" }, "Link"),
      ],
    );
  }
  return el("section", { class: "card panel tk-regressions", "aria-label": "Escaped defects" }, [
    panelHead("Escaped defects"),
    rows.length ? el("ul", { class: "tk-regression-list" }, rows) : null,
    form,
    el(
      "p",
      { class: "dim tk-regression-foot" },
      "Health's escaped-defect rate counts only the links a person files here.",
    ),
  ]);
}

/** Who recorded an evidence row, as the ticket page groups the trail. */
const EVIDENCE_PROVENANCE = [
  { id: "agent", label: "Reported by agents", note: "self-reported: weigh it against the diff" },
  { id: "system", label: "Recorded by the runner", note: "gates, checks and verdicts" },
  { id: "human", label: "Recorded by people", note: null },
  { id: "unknown", label: "Recorder not recorded", note: "older rows" },
];
function evidenceProvenance(ev) {
  if (ev.recorded_by_agent === true || ev.recorded_by_actor_type === "agent") return "agent";
  if (ev.recorded_by_actor_type === "system") return "system";
  if (ev.recorded_by_actor_type === "human" || ev.recorded_by_actor_type === "admin")
    return "human";
  return "unknown";
}

/**
 * The ticket page's Evidence: every recorded row (reviewer-agent notes, the DoD
 * checklist, AC check output, test output…), grouped by who recorded it, oldest
 * first in each group. Folded by default: it is the record, not the next move. Only
 * Review showed it before, so a ticket that left Review lost the visible trail.
 */
function ticketEvidenceCard(evidence, acList, repos) {
  if (!evidence.length) return null;
  const groups = EVIDENCE_PROVENANCE.map((g) => ({
    ...g,
    rows: evidence.filter((ev) => evidenceProvenance(ev) === g.id),
  })).filter((g) => g.rows.length);
  return el("details", { class: "card panel tk-evidence" }, [
    el("summary", { class: "tk-evidence-sum" }, [
      el("span", { class: "panel-title" }, "Evidence"),
      el(
        "span",
        { class: "panel-aux" },
        `${plural(evidence.length, "row")} · ${groups.map((g) => `${g.rows.length} ${g.id === "unknown" ? "unattributed" : g.id === "system" ? "runner" : g.id}`).join(" · ")}`,
      ),
    ]),
    ...groups.map((g) =>
      el("section", { class: "tk-evidence-group", dataset: { provenance: g.id } }, [
        el("h3", { class: "tk-evidence-h" }, [
          g.label,
          el("span", { class: "count" }, String(g.rows.length)),
          g.note ? el("span", { class: "dim tk-evidence-note" }, g.note) : null,
        ]),
        reviewEvidenceList(g.rows, acList, { repos }),
      ]),
    ),
  ]);
}

/**
 * What shipped, from the delivery's own diff stat (the diff_summary evidence the
 * runner recorded): after the merge the branch and main agree, so a live diff is
 * empty. Each file with its goal-difference bar. Null when there is no stat.
 */
function shippedFiles(evidence) {
  const ev = (evidence || []).filter((e) => e.evidence_type === "diff_summary").pop();
  if (!ev) return null;
  const rows = [];
  let total = null;
  for (const line of String(ev.summary || "").split("\n")) {
    const m = line.match(/^\s*(\S.*?)\s*\|\s*(\d+)\s*([+-]*)\s*$/);
    if (m) rows.push({ path: m[1], n: Number(m[2]), marks: m[3] });
    else if (/files? changed/.test(line)) total = line.trim();
  }
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.n));
  return el("div", { class: "diff-box" }, [
    el("div", { class: "diff-section" }, [
      el("div", { class: "diff-head" }, [
        el("span", {}, `From the delivery's diff stat, recorded ${fmtTime(ev.created_at)}`),
        total ? el("span", { class: "diff-stats" }, total) : null,
      ]),
      el(
        "ul",
        { class: "diff-filestrip clean", "aria-label": "Files that shipped" },
        rows.map((r) => {
          const plus = (r.marks.match(/\+/g) || []).length;
          const minus = (r.marks.match(/-/g) || []).length;
          const blocks = Math.max(1, Math.round((r.n / max) * 16));
          const add = plus + minus ? Math.round((plus / (plus + minus)) * blocks) : blocks;
          return el("li", { class: "diff-filejump is-static" }, [
            el("span", { class: "dfj-flag" }),
            el("code", { class: "mono diff-filejump-path" }, r.path),
            el("span", { class: "diff-filejump-stat" }, plural(r.n, "line")),
            el(
              "span",
              { class: "gd", "aria-hidden": "true" },
              Array.from({ length: blocks }, (_, i) =>
                el("i", { class: i < add ? "gd-a" : "gd-d" }),
              ),
            ),
          ]);
        }),
      ),
    ]),
  ]);
}

/** Deliveries made: the failed goes on the rework trail, plus the one that got through. */
const PAST_THE_PITCH = new Set(["in_review", "in_testing", "ready_for_merge", "done"]);
function deliveryCount(t, trail) {
  return trail.length + (PAST_THE_PITCH.has(t.status) ? 1 : 0);
}

/** Full time: a done ticket's result in place of a next move — when, how many goes, the criteria. */
function fullTimeCard(t, { trail, events, acList, doneAt }) {
  const claimAt = (events || []).find((e) => e.event_type === "claim.created")?.created_at;
  const sat = acList.filter((a) => a.status === "satisfied").length;
  const goes = deliveryCount(t, trail);
  const took = claimAt && doneAt ? Date.parse(doneAt) - Date.parse(claimAt) : null;
  return el("section", { class: "card panel tk-ft", "aria-label": "Full time" }, [
    panelHead("Full time", doneAt ? fmtTime(doneAt) : null, null, { kit: "ink" }),
    el("p", { class: "tk-move-t" }, [
      trail.length
        ? `Merged after ${plural(trail.length, "rework")}: it went through the gates ${plural(goes, "time")}.`
        : "Merged first time: it passed the gates on its first delivery.",
      t.branch_name ? [" Branch ", el("code", { class: "mono" }, t.branch_name), "."] : null,
    ]),
    el("div", { class: "kpi-row tk-ft-row" }, [
      statCell({ label: "Deliveries", value: String(goes) }),
      statCell({ label: "Reworks", value: String(trail.length) }),
      statCell({
        label: "Criteria met",
        value: acList.length ? `${sat}/${acList.length}` : "—",
      }),
      took != null && took >= 0
        ? statCell({ label: "Claim to merge", value: fmtDuration(took) })
        : null,
    ]),
    el("div", { class: "btn-row" }, [
      t.pr_url && safeHttpUrl(t.pr_url)
        ? el(
            "a",
            { class: "btn", href: safeHttpUrl(t.pr_url), target: "_blank", rel: "noopener" },
            "Open the PR",
          )
        : null,
      el("a", { class: "btn", href: "#/work?status=done" }, "See it on the board"),
    ]),
  ]);
}

/** The full-time plaque in a done ticket's head: scoreboard black, the merge date. */
function fullTimePlaque(at) {
  return el("div", { class: "ft-plaque", "aria-hidden": "true" }, [
    el("span", { class: "ft-l" }, "Full time"),
    el("b", { class: "ft-v" }, at ? fmtDay(at, { weekday: false }) : "Done"),
    at ? el("span", { class: "ft-t tabnum" }, clockTime(Date.parse(at))) : null,
  ]);
}

/** One event as a sentence a manager reads ("Ready → Claimed"), and the glyph it carries. */
function eventSentence(ev, repos) {
  const p = parseJsonSafe(ev.payload_json) || {};
  const who = actorName(ev.actor_type, ev.actor_id);
  const repoName = (id) => (repos || []).find((r) => r.id === id)?.name || "a repo";
  const reason = typeof p.reason === "string" && /\s/.test(p.reason) ? p.reason : null;
  switch (ev.event_type) {
    case "ticket.created":
      return { text: `Created by ${who}`, st: "draft" };
    case "ticket.transitioned":
      return {
        text: `${statusLabel(p.from || "?")} → ${statusLabel(p.to || "?")}`,
        note: reason,
        st: p.to || null,
      };
    case "claim.created":
      return { text: `Claimed by ${who}`, st: "claimed" };
    case "claim.released":
      return { text: "Claim released" };
    case "ticket.reworking":
      return {
        text: `Rework ${p.attempt ?? "?"}${p.max_attempts ? `/${p.max_attempts}` : ""}${p.gate ? `: the ${p.gate} gate failed` : ""}`,
        note: p.reason || null,
        st: "failed",
      };
    case "ticket.blocked":
      return { text: "Parked: it needs you", note: p.reason || null, st: "blocked" };
    case "ticket.usage_limited":
      return {
        text: p.paused_until
          ? `Held back by the usage limit until ${fmtTime(p.paused_until)} (no attempt counted)`
          : "Held back by the usage limit (no attempt counted)",
        note: p.reason || null,
        st: "ready",
      };
    case "ticket.delivery_recorded":
      return { text: p.branch_name ? `Delivered on ${p.branch_name}` : "Delivery recorded" };
    case "ticket.repo_delivery_recorded":
      return {
        text: `${repoName(p.repo_id)}: ${String(p.status || "delivery").replace(/_/g, " ")}`,
      };
    case "ticket.repo_access_set":
      return { text: `Boundary: ${repoName(p.repo_id)} set to ${p.access || "?"}` };
    case "evidence.recorded":
      return { text: `Evidence: ${evidenceKind(p.evidence_type)}` };
    case "ac.added":
      return { text: "Criterion added", note: p.text || null };
    case "ac.edited":
      return { text: "Criterion edited", note: p.changes?.text?.to || null };
    case "ac.removed":
      return { text: "Criterion removed", note: p.text || null };
    case "ticket.edited":
      return {
        text: `Edited: ${(Array.isArray(p.changed) ? p.changed : []).join(", ").replace(/_/g, " ") || "ticket"}`,
      };
    case "ticket.dependency_added":
      return { text: `Now depends on #${p.depends_on_number ?? "?"}` };
    case "ticket.paused":
      return { text: "Paused at a cap", note: p.reason || null, st: "paused" };
    // REVIEW TELEMETRY: measurements, said plainly (none of them moves the ticket).
    case "ticket.review_opened":
      return { text: `Opened in Review by ${who}` };
    case "ticket.review_raw_opened":
      return {
        text: `${who} opened the ${{ run_log: "run log", evidence: "evidence in full", full_diff: "full diff" }[p.what] || "raw view"}`,
      };
    // ESCAPED DEFECTS (MF5): a person's link from this ticket to the change it regresses.
    case "ticket.defect_escaped":
      return {
        text: `${who} linked this as a regression of #${p.regression_of_number ?? "?"}`,
        note: p.note || null,
      };
    case "ticket.defect_escaped_withdrawn":
      return { text: `${who} withdrew the regression link to #${p.regression_of_number ?? "?"}` };
    case "ticket.lane_verdict":
      return {
        text: `${{ "agent-review": "Reviewer agent", "security-review": "Security reviewer", tester: "Tester", "eval-judge": "Eval judge (a model's opinion)" }[p.lane] || "A lane"}: ${p.verdict || "?"}${p.commit ? ` on ${String(p.commit).slice(0, 12)}` : ""}`,
        note: p.held_reason || null,
      };
    default:
      return { text: humanizeEvent(ev.event_type), note: reason };
  }
}

/**
 * The match report: every event, minute by minute, grouped by day — a sentence,
 * who did it, and the tick it was written in. The raw payload is one switch away.
 */
function ticketMatchReport(events, repos) {
  // Creating a ticket writes its criteria and repo links in the same instant, some a
  // few ms before the ticket.created row itself; the report opens on the kick-off.
  const created = events.findIndex((e) => e.event_type === "ticket.created");
  if (
    created > 0 &&
    Date.parse(events[created].created_at) - Date.parse(events[0].created_at) < 1000
  )
    events = [events[created], ...events.slice(0, created), ...events.slice(created + 1)];
  let day = "";
  const list = el(
    "ol",
    { class: "timeline clean tk-report-list" },
    events.map((ev) => {
      const s = eventSentence(ev, repos);
      const d = fmtDay(ev.created_at);
      const dayHead = d !== day ? (day = d) : null;
      return el("li", { class: s.st ? `rp-${s.st}` : null }, [
        dayHead ? el("span", { class: "rp-day" }, dayHead) : null,
        el(
          "time",
          { class: "ev-time tabnum", datetime: ev.created_at, title: fmtTime(ev.created_at) },
          clockTime(Date.parse(ev.created_at)),
        ),
        s.st ? glyph(s.st, 14) : el("span", { class: "rp-dot", "aria-hidden": "true" }),
        el("div", { class: "rp-body" }, [
          el("div", { class: "ev-type" }, s.text),
          s.note ? el("div", { class: "rp-note" }, s.note) : null,
          el("div", { class: "ev-actor" }, [
            actorName(ev.actor_type, ev.actor_id),
            // TRACE: the runner tick that wrote this event (work_events.correlation_id).
            // Every event one tick produced carries the same id, so the chip shows which
            // events belong together; `dispatch events list --correlation <id>` prints the trail.
            ev.correlation_id
              ? el(
                  "span",
                  {
                    class: "ev-tick mono",
                    title: `Written during tick ${ev.correlation_id} — dispatch events list --correlation ${ev.correlation_id}`,
                  },
                  `tick ${ev.correlation_id}`,
                )
              : null,
          ]),
          ev.payload_json && ev.payload_json !== "{}" ? formatPayload(ev.payload_json) : null,
        ]),
      ]);
    }),
  );
  const raw = el(
    "button",
    {
      class: "btn quiet small tk-raw",
      type: "button",
      "aria-pressed": "false",
      onclick: () => {
        const on = !list.classList.contains("show-raw");
        list.classList.toggle("show-raw", on);
        raw.setAttribute("aria-pressed", String(on));
      },
    },
    "Show the raw data",
  );
  return el("section", { class: "card panel tk-report", "aria-label": "Match report" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, [
        "Match report",
        el("span", { class: "panel-aux" }, plural(events.length, "event")),
      ]),
      events.length ? raw : null,
    ]),
    events.length ? list : el("p", { class: "dim" }, "No events recorded."),
  ]);
}

/**
 * The runner's logs for a ticket. Delivery runs are matched by the claim they
 * started with (a run row carries no ticket; its log's ROUTE line does, and the
 * run detail reads it), so a live delivery links straight to its streaming log
 * and a finished one keeps its record. A ticket marked delivering with no live
 * run says so plainly (the #88 hung-claim case).
 */
/** A run's own turns / spend (an older server sends only the ticket's totals). */
const runTurns = (d) => (typeof d.run_num_turns === "number" ? d.run_num_turns : d.num_turns);
const runCost = (d) => (typeof d.run_cost_usd === "number" ? d.run_cost_usd : d.cost_usd);
function ticketRunsPanel(t, events) {
  // In testing is not delivering: the tester lane runs outside the delivery runs read here,
  // so "no live run" would wrongly say a ticket under test may be stuck.
  const delivering = ["in_progress", "claimed"].includes(t.status);
  const panel = el("section", { class: "card panel tk-runs", "aria-label": "Runs" });
  const body = el("div", { class: "tk-runs-body" }, [
    el("p", { class: "dim" }, delivering ? "Finding the live run…" : "Reading the runner's logs…"),
  ]);
  panel.append(
    panelHead(
      delivering ? "On the pitch" : "Match footage",
      delivering ? "the live run" : "the runner's log of each delivery",
      null,
      delivering ? { kit: "ink" } : {},
    ),
    body,
  );
  const claims = (events || [])
    .filter((e) => e.event_type === "claim.created")
    .map((e) => Date.parse(e.created_at))
    .filter(Number.isFinite);
  const near = (run) => claims.some((c) => Math.abs(Date.parse(run.started_at) - c) <= 5 * 60_000);
  const signal = routeSignal();
  (async () => {
    let found;
    try {
      const res = await api("GET", "/api/runs?active=1&limit=50", undefined, { signal });
      const pool = [...(res.active || []), ...(res.recent || [])].filter(
        (r) => r.kind === "poll_work" || r.kind === "other",
      );
      // Live runs always (there are a handful); finished ones only near this ticket's claims.
      const cand = pool.filter((r) => r.status === "running" || near(r)).slice(0, 8);
      const details = await Promise.all(
        cand.map((r) =>
          api("GET", `/api/runs/${encodeURIComponent(r.id)}`, undefined, { signal })
            .then((x) => x.detail || null)
            .catch(() => null),
        ),
      );
      found = cand
        .map((r, i) => ({ run: r, d: details[i] }))
        .filter((x) => x.d && x.d.ticket_number === t.number);
    } catch (e) {
      if (e && e.code === "ABORTED") return;
      clear(body);
      body.appendChild(el("p", { class: "dim" }, "The runner's logs could not be read."));
      return;
    }
    clear(body);
    const liveRun = found.find((x) => x.run.status === "running");
    if (delivering && !liveRun) {
      // Marked delivering but no live run attached ⇒ likely a hung/orphaned claim.
      body.appendChild(
        el("div", { class: "delivering-banner is-warn" }, [
          el("span", { class: "delivering-dot is-warn" }),
          el(
            "span",
            {},
            "Marked delivering, but no live run is attached — it may be stuck or already ended.",
          ),
        ]),
      );
    }
    if (!found.length) {
      if (!delivering) panel.remove();
      return;
    }
    body.appendChild(
      el(
        "ul",
        { class: "clean tk-run-list" },
        found.map(({ run, d }) => {
          const on = run.status === "running";
          const chips = [
            d.phase ? el("span", { class: "run-detail-chip" }, d.phase) : null,
            // This run's own turns and spend (run_*), not the ticket's totals: two
            // runs of one ticket read the same cumulative figure.
            runTurns(d) > 0
              ? el("span", { class: "run-detail-chip" }, plural(runTurns(d), "turn"))
              : null,
            runCost(d) > 0
              ? el("span", { class: "run-detail-chip tabnum" }, money(runCost(d)))
              : null,
            d.outcome
              ? el(
                  "span",
                  { class: "run-detail-chip" },
                  d.outcome === "blocked"
                    ? "parked as blocked"
                    : `ended ${statusLabel(d.outcome).replace(/_/g, " ").toLowerCase()}`,
                )
              : null,
          ];
          return el("li", { class: `tk-run${on ? " is-live" : ""}` }, [
            on
              ? el("span", { class: "run-spinner", "aria-hidden": "true" })
              : glyph(run.status === "failed" ? "failed" : "done", 16),
            el("div", { class: "tk-run-main" }, [
              el("p", { class: "tk-run-h" }, [
                el("b", {}, on ? `Delivering #${t.number}` : `Delivery of #${t.number}`),
                " ",
                el(
                  "span",
                  { class: "dim" },
                  on
                    ? `since ${clockTime(Date.parse(run.started_at))} · ${runDuration(run)}`
                    : `${fmtTime(run.started_at)} · ${runDuration(run)} · ${run.status}`,
                ),
              ]),
              el("div", { class: "run-detail-chips" }, chips),
            ]),
            el(
              "button",
              {
                class: "btn small run-viewlog",
                type: "button",
                onclick: () => {
                  if (t.status === "in_review")
                    noteReviewOpen(t.id, sinceStatus(events, "in_review"), "run_log");
                  return on
                    ? viewRunDetail(run.id, `Delivery of #${t.number}`)
                    : viewRunLog(run, `Delivery of #${t.number} · log`);
                },
              },
              on ? "View live log →" : "View log",
            ),
          ]);
        }),
      ),
    );
  })();
  return panel;
}

/**
 * Per-delivery memory attribution (PO-r2 #2). Shows the memory context the runner primed
 * into the delivery agent (recorded as `memory_primed` evidence) + the delivery outcome,
 * so an operator can see the learn-loop working. Renders NOTHING before a delivery (a
 * draft/ready/claimed ticket has no delivery to attribute); once delivered it shows either
 * the primed set or a DISTINCT "no memory primed" state.
 *
 * HONESTY: the per-item "which primed items were actually RECALLED/used" signal is the
 * memory engine's own recall log (write-only via the CLI today) — not fabricated here.
 * What's shown is what was PRIMED (deterministic) + the outcome (the "did it help?" pair).
 */
function memoryPrimedPanel(t, evidence, reworkTrail) {
  const delivered = ["in_review", "in_testing", "ready_for_merge", "done", "refining", "blocked"];
  if (!delivered.includes(t.status)) return null;
  const primed = (evidence || []).filter((e) => e.evidence_type === "memory_primed");
  const reworks = (reworkTrail || []).length;
  const outcome =
    t.status === "done"
      ? reworks > 0
        ? { txt: `shipped after ${reworks} rework${reworks === 1 ? "" : "s"}`, cls: "warn" }
        : { txt: "shipped clean — no rework", cls: "ok" }
      : reworks > 0
        ? { txt: `needed ${reworks} rework${reworks === 1 ? "" : "s"}`, cls: "warn" }
        : { txt: statusLabel(t.status, t.landing_state).toLowerCase(), cls: "dim" };

  const head = el("div", { class: "panel-head mem-primed-head" }, [
    el("h2", { class: "panel-title" }, "The scouting report"),
    el("span", { class: "panel-aux mem-primed-outcome " + outcome.cls }, outcome.txt),
  ]);
  const sub = primed.length
    ? el(
        "p",
        { class: "mem-primed-title" },
        "Memory primed for this delivery: what the club's memory briefed the agent with.",
      )
    : null;

  let bodyNode;
  if (primed.length === 0) {
    bodyNode = el(
      "div",
      { class: "mem-primed-none" },
      "The club's memory briefed the agent with nothing for this delivery: no lore or file cards were primed, so it went out without a scouting report.",
    );
  } else {
    bodyNode = el(
      "ul",
      { class: "mem-primed-list" },
      primed.map((e) =>
        el("li", { class: "mem-primed-item" }, [
          el("span", { class: "mem-primed-summary" }, String(e.summary || "").trim() || "(empty)"),
          e.created_at
            ? el("span", { class: "mem-primed-at dim" }, fmtRelative(e.created_at))
            : null,
        ]),
      ),
    );
  }
  return el(
    "section",
    { class: "card panel mem-primed-card", "aria-label": "The scouting report" },
    [head, sub, bodyNode],
  );
}

/**
 * FAILURE-DIAGNOSIS: render a ticket's full ordered rework failure trail (the "why
 * did #N fail" history). Each attempt shows its gate + the DISTILLED failing test +
 * assertion/stack the runner captured — not a one-line summary. Returns null when
 * the ticket never bounced, so a clean ticket shows no card.
 */
/**
 * BBT-001 testing card: the `can_be_tested` toggle, the test_contract (the
 * handover the independent tester reads to stand the system up — never the diff),
 * and the tester's recorded test_output evidence. The toggle POSTs /testable; the
 * contract is read-only here (filled by the implementer/reviewer via CLI/MCP).
 */
function renderTestingCard(t, evidence) {
  const contract = parseTicketTestContract(t.test_contract);
  const testable = t.can_be_tested === 1;

  // A merged or closed ticket's testing route is its record: it can no longer change.
  const closed = t.status === "done" || t.status === "cancelled";
  const toggle = el("input", {
    type: "checkbox",
    role: "switch",
    "aria-label": "Testable",
    disabled: closed ? "" : null,
  });
  toggle.checked = testable;
  toggle.addEventListener("change", () =>
    guard(async () => {
      await api("POST", `/tickets/${t.id}/testable`, { can_be_tested: toggle.checked });
      toast(toggle.checked ? "Marked testable" : "Marked not testable", { ok: true });
      router();
    }),
  );

  const contractRows = contract
    ? el("dl", { class: "kv" }, [
        el("dt", {}, "Changed surfaces"),
        el("dd", {}, contract.changed_surfaces.length ? contract.changed_surfaces.join(", ") : "—"),
        el("dt", {}, "Runtime deps"),
        el("dd", {}, contract.runtime_deps.length ? contract.runtime_deps.join(", ") : "—"),
        el("dt", {}, "Env vars"),
        el("dd", {}, contract.env_vars.length ? contract.env_vars.join(", ") : "—"),
        el("dt", {}, "Run command"),
        el("dd", {}, contract.run_command || "—"),
        el("dt", {}, "Harness"),
        el(
          "dd",
          {},
          contract.harness_ready ? "ready (black-box mode)" : "not ready (harness mode)",
        ),
      ])
    : el("p", { class: "dim" }, [
        "No test contract recorded. Add one with ",
        el("code", { class: "mono" }, "wg ticket test-contract"),
        " or the Dispatch MCP.",
      ]);

  // The tester's verdict evidence: ONLY test_output rows whose payload carries a BBT
  // tester verdict (pass/fail). Plain implementation / AC test_output must NOT show
  // under "Tester results" — that would mislabel ordinary evidence as tester output.
  const testerEvidence = (evidence || []).filter(
    (e) => e.evidence_type === "test_output" && parseTesterVerdict(e.payload_json) !== null,
  );
  const evidenceList = testerEvidence.length
    ? el(
        "ul",
        { class: "clean" },
        testerEvidence.map((e) => {
          const prov = parseTesterProvenance(e.payload_json);
          const verdict = parseTesterVerdict(e.payload_json);
          return el("li", { class: `tt-row tt-${verdict}` }, [
            glyph(verdict === "pass" ? "done" : "failed", 16, verdict === "pass" ? "Pass" : "Fail"),
            el("div", {}, [
              e.summary,
              // BBT-001 provenance badge: who produced this verdict (derived from the
              // recording actor's type), so a reviewer sees "by <agent|human|system>".
              // A PASS the runner recorded as the system names the tester agent whose run
              // it records: it reads as that, never as the system's own verdict.
              prov
                ? el(
                    "span",
                    { class: "badge no-dot", style: "margin-left:8px" },
                    testerRecordedBy(prov, parseTesterAgent(e.payload_json)) || `by ${prov}`,
                  )
                : null,
            ]),
            el("div", { class: "ac-meta tt-who" }, `${e.created_by} · ${fmtTime(e.created_at)}`),
          ]);
        }),
      )
    : el("p", { class: "dim" }, "No tester results recorded yet.");

  // TESTER REPLAY: which of the tester's assertions passed on which LANDED revision — the
  // runner's own record (a SYSTEM row, uri gaffer-tester-replayed:<sha>), written only when
  // the merge gate replayed the tester's tests on the exact merge candidate and it landed.
  // Read from the record, never guessed from timestamps; the epic is accepted only on it.
  // Only the record itself counts: a SYSTEM row with the uri AND the record's payload
  // (dispatch refuses the uri on any other system evidence path).
  const replayPayload = (e) => {
    try {
      const p = JSON.parse(e.payload_json || "{}");
      return p && p.kind === "tester_replay" ? p : null;
    } catch {
      return null;
    }
  };
  const replays = (evidence || []).filter(
    (e) =>
      e.recorded_by_actor_type === "system" &&
      typeof e.uri === "string" &&
      e.uri.startsWith("gaffer-tester-replayed:") &&
      replayPayload(e) !== null,
  );
  const replayList = replays.length
    ? el(
        "ul",
        { class: "clean" },
        replays.map((e) => {
          const sha = e.uri.slice("gaffer-tester-replayed:".length);
          const p = replayPayload(e) || {};
          const files = Array.isArray(p.files) ? p.files.filter((f) => typeof f === "string") : [];
          const others = Array.isArray(p.not_replayed_repos)
            ? p.not_replayed_repos.filter((f) => typeof f === "string")
            : [];
          // What the record proves: every test the tester's PASS bound, or (an older PASS
          // without test identities) only that each file ran: file-level evidence only.
          const tests = Array.isArray(p.tests) ? p.tests.length : 0;
          const level = p.evidence === "identities" ? "identities" : "files";
          const proves =
            level === "identities"
              ? ` (${tests} bound test${tests === 1 ? "" : "s"} passed)`
              : " (file-level evidence only)";
          return el("li", { class: files.length ? "tt-row tt-pass" : "tt-row" }, [
            glyph(
              files.length ? "done" : "blocked",
              16,
              files.length
                ? "Passed on the landed revision"
                : "No tester test ran on the landed revision",
            ),
            el("div", {}, [
              files.length ? "Passed on the landed revision " : "Landed ",
              el("code", { class: "mono" }, sha.slice(0, 12)),
              files.length
                ? `: ${files.join(", ")}${proves}`
                : " with no tester test file replayed (not counted as accepted)",
              others.length ? `. Not replayed in ${others.join(", ")}.` : "",
            ]),
            el("div", { class: "ac-meta tt-who" }, `runner · ${fmtTime(e.created_at)}`),
          ]);
        }),
      )
    : el(
        "p",
        { class: "dim" },
        t.status === "done"
          ? "No record that the tester's assertions passed on the revision that landed."
          : "Replayed on the merge candidate when it lands.",
      );

  return el("section", { class: "card panel tk-testing", "aria-label": "Independent testing" }, [
    panelHead("Independent testing", testable ? "black-box tester on" : "off", null, {}),
    el("div", { class: "setting-row tk-testable" }, [
      el("div", { class: "setting-meta" }, [
        el("div", { class: "setting-label" }, [
          el("span", {}, "Eligible for black-box testing"),
          t.status === "in_testing" ? el("span", { class: "badge no-dot" }, "in testing") : null,
        ]),
        el(
          "p",
          { class: "setting-help dim" },
          closed
            ? `${t.status === "done" ? "Merged" : "Closed"}: this records whether it went through the independent tester. It can no longer change.`
            : "When on (and the tester lane is on for its repositories: GAFFER_TESTING on, or by default where a test command is registered), an independent tester tests each delivery before you review it, and you approve the commit it passed.",
        ),
      ]),
      el("label", { class: "switch" }, [
        toggle,
        el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
      ]),
    ]),
    el("h3", { class: "tk-h3" }, "Test contract"),
    contractRows,
    el("h3", { class: "tk-h3" }, "Acceptance profile"),
    renderAcceptanceProfile(t, closed),
    el("h3", { class: "tk-h3" }, "Runtime acceptance"),
    renderRuntimeAcceptance(evidence),
    el("h3", { class: "tk-h3" }, "Tester results"),
    evidenceList,
    el("h3", { class: "tk-h3" }, "On the landed revision"),
    replayList,
  ]);
}

export {
  regressionCard,
  ticketEvidenceCard,
  shippedFiles,
  deliveryCount,
  fullTimeCard,
  fullTimePlaque,
  ticketMatchReport,
  ticketRunsPanel,
  memoryPrimedPanel,
  renderTestingCard,
};
