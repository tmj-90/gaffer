// Shared status vocabulary, and the state-aware ticket action sets (single source of truth).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { el } from "./dom.js";
import { badge, glyph } from "./icons.js";

// --- Shared status vocabulary ----------------------------------------------

const STATUS_LABELS = {
  draft: "Draft",
  refining: "Refining",
  ready: "Ready",
  claimed: "Claimed",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  in_testing: "In testing",
  // Never "merging": nothing merges an approval unless a landing path does. A ticket
  // that carries the server's `landing_state` reads its truthful label instead.
  ready_for_merge: "Approved · to merge",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
};
/**
 * A status's word. An approved (ready_for_merge) or held ticket passes the server's
 * `landing_state`, so the word says where the landing really is ("Approved · waiting
 * for Merge now", "Approved · lands next tick", "Approved · landing", "Approved ·
 * partly landed", or the hold: "Held · merge gate failed").
 */
function statusLabel(status, landing) {
  if (landing && landing.label && (status === "ready_for_merge" || landing.kind === "held"))
    return landing.label;
  return STATUS_LABELS[status] || status;
}
/** A status: its §6 glyph + its word, together (never colour alone). */
function statusBadge(status, landing) {
  return el(
    "span",
    {
      class: `badge st status-${status}`,
      title: landing && landing.detail ? landing.detail : null,
    },
    [glyph(status, 16), el("span", {}, statusLabel(status, landing))],
  );
}
/** Risk: outlined condensed caps ("HIGH RISK" reads on its own, not by hue). */
/** Risk chip. `long` says "high risk" (a page's meta line, where "high" alone is ambiguous). */
function riskBadge(risk, { long = false } = {}) {
  return el(
    "span",
    { class: `badge risk-${risk}`, title: `${risk} risk` },
    long ? `${risk} risk` : risk,
  );
}
function accessBadge(access) {
  return badge(access, `access-${access}`);
}
/**
 * A repo name that navigates to that repo's detail page (#/repo/:id). renderRepo
 * resolves the param by id OR name, so either works. Falls back to a plain span
 * when there's nothing to link to. `stop` halts click propagation so the link
 * works inside a clickable board card without also opening the ticket.
 */
function repoLink(repo, { className = "", stop = false } = {}) {
  const ref = repo && (repo.id || repo.name);
  const name = (repo && (repo.name || repo.id)) || "repo";
  if (!ref) return el("span", { class: `repo-link plain ${className}`.trim() }, name);
  return el(
    "a",
    {
      class: `repo-link ${className}`.trim(),
      href: `#/repo/${encodeURIComponent(ref)}`,
      title: `Open ${name}`,
      onclick: stop ? (e) => e.stopPropagation() : null,
    },
    name,
  );
}

/**
 * Lifecycle progress marks: five stages (draft → ready → in progress → review →
 * done); stages passed are filled, the current one is the long mark, a terminal
 * failure paints it red. Class `.pdots` — `.pipeline` belongs to the Overview's
 * development-flow strip (the old shared name broke its overflow on phones).
 */
const LIFECYCLE = ["draft", "ready", "in_progress", "in_review", "done"];
const STAGE_FOR_STATUS = {
  draft: 0,
  refining: 0,
  ready: 1,
  claimed: 2,
  in_progress: 2,
  blocked: 2,
  // PAUSE-ON-CAP: paused shares the blocked column on the board (boardService maps
  // both to "blocked"). Use the same pipeline stage so a paused in-flight ticket
  // never falls back to stage 0 (draft).
  paused: 2,
  in_review: 3,
  // BBT-001: the independent-testing lane shares the "review" lifecycle stage —
  // it's post-delivery, pre-merge, just like in_review/ready_for_merge.
  in_testing: 3,
  ready_for_merge: 3,
  done: 4,
  failed: 4,
  cancelled: 4,
};
function pipelineDots(status) {
  const stage = STAGE_FOR_STATUS[status] ?? 0;
  const failed = status === "failed" || status === "cancelled";
  const wrap = el("span", {
    class: "pdots",
    role: "img",
    "aria-label": `Lifecycle: ${statusLabel(status)}`,
  });
  for (let i = 0; i < LIFECYCLE.length; i++) {
    let cls = "pd";
    if (i < stage) cls += " done";
    else if (i === stage) cls += failed ? " fail" : " active";
    wrap.appendChild(el("span", { class: cls }));
  }
  return wrap;
}

/** The pips said in words: "stage 3 of 5 · on the pitch". */
const STAGE_WORDS = ["drafting", "in the fixtures", "on the pitch", "the sign-off", "full time"];
function stageCaption(status) {
  const stage = STAGE_FOR_STATUS[status] ?? 0;
  const word =
    status === "failed" ? "sent off" : status === "cancelled" ? "won't do" : STAGE_WORDS[stage];
  return `Stage ${stage + 1} of ${LIFECYCLE.length} · ${word}`;
}

// --- State-aware action sets (single source of truth) -----------------------
//
// Every ticket/review action set is DRIVEN OFF THIS ONE MAP so the options can
// never drift between the detail page and the review surface. The headline bug
// this fixes: "Mark ready" used to appear in `in_review` (and would throw the
// ticket back to the start). It is now offered ONLY where it is legal — never for
// `in_review`, `ready_for_merge`, or `done`.
//
// Each action is a stable key; the renderers map a key to a concrete button. The
// backend remains the source of truth (an illegal call still comes back as an
// error); this map only decides what to OFFER.
const TICKET_ACTION_KEYS = {
  draft: ["mark_ready", "wont_do"],
  refining: ["mark_ready", "wont_do"],
  // A queued ticket nobody has claimed yet can still be closed (ready -> cancelled).
  // Claimed/live states have no human button here — work is owned by an agent.
  ready: ["wont_do"],
  claimed: [],
  in_progress: [],
  blocked: ["unblock", "wont_do"],
  // Review surface: approve takes the ticket to `ready_for_merge` (or in_testing).
  in_review: ["approve", "rework", "wont_do"],
  // BBT-001: independent testing lane. The tester agent owns the verdict (pass →
  // ready_for_merge, fail → refining); a human can also record it from here when the
  // lane is off, held (no verdict token) or the operator tested by hand.
  in_testing: ["tester_pass", "tester_fail"],
  // Approved, not landed (its landing_state says whether anything is landing it). A
  // human can merge it now, mark it merged
  // (admin override) or send it back for rework — but NOT "mark ready".
  ready_for_merge: ["merge_now", "mark_merged", "rework"],
  // Terminal: reopen only where allowed (cancelled is reopenable; done is not).
  done: [],
  // in_testing / ready_for_merge -> cancelled are legal too, but the Review view reads
  // this map for its sign-off buttons, so they are offered there, not added here.
  failed: ["unblock", "wont_do"],
  cancelled: ["reopen"],
  // PAUSE-ON-CAP: a paused (cap-hit) delivery offers one-click Continue (re-enter
  // the existing worktree) or Stop (cancel; the next tick removes the worktree). The banner above the bar
  // surfaces the reason + spend-so-far.
  paused: ["pause_continue", "pause_stop"],
};
function ticketActionKeys(status) {
  return TICKET_ACTION_KEYS[status] || [];
}
function hasTicketAction(status, key) {
  return ticketActionKeys(status).includes(key);
}

export {
  statusLabel,
  statusBadge,
  riskBadge,
  accessBadge,
  repoLink,
  pipelineDots,
  stageCaption,
  ticketActionKeys,
  hasTicketAction,
};
