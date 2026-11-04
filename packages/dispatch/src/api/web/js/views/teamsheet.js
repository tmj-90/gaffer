// The Team Sheet: what needs you, ranked, each with one real action.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock } from "../access.js";
import { panelHead } from "../components.js";
import { el } from "../dom.js";
import { fmtTime, plural } from "../format.js";
import { agentChip, glyph, icon, ycard } from "../icons.js";
import { ON_BENCH } from "../matchday.js";
import {
  answerSheet,
  mergeSheet,
  pausedSheet,
  readyApprovalSheet,
  unblockSheet,
} from "../sheets.js";
import { deliveredBy, integrityFlagOf } from "../../app.js";

// --- The Team Sheet: what needs you, ranked, each with one real action -------

/** The verb on each row. Every one is a real button or link (never a decoration). */
const OWN_VERB = {
  review: "Review",
  decision: "Answer…",
  parked: "Unblock…",
  awaiting_merge: "Merge…",
  ready_approval: "Approve…",
  reviewer_assignment: "Assign…",
  dependency_cancelled: "Re-plan…",
  paused: "Continue…",
  lore_drafts: "Open Memory",
};
/** The word each kind of row leads with (the referee's call, not the queue's jargon). */
const OWN_WORD = {
  parked: "Blocked",
  decision: "Decision",
  review: "Review sign-off",
  awaiting_merge: "Approved, not merged",
  paused: "Paused",
  lore_drafts: "Lore drafts",
};
const OWN_GLYPH = {
  review: "in_review",
  decision: "decision",
  parked: "blocked",
  awaiting_merge: "ready_for_merge",
  ready_approval: "ready",
  dependency_cancelled: "cancelled",
  paused: "paused",
};

function whatIOwnPanel(queue, f) {
  const items = (queue && queue.items) || [];
  const total = (queue && queue.counts && queue.counts.total) || items.length;
  const card = el(
    "section",
    { class: "card what-i-own", id: "what-i-own", "aria-label": "Team sheet" },
    [
      panelHead("Team sheet", items.length ? `needs you · ${total}` : null, null, {
        kit: "claret",
      }),
    ],
  );
  if (!items.length) {
    // Nothing needs you: say so, then the one thing a gaffer can do with a quiet
    // hour (the bench: drafts and refining tickets wait for criteria), when any.
    const bench = f ? f.tickets.filter((t) => ON_BENCH.has(t.status)) : [];
    const drafts = bench.filter((t) => t.status === "draft").length;
    card.appendChild(
      el("div", { class: "empty-state" }, [
        el(
          "p",
          { class: "es-title" },
          "Nothing needs you. Every ticket in play is with an agent or the queue.",
        ),
        bench.length
          ? el("p", { class: "es-sub" }, [
              `On the bench: ${[drafts ? `${drafts} draft` : "", bench.length - drafts ? `${bench.length - drafts} refining` : ""].filter(Boolean).join(", ")}. `,
              el("a", { href: "#/work?status=draft" }, "Pick one to sharpen"),
              " and it joins the fixtures.",
            ])
          : null,
      ]),
    );
    return card;
  }
  const well = el("ol", { class: "own-well" });
  items.forEach((it, i) => well.appendChild(el("li", {}, renderOwnedItem(it, i, f))));
  card.appendChild(well);
  return card;
}

/** The one action a row offers: a real button (a sheet that acts) or a real link. */
function ownAction(it, primary, f) {
  const act = ownActionControl(it, primary, f);
  // A link only opens a page; a button would change something, so a read token's is off.
  return act && act.tagName === "BUTTON" ? roLock(act, "ticket") : act;
}
function ownActionControl(it, primary, f) {
  const t = it.ticket;
  const cls = `btn own-act${primary ? " primary" : ""}`;
  const verb = OWN_VERB[it.kind] || "Open";
  const ref = t && t.number != null ? ` #${t.number}` : "";
  const label = `${verb.replace("…", "")}${ref}`;
  switch (it.kind) {
    case "parked":
      return t
        ? el(
            "button",
            { class: cls, type: "button", "aria-label": label, onclick: () => unblockSheet(t, it) },
            verb,
          )
        : null;
    case "decision":
      return it.decisionId
        ? el(
            "button",
            {
              class: cls,
              type: "button",
              "aria-label": `Answer: ${decisionTitle(it, f)}`,
              onclick: () => answerSheet(it, f),
            },
            verb,
          )
        : null;
    case "awaiting_merge":
      return t
        ? el(
            "button",
            { class: cls, type: "button", "aria-label": label, onclick: () => mergeSheet(t) },
            verb,
          )
        : null;
    case "ready_approval":
      return t
        ? el(
            "button",
            {
              class: cls,
              type: "button",
              "aria-label": label,
              onclick: () => readyApprovalSheet(t, it),
            },
            verb,
          )
        : null;
    case "review":
      return t
        ? el("a", { class: cls, href: `#/review/${t.id}`, "aria-label": label }, verb)
        : null;
    case "paused":
      return t
        ? el(
            "button",
            { class: cls, type: "button", "aria-label": label, onclick: () => pausedSheet(t, it) },
            verb,
          )
        : null;
    case "lore_drafts":
      // Approving is Memory's: the drafts are listed there, each with Approve / Reject.
      return el(
        "a",
        {
          class: cls,
          href: "#/memory",
          "aria-label": `Open Memory: ${plural(it.loreDrafts || 0, "lore draft")} to approve`,
        },
        verb,
      );
    default:
      return t
        ? el("a", { class: cls, href: `#/ticket/${t.id}`, "aria-label": label }, verb)
        : null;
  }
}
/** How long a team-sheet row has waited, in words a programme would print: "9 h 16 min". */
function fmtWait(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ${min % 60} min`;
  const day = Math.floor(hr / 24);
  return `${day} ${day === 1 ? "day" : "days"} ${hr % 24} h`;
}

/** A decision's question: its title from /decisions (the reason is the detail). */
function decisionTitle(it, f) {
  const d = f && f.decisions.find((x) => x.id === it.decisionId);
  return (d && d.title) || it.title || it.reason || "Decision";
}

/** A Team Sheet body longer than this is clamped to four lines behind a More toggle. */
const OWN_CLAMP_CHARS = 220;
/** The rows the operator opened, by kind and ticket/decision, so a refresh keeps them open. */
const ownExpanded = new Set();
let ownReasonSeq = 0;
/**
 * One watcher for every clamped body: once laid out, a body that fits its four
 * lines after all (a wide column) drops its toggle; a narrower one gets it back.
 */
let ownClampObserver;
function watchOwnClamp(p, btn) {
  if (typeof window.ResizeObserver !== "function") return;
  if (!ownClampObserver)
    ownClampObserver = new window.ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (!target.isConnected) {
          ownClampObserver.unobserve(target);
          continue;
        }
        const b = target._clampBtn;
        if (!b || !target.classList.contains("is-clamped") || !target.clientHeight) continue;
        b.hidden = target.scrollHeight <= target.clientHeight + 1;
      }
    });
  p._clampBtn = btn;
  ownClampObserver.observe(p);
}
/** A row's body (its reason), clamped when long, and its More / Less toggle. */
function ownReason(it, i, reason) {
  const p = el("p", { class: "own-reason" }, reason);
  const long = reason.length > OWN_CLAMP_CHARS || (reason.match(/\n/g) || []).length >= 4;
  if (!long) return [p];
  const key = `${it.kind}:${(it.ticket && it.ticket.id) || it.decisionId || i}`;
  p.id = `own-reason-${++ownReasonSeq}`;
  const btn = el("button", { class: "own-more", type: "button", "aria-controls": p.id });
  const paint = () => {
    const open = ownExpanded.has(key);
    p.classList.toggle("is-clamped", !open);
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Less" : "More";
  };
  btn.addEventListener("click", () => {
    if (ownExpanded.has(key)) ownExpanded.delete(key);
    else ownExpanded.add(key);
    btn.hidden = false;
    paint();
  });
  paint();
  watchOwnClamp(p, btn);
  return [p, btn];
}

/** Team-sheet rows that name the agent who played the ticket. */
const OWN_BY_KINDS = new Set(["review", "awaiting_merge", "parked"]);
/** One team-sheet row: rank · card · kind · #ref, the title (a link), the reason, the wait, the action. */
function renderOwnedItem(it, i = 0, f = null) {
  const t = it.ticket;
  const ref = t ? (t.number != null ? `#${t.number}` : t.id.slice(0, 8)) : null;
  const href = t ? (it.kind === "review" ? `#/review/${t.id}` : `#/ticket/${t.id}`) : null;
  const title = t && t.title ? t.title : it.kind === "decision" ? decisionTitle(it, f) : null;
  // An approved change's row says why it waits in its landing_state's words (the ticket
  // page's): the queue's generic "the runner held the merge gate, or a merge attempt did
  // not land" was false for an approval nothing lands, one the merge lane lands next
  // tick, and one landing now.
  const landing = it.kind === "awaiting_merge" && t ? t.landing_state : null;
  const reason = (landing && landing.detail) || it.reason || "(no reason given)";
  // Who played it: the agent on the ticket's latest claim (a change, a merge, a parked ticket).
  const by = f && t && OWN_BY_KINDS.has(it.kind) ? deliveredBy(f.details.get(t.id)?.events) : null;
  const tFlag =
    f && t && OWN_BY_KINDS.has(it.kind) ? integrityFlagOf(f.details.get(t.id)?.evidence) : null;
  return el("div", { class: `own-row own-row--${it.kind}`, dataset: { kind: it.kind } }, [
    el("span", { class: "own-rank", "aria-hidden": "true" }, String(i + 1)),
    el("div", { class: "own-body" }, [
      el("p", { class: "own-head" }, [
        el("span", { class: `own-kind own-kind--${it.kind}` }, [
          ycard(16, "ycard-row"),
          OWN_GLYPH[it.kind] ? glyph(OWN_GLYPH[it.kind], 16) : null,
          // An approved change says where its landing is (the ticket page's own words).
          (landing && landing.label) || OWN_WORD[it.kind] || it.label,
        ]),
        ref ? el("span", { class: "own-ref" }, ref) : null,
      ]),
      title ? el("p", { class: "own-title" }, href ? el("a", { href }, title) : title) : null,
      // A decision's reason IS its question text; the title above is its headline.
      // A long one (an onboarding intake's eight questions) is clamped to four
      // lines with a More toggle, so the Tactics Board is not pushed down the page.
      ...ownReason(it, i, reason),
      el("p", { class: "own-meta" }, [
        // Memory records no time a draft started waiting, so its row says none.
        it.kind === "lore_drafts"
          ? null
          : el(
              "span",
              { class: "own-age tabnum", title: `Waiting since ${fmtTime(it.since)}` },
              `Waited ${fmtWait(it.waitedMs)}`,
            ),
        by
          ? el("span", { class: "own-by" }, [
              it.kind === "parked" ? "with " : "delivered by ",
              agentChip(by.id, by.name, 18),
            ])
          : null,
        // GATE INTEGRITY: the runner flagged that this delivery changed its own tests.
        tFlag
          ? el(
              "span",
              {
                class: "own-flag",
                title: String(tFlag.note || ""),
                "aria-label": `Tests changed: ${String(tFlag.note || "this delivery changed its tests")}.`,
              },
              [icon("alert", "", 14), "Tests changed"],
            )
          : null,
        // The server's structured code and its advice, as the referee's notebook:
        // one group, so the advice never wraps onto a line of its own.
        it.reasonCode != null || it.suggestedAction
          ? el("span", { class: "own-note" }, [
              it.reasonCode != null
                ? el(
                    "span",
                    { class: "own-code", title: "The server's reason code" },
                    it.reasonCode,
                  )
                : null,
              it.reasonCode != null && it.suggestedAction ? "\u00a0\u00a0" : null,
              it.suggestedAction
                ? el(
                    "span",
                    { class: "own-action", title: "What the server suggests" },
                    `→\u00a0${it.suggestedAction}`,
                  )
                : null,
            ])
          : null,
      ]),
    ]),
    el("div", { class: "own-cta" }, ownAction(it, i === 0, f)),
  ]);
}

export { whatIOwnPanel };
