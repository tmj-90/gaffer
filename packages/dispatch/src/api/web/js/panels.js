// Shared panels: the development flow, what is needed, waiting notes, the event vocabulary and feed rows.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { actorName } from "./club.js";
import { panelHead } from "./components.js";
import { el } from "./dom.js";
import { fmtDuration, fmtTime, plural } from "./format.js";
import { clockTime } from "./freshness.js";
import { glyph, icon, ycard } from "./icons.js";
import { statusLabel } from "./status.js";

/**
 * Development flow as a horizontal NODE PIPELINE — the Overview's signature
 * element. Five stage nodes (Plan → Ready → Build → Review → Deploy) mapped from
 * the authoritative board counts (summary.ticketsByStatus). Each node is a
 * circular icon disc + LABEL + COUNT; a node with work is "active" (amber ring +
 * glow), an empty node is "dim". Discs are joined by a hairline connector; the
 * segment leading into an active node tints amber. On mobile the row becomes a
 * single horizontally-scrollable strip. `tickets` is retained for signature
 * compatibility but counts come from the aggregate `byStatus`.
 */
const PIPELINE_STAGES = [
  {
    label: "Plan",
    icon: "gitbranch",
    glyph: "draft",
    zone: "On the bench",
    statuses: ["draft", "refining"],
    href: "#/work?status=draft",
  },
  {
    label: "Ready",
    icon: "inbox",
    glyph: "ready",
    zone: "Own box",
    statuses: ["ready"],
    href: "#/work?status=ready",
  },
  {
    label: "Build",
    icon: "wrench",
    glyph: "in_progress",
    zone: "Our half",
    statuses: ["in_progress", "claimed"],
    href: "#/work?status=in_progress",
  },
  {
    label: "Review",
    icon: "clipboardcheck",
    glyph: "in_review",
    zone: "Their box",
    statuses: ["in_review", "in_testing", "ready_for_merge"],
    href: "#/review",
  },
  {
    label: "Deploy",
    icon: "diamond",
    glyph: "done",
    zone: "In the net",
    statuses: ["done", "shipped"],
    href: "#/work?status=done",
  },
];

function devFlowPanel(_tickets, byStatus, _now) {
  const counts = byStatus || {};
  const nodes = PIPELINE_STAGES.map((s) => ({
    ...s,
    count: s.statuses.reduce((sum, st) => sum + (counts[st] || 0), 0),
  }));

  return el("div", { class: "card panel pipeline-panel" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, [
        "Phases of play",
        el("span", { class: "panel-aux" }, "bench to net"),
      ]),
      // When these counts were read — a fact from the response, not a "LIVE" lamp.
      el("span", { class: "pl-live", title: "The time these counts were read from the factory" }, [
        "as of ",
        el("time", { datetime: new Date().toISOString() }, clockTime(Date.now())),
      ]),
    ]),
    // A real list: each stage an <li> holding its link (role=listitem on the <a>
    // took the link's own role away, and axe flagged aria-allowed-role).
    el(
      "ol",
      { class: "pipeline", "aria-label": "Development flow stages" },
      nodes.map((n) => {
        const active = n.count > 0;
        return el(
          "li",
          { class: "pl-stage" },
          el(
            "a",
            {
              class: `pl-node ${active ? "active" : "dim"}`,
              href: n.href,
              "aria-label": `${n.label}: ${n.count}`,
            },
            [
              el("span", { class: "pl-label" }, n.label),
              el("span", { class: "pl-disc" }, glyph(n.glyph, 20)),
              el("span", { class: "pl-count tabnum" }, String(n.count)),
              el("span", { class: "pl-zone" }, n.zone),
            ],
          ),
        );
      }),
    ),
  ]);
}

/**
 * The treatment table: what is wrong with the factory right now, one line per
 * complaint, worst first. Each line is a link to where it is treated, with its
 * tickets as numbered links under it.
 */
function needsPanel({ tickets = [], byStatus = {}, summary = {}, decisions = [], claims = null }) {
  // Each ticket is on the table once, under its worst complaint, so the lines add
  // up to the total the header and the verdict state. With no ticket list the
  // counts come from the dashboard summary (the lines cannot overlap there).
  const have = tickets.length > 0;
  const taken = new Set();
  const take = (list) => list.filter((t) => (taken.has(t.id) ? false : taken.add(t.id)));
  const ofStatus = (st) => take(tickets.filter((t) => t.status === st));
  const sortOld = (list) =>
    [...list].sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
  // The summary counts stale claims on the factory's clock; the claims that expired
  // first are the stale ones.
  const nStale = summary.staleClaims || 0;
  const staleClaims =
    claims && nStale
      ? (claims.claims || [])
          .filter((c) => (!c.status || c.status === "active") && c.expires_at)
          .sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)))
          .slice(0, nStale)
      : null;
  const pendingDecisions = decisions.filter((d) => !d.resolved_at);
  const items = [];
  const add = (it) => it.count > 0 && items.push(it);

  const blocked = have ? sortOld(ofStatus("blocked")) : null;
  add({
    severity: "critical",
    count: blocked ? blocked.length : (summary.blocked ?? byStatus.blocked ?? 0),
    title: (n) => `${n} blocked ${n === 1 ? "task" : "tasks"}`,
    sub: "waiting on a human to clear the path",
    action: "View",
    href: "#/work?status=blocked",
    tickets: blocked,
  });
  const failed = have ? sortOld(ofStatus("failed")) : null;
  add({
    severity: "critical",
    count: failed ? failed.length : byStatus.failed || 0,
    title: (n) => `${n} failed ${n === 1 ? "ticket" : "tickets"}`,
    sub: "out of attempts: reopen it or close it",
    action: "View",
    href: "#/work?status=failed",
    tickets: failed,
  });
  const review = have ? sortOld(ofStatus("in_review")) : null;
  add({
    severity: "waiting",
    count: review ? review.length : byStatus.in_review || 0,
    title: (n) => `${n} ${n === 1 ? "change" : "changes"} to review`,
    sub: "waiting on your sign-off",
    action: "Review",
    href: "#/review",
    tickets: review,
  });
  const merge = have ? sortOld(ofStatus("ready_for_merge")) : null;
  add({
    severity: "waiting",
    count: merge ? merge.length : byStatus.ready_for_merge || 0,
    title: (n) => `${n} approved, not merged`,
    sub: "signed off and waiting to merge",
    action: "View",
    href: "#/work?status=ready_for_merge",
    tickets: merge,
  });
  const nDec = summary.openDecisions ?? pendingDecisions.length;
  add({
    severity: "waiting",
    count: nDec,
    title: (n) => `${n} open ${n === 1 ? "decision" : "decisions"}`,
    sub:
      pendingDecisions.length === 1 && pendingDecisions[0].title
        ? `“${pendingDecisions[0].title}”`
        : "a question is waiting on you",
    action: "Answer",
    // The team sheet on the Overview is where a decision is answered.
    href: "#/overview",
  });
  // Stale claims: a lease past expiry is a fault in the squad, not a wait on you.
  const staleIds = staleClaims ? new Set(staleClaims.map((c) => c.ticket_id)) : null;
  const stale = staleIds && have ? take(tickets.filter((t) => staleIds.has(t.id))) : null;
  add({
    severity: "fault",
    count: stale ? stale.length : nStale,
    title: (n) => `${n} stale ${n === 1 ? "claim" : "claims"}`,
    sub: "an agent's lease ran out mid-ticket",
    action: "View",
    href: "#/work",
    tickets: stale,
  });
  // Held too long: in flight (an agent has it, or it is paused), past the stuck
  // threshold, and not already counted above. A draft or a ready ticket that has
  // waited a day is a queue, not an injury: it goes to the phases of play as a
  // flow note (card._waiting), so a normal backlog never keeps Health in alarm.
  const stuckAll = (summary.stuckTickets || []).map((s) => ({ ...s, updated_at: s.since }));
  const waiting = stuckAll.filter((s) => HELD_WAITING.has(s.status));
  const stuck = take(stuckAll.filter((s) => !HELD_WAITING.has(s.status)));
  const hours = summary.stuckThresholdHours;
  if (stuck.length)
    add({
      severity: "held",
      count: stuck.length,
      title: (n) => `${n} held too long`,
      sub: `in one state over ${hours ? `${hours}h` : "the limit"} · oldest ${fmtDuration(stuck[0].stuckForMs)} (#${stuck[0].number}, ${statusLabel(stuck[0].status).toLowerCase()})`,
      ...(stuck.length === 1
        ? { action: "Open", href: `#/ticket/${stuck[0].id}` }
        : new Set(stuck.map((x) => x.status)).size === 1
          ? { action: "View", href: `#/work?status=${stuck[0].status}` }
          : { action: "Board", href: "#/work" }),
      tickets: stuck,
    });

  // Referee's marks: red for blocked or failed, a yellow card for what waits on
  // you, a stopwatch for what is held, the red triangle for a fault.
  const sevIcon = (severity) =>
    severity === "critical"
      ? glyph("blocked", 18)
      : severity === "fault"
        ? glyph("failed", 18)
        : severity === "held"
          ? icon("clock", "ni-clock", 20)
          : ycard(20);
  const total = items.reduce((a, n) => a + n.count, 0);
  const chips = (list, href) => {
    if (!list || !list.length) return null;
    const shown = list.slice(0, 5);
    return el("span", { class: "ni-tks" }, [
      ...shown.map((t) =>
        el(
          "a",
          {
            class: "ni-tk tabnum",
            href: `#/ticket/${t.id}`,
            title: t.title || "",
            "aria-label": `#${t.number} ${t.title || ""}`,
          },
          `#${t.number}`,
        ),
      ),
      list.length > shown.length
        ? el(
            "a",
            {
              class: "ni-tk-more",
              href,
              "aria-label": `${list.length - shown.length} more`,
            },
            `+${list.length - shown.length}`,
          )
        : null,
    ]);
  };

  const body = items.length
    ? el(
        "ul",
        { class: "needs-list" },
        items.map((n) =>
          el("li", { class: "needs-item", dataset: { sev: n.severity, count: String(n.count) } }, [
            el("a", { class: "ni-link", href: n.href }, [
              el("span", { class: "ni-icon" }, sevIcon(n.severity)),
              el("span", { class: "ni-body" }, [
                el("span", { class: "ni-title" }, n.title(n.count)),
                el("span", { class: "ni-sub" }, n.sub),
              ]),
              el("span", { class: "ni-action" }, [
                n.action,
                el("span", { class: "ni-arrow" }, "→"),
              ]),
            ]),
            chips(n.tickets, n.href),
          ]),
        ),
      )
    : el("div", { class: "needs-empty" }, [icon("check"), "All clear: nothing is waiting on you."]);

  const card = el("div", { class: "card panel needs-hero" }, [
    panelHead("Treatment table", items.length ? plural(total, "thing") : "all clear", null, {
      kit: items.length ? "red" : "sky",
    }),
    body,
  ]);
  card.dataset.total = String(total);
  card._waiting = { list: waiting, hours: summary.stuckThresholdHours };
  return card;
}

/** Statuses where a ticket waits its turn: held long there is a queue, not an injury. */
const HELD_WAITING = new Set(["draft", "refining", "ready"]);

/**
 * The flow note under the phases of play: what has waited past the stuck limit on
 * the bench or in its box, oldest first, each a link. Null when nothing has.
 */
function waitingNote(w) {
  if (!w || !w.list || !w.list.length) return null;
  const list = w.list;
  const by = (st) => list.filter((t) => t.status === st).length;
  const where = [
    by("draft") + by("refining") ? `${by("draft") + by("refining")} on the bench` : null,
    by("ready") ? `${by("ready")} ready, not yet claimed` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const shown = list.slice(0, 6);
  return el("p", { class: "pl-wait" }, [
    icon("clock", "pl-wait-ico", 18),
    el("span", {}, [
      el(
        "b",
        {},
        `${plural(list.length, "ticket")} waiting over ${w.hours ? `${w.hours}h` : "a day"}`,
      ),
      ` (${where}). Oldest ${fmtDuration(list[0].stuckForMs)}. A queue, not an injury: `,
      ...shown.flatMap((t, i) => [
        i ? " " : "",
        el(
          "a",
          {
            href: `#/ticket/${t.id}`,
            title: t.title || "",
            "aria-label": `#${t.number} ${t.title || ""}`,
          },
          `#${t.number}`,
        ),
      ]),
      list.length > shown.length
        ? [" and ", el("a", { href: "#/work" }, `${list.length - shown.length} more`)]
        : null,
      ".",
    ]),
  ]);
}

/** One reverse-chronological activity row: time · ticket · event · actor. */
/**
 * Turn a machine event_type ("ticket.acceptance_criteria_reset") into a human
 * label ("Acceptance criteria reset"). A few cases read better with a bespoke
 * verb; everything else is derived by dropping the entity prefix and
 * sentence-casing the remainder, so new event types degrade gracefully.
 */
const EVENT_LABELS = {
  "ticket.created": "Ticket created",
  "ticket.transitioned": "Ticket moved",
  "ticket.claimed": "Ticket claimed",
  "ticket.evidence_recorded": "Evidence recorded",
  "ticket.acceptance_criteria_reset": "Acceptance criteria reset",
  "ticket.reopened_for_review": "Reopened for review",
  "ticket.edited": "Ticket edited",
  "ticket.unblocked": "Unblocked",
  "ac.edited": "Criterion edited",
  "ac.removed": "Criterion removed",
};
function humanizeEvent(type) {
  if (!type) return "Event";
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  const tail = type.includes(".") ? type.slice(type.indexOf(".") + 1) : type;
  const words = tail.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
}

/** "from_status" -> "From status" — a readable label for a payload key. */
function humanizeKey(key) {
  const words = String(key).replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * Render an event's JSON payload as readable key·value pairs rather than a raw
 * JSON dump. Only primitive values are shown (nested objects are omitted to keep
 * the timeline scannable); returns null when there is nothing worth showing.
 */
function formatPayload(jsonStr) {
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const pairs = Object.entries(obj).filter(
    ([, v]) => v != null && v !== "" && typeof v !== "object",
  );
  if (!pairs.length) return null;
  return el(
    "div",
    { class: "ev-payload" },
    pairs.map(([k, v]) =>
      el("span", { class: "ev-pair" }, [
        el("span", { class: "ev-key" }, humanizeKey(k)),
        el("span", { class: "ev-val" }, String(v)),
      ]),
    ),
  );
}

function renderFeedRow(ev) {
  const ticketRef =
    ev.ticket_number != null
      ? el(
          "a",
          { class: "feed-ticket", href: `#/ticket/${ev.entity_id}`, title: ev.ticket_title || "" },
          `#${ev.ticket_number}`,
        )
      : el("span", { class: "feed-ticket dim" }, ev.entity_type);
  return el("li", { class: "feed-row" }, [
    el("time", { class: "feed-time tabnum", datetime: ev.created_at }, fmtTime(ev.created_at)),
    ticketRef,
    el(
      "span",
      { class: `feed-event ev-${ev.event_type.split(".")[0]}` },
      humanizeEvent(ev.event_type),
    ),
    el("span", { class: "feed-actor dim" }, actorName(ev.actor_type, ev.actor_id)),
  ]);
}

export { devFlowPanel, needsPanel, waitingNote, humanizeEvent, formatPayload, renderFeedRow };
