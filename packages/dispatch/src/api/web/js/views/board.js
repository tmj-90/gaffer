// The board: moves (drag and the touch status menu), lanes, cards, the list and the claims panel.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentWho, roLock } from "../access.js";
import { api } from "../api.js";
import { emptyState } from "../components.js";
import { el, prefersReducedMotion } from "../dom.js";
import { fmtTime, plural } from "../format.js";
import { clockTime } from "../freshness.js";
import { agentChip, badge, glyph, icon, kitShirt, repoTag, ycard } from "../icons.js";
import { announce } from "../live.js";
import { navigate, router } from "../router.js";
import { wontDoSheet } from "../sheets.js";
import { hasTicketAction, pipelineDots, riskBadge, statusBadge, statusLabel } from "../status.js";
import { guard, toast } from "../toast.js";
import { progPage } from "./programme.js";
import {
  BOARD_COLUMN_LABELS,
  STATUS_URGENCY,
  WORK_BOARD_WINDOW,
  boardTruncated,
  cardHasMoveMenu,
  cardIsMovable,
  hashText,
  isPhoneWidth,
  laneOpenState,
  laneStartsOpen,
  legalTargetColumns,
  needsLabel,
  workFiltered,
  workMatches,
} from "./work.js";

/**
 * Move a card to a target column with an optimistic UI update + rollback. The
 * DOM card glides into the destination lane at once (a View Transition, off under
 * reduced motion); on a backend rejection (illegal transition, policy,
 * concurrency) it snaps back and an error toast surfaces the API code. On success
 * the board re-renders so counts and claim state stay truthful.
 */
async function performBoardMove(cardEl, card, toColumn) {
  if (card.status === toColumn) return; // dropped on its own column — no-op.
  const fromBody = cardEl.parentElement;
  const placeholder = document.createComment("wg-move");
  fromBody.insertBefore(placeholder, cardEl);
  const destBody = document.querySelector(`.board-col.col-${toColumn} .board-col-body`);
  const glide = (fn) => {
    if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) return fn();
    cardEl.style.viewTransitionName = "wk-moving-card";
    let t;
    try {
      t = document.startViewTransition(fn);
    } catch {
      cardEl.style.viewTransitionName = "";
      return fn();
    }
    // The refresh after the move starts its own transition, which skips this one
    // and rejects its promises with InvalidStateError: swallow those (the DOM
    // update still ran), as router() does.
    const clear = () => (cardEl.style.viewTransitionName = "");
    t.ready?.catch(() => {});
    t.updateCallbackDone?.catch(() => {});
    t.finished?.then(clear, clear);
  };
  if (destBody) {
    glide(() => {
      const dash = destBody.querySelector(".board-empty");
      if (dash) dash.remove();
      destBody.prepend(cardEl);
      const fold = destBody.closest("details");
      if (fold) fold.open = true;
    });
  }
  cardEl.classList.add("is-moving");
  const label = BOARD_COLUMN_LABELS[toColumn] || toColumn;
  try {
    await api("POST", `/tickets/${card.id}/move`, { to: toColumn });
    toast(`Moved ${card.number != null ? `#${card.number}` : "the ticket"} to ${label}`, {
      ok: true,
    });
    router(); // refresh truthfully (counts/claim) once the move landed.
  } catch (e) {
    // Rollback: restore the card to where the drag started.
    if (placeholder.parentElement) placeholder.parentElement.insertBefore(cardEl, placeholder);
    cardEl.classList.remove("is-moving");
    toast(e.message || "Move rejected", { code: e.code });
  } finally {
    if (placeholder.parentElement) placeholder.remove();
  }
}

/**
 * The move menu (touch and keyboard; the same moves as a drag): the card is
 * armed while it is open, focus goes to the first lane, arrows walk the list and
 * Escape puts focus back on the card's Move button.
 */
function openMoveMenu(card, anchorEl) {
  const targets = card.claim ? [] : legalTargetColumns(card.status);
  const wontDo = !card.claim && hasTicketAction(card.status, "wont_do");
  if (!targets.length && !wontDo) return;
  closeMoveMenu();
  const cardNode = anchorEl.closest(".board-card");
  const name = card.number != null ? `#${card.number}` : "this ticket";
  const items = targets.map((col) =>
    el(
      "button",
      {
        class: "movemenu-item",
        type: "button",
        role: "menuitem",
        onclick: () => {
          closeMoveMenu({ restore: false });
          if (cardNode) guard(() => performBoardMove(cardNode, card, col));
        },
      },
      [glyph(col, 18), el("span", {}, BOARD_COLUMN_LABELS[col] || col)],
    ),
  );
  // Won't do is not a lane you drop on: it asks for a reason in the shared sheet,
  // which hands focus back to the card's Move button when it closes.
  if (wontDo)
    items.push(
      el(
        "button",
        {
          class: "movemenu-item movemenu-wontdo",
          type: "button",
          role: "menuitem",
          onclick: () => {
            closeMoveMenu();
            wontDoSheet(card);
          },
        },
        [glyph("cancelled", 18), el("span", {}, "Won't do…")],
      ),
    );
  const menu = el("div", { class: "movemenu", role: "menu", "aria-label": `Move ${name} to` }, [
    el("div", { class: "movemenu-head", "aria-hidden": "true" }, `Move ${name} to`),
    ...items,
  ]);
  menu.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Tab") {
      e.preventDefault(); // the menu keeps focus until a lane is picked or it closes
    }
  });
  const scrim = el("div", { class: "movemenu-scrim", onclick: () => closeMoveMenu() });
  scrim.appendChild(menu);
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(scrim);
  moveMenuScrim = scrim;
  moveMenuReturn = anchorEl;
  if (cardNode) cardNode.classList.add("card-armed");
  anchorEl.setAttribute("aria-expanded", "true");
  document.addEventListener("keydown", moveMenuKeydown);
  // The menu opens at its Move button (below it, or above when the screen ends),
  // so the armed card stays in view beside the lanes it can go to.
  const r = anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
  if (r && r.width) {
    scrim.classList.add("is-anchored");
    const place = () => {
      const a = anchorEl.getBoundingClientRect();
      const nav = document.getElementById("bottomnav");
      const navTop = nav && nav.offsetHeight ? nav.getBoundingClientRect().top : window.innerHeight;
      const floor = Math.min(window.innerHeight, navTop) - 8;
      // The Move button scrolled out of view: the menu has nothing to sit by.
      if (!anchorEl.isConnected || a.bottom < 0 || a.top > floor) return false;
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      let top = a.bottom + 6;
      if (top + mh > floor) top = Math.max(8, a.top - 6 - mh);
      menu.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - mw - 8))}px`;
      menu.style.top = `${top}px`;
      return true;
    };
    place();
    moveMenuPlace = place;
    window.addEventListener("scroll", onMoveMenuScroll, { passive: true });
  }
  items[0].focus();
}
let moveMenuScrim = null;
let moveMenuReturn = null;
let moveMenuPlace = null;
// The page scrolls under an anchored menu: it follows its Move button (a momentum
// scroll no longer closes it under a tap), and closes once the button leaves view.
function onMoveMenuScroll() {
  if (!moveMenuPlace || !moveMenuPlace()) closeMoveMenu();
}
function closeMoveMenu({ restore = true } = {}) {
  window.removeEventListener("scroll", onMoveMenuScroll);
  moveMenuPlace = null;
  if (moveMenuScrim) {
    moveMenuScrim.remove();
    moveMenuScrim = null;
  }
  document
    .querySelectorAll(".board-card.card-armed")
    .forEach((n) => n.classList.remove("card-armed"));
  if (moveMenuReturn) {
    moveMenuReturn.setAttribute("aria-expanded", "false");
    // preventScroll: a menu closed by scrolling away never yanks the page back.
    if (restore && moveMenuReturn.isConnected) moveMenuReturn.focus({ preventScroll: true });
    moveMenuReturn = null;
  }
  document.removeEventListener("keydown", moveMenuKeydown);
}
function moveMenuKeydown(e) {
  if (e.key === "Escape") closeMoveMenu();
}

/**
 * The board renders a bounded number of cards per lane: the whole Done history
 * (and a runaway live lane) would otherwise grow the DOM forever and jank every
 * 9s refresh (board-unbounded-render). Done shows the newest BOARD_DONE_CAP;
 * live lanes show BOARD_LANE_CAP. The lane head always shows the TRUE count, and
 * the remainder is one link away in the List view, filtered to that status.
 */
const BOARD_DONE_CAP = 25;
const BOARD_LANE_CAP = 60;
const BOARD_CLOSED_CAP = 25;
function capLane(column, cards) {
  if (column === "done") {
    const newest = [...cards].sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    return newest.slice(0, BOARD_DONE_CAP);
  }
  return cards.slice(0, BOARD_LANE_CAP);
}
function laneMoreLink(column, shown, total) {
  if (total <= shown) return null;
  return el(
    "a",
    { class: "lane-more", href: `#/work?mode=list&status=${encodeURIComponent(column)}` },
    `Showing ${shown} of ${total} — see all in the list`,
  );
}

/** Phone lane order: most urgent first; lanes with no (matching) card sink last. */
const PHONE_LANE_URGENCY = [
  "blocked",
  "in_review",
  "in_progress",
  "ready_for_merge",
  "in_testing",
  "ready",
  "draft",
  "done",
];
function phoneLaneOrder(columns) {
  const rank = (c) => {
    const i = PHONE_LANE_URGENCY.indexOf(c.column);
    const empty = !(c.cards || []).some(workMatches);
    return (empty ? 100 : 0) + (i < 0 ? 50 : i);
  };
  return [...columns].sort((a, b) => rank(a) - rank(b));
}

/** Board (kanban) — mown lanes by status; filters narrow the cards client-side. */
function renderBoard(columns, closed, wontDo = [], needs = null, totals = null) {
  const wrap = el("div", { class: "board-wrap" });
  const phone = isPhoneWidth();
  const total = columns.reduce((n, c) => n + (c.cards || []).length, 0);
  const shown = columns.reduce((n, c) => n + (c.cards || []).filter(workMatches).length, 0);
  // A filter narrows only the cards the window loaded: say so, and where to search all.
  if (workFiltered() && boardTruncated(columns)) {
    wrap.appendChild(
      el("p", { class: "section-note work-window-note", role: "status" }, [
        `Filters apply to the first ${WORK_BOARD_WINDOW} cards of each lane. `,
        el("a", { href: "#/work?mode=list" }, "The list searches every ticket."),
      ]),
    );
  }
  if (!total && !closed.length && !wontDo.length && !workFiltered()) {
    wrap.appendChild(
      emptyState(
        "No tickets yet. Create one, or let the product owner suggest work.",
        null,
        null,
        el("a", { class: "btn", href: "#/create" }, "Create a ticket"),
      ),
    );
  } else if (!shown && workFiltered()) {
    wrap.appendChild(
      el("p", { class: "work-nomatch", role: "status" }, "No ticket matches these filters."),
    );
  }

  const closedAll = [...closed, ...wontDo].filter(workMatches);
  // On a phone the lanes stack in urgency order (Blocked, In review, In progress
  // first; empty lanes last) IN THE DOM, so tab and screen-reader order match what
  // is on screen (WCAG 2.4.3). The board re-renders when the width crosses 760px.
  const laneCols = phone ? phoneLaneOrder(columns) : columns;
  const cols = el(
    "div",
    { class: "board" },
    laneCols.map((c, laneIdx) => {
      // repo is filtered server-side via ?repo= on /api/board; status, risk and the
      // number-or-title filter narrow the cards here.
      const all = (c.cards || []).filter(workMatches);
      const cards = capLane(c.column, all);
      const label = BOARD_COLUMN_LABELS[c.column] || c.column;
      // The lane's true size: the server's count unfiltered, the matches filtered.
      const laneTotal = workFiltered() ? all.length : (c.total ?? all.length);
      const body = el(
        "div",
        { class: "board-col-body" },
        cards.length
          ? [
              ...cards.map((card) => renderBoardCard(card, c.column, needs)),
              laneMoreLink(c.column, cards.length, laneTotal),
            ]
          : el("p", { class: "board-empty" }, "Nothing here."),
      );
      // Done carries the tickets that left without merging, as the comp's foot line.
      const foot =
        c.column === "done" && closedAll.length
          ? el("p", { class: "lane-foot" }, [
              "Closed without merging: ",
              ...closedAll
                .slice(0, 6)
                .flatMap((t, j) => [
                  j ? ", " : "",
                  el(
                    "a",
                    { href: `#/ticket/${t.id}` },
                    t.number != null ? `#${t.number}` : t.id.slice(0, 8),
                  ),
                  ` ${t.status === "cancelled" ? "won't do" : statusLabel(t.status, t.landing_state).toLowerCase()}`,
                ]),
              closedAll.length > 6 ? `, and ${closedAll.length - 6} more` : "",
              ".",
            ])
          : null;
      const headBits = [
        glyph(c.column, 18),
        el("h2", { class: "board-col-title" }, label),
        el("span", { class: "board-col-count tabnum" }, String(laneTotal)),
      ];
      let inner;
      if (phone && all.length) {
        const open = laneStartsOpen(c.column, all.length);
        const toggleWord = el(
          "span",
          { class: "lane-toggle", "aria-hidden": "true" },
          open ? "Hide" : "Show",
        );
        const details = el("details", { class: "lane-d", open: open ? "" : null }, [
          el("summary", { class: "board-col-head" }, [...headBits, toggleWord]),
          body,
          foot,
        ]);
        details.addEventListener("toggle", () => {
          laneOpenState.set(c.column, details.open);
          toggleWord.textContent = details.open ? "Hide" : "Show";
        });
        inner = [details];
      } else {
        inner = [el("div", { class: "board-col-head" }, headBits), body, foot];
      }
      const section = el(
        "section",
        {
          class: `board-col col-${c.column} ${laneIdx % 2 ? "lane-b" : "lane-a"}`,
          dataset: { column: c.column, status: c.column },
          "aria-label": `${label}: ${laneTotal}`,
        },
        inner,
      );
      wireColumnDropZone(section, c.column);
      return section;
    }),
  );
  wrap.appendChild(cols);

  // Closed without merging: won't do (reversible: Reopen → refining) and failed.
  const wontDoVisible = wontDo.filter(workMatches);
  const failedVisible = closed.filter(workMatches);
  const areaTotal = (list, key) => (!workFiltered() && totals ? totals[key] : list.length);
  if (wontDoVisible.length || failedVisible.length) {
    const group = (cls, title, list, action, key) => {
      const n = areaTotal(list, key);
      return el("section", { class: `closed-area ${cls}`, "aria-label": `${title}: ${n}` }, [
        el("h3", { class: "closed-head" }, [
          glyph(list[0].status, 16),
          el("span", {}, title),
          el("span", { class: "closed-count tabnum" }, String(n)),
        ]),
        el("ul", { class: "closed-cards" }, [
          ...list.slice(0, BOARD_CLOSED_CAP).map((t) => closedRow(t, action)),
        ]),
        n > BOARD_CLOSED_CAP
          ? el(
              "p",
              { class: "section-note" },
              `Showing ${Math.min(BOARD_CLOSED_CAP, list.length)} of ${n}.`,
            )
          : null,
      ]);
    };
    wrap.appendChild(
      progPage(
        "work-closed",
        null,
        "Closed without merging",
        plural(areaTotal(wontDoVisible, "wontDo") + areaTotal(failedVisible, "closed"), "ticket"),
        el("div", { class: "closed-groups" }, [
          wontDoVisible.length
            ? group("wont-do-area", "Won't do", wontDoVisible, wontDoReopen, "wontDo")
            : null,
          failedVisible.length
            ? group("failed-area", "Failed", failedVisible, null, "closed")
            : null,
        ]),
      ),
    );
  }
  return wrap;
}

/** One closed ticket: number, title (the link), risk, repo, and its one action. */
function closedRow(t, action) {
  const repo = (t.repos || [])[0];
  return el("li", { class: `closed-row bc-${t.status}` }, [
    el("span", { class: "closed-num tabnum" }, t.number != null ? `#${t.number}` : "—"),
    el("a", { class: "closed-title", href: `#/ticket/${t.id}` }, t.title),
    el("span", { class: "closed-meta" }, [
      riskBadge(t.risk_level),
      repo ? repoTag(repo.name, 16) : null,
      el("span", { class: "dim tabnum" }, fmtTime(t.updated_at)),
    ]),
    action ? action(t) : null,
  ]);
}

/** Won't do is reversible: Reopen sends the ticket back to refining. */
function wontDoReopen(card) {
  return roLock(
    el(
      "button",
      {
        class: "btn small",
        type: "button",
        title: "Reopen this ticket into refining",
        "aria-label": `Reopen ${card.number != null ? `#${card.number}` : "this ticket"} into refining`,
        onclick: () =>
          guard(async () => {
            await api("POST", `/tickets/${card.id}/reopen`, { to: "refining" });
            toast("Reopened to refining", { ok: true });
            router();
          }),
      },
      "Reopen",
    ),
    "ticket",
  );
}

/**
 * Make a column a HTML5 drop target. While a movable card is dragging, columns
 * that can legally accept it light up (sky edge); columns that can't show a
 * not-allowed cursor and never accept the drop.
 */
function wireColumnDropZone(section, column) {
  section.addEventListener("dragover", (e) => {
    if (!draggingCard) return;
    if (legalTargetColumns(draggingCard.status).includes(column)) {
      e.preventDefault(); // allow the drop
      e.dataTransfer.dropEffect = "move";
      section.classList.add("drop-ok");
    } else {
      e.dataTransfer.dropEffect = "none";
      section.classList.add("drop-no");
    }
  });
  section.addEventListener("dragleave", (e) => {
    // Only clear when actually leaving the column (not crossing a child boundary).
    if (e.target === section || !section.contains(e.relatedTarget)) {
      section.classList.remove("drop-ok", "drop-no");
    }
  });
  section.addEventListener("drop", (e) => {
    section.classList.remove("drop-ok", "drop-no");
    if (!draggingCard || !draggingEl) return;
    if (!legalTargetColumns(draggingCard.status).includes(column)) return;
    e.preventDefault();
    const cardEl = draggingEl,
      card = draggingCard;
    guard(() => performBoardMove(cardEl, card, column));
  });
}

// The card currently being dragged (set on dragstart, cleared on dragend) so
// drop zones can decide legality without serialising state into dataTransfer.
let draggingCard = null;
let draggingEl = null;

/**
 * TRACK-2b: the human WIP lane's per-card action. A `ready` card gets an "I'll do
 * this by hand" button (human-claim → in_progress owned by you, so the agent loop
 * skips it); a human-owned in_progress card gets a "Hand back" button (release →
 * ready). Both POST the dedicated endpoints and re-render on success. Returns null
 * for cards with no human-lane action (agent-claimed / other states).
 */
function humanLaneAction(card) {
  const post = async (path, verb) => {
    try {
      await api("POST", `/tickets/${card.id}/${path}`, {});
      toast(verb, { ok: true });
      router();
    } catch (e) {
      toast(e.message || "Action rejected", { code: e.code });
    }
  };
  if (card.humanOwner) {
    return el(
      "button",
      {
        class: "card-human-btn hand-back",
        type: "button",
        title: "Hand this ticket back to the queue so an agent can pick it up",
        onclick: () => guard(() => post("human-release", "Handed back to the queue")),
      },
      "Hand back",
    );
  }
  // Only a genuinely-claimable ready ticket (no agent claim) can be taken by hand.
  if (card.status === "ready" && !card.claim) {
    return el(
      "button",
      {
        class: "card-human-btn take-myself",
        type: "button",
        title: "Take this ticket by hand — the agent will stay out of it",
        onclick: () => guard(() => post("human-claim", "You're on it — taken by hand")),
      },
      "I'll do this by hand",
    );
  }
  return null;
}

/** A status word with its glyph, at card size (for a card whose status is not its lane's). */
function cardStatus(status, landing) {
  return el(
    "span",
    { class: `card-status st-${status}`, title: landing && landing.detail ? landing.detail : null },
    [glyph(status, 14), el("span", {}, statusLabel(status, landing))],
  );
}

/**
 * A board card: an <article> whose title is the link (stretched over the card).
 * `laneKey` is the lane it sits in, so a refining, claimed or paused card says so.
 */
function renderBoardCard(card, laneKey, needs) {
  const numText = card.number != null ? `#${card.number}` : card.id.slice(0, 8);
  const need = needsLabel(card, needs);
  const href = card.status === "in_review" ? `#/review/${card.id}` : `#/ticket/${card.id}`;

  const top = el("div", { class: "card-top" }, [
    el("span", { class: "num" }, numText),
    // An approved or held card always says where its landing is (the lane cannot).
    card.landing_state
      ? cardStatus(card.status, card.landing_state)
      : laneKey && card.status !== laneKey && card.status !== "done"
        ? cardStatus(card.status)
        : null,
    el("span", { class: "card-tags" }, [
      card.blockingCount ? badge(`${card.blockingCount} blocking`, "status-blocked") : null,
      el(
        "span",
        { class: "card-pri tabnum", title: `Priority ${card.priority}` },
        `P${card.priority}`,
      ),
      riskBadge(card.risk_level),
    ]),
  ]);

  let acText = null;
  let acTitle = null;
  if (card.acEvidenceRequired > 0) {
    acText = `Evidence ${card.acEvidenced}/${card.acEvidenceRequired}`;
    acTitle = `${card.acEvidenced} of ${card.acEvidenceRequired} criteria evidenced`;
  } else if (card.acTotal > 0) {
    acText = `AC ${card.acSatisfied}/${card.acTotal}`;
    acTitle = `${card.acSatisfied} of ${card.acTotal} acceptance criteria satisfied`;
  }

  // Repo cross-link (audit: "no path from a card to its repo"): the repo is a
  // button beside the title link, one hop to #/repo/:id.
  const cardRepos = card.repos || [];
  const meta = el("div", { class: "card-meta" }, [
    cardRepos.length
      ? el("span", { class: "card-repos" }, [
          ...cardRepos.slice(0, 2).map((r) =>
            el(
              "button",
              {
                class: "card-repo-chip",
                type: "button",
                title: `Open ${r.name}`,
                onclick: () => navigate(`#/repo/${encodeURIComponent(r.id || r.name)}`),
              },
              [kitShirt(r.name, 16), el("span", {}, r.name)],
            ),
          ),
          cardRepos.length > 2
            ? el("span", { class: "card-repo-more dim" }, `+${cardRepos.length - 2}`)
            : null,
        ])
      : el("span", { class: "dim" }, "No repo yet"),
    el("span", { class: "ac-progress tabnum", title: acTitle }, acText || "No AC"),
  ]);

  // TRACK-2b: a ticket the operator took "by hand" is THEIR in-flight work, not the
  // agent's. Render it distinctly (a "By hand" marker with the human-owner) so the
  // human WIP lane reads apart from an agent claim. This branch wins over the agent
  // claim — a human-owned ticket never carries an agent claim.
  const owner = card.humanOwner
    ? el(
        "p",
        { class: "card-human-owned", title: `You're working this by hand (${card.humanOwner})` },
        [el("span", { class: "human-dot" }), "By hand", ` · ${card.humanOwner}`],
      )
    : card.claim
      ? el(
          "p",
          {
            class: `card-claim${card.claim.stale ? " stale" : ""}`,
            title: card.claim.stale
              ? `Lease ended ${fmtTime(card.claim.expiresAt)}`
              : `Lease to ${fmtTime(card.claim.expiresAt)}`,
          },
          [
            agentChip(card.claim.agentId, card.claim.agentDisplayName, 22),
            card.claim.stale ? el("span", { class: "card-stale" }, "lease ended") : null,
          ],
        )
      : null;

  // WG-049 + rework loop: a ticket bounced back from review OR being reworked in
  // place carries a reason, so a human triaging the board sees WHAT is happening
  // without opening the ticket. Three shapes, keyed off the structured feedback code:
  //   • reworking        → the runner is re-invoking the agent right now (in_progress):
  //                        "Reworking · attempt N/M" so the ticket never looks "gone".
  //   • rework_exhausted → the rework loop hit its attempt/cost ceiling and parked to
  //                        the VISIBLE blocked column: "Rework exhausted".
  //   • (none)           → an ordinary human review rejection: "Rejected".
  const reject = (() => {
    const fb = card.lastReviewFeedback;
    if (!fb) return null;
    const attemptSuffix =
      typeof fb.attempt === "number" && typeof fb.maxAttempts === "number"
        ? ` · attempt ${fb.attempt}/${fb.maxAttempts}`
        : "";
    let label = "Rejected:";
    let cls = "card-reject";
    let title = `Rejected by ${fb.reviewer || "reviewer"}`;
    if (fb.code === "reworking") {
      label = `Reworking${attemptSuffix}:`;
      cls = "card-reject card-reworking";
      title = "Runner is re-invoking the agent";
    } else if (fb.code === "rework_exhausted") {
      label = `Rework exhausted${attemptSuffix}:`;
      cls = "card-reject card-rework-exhausted";
      title = "Rework loop hit its attempt/cost ceiling — needs a human";
    }
    return el("p", { class: cls, title }, [
      el("span", { class: "card-reject-label" }, label),
      " ",
      fb.reason,
    ]);
  })();

  // In Review, the reviewer agent's ADVISORY verdict: it asked for changes, the
  // runner may not act on it, so the human sees it here before opening the diff.
  const advisory = card.advisoryReview
    ? el(
        "p",
        {
          class: "card-reject card-advisory",
          title: "The reviewer agent's verdict is advisory: you sign off on Review.",
        },
        [
          el("span", { class: "card-reject-label" }, "Reviewer agent: changes requested —"),
          " ",
          card.advisoryReview.reason,
        ],
      )
    : null;

  const movable = cardIsMovable(card);
  // Touch/keyboard fallback: "Move" opens the lane menu, so the same moves work
  // one-handed on phones where drag is unreliable. It also carries Won't do….
  const moveBtn = cardHasMoveMenu(card)
    ? el(
        "button",
        {
          class: "card-move-btn",
          type: "button",
          "aria-label": `Move ${numText} to another lane`,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          onclick: (e) => openMoveMenu(card, e.currentTarget),
        },
        [el("span", {}, "Move"), icon("chevdown", "", 14)],
      )
    : null;
  roLock(moveBtn, "ticket");
  // TRACK-2b dashboard actions: a READY card offers "I'll do this by hand" (human-
  // claim); a human-owned in_progress card offers "Hand back" (release to the queue).
  const humanLaneBtn = roLock(humanLaneAction(card), "ticket");

  const node = el(
    "article",
    {
      class: `board-card bc-${card.status}${need ? " needs" : ""}${movable ? " is-movable" : ""}`,
      dataset: { id: card.id },
      draggable: movable ? "true" : null,
    },
    [
      // A yellow card: this one waits on you (the human queue's own word for why).
      need
        ? el(
            "span",
            {
              class: "card-needs",
              role: "img",
              "aria-label": `Needs you: ${need}`,
              title: `Needs you: ${need}`,
            },
            ycard(20),
          )
        : null,
      top,
      el(
        "h3",
        { class: "card-title" },
        el(
          "a",
          {
            class: "card-link",
            href,
            draggable: "false",
            "aria-label": `${numText} ${card.title}`,
            // The card clamps a long title to three lines; hovering reads all of it.
            title: card.title,
          },
          card.title,
        ),
      ),
      meta,
      owner,
      reject,
      advisory,
      moveBtn || humanLaneBtn ? el("div", { class: "card-foot" }, [moveBtn, humanLaneBtn]) : null,
    ],
  );

  if (movable) {
    node.addEventListener("dragstart", (e) => {
      draggingCard = card;
      draggingEl = node;
      node.classList.add("dragging");
      document.querySelector(".board")?.classList.add("is-dragging");
      // Some browsers require data to be set for the drag to start.
      try {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
      } catch {
        /* ignore */
      }
    });
    node.addEventListener("dragend", () => {
      node.classList.remove("dragging");
      document.querySelector(".board")?.classList.remove("is-dragging");
      document
        .querySelectorAll(".drop-ok, .drop-no")
        .forEach((n) => n.classList.remove("drop-ok", "drop-no"));
      draggingCard = null;
      draggingEl = null;
    });
  }
  return node;
}

/**
 * List mode — the league table: every ticket from the filtered /tickets read, most
 * urgent first (then by number, so a refresh never reorders rows whose data did not
 * change). What waits on you carries its yellow card; who holds it comes from the
 * claims.
 */
function renderWorkList(allTickets, needs, claims = []) {
  const tickets = allTickets.filter(workMatches);
  if (tickets.length === 0) {
    // A day-one empty factory must not be told its (nonexistent) filter is hiding
    // work. Only show "No tickets match" when a filter is actually active.
    if (workFiltered()) {
      return emptyState(
        "No tickets match",
        "Adjust the filters above, or suggest fresh work.",
        "work",
      );
    }
    return emptyState(
      "No tickets yet",
      "Create your first ticket, or let the product-owner suggest work.",
      "work",
      el(
        "button",
        { class: "btn", type: "button", onclick: () => navigate("#/create") },
        "Create a ticket",
      ),
    );
  }
  const holder = new Map(claims.map((c) => [c.ticket_id, c]));
  const rank = (t) => STATUS_URGENCY[t.status] ?? 9;
  const sorted = tickets
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (a.number ?? 1e9) - (b.number ?? 1e9));
  const th = (label, cls) => el("th", { scope: "col", class: cls }, label);
  return el("div", { class: "card prog work-table" }, [
    el("table", { class: "wl-table", "aria-label": "Tickets, most urgent first" }, [
      el("thead", {}, [
        el("tr", {}, [
          th("No.", "c-num"),
          th("Ticket", "c-title"),
          th("Status", "c-status"),
          th("On it", "c-agent"),
          th("Risk", "c-risk"),
          th("P", "c-pri"),
          th("Stage", "c-stage"),
          th("Updated", "c-time"),
        ]),
      ]),
      el(
        "tbody",
        {},
        sorted.map((t) => {
          const need = needsLabel(t, needs);
          const c = holder.get(t.id);
          const who = t.human_owner
            ? el("span", { class: "card-human-owned" }, [
                el("span", { class: "human-dot" }),
                `By hand · ${t.human_owner}`,
              ])
            : c
              ? agentChip(c.agent_id, c.agent_display_name, 26)
              : el("span", { class: "dim" }, "—");
          return el(
            "tr",
            { class: `wl-row st-${t.status}${need ? " needs" : ""}`, dataset: { id: t.id } },
            [
              el("td", { class: "c-num wl-num tabnum" }, t.number != null ? `#${t.number}` : "—"),
              el("th", { scope: "row", class: "c-title wl-title" }, [
                need
                  ? el(
                      "span",
                      {
                        class: "wl-needs",
                        role: "img",
                        "aria-label": `Needs you: ${need}`,
                        title: `Needs you: ${need}`,
                      },
                      ycard(16),
                    )
                  : null,
                el(
                  "a",
                  { href: t.status === "in_review" ? `#/review/${t.id}` : `#/ticket/${t.id}` },
                  t.title,
                ),
              ]),
              el("td", { class: "c-status" }, statusBadge(t.status, t.landing_state)),
              el("td", { class: "c-agent" }, who),
              el("td", { class: "c-risk" }, riskBadge(t.risk_level)),
              el("td", { class: "c-pri tabnum" }, `P${t.priority}`),
              el("td", { class: "c-stage" }, pipelineDots(t.status)),
              el("td", { class: "c-time wl-time tabnum" }, fmtTime(t.updated_at)),
            ],
          );
        }),
      ),
    ]),
  ]);
}

/**
 * On the pitch: the active claims (who holds what, lease and heartbeat, branch),
 * each with Revoke set apart. Was the Claims tab; read with the board.
 */
function renderClaimsPanel(claims, readAt = Date.now()) {
  const now = Date.now();
  const page = progPage(
    "claims-panel",
    "ink",
    "On the pitch",
    [
      `${plural(claims.length, "agent")} holding tickets · as of `,
      el("time", { datetime: new Date(readAt).toISOString() }, clockTime(readAt)),
    ],
    [],
  );
  page.dataset.sig = hashText(JSON.stringify(claims));
  if (claims.length === 0) {
    page.appendChild(el("p", { class: "quiet claims-empty" }, "No agents are working right now."));
    return page;
  }
  const rows = claims.map((c) => {
    const ended = Date.parse(c.expires_at) < now;
    const num = c.ticket_number != null ? `#${c.ticket_number}` : c.ticket_id.slice(0, 8);
    const agentLabel = agentWho(c.agent_id, c.agent_display_name).name;
    return el("tr", { class: ended ? "is-stale" : "" }, [
      el(
        "th",
        { scope: "row", class: "cl-agent" },
        agentChip(c.agent_id, c.agent_display_name, 26),
      ),
      el("td", { class: "cl-ticket" }, [
        el("a", { href: `#/ticket/${c.ticket_id}` }, [
          el("span", { class: "cl-num tabnum" }, num),
          " ",
          c.ticket_title,
        ]),
        ended ? el("span", { class: "cl-stale cl-stale-inline" }, " · lease ended") : null,
      ]),
      el("td", { class: "cl-status" }, statusBadge(c.ticket_status)),
      el("td", { class: "cl-lease tabnum" }, [
        fmtTime(c.expires_at),
        ended ? el("span", { class: "cl-stale" }, " · ended") : null,
      ]),
      el("td", { class: "cl-beat tabnum dim" }, fmtTime(c.heartbeat_at)),
      el(
        "td",
        { class: "cl-branch" },
        c.branch_name
          ? el("code", { class: "mono" }, c.branch_name)
          : el("span", { class: "dim" }, "—"),
      ),
      el(
        "td",
        { class: "cl-act" },
        roLock(
          el(
            "button",
            {
              class: "btn danger small",
              type: "button",
              "aria-label": `Revoke ${agentLabel}'s claim on ${num}`,
              // Revoking stops an agent's work, so it takes two presses: the first
              // arms the button ("Stop the work?") for five seconds.
              onclick: (e) => {
                const btn = e.currentTarget;
                if (btn.dataset.armed !== "1") {
                  btn.dataset.armed = "1";
                  btn.textContent = "Stop the work?";
                  btn.setAttribute(
                    "aria-label",
                    `Press again to stop ${agentLabel}'s work on ${num}`,
                  );
                  announce(`Press Revoke again to stop the work on ${num}`);
                  setTimeout(() => {
                    if (!btn.isConnected || btn.dataset.armed !== "1") return;
                    delete btn.dataset.armed;
                    btn.textContent = "Revoke";
                    btn.setAttribute("aria-label", `Revoke ${agentLabel}'s claim on ${num}`);
                  }, 5000);
                  return;
                }
                delete btn.dataset.armed;
                guard(async () => {
                  await api("POST", `/claims/${c.claim_id}/revoke`);
                  toast("Claim revoked", { ok: true });
                  router();
                });
              },
            },
            "Revoke",
          ),
          "ticket",
        ),
      ),
    ]);
  });
  const table = el("table", { class: "claims-table" }, [
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        [
          ["Agent", "cl-agent"],
          ["Ticket", "cl-ticket"],
          ["Status", "cl-status"],
          ["Lease ends", "cl-lease"],
          ["Heartbeat", "cl-beat"],
          ["Branch", "cl-branch"],
          ["", "cl-act"],
        ].map(([h, cls]) =>
          el(
            "th",
            { scope: "col", class: cls },
            h ? h : el("span", { class: "sr-only" }, "Action"),
          ),
        ),
      ),
    ),
    el("tbody", {}, rows),
  ]);
  // The table scrolls inside its own box: seven columns never fit a phone, and the
  // page itself must never pan sideways (the Revoke column went off-screen).
  page.appendChild(
    el(
      "div",
      {
        class: "claims-scroll",
        role: "region",
        "aria-label": "On the pitch: claims (scrolls sideways)",
        tabindex: "0",
      },
      table,
    ),
  );
  return page;
}

export { renderBoard, renderWorkList, renderClaimsPanel };
