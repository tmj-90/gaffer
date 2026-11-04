// Auto refresh and the live event stream: re-reading the current view, nav badges, going quiet behind the login gate.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api, authToken } from "./api.js";
import { BOTTOM_NAV_IDS, fitNav, navCounts, navMenuEl } from "./chrome.js";
import { refreshSquad, squad } from "./club.js";
import { app, bottomnav } from "./dom.js";
import { parseJsonSafe } from "./format.js";
import { freshness } from "./freshness.js";
import { clubName } from "./kit.js";
import { renderLogin } from "./login.js";
import {
  VIEWS,
  activeArea,
  carryOpenForms,
  digitValues,
  disposeView,
  flipDigits,
  mountView,
  parseHash,
  routeGen,
} from "./router.js";
import { toast } from "./toast.js";
import { OFF_PITCH, ON_PITCH, allTickets, hashText, isModalOpen } from "../app.js";

/**
 * The gate is up, so the page stops asking. A token revoked or rotated server-side
 * used to leave the interval refresh, the live stream and its reconnects running
 * behind the gate: about 80 refused reads a minute, each drawing the gate again.
 * Entering a token reloads the page, which starts them afresh.
 */
let authLost = false;
function goQuietForLogin() {
  authLost = true;
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
  liveRefreshTimer = null;
  if (liveStreamAbort) liveStreamAbort.abort();
}

// Hot-refresh: read-mostly views quietly re-fetch so the board, overview and
// review reflect what the factory is doing without a manual reload. It never
// fights the operator: skipped while typing, dragging, with a sheet/menu open,
// when the tab is hidden, or if the route changed mid-fetch. It keeps the scroll
// position (on the document — the real scroller), holds the view's height while
// async parts (diffs) settle so the page can't shrink and clamp scroll to 0, and
// skips the swap entirely when the view's data signature did not change.
const AUTO_REFRESH_MS = 9000;
const AUTO_REFRESHABLE = new Set([
  "ticket",
  "overview",
  "work",
  "review",
  "epics",
  "memory",
  "factory",
  "squad",
  "floor",
]);
let autoRefreshTimer;
function busyEditing() {
  const a = document.activeElement;
  return !!(
    a &&
    (a.tagName === "INPUT" ||
      a.tagName === "TEXTAREA" ||
      a.tagName === "SELECT" ||
      a.isContentEditable)
  );
}
// --- live event stream --------------------------------------------------------
// The control plane pushes its append-only event log as Server-Sent Events
// (GET /api/events/stream). Every push schedules ONE debounced refresh of the
// current view. Streamed with fetch (not EventSource) so the bearer token travels
// in the Authorization header, never in the URL. A read watchdog treats ~40s of
// silence (the server pings every 15s) as a dead connection, so a half-open
// socket after sleep or a network change can't keep the header saying "Live".
let liveStreamAbort = null;
const SQUAD_EVENTS = new Set(["club.updated", "agent.display_updated", "agent.registered"]);
let liveStreamSeq = null;
let liveRefreshTimer = null;
const LIVE_REFRESH_DEBOUNCE_MS = 400;
const LIVE_RECONNECT_MS = 5000;
const LIVE_WATCHDOG_MS = 40000;

function scheduleLiveRefresh() {
  if (liveRefreshTimer) return;
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null;
    refreshCurrentView();
  }, LIVE_REFRESH_DEBOUNCE_MS);
}

async function startLiveStream() {
  if (
    authLost ||
    liveStreamAbort ||
    typeof fetch !== "function" ||
    typeof ReadableStream === "undefined"
  )
    return;
  const controller = new AbortController();
  liveStreamAbort = controller;
  const headers = { accept: "text/event-stream" };
  const tok = authToken();
  if (tok) headers["authorization"] = "Bearer " + tok;
  const since = liveStreamSeq === null ? "" : `?since=${liveStreamSeq}`;
  let watchdog = null;
  const pet = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), LIVE_WATCHDOG_MS);
  };
  try {
    const res = await fetch(`/api/events/stream${since}`, { headers, signal: controller.signal });
    if (res.status === 401) {
      // The token stopped working: the gate, once, and no reconnect behind it.
      freshness.fail("auth");
      renderLogin(Boolean(tok));
    }
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    pet();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pet();
      if (freshness.stream !== "up") freshness.setStream("up");
      else freshness.lastOkAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let isEvent = false;
        let isReset = false;
        let data = "";
        for (const line of frame.split("\n")) {
          // A seq of 0 counts: the server's `reset` frame moves a stale cursor back to it.
          if (line.startsWith("id: ")) {
            const seq = line.slice(4).trim();
            if (/^\d+$/.test(seq)) liveStreamSeq = Number(seq);
          } else if (line.startsWith("event: work_event")) isEvent = true;
          else if (line.startsWith("event: reset")) isReset = true;
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        // A reset says the cursor came from another log (a restore, an import): what the
        // page shows may be stale, and no event will say so. Re-read it.
        if (isReset) scheduleLiveRefresh();
        if (isEvent) {
          // The stream carries no agent_display: a rename or a new agent re-reads the squad.
          const type = (parseJsonSafe(data) || {}).event_type;
          if (SQUAD_EVENTS.has(type)) refreshSquad();
          else scheduleLiveRefresh();
        }
      }
    }
  } catch {
    // fall through to reconnect (the interval refresh keeps the UI honest meanwhile)
  } finally {
    clearTimeout(watchdog);
    liveStreamAbort = null;
    freshness.setStream("down");
    if (document.visibilityState !== "hidden" && !authLost)
      setTimeout(startLiveStream, LIVE_RECONNECT_MS);
  }
}

/**
 * Cheap per-view change signatures. When a refresh's signature matches the one
 * the view on screen was rendered from, the view is left alone: no detail or diff
 * re-fetches, no DOM swap, nothing moves (review-n-plus-one-refresh).
 */
const VIEW_SIGNATURES = {
  // A ticket page follows its own ticket: a landing that completes (status to Done, the
  // actions gone), a hold, a criterion checked. One read of the ticket says whether.
  ticket: async (param) => {
    if (!param) return null;
    return ticketSignature(await api("GET", `/tickets/${param}`));
  },
  review: async () => {
    const tickets = (await allTickets("status=in_review", { full: true })).tickets;
    if (tickets.length) return reviewSignature(tickets);
    // The clear desk shows what moved on and who is still playing: watch those.
    const all = (await allTickets()).tickets;
    return clearDeskSignature(all);
  },
};
/** What the clear Review desk draws from: the tickets past and before the sign-off. */
const CLEAR_DESK_STATUSES = new Set([
  "claimed",
  "in_progress",
  "in_testing",
  "ready_for_merge",
  "done",
  "cancelled",
]);
/**
 * What a ticket page is drawn from, coarsely: the ticket row, where its landing is, its
 * criteria, decisions and rework trail. Evidence rows and events a delivery writes as it
 * goes do not count on their own (the status and the criteria carry what they change).
 */
function ticketSignature(view) {
  const t = (view && view.ticket) || {};
  const ls = t.landing_state || null;
  return hashText(
    JSON.stringify([
      t.id,
      t.status,
      t.updated_at,
      t.attempt_count,
      ls ? [ls.kind, ls.hold, ls.label, ls.detail] : null,
      ((view && view.acceptance_criteria) || []).map((a) => [a.id, a.status, a.text]),
      ((view && view.blocking_decisions) || []).map((d) => [d.id, d.status]),
      ((view && view.rework_trail) || []).length,
      // A repo linked in another tab (the ready gate reads it, so Mark ready may switch
      // on) and a dependency that finished change the page too.
      ((view && view.repositories) || []).map((r) => [r.id, r.access, r.relation]),
      ((view && view.dependencies) || []).map((d) => [d.depends_on_ticket_id, d.status]),
    ]),
  );
}
function clearDeskSignature(all) {
  return `clear:${reviewSignature(all.filter((t) => CLEAR_DESK_STATUSES.has(t.status)))}`;
}
function reviewSignature(tickets) {
  return tickets.map((t) => `${t.id}@${t.updated_at || ""}`).join("|");
}

/** A text field in this view holds something the person typed and has not sent. */
function viewHasTypedText(root) {
  if (!root || !root.querySelectorAll) return false;
  for (const f of root.querySelectorAll("textarea, input")) {
    const type = (f.getAttribute("type") || "text").toLowerCase();
    if (!["text", "search", "url", "number", "email"].includes(type) && f.tagName !== "TEXTAREA")
      continue;
    if (f.value !== f.defaultValue) return true;
  }
  return false;
}

/** Re-render the current view in place if it is safe to do so (shared by the interval + stream). */
let refreshing = false;
function refreshCurrentView() {
  if (authLost || document.visibilityState === "hidden") return;
  if (busyEditing()) return;
  // don't yank a card mid-drag or a menu/sheet out from under a click.
  if (document.querySelector(".dragging, .is-dragging, .sheet.open, .menu-open")) return;
  if (navMenuEl) return;
  // A modal owns the screen (reject dialog, move menu, command palette).
  if (isModalOpen()) return;
  // Never tear down the review queue mid-triage (armed approve or focus in a card).
  if (reviewInteractionInProgress()) return;
  const { view, param } = parseHash();
  if (!AUTO_REFRESHABLE.has(view)) return;
  const render = VIEWS[view];
  if (!render || refreshing) return;
  const gen = routeGen;
  const current = app.firstElementChild;
  // The ticket page has inline forms (a criterion, a repo, a note): text typed there and
  // left for a moment is not thrown away by a delivery that touched the ticket.
  if ((view === "ticket" || view === "review") && viewHasTypedText(current)) return;
  refreshing = true;
  (async () => {
    try {
      const sigFn = VIEW_SIGNATURES[view];
      if (sigFn && current && current.dataset.sig != null) {
        const sig = await sigFn(param);
        if (sig === current.dataset.sig) return;
      }
      const content = await render(param);
      // bail if the operator navigated or started interacting during the fetch — the
      // armed-approve check must run AGAIN here: a refresh that started a moment before
      // the first Approve click would otherwise swap in a fresh, unarmed button under
      // the confirming second click (the click then only re-arms; nothing is approved).
      if (gen !== routeGen || busyEditing() || reviewInteractionInProgress() || isModalOpen()) {
        disposeView(content);
        return;
      }
      if (content.dataset.sig != null && current && content.dataset.sig === current.dataset.sig) {
        disposeView(content); // same data: keep the DOM (and its scroll + open details)
        return;
      }
      const se = document.scrollingElement || document.documentElement;
      const y = se.scrollTop;
      const prevDigits = digitValues(current);
      // Hold the old height across the swap: async parts of the new view (diffs)
      // mount as short placeholders, and a shorter page would clamp scroll to 0.
      app.style.minHeight = `${app.offsetHeight}px`;
      const restoreForms = carryOpenForms(current, content);
      mountView(content);
      se.scrollTop = y;
      restoreForms();
      flipDigits(content, prevDigits);
      const release = () => {
        if (app.firstElementChild === content) app.style.minHeight = "";
      };
      if (content._settled && typeof content._settled.then === "function") {
        Promise.race([content._settled, new Promise((r) => setTimeout(r, 8000))]).then(release);
      } else release();
    } catch (e) {
      if (e && (e.code === "UNAUTHORIZED" || e.code === "ABORTED")) return;
      // The header already says "Offline"; one toast per outage, not one per tick.
      if (e && e.code === "NETWORK") return;
      toast(e.message || "Refresh failed", { code: e.code });
    } finally {
      refreshing = false;
    }
  })();
}

/** An approve is armed (keyboard `.card-armed` or mouse `.btn-armed`) or the operator is focused inside a review card. */
function reviewInteractionInProgress() {
  if (document.querySelector(".card-armed, .btn-armed")) return true;
  const a = document.activeElement;
  return !!(a && typeof a.closest === "function" && a.closest(".view .card"));
}

function startAutoRefresh() {
  if (autoRefreshTimer) return;
  startLiveStream();
  autoRefreshTimer = setInterval(refreshCurrentView, AUTO_REFRESH_MS);
}

function syncNav() {
  document.querySelectorAll("[data-area]").forEach((n) => {
    const on = n.dataset.area === activeArea;
    n.classList.toggle("active", on);
    // Programmatic active state for assistive tech (WCAG 1.4.1).
    if (on) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  });
  const moreBtn = bottomnav && bottomnav.querySelector(".bottomnav-more");
  if (moreBtn) moreBtn.classList.toggle("active", !BOTTOM_NAV_IDS.includes(activeArea));
  fitNav();
}

// One-line polite announcement into the dedicated #sr-status region (see
// index.html). Used for view changes and background refreshes so a screen
// reader hears a short message instead of the whole re-rendered view.
function announce(msg) {
  const r = document.getElementById("sr-status");
  if (!r) return;
  r.textContent = "";
  // A frame gap makes the region change register as a fresh announcement.
  requestAnimationFrame(() => {
    r.textContent = msg;
  });
}

/** The club's name under the crest: the factory node on the scope map (read once). */
let factoryNamePromise = null;
function factoryName() {
  if (!factoryNamePromise) {
    factoryNamePromise = api("GET", "/scope/nodes")
      .then((r) => (r.nodes || []).find((n) => n.type === "factory")?.name || null)
      .catch(() => {
        factoryNamePromise = null;
        return null;
      });
  }
  return factoryNamePromise;
}

/** Live nav counts from /api/dashboard: Review = the gate queue (yellow: it needs
 *  you); Work = tickets in flight (plain). Best-effort; the nav works without them. */
let navBadgeBusy = false;
async function updateNavBadges() {
  if (navBadgeBusy) return;
  navBadgeBusy = true;
  try {
    const { summary } = await api("GET", "/api/dashboard");
    const s = summary.ticketsByStatus || {};
    // Work = everything live: on the Tactics Board's pitch (Ready through To merge) plus
    // off it (blocked, paused, failed), the same two counts the board heads with.
    navCounts.work = [...ON_PITCH, ...OFF_PITCH].reduce((n, k) => n + (s[k] || 0), 0);
    navCounts.review = s.in_review || 0;
    // Under the crest: the factory's name, while the club has no name of its own.
    const club = squad.club && squad.club.name ? null : summary.clubName || (await factoryName());
    const sub = document.getElementById("brand-sub");
    if (sub) sub.textContent = club && club !== clubName() ? club : "";
    document.querySelectorAll(".nav-count[data-count]").forEach((n) => {
      const id = n.dataset.count;
      const v = navCounts[id];
      if (v > 0) {
        n.textContent = String(v);
        n.hidden = false;
        n.classList.toggle("urgent", id === "review");
        // The Work count is unexplained on screen: its title and label say what it
        // counts (live tickets, ready through to merge plus blocked/paused/failed;
        // drafts are on the bench, not in it).
        const what =
          id === "review"
            ? `${v} waiting for your sign-off`
            : `${v} ${v === 1 ? "ticket" : "tickets"} in play: ready through to merge, plus blocked, paused or failed (drafts not counted)`;
        n.setAttribute("aria-label", what);
        n.title = what;
      } else {
        n.hidden = true;
      }
    });
    fitNav();
  } catch {
    /* best-effort */
  } finally {
    navBadgeBusy = false;
  }
}

export {
  authLost,
  goQuietForLogin,
  autoRefreshTimer,
  busyEditing,
  startLiveStream,
  ticketSignature,
  clearDeskSignature,
  reviewSignature,
  refreshCurrentView,
  startAutoRefresh,
  syncNav,
  announce,
  updateNavBadges,
};
