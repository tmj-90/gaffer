// Shared status vocabulary, the ticket as one set of parts (ticketRef, ticketHead,
// statusBadge, verdictMark, priorityTag, reasonText), and the state-aware ticket action
// sets (single source of truth).

import { table } from "./lookup.js";
import { el, svgEl } from "./dom.js";
import { badge, glyph } from "./icons.js";

// --- Shared status vocabulary ----------------------------------------------

const STATUS_LABELS = table({
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
});
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
/** Glyph px per statusBadge size. */
const BADGE_GLYPH = table({ s: 14, m: 16, l: 20 });
/**
 * A status: its §6 glyph + its word, together (never colour alone). `size` "s" (a
 * board card), "m" (default) or "l"; one build for every status mark on a ticket.
 */
function statusBadge(status, landing, { size = "m" } = {}) {
  return el(
    "span",
    {
      class: `badge st status-${status}${size !== "m" ? ` st-${size}` : ""}`,
      title: landing && landing.detail ? landing.detail : null,
    },
    [glyph(status, BADGE_GLYPH[size] || 16), el("span", {}, statusLabel(status, landing))],
  );
}

// --- the ticket as one set of parts --------------------------------------------

/** A ticket's reference text: "#12", or (one fallback) its short id, or "?". */
function ticketRefText(t) {
  if (t && t.number != null) return `#${t.number}`;
  if (t && t.id) return String(t.id).slice(0, 8);
  return "?";
}
/** Where a ticket opens: Review while it is in review, else its own page. */
function ticketHref(t) {
  if (!t || !t.id) return null;
  return t.status === "in_review" ? `#/review/${t.id}` : `#/ticket/${t.id}`;
}
/**
 * A ticket's number, one build everywhere: Big Shoulders in claret ink at `size` "s"
 * (14 px, cards and rows), "m" (20 px) or "l" (26 px, a page head). A link to Review
 * while the ticket is in review, else to the ticket; `link: false` where the number
 * sits inside something that is already the link (a board card's title).
 */
function ticketRef(t, { size = "m", link = true } = {}) {
  const text = ticketRefText(t);
  const href = link ? ticketHref(t) : null;
  const cls = `tref tref-${size}`;
  if (!href) return el("span", { class: cls }, text);
  return el("a", { class: cls, href, "aria-label": `Ticket ${text}` }, text);
}
/**
 * A ticket's header, one build for Review and the ticket page: the title first, the
 * meta under it (number, status, then `facts`: strings or nodes), then the `lede`.
 * `mark` (a node: the yellow card, a verdict) rides at the end of the title row.
 * `level` is the title's heading level (0 for a plain paragraph inside a sheet).
 *   opts: { facts, lede, mark, level = 1, refSize = "m", link = false, cls }
 */
function ticketHead(
  t,
  { facts = [], lede, mark, level = 1, refSize = "m", link = false, cls } = {},
) {
  const tag = level ? `h${level}` : "p";
  return el("header", { class: cls ? `ticket-head ${cls}` : "ticket-head" }, [
    el(tag, { class: "th-title" }, (t && t.title) || "Untitled ticket"),
    mark ? el("span", { class: "th-mark" }, mark) : null,
    el("p", { class: "th-meta" }, [
      ticketRef(t, { size: refSize, link }),
      t && t.status ? statusBadge(t.status, t.landing_state, { size: "s" }) : null,
      ...[].concat(facts).map((f) => (f == null ? null : el("span", { class: "th-fact" }, f))),
    ]),
    lede ? el("p", { class: "th-lede" }, lede) : null,
  ]);
}

/**
 * A verdict's marks (a lane, a gate, a criterion), apart from the ticket lifecycle
 * glyphs so a passed check never reads as "done" nor an open one as "draft". 16px
 * grid, currentColor.
 */
const VERDICT_GLYPHS = table({
  pass: [["path", { d: "M3.2 8.6 L6.6 12 L12.8 4.6", fill: "none" }]],
  fail: [["path", { d: "M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8", fill: "none" }]],
  flag: [
    ["path", { d: "M8 2.6 V9.4", fill: "none" }],
    ["circle", { cx: 8, cy: 12.9, r: 1.3, fill: "currentColor", stroke: "none" }],
  ],
  skip: [["path", { d: "M3.8 8 H12.2", fill: "none" }]],
  open: [["rect", { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1, fill: "none" }]],
});
const VERDICT_WORDS = table({
  pass: "passed",
  fail: "failed",
  flag: "flagged",
  skip: "skipped",
  open: "open",
});
/**
 * A verdict: its own glyph and a word, together ("passed", "failed", "flagged",
 * "skipped", "open"). `word` replaces the default word; `size` is the glyph px.
 */
function verdictMark(verdict, { word, size = 16 } = {}) {
  const v = VERDICT_GLYPHS[verdict] ? verdict : "open";
  const svg = svgEl(
    "svg",
    {
      class: "vglyph",
      viewBox: "0 0 16 16",
      width: size,
      height: size,
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    VERDICT_GLYPHS[v].map(([tag, attrs]) => svgEl(tag, attrs)),
  );
  return el("span", { class: `vmark vm-${v}` }, [
    svg,
    el("span", { class: "vm-word" }, word || VERDICT_WORDS[v]),
  ]);
}

/** A priority, one way everywhere: "P0", its meaning in the title. Null for none. */
function priorityTag(p) {
  if (p == null || p === "") return null;
  return el(
    "span",
    { class: `badge prio prio-${p}`, title: `Priority ${p}${Number(p) === 0 ? " (highest)" : ""}` },
    `P${p}`,
  );
}

/** Plain words for the reason codes the server sends (park reasons, verdicts, advice). */
const REASON_WORDS = table({
  rework_exhausted: "Rework ran out of attempts",
  reworking: "Being reworked",
  bootstrap_failed: "Setup failed before work began",
  strict_require_unavailable: "A required check is unavailable",
  budget_exhausted: "Budget used up",
  budget_cap: "Hit the spend cap",
  no_write_repo: "No repository it may write to",
  no_local_repo_path: "Repository not checked out here",
  parked_retry_cap: "Retried too many times",
  tester_passed: "Tester passed it",
  tester_failed: "Tester failed it",
  tests_passed: "Tests passed",
  tests_failed: "Tests failed",
  merge_gate_red: "Merge checks failed",
  ci_red: "CI failed",
  tester_replay_red: "Tests failed on the landed revision",
  unsigned_approval: "Approval was not signed",
  partly_landed: "Partly landed",
  usage_limit: "Model usage limit reached",
  rate_limit: "Model rate limit reached",
  unpark: "Unpark it",
  refine: "Refine it",
  cancel: "Cancel it",
  continue: "Continue it",
});
/**
 * A server reason code in plain words ("rework_exhausted" reads "Rework ran out of
 * attempts", "risk=low" reads "Low risk"); an unknown code is de-snaked ("some_new_code"
 * reads "Some new code"). Show the raw code in a title (reasonTag does).
 */
function reasonText(code) {
  if (code == null) return "";
  const raw = String(code).trim();
  const kv = /^([a-z_]+)=([\w-]+)$/i.exec(raw);
  if (kv) {
    const [, k, v] = kv;
    if (k === "risk") return `${v.charAt(0).toUpperCase()}${v.slice(1)} risk`;
    return `${desnake(k)}: ${v}`;
  }
  const head = raw.split(":")[0];
  return REASON_WORDS[head] || desnake(head);
}
function desnake(s) {
  const t = String(s).replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}
/** A reason code as a tag: the plain words, the raw code in its title. */
function reasonTag(code, cls) {
  return el(
    "span",
    { class: cls ? `reason ${cls}` : "reason", title: `Server reason code: ${code}` },
    reasonText(code),
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
const STAGE_FOR_STATUS = table({
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
});
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
const TICKET_ACTION_KEYS = table({
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
});
function ticketActionKeys(status) {
  return TICKET_ACTION_KEYS[status] || [];
}
function hasTicketAction(status, key) {
  return ticketActionKeys(status).includes(key);
}

export {
  statusLabel,
  statusBadge,
  ticketRefText,
  ticketHref,
  ticketRef,
  ticketHead,
  verdictMark,
  priorityTag,
  reasonText,
  reasonTag,
  riskBadge,
  accessBadge,
  repoLink,
  pipelineDots,
  stageCaption,
  ticketActionKeys,
  hasTicketAction,
};
