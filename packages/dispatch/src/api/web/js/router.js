// Routing and IA: the view table, the hash router, in-page jumps, error pages, tab titles.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { scoped } from "./access.js";
import { skeleton } from "./components.js";
import { app, clear, el, prefersReducedMotion } from "./dom.js";
import { icon } from "./icons.js";
import { announce, syncNav, updateNavBadges } from "./live.js";
import { openPalette } from "./palette.js";
import { appState } from "./state.js";
import {
  overviewError,
  refCard,
  renderCreate,
  renderEpics,
  renderFactory,
  renderFloor,
  renderHealth,
  renderHidden,
  renderMemory,
  renderNode,
  renderOverview,
  renderRepo,
  renderReview,
  renderSettings,
  renderSpecs,
  renderSquad,
  renderTicket,
  renderWork,
} from "../app.js";

// --- Routing & IA -----------------------------------------------------------
//
// 8 tabs folded to 5 areas. Legacy hashes are aliased so deep links and the
// previous IA keep working: every prior view is still reachable.

const VIEWS = {
  overview: renderOverview,
  health: renderHealth,
  work: renderWork,
  review: renderReview,
  factory: renderFactory,
  memory: renderMemory,
  squad: renderSquad,
  floor: renderFloor,
  epics: renderEpics,
  specs: renderSpecs,
  settings: renderSettings,
  create: renderCreate,
  ticket: renderTicket,
  node: renderNode,
  repo: renderRepo,
  hidden: renderHidden,
};

// Map old view names onto the new IA so existing links never break.
const VIEW_ALIASES = {
  dashboard: "overview",
  decisions: "overview",
  board: "work",
  backlog: "work",
  claims: "work",
  map: "factory",
};

// Sub-views highlight their parent area in the nav.
const AREA_FOR_VIEW = {
  ticket: "work",
  node: "factory",
  repo: "factory",
  create: "epics",
  hidden: "factory",
};

/** Parse the hash into { view, param, query }. e.g. #/ticket/abc -> ticket. */
function parseHash() {
  const raw = (location.hash || "#/overview").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const [rawView, param] = pathPart.split("/");
  const view = VIEW_ALIASES[rawView] || rawView || "overview";
  const query = new URLSearchParams(queryPart || "");
  return { view, param, query };
}

function navigate(hash) {
  // Re-selecting the view you are already on must still re-fetch. Assigning an
  // IDENTICAL location.hash fires no `hashchange`, so router() (the sole data-fetch
  // trigger) never runs and the view shows stale data until a manual reload. When the
  // hash is unchanged, re-render explicitly; otherwise let the hashchange drive it.
  const next = hash.startsWith("#") ? hash : "#" + hash;
  if (location.hash === next) router();
  else location.hash = next;
}

let activeArea = "overview";
// Where a ticket detail's "← Back" returns to. Tracks the last LIST view the
// operator came from (Work or Review) so opening a ticket from the Review queue
// returns to Review, not always Work.
let detailBackHash = "#/work";

// Route generations. Every navigation bumps routeGen and aborts the previous
// route's reads. A render that resolves after the operator has moved on is
// DISCARDED (and disposed, so its document-level key handlers die with it):
// a slow Review render must never land under the Specs URL with live Approve
// buttons (router-stale-render-race).
let routeGen = 0;
let routeAbort = null;
/** The AbortSignal for the current route's reads (views pass it to api()). */
function routeSignal() {
  return routeAbort ? routeAbort.signal : undefined;
}
/**
 * Tear down a rendered view tree: views register cleanup as `node._dispose`
 * (document listeners, timers, observers). Safe to call twice.
 */
function disposeView(node) {
  if (!node) return;
  const fns = [];
  if (typeof node._dispose === "function") fns.push(node._dispose);
  if (node.querySelectorAll) {
    for (const n of node.querySelectorAll("*")) {
      if (typeof n._dispose === "function") fns.push(n._dispose);
    }
  }
  for (const fn of fns) {
    try {
      fn();
    } catch {
      /* cleanup is best-effort */
    }
  }
  node._dispose = null;
}
/** Swap #app's content, disposing whatever view was there. */
function mountView(content) {
  for (const child of [...app.children]) disposeView(child);
  clear(app);
  app.appendChild(content);
  // A view that measures itself (the tactics board, the wage chart) draws once it is in the DOM.
  if (typeof content._mounted === "function") {
    try {
      content._mounted();
    } catch {
      /* a drawing that cannot measure keeps its first draw */
    }
  }
}

/**
 * An inline form the operator has open survives a re-render. A control that opens
 * a form in place (a lore draft's Reject → reason + confirm) marks its container
 * `data-keep-key` (a key stable across renders: the record's id) and, while the form
 * is open, `data-keep-open`. This moves each open container of the outgoing tree
 * into the incoming one, in place of its fresh twin with the same key, so a refresh
 * that changed OTHER rows (or the lore filter's own re-fetch landing late) leaves
 * the half-typed reason, and the handlers bound to it, where they were. A form whose
 * record is gone from the new data has no twin and goes with the old tree. Answers
 * a restore() to call once the incoming tree is in the document: it puts the focus
 * (and the text selection) back when it was inside a carried form, and answers
 * whether it did.
 */
function carryOpenForms(from, to) {
  let refocus = null;
  if (from && to && from.querySelectorAll) {
    const active = document.activeElement;
    for (const open of from.querySelectorAll("[data-keep-key][data-keep-open]")) {
      const key = open.dataset.keepKey;
      const twin = [...to.querySelectorAll("[data-keep-key]")].find(
        (n) => n.dataset.keepKey === key,
      );
      if (!twin) continue;
      if (active && open.contains(active))
        refocus = {
          node: active,
          sel:
            typeof active.selectionStart === "number"
              ? [active.selectionStart, active.selectionEnd]
              : null,
        };
      twin.replaceWith(open);
    }
  }
  return () => {
    if (!refocus || !refocus.node.isConnected) return false;
    refocus.node.focus({ preventScroll: true });
    if (refocus.sel) {
      try {
        refocus.node.setSelectionRange(refocus.sel[0], refocus.sel[1]);
      } catch {
        /* not a text control */
      }
    }
    return true;
  };
}

/**
 * Views that draw their own failure page (one specific message + Try again). The
 * router uses it only for a navigation; a failed background refresh keeps the
 * view on screen, and a later refresh that succeeds replaces the failure page.
 */
const VIEW_ERROR_PAGES = { overview: (e) => overviewError(e) };

/**
 * The error page in the club's language: the fourth official's board held up
 * with the code the server (or the router) gave, one plain sentence of what went
 * wrong, and the one useful way on. `code` is shown only when it is a real code.
 */
function errorPage({ code, caption, title, lede, detail, actions, error = false }) {
  const board = code
    ? el("div", { class: "err-board", "aria-hidden": "true" }, [
        el("div", { class: "err-face" }, [
          el("span", { class: "err-code tabnum" }, code),
          caption ? el("span", { class: "err-cap" }, caption) : null,
        ]),
        el("span", { class: "err-handle" }),
      ])
    : el("div", { class: "err-board is-card", "aria-hidden": "true" }, refCard("red"));
  return el("div", { class: `view view-error${error ? " is-error" : ""}` }, [
    el("section", { class: "err-page", "aria-labelledby": "err-title" }, [
      board,
      el("div", { class: "err-body" }, [
        el("h1", { id: "err-title" }, title),
        lede ? el("p", { class: "err-lede" }, lede) : null,
        detail ? el("p", { class: "err-detail" }, detail) : null,
        actions && actions.length ? el("div", { class: "err-actions" }, actions) : null,
      ]),
    ]),
  ]);
}

/** #/<anything that is not a page>: say which address, and offer the way back. */
function renderNotFound() {
  const addr = decodeURIComponent((location.hash || "#/").split("?")[0]);
  setDocTitle("", "Page not found");
  return errorPage({
    code: "404",
    caption: "page not found",
    title: `No page at ${addr}`,
    lede: "Gaffer has no page at this address. It may be an old link or a typo.",
    actions: [
      el("a", { class: "btn primary", href: "#/overview" }, "Go to the Overview"),
      el("button", { class: "btn", type: "button", onclick: () => openPalette() }, [
        icon("search"),
        el("span", {}, "Search"),
      ]),
    ],
  });
}

/** A view that failed to load: one specific message and a retry, shown once (not toasted). */
function loadErrorPage(e) {
  const status = e && Number.isInteger(e.status) && e.status >= 400 ? String(e.status) : "";
  const offline = e && (e.code === "NETWORK" || e.code === "BAD_GATEWAY");
  return errorPage({
    code: status,
    caption: status ? "the server answered" : null,
    title: offline ? "Can't reach the factory." : "That page could not load.",
    lede: (e && e.message) || "The request failed. Check the connection and retry.",
    error: true,
    actions: [
      el("button", { class: "btn primary", type: "button", onclick: () => router() }, "Try again"),
      el("a", { class: "btn", href: "#/overview" }, "Go to the Overview"),
    ],
  });
}

async function router() {
  const parsed = parseHash();
  // A scoped token reads no factory-wide overview: its front page is the Work board
  // (its own tickets), wherever the Overview would have opened.
  const { view, param } =
    scoped() && (parsed.view === "overview" || !(location.hash || "").startsWith("#/"))
      ? { view: "work", param: undefined }
      : parsed;
  // Aliases are resolved in parseHash. An address under #/ that names no view is
  // a 404 page (one link back); a bare fragment that is not a section on this
  // page still opens the Overview, as it always has.
  const notFound = !VIEWS[view] && (location.hash || "").startsWith("#/");
  const render = VIEWS[view] || (notFound ? renderNotFound : renderOverview);
  activeArea = AREA_FOR_VIEW[view] || (VIEWS[view] ? view : notFound ? "" : "overview");
  if (view === "work" || view === "review") detailBackHash = "#/" + view;

  const gen = ++routeGen;
  appState.workRefCache = null; // a navigation re-reads repos/nodes (the refresh reuses them)
  if (routeAbort) routeAbort.abort();
  routeAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
  const isCurrent = () => gen === routeGen;

  app.dataset.area = activeArea; // lets CSS give width-hungry views (work/map/epics) the full screen
  // The view actually rendered: a stray bare fragment (#grp-nothing) opens the
  // Overview, so it is named "overview", not after the fragment.
  app.dataset.view = VIEWS[view] ? view : notFound ? "notfound" : "overview";
  syncNav();
  updateNavBadges();
  setDocTitle(view); // detail views refine this once their data loads
  app.classList.remove("login-shell");

  // The DOM swap: a view-shaped skeleton (invisible for its first 300ms), then the
  // awaited content — unless a newer navigation superseded this one meanwhile.
  const swap = async () => {
    if (!isCurrent()) return;
    mountView(skeleton(view === "overview" ? "overview" : view === "work" ? "board" : "list"));
    let content;
    try {
      content = await render(param);
    } catch (e) {
      if (!isCurrent()) return; // a stale failure never paints over the new view
      // A 401 is already handled inside api() (the login screen is shown).
      if (e && (e.code === "UNAUTHORIZED" || e.code === "ABORTED")) return;
      // A view may draw its own failure in its own language (the Overview's dark scoreboard).
      if (VIEW_ERROR_PAGES[view]) {
        mountView(VIEW_ERROR_PAGES[view](e));
        return;
      }
      // One specific message + a retry, shown once — not repeated in a toast.
      mountView(loadErrorPage(e));
      return;
    }
    if (!isCurrent()) {
      disposeView(content);
      return;
    }
    mountView(content);
    window.scrollTo?.(0, 0);
    flipDigits(content);
    // Tell a screen reader the view changed (one short line, not the whole DOM).
    announce(`${VIEW_TITLES[view] || "View"} loaded`);
  };

  const reduce = prefersReducedMotion();
  if (document.startViewTransition && !reduce && app.childElementCount) {
    // A rapid navigation aborts the in-flight transition, rejecting its promises
    // with InvalidStateError; the update still runs (and bails if stale).
    try {
      const vt = document.startViewTransition(swap);
      vt.ready?.catch(() => {});
      vt.finished?.catch(() => {});
      vt.updateCallbackDone?.catch(() => {});
    } catch {
      void swap();
    }
  } else {
    await swap();
  }
}

/**
 * Scoreboard digits flip in on first paint (and when a refresh changes them):
 * each character of a `.kpi-val[data-flip]` becomes a `.dg` with a stagger index.
 * A flip, never a count-up — we never show a number the server did not give.
 */
function flipDigits(root, prev = null) {
  if (prefersReducedMotion() || !root || !root.querySelectorAll) return;
  for (const node of root.querySelectorAll("[data-flip]")) {
    const text = node.textContent || "";
    if (node.dataset.flipped === text) continue;
    node.dataset.flipped = text;
    // A background refresh flips only the numbers that actually changed.
    if (prev && prev[node.dataset.flip] === text) continue;
    clear(node);
    [...text].forEach((ch, i) =>
      node.appendChild(el("span", { class: "dg", style: { "--i": i } }, ch)),
    );
    node.classList.add("flip");
  }
}
/** The current text of every flip-digit node under root, keyed by data-flip. */
function digitValues(root) {
  const out = {};
  if (root && root.querySelectorAll)
    for (const n of root.querySelectorAll("[data-flip]")) out[n.dataset.flip] = n.textContent;
  return out;
}

// Human-facing browser-tab title per view, so several open tabs (Review, a
// ticket, Settings) are distinguishable in the tab strip, history and bookmarks.
const VIEW_TITLES = {
  overview: "Overview",
  health: "Health",
  work: "Work",
  review: "Review",
  epics: "Epics",
  specs: "Specs",
  factory: "Map",
  memory: "Memory",
  squad: "Squad",
  floor: "Floor",
  settings: "Settings",
  ticket: "Ticket",
  repo: "Repo",
  node: "Map",
  create: "Plan a build",
  hidden: "Hidden repos",
};
/**
 * Set the tab title. `detail` (a detail view's own label, e.g. "#12 Add login") wins;
 * an unknown view is plain "Gaffer". A detail title is applied only while its route is
 * still the current one, so a slow load can never retitle the view the operator has
 * since moved to.
 */
function setDocTitle(view, detail, param) {
  if (detail) {
    const cur = parseHash();
    if (view && (cur.view !== view || (param !== undefined && cur.param !== param))) return;
    document.title = `${detail} · Gaffer`;
    return;
  }
  document.title = VIEW_TITLES[view] ? `${VIEW_TITLES[view]} · Gaffer` : "Gaffer";
}

// --- Wiring -----------------------------------------------------------------

/**
 * In-page jumps ("#what-i-own", "#tactics"): scroll to and focus the section
 * instead of letting the hash router read the fragment as an unknown view (which
 * re-rendered the Overview at the top, so the jump never arrived).
 */
function jumpTo(id) {
  const target = id && document.getElementById(id);
  if (!target) return false;
  // A folded section (or a row inside one) opens on the way in.
  for (let n = target; n; n = n.parentElement) if (n.tagName === "DETAILS") n.open = true;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  target.focus?.({ preventScroll: true });
  return true;
}

export {
  VIEWS,
  parseHash,
  navigate,
  activeArea,
  detailBackHash,
  routeGen,
  routeSignal,
  disposeView,
  mountView,
  carryOpenForms,
  errorPage,
  router,
  flipDigits,
  digitValues,
  setDocTitle,
  jumpTo,
};
