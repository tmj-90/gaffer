// Gaffer dashboard — plain ES-module SPA over the Dispatch REST API.
// No framework, no build step. Every view calls the JSON API via fetch().
//
// Presentation: "Match Day". The gaffer is the manager and the factory is the
// club on match day — a claret club header, a stadium scoreboard, programme
// pages with kit-colour section blocks, referee's cards for status. The tokens,
// components and conventions are in css/ (see css/tokens.css) and the shared
// helpers below (el/field/icon/glyph, viewHead, panelHead, emptyState,
// skeleton, statCell, charts). Every mark carries data the server gave us.

// This file is the entry: it imports the modules under js/, registers the page's
// load-time listeners and starts the dashboard. The code lives in:
//   js/api.js          API client: token helpers, api()
//   js/state.js        the few bindings more than one module assigns (appState)
//   js/dom.js          mount points, el/svgEl/clear, field
//   js/icons.js        icons, glyphs, kit shirts, agent chips, crest, badges
//   js/format.js       durations, times, days, money, plurals
//   js/club.js         the club and its squad (agent names, capability)
//   js/access.js       read-only and scoped access, the locks views draw
//   js/kit.js          kit colours and contrast
//   js/toast.js        toast and guarded async actions
//   js/login.js        login gate, logout
//   js/status.js       status vocabulary and the ticket action sets
//   js/components.js   view and panel heads, empty states, skeletons, stat cells
//   js/sheet.js        the detail sheet
//   js/sheets.js       the action sheets (confirm, reason, merge, ...)
//   js/router.js       the view table, hash router, in-page jumps, tab titles
//   js/freshness.js    the Data as of tracker
//   js/chrome.js       theme, club header, bottom nav
//   js/live.js         auto refresh, the live event stream, nav badges
//   js/palette.js      command palette
//   js/matchday.js     the Overview's shared reads, headline and scoreboard
//   js/charts.js       inline SVG chart primitives
//   js/panels.js       development flow, needs, event vocabulary, feed rows
//   js/runs.js         Running now: run rows, logs, run detail
//   js/diff.js         the diff renderer
//   js/views/          one module per view or view part: overview, teamsheet,
//                      tactics, programme, fitness, work, board, ticket,
//                      ticket-cards, acceptance, repo-panel, create, settings,
//                      formation, autonomy, health, review, review-comments,
//                      review-packet, map, scope-node, repo, epics, plan,
//                      spec-build, specs, memory, onboarding, squad, floor

import { learnWhoami } from "./js/access.js";
import { adoptTokenFromUrl, api, authToken } from "./js/api.js";
import { buildChrome } from "./js/chrome.js";
import { squad } from "./js/club.js";
import { clockTime, freshness, paintFreshness } from "./js/freshness.js";
import { autoRefreshTimer, refreshCurrentView, startLiveStream } from "./js/live.js";
import { logout, renderLogin } from "./js/login.js";
import { closePalette, openPalette, paletteEls } from "./js/palette.js";
import { jumpTo, router } from "./js/router.js";
import { closeSheet, sheetOpen } from "./js/sheet.js";

window.wgLogout = logout;
let freshPainted = "";
freshness.listeners.add((now, was) => {
  // Repaint only when what the line says would change (state or the minute shown).
  const key = `${now}|${freshness.lastOkAt ? clockTime(freshness.lastOkAt) : ""}`;
  if (key !== freshPainted) {
    freshPainted = key;
    paintFreshness();
  }
  // Coming back: re-read the view at once instead of waiting for the next tick.
  if (was === "offline" && (now === "live" || now === "polling")) refreshCurrentView();
});
// A phone tab coming back to the foreground re-checks at once instead of
// trusting its old state: restart the stream and re-read the view.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !autoRefreshTimer) return;
  startLiveStream();
  refreshCurrentView();
});

// Global ⌘K / Ctrl+K hotkey.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEls && paletteEls.scrim.classList.contains("open")) closePalette();
    else openPalette();
  }
});
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#/") || href === "#") return;
  if (jumpTo(href.slice(1))) e.preventDefault();
});

/**
 * The members' entrance asks for nothing it cannot have. With no token, the public
 * /healthz says whether this server wants one, and if it does the gate is drawn
 * straight away (no data call that can only answer 401). With a token, ONE whoami
 * checks it first: a wrong token gets the gate from that one answer instead of a
 * page of refused reads and a live stream, and a right one tells the views at once
 * whether this token is read-only. Answers whether the dashboard may start.
 */
async function passGate() {
  if (!authToken()) {
    try {
      const res = await fetch("/healthz");
      const body = res.ok ? await res.json() : null;
      if (body && body.auth === true) {
        renderLogin(false);
        return false;
      }
    } catch {
      // An old server or a blip: start, and let the first read say if a token is needed.
    }
    return true;
  }
  try {
    const who = await api("GET", "/api/whoami");
    if (who && typeof who === "object" && who.capability) learnWhoami(who);
  } catch (e) {
    if (e && e.code === "UNAUTHORIZED") return false; // api() drew the gate already
    // Slow, failing or unreachable: start anyway (unknown counts as full; the server
    // still refuses a read token's writes), without a second wait for the same answer.
    squad.whoamiFailed = true;
  }
  return true;
}

async function start() {
  adoptTokenFromUrl(); // one-scan token pickup (QR) before the first authed call
  if (!(await passGate())) return;
  buildChrome();
  window.addEventListener("hashchange", () => {
    // A bare fragment that names a section on this page is a jump, not a route.
    const h = location.hash || "";
    if (h.length > 1 && !h.startsWith("#/") && jumpTo(h.slice(1))) return;
    // A sheet belongs to the page that opened it: a reason being written for #15 must
    // never stay over #20 (Back, a link, a typed address), where confirming it would
    // act on a ticket the reader is no longer looking at.
    if (sheetOpen()) closeSheet({ restore: false });
    router();
  });
  router();
}
start();
