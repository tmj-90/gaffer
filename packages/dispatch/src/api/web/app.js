// Gaffer dashboard — plain ES-module SPA over the Dispatch REST API.
// No framework, no build step. Every view calls the JSON API via fetch().
//
// Presentation: "Match Day". The gaffer is the manager and the factory is the
// club on match day — a claret club header, a stadium scoreboard, programme
// pages with kit-colour section blocks, referee's cards for status. The tokens,
// components and conventions are in css/ (see css/tokens.css) and the shared
// helpers below (el/field/icon/glyph, viewHead, panelHead, emptyState,
// skeleton, statCell, charts). Every mark carries data the server gave us.

import { agentTitle, agentWho, learnWhoami, readOnly, roLock, roLockAll } from "./js/access.js";
import { adoptTokenFromUrl, api, authToken } from "./js/api.js";
import { buildChrome, paintBrand } from "./js/chrome.js";
import {
  ROLE_LABELS,
  applySquad,
  canEditSquad,
  ensureSquad,
  learnDisplay,
  squad,
} from "./js/club.js";
import { emptyState, panelHead, statCell, viewHead } from "./js/components.js";
import { app, clear, el, field, prefersReducedMotion, svgEl } from "./js/dom.js";
import { fmtDay, fmtRelative, fmtTime, money, moneyW, plural } from "./js/format.js";
import { clockTime, freshness, paintFreshness } from "./js/freshness.js";
import {
  agentShirt,
  agentTag,
  badge,
  crest,
  glyph,
  icon,
  kitShirt,
  repoTag,
  ycard,
} from "./js/icons.js";
import {
  RGB_HOUSE_CLARET,
  RGB_HOUSE_SKY,
  applyClub,
  clubLetters,
  clubName,
  kitTokens,
  readHouseKit,
  rgbHex,
  setKitTokens,
} from "./js/kit.js";
import { autoRefreshTimer, refreshCurrentView, startLiveStream } from "./js/live.js";
import { logout, renderLogin } from "./js/login.js";
import { TERMINAL, allTickets, loadMatchDay } from "./js/matchday.js";
import { closePalette, openPalette, paletteEls } from "./js/palette.js";
import {
  carryOpenForms,
  disposeView,
  jumpTo,
  mountView,
  navigate,
  parseHash,
  routeGen,
  routeSignal,
  router,
} from "./js/router.js";
import { closeSheet, openSheet, sheetOpen } from "./js/sheet.js";
import { confirmSheet } from "./js/sheets.js";
import { appState } from "./js/state.js";
import { statusLabel } from "./js/status.js";
import { guard, runAsyncAction, toast } from "./js/toast.js";
import { backLink, typeLabel } from "./js/views/map.js";
import { progPage } from "./js/views/programme.js";
import { deliveredBy, sinceStatus } from "./js/views/review-comments.js";
import { hashText } from "./js/views/work.js";

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

// ===========================================================================
//  Plan a build — the decompose chat panel (a docked, mobile-first sheet)
// ===========================================================================
//
// One-line brief → POST /plan-build → the backend spawns the decompose helper →
// it answers with a clarify turn (questions), a plan (proposed epic + tickets),
// or an error. The FRONTEND accumulates the conversation `history` and replays
// it each turn. A plan is PROPOSED ONLY — "Create these tickets" is the human's
// explicit confirm, which POSTs the plan to /epics and lands DRAFT tickets.

// The conversation no longer dead-ends client-side: a long chat is never blocked.
// "Build the tickets" (forcePlan) is always available so the user can break out at
// any point, and the decomposer's own advisory turn ceiling force-plans rather than
// rejecting — see PLAN_BUILD_FORCE_EMPHASIS_TURNS for when the escape is emphasised.

// H9 — DURABLE SESSIONS: the panel persists its conversation to the server via
// /plan-sessions so a reload or navigation-away restores the exact history +
// proposed plan. Each turn calls POST /plan-sessions/:id/turns to append both
// the user message and the assistant reply. On first open the panel fetches
// GET /plan-sessions/active to restore any in-progress session. "Start new plan"
// archives the current session (POST /plan-sessions/:id/archive, status:abandoned)
// and creates a fresh one. Confirming a plan archives with status:confirmed.
//
// GRACEFUL DEGRADATION: every session API call is best-effort. If the endpoint
// is unreachable (older server, network blip) the panel continues with in-memory
// state exactly as before H9 — `planBuildState.sessionId` stays null and no
// persistence calls are attempted for that session.

let planBuildEls = null;
let planBuildState = null;

function ensurePlanBuild() {
  if (planBuildEls) return planBuildEls;
  const scrim = el("div", { class: "pb-scrim", onclick: closePlanBuild });
  const log = el("div", { class: "pb-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", {
    class: "pb-input",
    rows: "1",
    placeholder: "Describe the app you want to build…",
    "aria-label": "Your message",
  });
  const sendBtn = el(
    "button",
    { class: "btn pb-send", type: "submit", "aria-label": "Send" },
    icon("send"),
  );
  // "Build the tickets now" escape: forces the decomposer to emit a plan from the
  // brief + answers so far. Always visible so the user is NEVER stuck clarifying;
  // it gets emphasised once the conversation runs several turns deep (see render).
  const forceBtn = el(
    "button",
    {
      class: "btn primary pb-force",
      type: "button",
      "aria-label": "Build the tickets now from what you've told me",
      onclick: () => submitPlanBuildTurn({ forcePlan: true }),
    },
    [icon("check"), el("span", {}, "Build the tickets")],
  );
  const actions = el("div", { class: "pb-actions" }, [
    forceBtn,
    el("span", { class: "pb-keys" }, "Enter sends · Shift+Enter for a new line"),
    sendBtn,
  ]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const titleEl = el("div", { class: "pb-title" }, "Plan a build");
  const subEl = el("div", { class: "pb-sub" }, "Your brief → the planner's questions → the draw");
  const closeBtn = el(
    "button",
    { class: "icon-btn pb-close", type: "button", "aria-label": "Close", onclick: closePlanBuild },
    icon("close", "", 20),
  );
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Plan a build" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [titleEl, subEl]),
        el("div", { class: "pb-head-actions" }, [
          el(
            "button",
            {
              class: "btn pb-new-plan",
              type: "button",
              "aria-label": "Start a new plan (archives current conversation)",
              onclick: startNewPlanBuild,
            },
            "New plan",
          ),
          closeBtn,
        ]),
      ]),
      el("p", { class: "pb-guardrail" }, [
        el("b", {}, "Proposes only. "),
        "Nothing runs until you confirm, and confirmed tickets land as draft (or ready, if you say so).",
      ]),
      log,
      form,
    ],
  );
  panel.addEventListener("click", (e) => e.stopPropagation());

  // Auto-grow the composer; Enter sends, Shift+Enter is a newline.
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitPlanBuildTurn();
  });
  scrim.appendChild(panel); // the panel must live inside the scrim (click-outside closes; panel stops propagation)
  document.body.appendChild(scrim);

  planBuildEls = {
    scrim,
    panel,
    log,
    input,
    sendBtn,
    forceBtn,
    form,
    titleEl,
    subEl,
    closeBtn,
    inline: null,
  };
  return planBuildEls;
}

// ---------------------------------------------------------------------------
//  Session helpers — best-effort; never throw to the caller.
// ---------------------------------------------------------------------------

/**
 * Restore the in-progress session state from a server session row.
 * Parses messages_json and populates planBuildState.history + plan.
 * The server stores assistant turns as JSON-stringified decompose envelopes;
 * user turns store the raw text in `content`.
 */
function restorePlanBuildSession(session) {
  if (!planBuildState || !session) return;
  planBuildState.sessionId = session.id;
  planBuildState.brief = session.brief || null;

  let messages;
  try {
    messages = JSON.parse(session.messages_json || "[]");
  } catch {
    messages = [];
  }

  const history = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      // First user message is the brief; subsequent ones are answers.
      const isFirst = history.filter((t) => t.role === "user").length === 0;
      history.push(
        isFirst ? { role: "user", brief: msg.content } : { role: "user", answer: msg.content },
      );
    } else if (msg.role === "assistant") {
      try {
        const envelope = JSON.parse(msg.content);
        if (envelope && envelope.phase === "clarify") {
          history.push({ role: "assistant", questions: envelope.questions || [] });
        }
        // plan turns are restored via plan_json below, not via history
      } catch {
        // Malformed assistant message — skip.
      }
    }
  }
  planBuildState.history = history;

  if (session.plan_json) {
    try {
      planBuildState.plan = JSON.parse(session.plan_json);
    } catch {
      planBuildState.plan = null;
    }
  }
}

/**
 * Create a new server-side session. Best-effort: if the API is unreachable,
 * sessionId stays null and the panel works in pure in-memory mode.
 */
async function createPlanBuildSession() {
  try {
    const res = await api("POST", "/plan-sessions");
    if (res && res.session && res.session.id) {
      planBuildState.sessionId = res.session.id;
    }
  } catch {
    // Degrade gracefully — session persistence unavailable.
  }
}

/**
 * Append a message to the current session. Called after each user turn and
 * after each assistant reply. Best-effort — never interrupts the chat.
 */
async function persistPlanBuildTurn(role, content, opts) {
  const id = planBuildState && planBuildState.sessionId;
  if (!id) return;
  try {
    await api("POST", `/plan-sessions/${id}/turns`, { role, content, ...opts });
  } catch {
    // Session persistence unavailable — continue in-memory.
  }
}

/**
 * Archive the current session (if any). Called on "Start new plan" (abandoned)
 * and on confirmPlanBuild (confirmed). Best-effort.
 */
async function archivePlanBuildSession(status) {
  const id = planBuildState && planBuildState.sessionId;
  if (!id) return;
  try {
    await api("POST", `/plan-sessions/${id}/archive`, { status });
  } catch {
    // Ignore — the session may not exist on an older server.
  }
}

function openPlanBuild(opts = {}) {
  const els = ensurePlanBuild();
  // On the Plan-a-build page the panel is part of the page: (re)start it there.
  if (els.inline && els.inline.isConnected && els.inline.contains(els.panel)) {
    startPlanBuild(opts);
    els.panel.scrollIntoView?.({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    return;
  }
  startPlanBuild(opts);
  els.scrim.classList.add("open");
  document.addEventListener("keydown", planBuildKeydown);
}

/**
 * The Plan-a-build page (#/create) hosts the same panel inline: the conversation
 * state, the session persistence and the tests' hooks are shared with the sheet.
 * Returns the undo, which hands the panel back to its scrim — but only while this
 * host still holds it (a newer render of the page may have taken it already).
 */
function mountPlanBuildInline(host) {
  const els = ensurePlanBuild();
  closePlanBuild();
  host.appendChild(els.panel);
  els.inline = host;
  els.panel.classList.add("pb-inline");
  els.panel.setAttribute("role", "region");
  els.panel.removeAttribute("aria-modal");
  els.closeBtn.hidden = true;
  els.titleEl.textContent = "The team talk";
  els.subEl.textContent =
    "You give the brief. The planner asks what it needs, then proposes the draw.";
  startPlanBuild({ focus: false });
  return () => {
    if (!host.contains(els.panel)) return;
    els.scrim.appendChild(els.panel);
    els.inline = null;
    els.panel.classList.remove("pb-inline");
    els.panel.setAttribute("role", "dialog");
    els.panel.setAttribute("aria-modal", "true");
    els.closeBtn.hidden = false;
    els.titleEl.textContent = "Plan a build";
    els.subEl.textContent = "Your brief → the planner's questions → the draw";
  };
}

function startPlanBuild(opts = {}) {
  const { input } = ensurePlanBuild();
  // `mode` is the start toggle: "new" (greenfield app) vs "extend" (add tickets
  // to an existing scope node / epic). `target` holds the chosen extend node and
  // becomes the `context` sent to the decomposer on the first turn. `nodes` is
  // loaded lazily for the extend picker; an empty list just hides the option.
  // `sessionId` is the server-side session id (null when persistence unavailable).
  // `spec` (SPEC-DRIVEN): when opened from a FROZEN spec via buildFromFrozenSpec(),
  // its clauses ride along on every plan-build POST so the decomposer satisfies each
  // clause and stamps spec_clause_id provenance on the ACs — without this the whole
  // spec→plan→coverage traceability chain is dead (the spec never reaches decompose).
  // `repo` (from a spec's target_repo): start in "extend" mode targeting that repo
  // so the first turn's context carries it and decompose takes the brownfield path.
  const seededRepo = typeof opts.repo === "string" && opts.repo.trim() ? opts.repo.trim() : null;
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: opts.brief || null,
    mode: seededRepo ? "extend" : "new",
    target: seededRepo ? { kind: "repo", id: seededRepo, name: seededRepo } : null,
    nodes: [],
    repos: [],
    sessionId: null,
    spec: Array.isArray(opts.spec) && opts.spec.length ? opts.spec : null,
  };
  renderPlanBuildLog();
  // Seeded from a spec: pre-fill the brief so the user can immediately "Build the tickets".
  if (planBuildState.brief && input) input.value = planBuildState.brief;
  if (opts.focus !== false) setTimeout(() => input.focus(), 50);
  // Best-effort: restore the in-progress session from the server, and populate
  // the "Extend existing" picker. Both are non-blocking; the panel works without them.
  guard(async () => {
    const [sessionRes, nodesRes, reposRes] = await Promise.all([
      api("GET", "/plan-sessions/active").catch(() => null),
      api("GET", "/scope/nodes"),
      api("GET", "/repositories"),
    ]);
    if (!planBuildState) return; // panel was closed during the fetch
    // A spec-driven open is ALWAYS a fresh session — never restore an unrelated
    // in-progress plan over the frozen-spec intent.
    if (planBuildState.spec) {
      await createPlanBuildSession();
    } else if (sessionRes && sessionRes.session && planBuildState.history.length === 0) {
      // Restore server session (if one exists and the panel hasn't been interacted with).
      restorePlanBuildSession(sessionRes.session);
    } else if ((!sessionRes || !sessionRes.session) && !readOnly()) {
      // No active session on the server — create one (best-effort). A read token
      // cannot hold one (the server refuses the POST), so it reads without.
      await createPlanBuildSession();
    }
    planBuildState.nodes = nodesRes.nodes || [];
    planBuildState.repos = reposRes.repositories || [];
    // Only repaint while still on the empty intro (no turns sent yet) OR if we
    // just restored a session with history.
    renderPlanBuildLog();
  });
}

/**
 * Archive the current session as 'abandoned' and open a fresh one.
 * The "New plan" button in the panel header calls this.
 */
async function startNewPlanBuild() {
  if (!planBuildState || planBuildState.busy) return;
  await archivePlanBuildSession("abandoned");
  // Reset in-memory state.
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: null,
    mode: "new",
    target: null,
    nodes: planBuildState ? planBuildState.nodes : [],
    repos: planBuildState ? planBuildState.repos : [],
    sessionId: null,
    spec: null, // "New plan" starts clean — any frozen-spec attachment is dropped
  };
  renderPlanBuildLog();
  // Create a fresh server-side session.
  await createPlanBuildSession();
  if (planBuildEls) planBuildEls.input.focus();
}
function closePlanBuild() {
  if (!planBuildEls) return;
  planBuildEls.scrim.classList.remove("open");
  document.removeEventListener("keydown", planBuildKeydown);
}
function planBuildKeydown(e) {
  if (e.key === "Escape") closePlanBuild();
}

/** Repaint the conversation log from state (turns + the live proposal). */
function renderPlanBuildLog() {
  const { log } = planBuildEls;
  clear(log);

  if (planBuildState.history.length === 0) {
    log.appendChild(
      el("div", { class: "pb-intro" }, [
        renderPlanBuildModeToggle(),
        planBuildState.spec
          ? el(
              "p",
              { class: "pb-spec-note" },
              `Built to a frozen spec: its ${plural(planBuildState.spec.length, "clause")} ride along, so every criterion names the clause it proves.`,
            )
          : null,
        planBuildState.spec
          ? el(
              "p",
              { class: "pb-ask" },
              "The spec's brief is in the box below. Edit it if you like, then send it to the planner.",
            )
          : planBuildState.mode === "extend"
            ? el(
                "p",
                { class: "pb-ask" },
                planBuildState.target
                  ? `Say what to add to “${planBuildState.target.name}” in a line or two. For example:`
                  : "Pick what to extend, then say what to add in a line or two. For example:",
              )
            : el("p", { class: "pb-ask" }, "Say what to build in a line or two. For example:"),
        // From a frozen spec the brief is already written: no stock examples then.
        planBuildState.spec
          ? null
          : el(
              "ul",
              { class: "pb-examples" },
              (planBuildState.mode === "extend"
                ? ["add CSV export to the reports", "add a settings page with dark mode"]
                : ["a web app that tracks gym workouts", "an API that summarises PDFs"]
              ).map((ex) =>
                el(
                  "li",
                  {},
                  el(
                    "button",
                    {
                      class: "pb-example",
                      type: "button",
                      onclick: () => {
                        planBuildEls.input.value = ex;
                        planBuildEls.input.focus();
                      },
                    },
                    ex,
                  ),
                ),
              ),
            ),
      ]),
    );
  }

  let userTurn = 0;
  for (const turn of planBuildState.history) {
    if (turn.role === "user") {
      log.appendChild(
        el("div", { class: "pb-msg pb-user" }, [
          el("div", { class: "pb-bot-label" }, userTurn++ === 0 ? "Your brief" : "You"),
          el("div", { class: "pb-msg-t" }, turn.answer || turn.brief || ""),
        ]),
      );
    } else if (turn.role === "assistant" && turn.questions) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot" }, [
          el(
            "div",
            { class: "pb-bot-label" },
            `The planner asks ${turn.questions.length === 1 ? "one question" : `${turn.questions.length} questions`}`,
          ),
          el(
            "ol",
            { class: "pb-questions" },
            turn.questions.map((q) => el("li", {}, q)),
          ),
          el(
            "p",
            { class: "pb-hint" },
            "Answer below in your own words, or build the tickets now.",
          ),
        ]),
      );
    } else if (turn.role === "assistant" && turn.error) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot pb-error-msg" }, [
          el("div", { class: "pb-bot-label" }, "Couldn't build the plan"),
          el("div", {}, turn.error),
          el(
            "div",
            { class: "pb-error-hint dim" },
            'Edit your brief and try again, or press "Build the tickets".',
          ),
        ]),
      );
    }
  }

  if (planBuildState.plan) {
    log.appendChild(renderPlanProposal(planBuildState.plan));
  }

  if (planBuildState.notice) {
    log.appendChild(el("p", { class: "pb-notice", role: "alert" }, planBuildState.notice));
  }

  if (planBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking", role: "status" }, [
        el("span", { class: "btn-spinner", "aria-hidden": "true" }),
        el("span", {}, "The planner is working on it…"),
      ]),
    );
  }

  updatePlanBuildActions();
  log.scrollTop = log.scrollHeight;
}

/** Turn depth (number of user messages sent) at which "Build the tickets" emphasises. */
const PLAN_BUILD_FORCE_EMPHASIS_TURNS = 3;

/**
 * Keep the composer actions honest about where the conversation is:
 *  - "Build the tickets" (forcePlan) is ALWAYS available so the user is never
 *    stuck clarifying — it forces the decomposer to emit a plan from what it has.
 *  - It gets EMPHASISED once several turns deep (the point where endless clarify
 *    stops earning its keep).
 *  - Once a plan is on screen the conversation's job is done — review/create takes
 *    over — so both the composer and the force button are hidden.
 * The "Send"/Continue button stays secondary: it keeps refining.
 */
function updatePlanBuildActions() {
  if (!planBuildEls) return;
  const { forceBtn, form } = planBuildEls;
  const turns = planBuildState.history.filter((t) => t.role === "user").length;
  const hasPlan = !!planBuildState.plan;
  // Hide the whole composer once a plan is proposed — the create path owns it now.
  form.hidden = hasPlan;
  if (!hasPlan) {
    planBuildEls.input.placeholder = turns
      ? "Answer the planner, or add anything it should know…"
      : "Describe what to build…";
    // A bare first turn has no brief yet — force-plan with nothing to go on is a no-op.
    forceBtn.disabled = planBuildState.busy || turns === 0;
    forceBtn.classList.toggle("pb-force-strong", turns >= PLAN_BUILD_FORCE_EMPHASIS_TURNS);
  }
  lockPlanBuildForReadOnly();
}

/**
 * A read token may read a plan conversation but not hold one: the composer, its
 * examples and mode toggle, New plan and the plan's create buttons are switched off
 * (Close stays live). Runs after every repaint of the panel.
 */
function lockPlanBuildForReadOnly() {
  if (!planBuildEls || !readOnly()) return;
  planBuildEls.closeBtn.setAttribute("data-ro-ok", "");
  roLockAll(planBuildEls.panel);
}

// ── Shared target selector ──────────────────────────────────────────────────
// One control for "pick a repo OR a scope node, and assign it as a target".
// A target is { kind: "repo" | "node", id, name }. A node resolves to its linked
// repo NAME(s) via resolveTargetRepos() so every consumer (plan-build extend,
// idle-loop scoping) ends up repo-name-based — the loop/decompose backends never
// learn about nodes. Two variants: single-select (a <select> with Repos/Scopes
// optgroups, plus a repo disambiguator when a multi-repo node is chosen) and
// multi-select (grouped checkboxes). Self-contained + styled to match the
// existing form controls.

/** Cache of node id → repo NAMES, so a node only fetches its repos once per session. */
const nodeReposCache = new Map();

/**
 * Resolve a node's linked repo NAMES. Uses the already-loaded `scopeRepos` map
 * (node id → repo objects) when present, else fetches `GET /scope/repos?node=<id>`
 * once and caches it. A repo target resolves to its own single name. Best-effort:
 * returns [] on any error so a save never hard-fails on a transient fetch.
 */
async function resolveTargetRepos(target, scopeRepos) {
  if (!target) return [];
  if (target.kind === "repo") return target.name ? [target.name] : [];
  const id = target.id;
  if (scopeRepos && Array.isArray(scopeRepos[id])) {
    return scopeRepos[id].map((r) => r.name).filter(Boolean);
  }
  if (nodeReposCache.has(id)) return nodeReposCache.get(id);
  try {
    const { repos } = await api("GET", `/scope/repos?node=${encodeURIComponent(id)}`);
    const names = (Array.isArray(repos) ? repos : []).map((r) => r.name).filter(Boolean);
    nodeReposCache.set(id, names);
    return names;
  } catch {
    return [];
  }
}

/**
 * Single-select target picker. Renders a labelled <select> grouping repos
 * ("Repos") and scope nodes ("Scopes"). On choosing a repo the value becomes
 * { kind:"repo", id, name }; on a node it becomes { kind:"node", id, name } and,
 * when the node links more than one repo, a second <select> appears so the user
 * disambiguates which repo to target (a node with exactly one repo auto-resolves).
 * Calls `onChange(target)` with the current selection (or null when cleared).
 */
function targetPickerSingle({ repos, nodes, value, allowRepo = true, allowNode = true, onChange }) {
  const wrap = el("div", { class: "target-picker" });
  const repoList = allowRepo ? repos || [] : [];
  const nodeList = allowNode ? nodes || [] : [];

  // Slot for the per-node repo disambiguator (filled when a multi-repo node is chosen).
  const repoSlot = el("div", { class: "target-picker-reposlot" });

  const optionValue = (kind, id) => `${kind}:${id}`;
  const selected =
    value && value.kind
      ? optionValue(value.kind, value.kind === "repo" ? value.name : value.id)
      : "";

  const sel = el(
    "select",
    { class: "target-picker-select", "aria-label": "Target repo or scope" },
    [
      el("option", { value: "" }, "Select a target…"),
      repoList.length
        ? el(
            "optgroup",
            { label: "Repos" },
            repoList.map((r) =>
              el(
                "option",
                {
                  value: optionValue("repo", r.name),
                  selected: selected === optionValue("repo", r.name) ? "" : undefined,
                },
                r.name,
              ),
            ),
          )
        : null,
      nodeList.length
        ? el(
            "optgroup",
            { label: "Scopes" },
            nodeList.map((n) =>
              el(
                "option",
                {
                  value: optionValue("node", n.id),
                  selected: selected === optionValue("node", n.id) ? "" : undefined,
                },
                `${n.name} (${typeLabel(n.type)})`,
              ),
            ),
          )
        : null,
    ],
  );

  // Build the per-node repo disambiguator into the slot from a list of repo names.
  // Idempotent: clears the slot first, so it survives consumer re-renders that
  // remount the whole picker with the same node `value`.
  function renderRepoSlot(target, names) {
    clear(repoSlot);
    if (names.length <= 1) {
      // 0 → greenfield-style (no repo); 1 → use it directly. No disambiguation.
      target.repo = names[0] || null;
      return;
    }
    const repoSel = el(
      "select",
      { class: "target-picker-select", "aria-label": "Which repo in this scope" },
      [
        el("option", { value: "" }, "Pick a repo in this scope…"),
        ...names.map((name) =>
          el("option", { value: name, selected: target.repo === name ? "" : undefined }, name),
        ),
      ],
    );
    repoSel.addEventListener("change", () => {
      target.repo = repoSel.value || null;
      onChange(target);
    });
    repoSlot.appendChild(el("label", { class: "target-picker-sublabel" }, "Repo in scope"));
    repoSlot.appendChild(repoSel);
  }

  // For a node target: render the disambiguator. Uses the repo-name cache when
  // present (so a remount paints synchronously); otherwise fetches, then repaints
  // just the slot — without notifying the consumer (no re-render churn).
  function hydrateRepoSlot(target) {
    clear(repoSlot);
    if (!target || target.kind !== "node") return;
    if (nodeReposCache.has(target.id)) {
      renderRepoSlot(target, nodeReposCache.get(target.id));
      return;
    }
    // The slot belongs to this picker instance; paint into it when the resolve
    // lands. A remount supersedes us with its own slot, so this is always safe.
    resolveTargetRepos(target).then((names) => renderRepoSlot(target, names));
  }

  sel.addEventListener("change", () => {
    clear(repoSlot);
    const raw = sel.value;
    if (!raw) {
      onChange(null);
      return;
    }
    const sep = raw.indexOf(":");
    const kind = raw.slice(0, sep);
    const key = raw.slice(sep + 1);
    if (kind === "repo") {
      onChange({ kind: "repo", id: key, name: key, repo: key });
      return;
    }
    const node = nodeList.find((n) => n.id === key);
    const target = node
      ? { kind: "node", id: node.id, name: node.name, type: node.type, repo: null }
      : null;
    if (!target) {
      onChange(null);
      return;
    }
    // Notify first (the consumer may re-render and remount this picker — the new
    // mount's hydrateRepoSlot then paints the disambiguator), then paint here too
    // for consumers that don't re-render. A detached paint is harmless.
    onChange(target);
    hydrateRepoSlot(target);
  });

  wrap.appendChild(sel);
  wrap.appendChild(repoSlot);
  // Restore the disambiguator when remounted with a node already selected (the
  // consumer re-renders the picker on every change, so this keeps it in sync).
  if (value && value.kind === "node") hydrateRepoSlot(value);
  return wrap;
}

/**
 * Multi-select target picker. Renders grouped checkboxes (Repos / Scopes) and
 * keeps a live Set of selected targets. `getTargets()` returns the current
 * selection as `{ kind, id, name }[]`; consumers resolve nodes to repo NAMES via
 * resolveTargetRepos() on save. An empty selection means "all" — the caller owns
 * that copy. Used for the idle loops (repos + nodes, node expands to repo names).
 */
function targetPickerMulti({ repos, nodes, value, onChange }) {
  const wrap = el("div", { class: "target-picker target-picker-multi" });
  const repoList = repos || [];
  const nodeList = nodes || [];

  // Selection keyed by "kind:id" so repos and nodes can't collide.
  const selected = new Map();
  for (const t of value || []) selected.set(`${t.kind}:${t.id}`, t);

  const emit = () => onChange(getTargets());
  function getTargets() {
    return [...selected.values()];
  }

  function checkboxRow(target, label) {
    const key = `${target.kind}:${target.id}`;
    const input = el("input", { type: "checkbox", "aria-label": label });
    input.checked = selected.has(key);
    input.addEventListener("change", () => {
      if (input.checked) selected.set(key, target);
      else selected.delete(key);
      emit();
    });
    return el("label", { class: "target-picker-check" }, [input, el("span", {}, label)]);
  }

  if (repoList.length) {
    wrap.appendChild(el("div", { class: "target-picker-grouplabel" }, "Repos"));
    const group = el("div", { class: "target-picker-group" });
    for (const r of repoList) {
      group.appendChild(checkboxRow({ kind: "repo", id: r.name, name: r.name }, r.name));
    }
    wrap.appendChild(group);
  }
  if (nodeList.length) {
    wrap.appendChild(el("div", { class: "target-picker-grouplabel" }, "Scopes"));
    const group = el("div", { class: "target-picker-group" });
    for (const n of nodeList) {
      group.appendChild(
        checkboxRow(
          { kind: "node", id: n.id, name: n.name, type: n.type },
          `${n.name} (${typeLabel(n.type)})`,
        ),
      );
    }
    wrap.appendChild(group);
  }
  if (!repoList.length && !nodeList.length) {
    wrap.appendChild(el("div", { class: "target-picker-empty dim" }, "No repos or scopes yet."));
  }

  // Expose the live reader so the caller can collect on save.
  wrap.getTargets = getTargets;
  return wrap;
}

/**
 * Shared entry point. `multiple` chooses the variant; both share the repos/nodes
 * inputs and the { kind, id, name } target shape. Kept as one function so the two
 * consumers (plan-build extend, idle loops) reach for the same abstraction.
 */
function targetPicker(opts) {
  return opts.multiple ? targetPickerMulti(opts) : targetPickerSingle(opts);
}

/**
 * Start toggle: "New app" vs "Extend existing". In extend mode a repo/scope
 * picker appears; the chosen target becomes the `context` the decomposer uses
 * to propose EXTENDING tickets rather than rebuilding. The toggle only shows on
 * the empty intro (before any turn) — once the conversation starts the target is
 * locked so history stays coherent.
 */
function renderPlanBuildModeToggle() {
  const nodes = planBuildState.nodes || [];
  const newRadio = el("input", {
    type: "radio",
    name: "pb-mode",
    value: "new",
    checked: planBuildState.mode === "new" ? "" : undefined,
  });
  const extendRadio = el("input", {
    type: "radio",
    name: "pb-mode",
    value: "extend",
    checked: planBuildState.mode === "extend" ? "" : undefined,
  });
  newRadio.addEventListener("change", () => {
    if (newRadio.checked) {
      planBuildState.mode = "new";
      planBuildState.target = null;
      renderPlanBuildLog();
      planBuildEls.input.focus();
    }
  });
  extendRadio.addEventListener("change", () => {
    if (extendRadio.checked) {
      planBuildState.mode = "extend";
      renderPlanBuildLog();
      planBuildEls.input.focus();
    }
  });

  const children = [
    el("div", { class: "mode-toggle" }, [
      el("label", { class: "mode-option" }, [
        newRadio,
        el("span", {}, [
          el("strong", {}, "New app"),
          el("span", { class: "mode-sub" }, "a new repo, from scratch"),
        ]),
      ]),
      el("label", { class: "mode-option" }, [
        extendRadio,
        el("span", {}, [
          el("strong", {}, "Extend existing"),
          el("span", { class: "mode-sub" }, "add to a repo or scope we have"),
        ]),
      ]),
    ]),
  ];

  if (planBuildState.mode === "extend") {
    const repos = planBuildState.repos || [];
    // Shared selector: offers BOTH repos and scope nodes. Choosing a repo sets the
    // target directly (the first-turn context carries that `repo`, no guessing);
    // choosing a multi-repo node expands to a repo disambiguator; a single-repo
    // node resolves to its one repo. The picker keeps target.repo current.
    const picker = targetPicker({
      repos,
      nodes,
      value: planBuildState.target,
      multiple: false,
      onChange: (target) => {
        planBuildState.target = target;
        planBuildState.notice = null;
        renderPlanBuildLog();
        planBuildEls.input.focus();
      },
    });
    children.push(field("Extend", picker, { class: "pb-extend-field" }));
  }

  return el("div", { class: "pb-mode" }, children);
}

/**
 * The proposal as the draw: the epic's name and brief, then its tickets round by
 * round (a ticket's round is its dependency depth in the plan), then the Final
 * the factory adds on confirm, then the two ways to confirm.
 */
// ---- Requirements agreed during clarification -----------------------------------
// The planner asks questions; the human's answers are requirements ("links expire after
// 30 minutes"). A proposal that dropped one used to be confirmed with only the brief, so
// the acceptance ticket never carried it and the independent tester never checked it.
// The proposal now lists every agreed answer, marks the ones no proposed criterion
// covers, and confirming carries the kept ones into the acceptance ticket's criteria
// (server: epic.agreed_requirements). Mirrors util/planClarifications.ts.
const PB_STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by as is are be been it its this that " +
    "these those should must will would can could may might shall do does did not no yes " +
    "after before when then than so if we our you your they them their there here also " +
    "just only all any each every some such very want need needs please"
  ).split(" "),
);
function pbTokens(text) {
  const words = new Set();
  const numbers = new Set();
  for (const tok of String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (!tok) continue;
    if (/^\p{N}+$/u.test(tok)) numbers.add(tok);
    else if (tok.length >= 3 && !PB_STOPWORDS.has(tok)) words.add(tok);
  }
  return { words, numbers };
}
function pbCriterionCovers(criterion, answer) {
  const a = pbTokens(answer);
  if (!a.words.size && !a.numbers.size) return false;
  const c = pbTokens(criterion);
  for (const n of a.numbers) if (!c.numbers.has(n)) return false;
  if (!a.words.size) return true;
  let hit = 0;
  for (const w of a.words) if (c.words.has(w)) hit++;
  return hit * 2 >= a.words.size;
}
/** The answers given to the planner's questions in this chat (the brief is not one). */
function planAgreedRequirements() {
  const out = [];
  let pending = null;
  for (const h of (planBuildState && planBuildState.history) || []) {
    if (!h) continue;
    if (h.role === "assistant") {
      pending = Array.isArray(h.questions)
        ? h.questions.filter((q) => q && String(q).trim())
        : null;
      continue;
    }
    const answer = typeof h.answer === "string" ? h.answer.trim() : "";
    if (pending && answer) {
      out.push({
        ...(pending.length ? { question: pending.join(" ").slice(0, 4000) } : {}),
        answer: answer.slice(0, 4000),
      });
    }
    pending = null;
  }
  return out.slice(0, 50);
}

function renderPlanAgreed(plan, agreed, withFinal) {
  if (!agreed.length) return null;
  const tickets = plan.tickets || [];
  const acText = (ac) => (typeof ac === "string" ? ac : (ac && ac.text) || "");
  const keep = (planBuildState.agreedKeep = planBuildState.agreedKeep || {});
  const items = agreed.map((r, i) => {
    const coveredBy = [];
    tickets.forEach((t, ti) => {
      const acs = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
      if (acs.some((ac) => pbCriterionCovers(acText(ac), r.answer))) coveredBy.push(`T${ti + 1}`);
    });
    if (keep[i] === undefined) keep[i] = true;
    const box = el("input", {
      type: "checkbox",
      class: "pb-agreed-keep",
      "aria-label": `Add “${r.answer.slice(0, 80)}” to the acceptance criteria`,
      ...(withFinal ? {} : { disabled: "" }),
      onchange: (e) => {
        keep[i] = e.target.checked;
      },
    });
    box.checked = withFinal && keep[i];
    return el("li", { class: `pb-agreed-item${coveredBy.length ? "" : " is-uncovered"}` }, [
      el("label", { class: "pb-agreed-label" }, [box, el("span", {}, r.answer)]),
      r.question ? el("p", { class: "pb-agreed-q" }, `Asked: ${r.question}`) : null,
      el(
        "p",
        { class: "pb-agreed-cover" },
        coveredBy.length
          ? `Covered by ${coveredBy.join(", ")}'s criteria`
          : "No proposed ticket's criteria cover this",
      ),
    ]);
  });
  const uncovered = items.filter((li) => li.classList.contains("is-uncovered")).length;
  return el("section", { class: "pb-agreed", "aria-label": "Requirements agreed while planning" }, [
    el("h4", { class: "pb-agreed-title" }, "Agreed while planning"),
    el(
      "p",
      { class: "pb-agreed-note" },
      withFinal
        ? `Each one you keep becomes a criterion of the Final, so the independent tester checks it.${uncovered ? ` ${plural(uncovered, "requirement")} ${uncovered === 1 ? "is" : "are"} in no ticket's criteria.` : ""}`
        : "This epic has no Final (acceptance is off), so nothing carries these into a criterion: add them to a ticket before you confirm.",
    ),
    el("ul", { class: "pb-agreed-list" }, items),
  ]);
}

function renderPlanProposal(plan) {
  const epic = plan.epic || {};
  const tickets = plan.tickets || [];
  const depthMemo = new Map();
  const depth = (i, seen = new Set()) => {
    if (depthMemo.has(i)) return depthMemo.get(i);
    if (seen.has(i)) return 0;
    seen.add(i);
    const deps = (Array.isArray(tickets[i]?.dependsOn) ? tickets[i].dependsOn : []).filter(
      (d) => Number.isInteger(d) && d >= 0 && d < tickets.length && d !== i,
    );
    const v = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, seen))) : 0;
    depthMemo.set(i, v);
    return v;
  };
  const rounds = [];
  tickets.forEach((t, i) => {
    const d = depth(i);
    (rounds[d] = rounds[d] || []).push(i);
  });
  const filled = rounds.filter(Boolean);
  const known = new Set(((planBuildState && planBuildState.repos) || []).map((r) => r.name));
  const withFinal = epic.acceptance !== false;

  const ticketRow = (i) => {
    const t = tickets[i];
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    const acs = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
    const acText = (ac) => (typeof ac === "string" ? ac : (ac && ac.text) || "");
    return el("li", { class: "pb-ticket" }, [
      el("div", { class: "pb-ticket-top" }, [
        // A proposal index, never a ticket number: the server numbers the tickets
        // only when you confirm, so "#1" here would name a ticket that exists.
        el(
          "span",
          { class: "pb-ticket-idx tabnum", title: `Proposed ticket ${i + 1}: not created yet` },
          `T${i + 1}`,
        ),
        el("span", { class: "pb-ticket-title" }, t.title),
      ]),
      el("div", { class: "pb-ticket-meta" }, [
        t.repo
          ? known.has(t.repo)
            ? repoTag(t.repo, 16)
            : el("span", { class: "pb-repo-new" }, [kitShirt(t.repo, 16), `new repo: ${t.repo}`])
          : el("span", {}, "no repo named"),
        t.bootstrap ? badge("bootstrap") : null,
        typeof t.priority === "number"
          ? el("span", { class: "tabnum" }, `priority ${t.priority}`)
          : null,
        deps.length
          ? el(
              "span",
              { class: "pb-ticket-deps" },
              `after ${deps.map((d) => `T${d + 1}`).join(", ")}`,
            )
          : null,
      ]),
      t.description ? el("p", { class: "pb-ticket-desc" }, t.description) : null,
      acs.length
        ? el("details", { class: "pb-acs-fold" }, [
            el("summary", {}, plural(acs.length, "acceptance criterion", "acceptance criteria")),
            el(
              "ul",
              { class: "pb-acs" },
              acs.map((ac) => el("li", {}, acText(ac))),
            ),
          ])
        : el(
            "p",
            { class: "pb-ticket-noac" },
            "No acceptance criterion: it stays draft until one is added.",
          ),
    ]);
  };

  const wrap = el(
    "section",
    { class: "pb-proposal", "aria-label": `Proposed campaign: ${epic.name || "epic"}` },
    [
      el("header", { class: "pb-proposal-head" }, [
        el("h3", { class: "pb-proposal-name" }, epic.name || "Proposed epic"),
        el(
          "p",
          { class: "pb-proposal-aux" },
          `The draw, proposed · ${plural(tickets.length, "ticket")} in ${plural(filled.length, "round")}${withFinal ? " + the Final" : ""}`,
        ),
      ]),
      epic.description ? el("p", { class: "pb-proposal-desc" }, epic.description) : null,
      el("ol", { class: "pb-rounds" }, [
        ...filled.map((idxs, ri) =>
          el("li", { class: "pb-round" }, [
            el("h4", { class: "pb-round-name" }, `Round ${ri + 1}`),
            el("ol", { class: "pb-tickets" }, idxs.map(ticketRow)),
          ]),
        ),
        withFinal
          ? el("li", { class: "pb-round is-final" }, [
              el("h4", { class: "pb-round-name" }, "Final"),
              el("div", { class: "pb-final" }, [
                el("span", { class: "pb-ticket-title" }, `Acceptance: ${epic.name || "the build"}`),
                el(
                  "p",
                  { class: "pb-ticket-desc" },
                  "Added by the factory when you confirm. Your brief is its contract; it runs last, against the whole build, and the independent tester decides it.",
                ),
              ]),
            ])
          : null,
      ]),
    ],
  );

  const agreedSection = renderPlanAgreed(plan, planAgreedRequirements(), withFinal);
  if (agreedSection) wrap.appendChild(agreedSection);

  wrap.appendChild(
    el("div", { class: "pb-confirm-row" }, [
      el(
        "p",
        { class: "pb-confirm-note" },
        `Create as draft to look them over first, or create and ready them for the squad now. Readying asks each ticket's gate: one with no acceptance criterion stays draft.`,
      ),
      el("div", { class: "pb-confirm-actions" }, [
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => confirmPlanBuild(plan),
          },
          el("span", {}, "Create as draft"),
        ),
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => confirmPlanBuild(plan, { ready: true }),
          },
          [icon("check"), el("span", {}, "Create & ready")],
        ),
      ]),
    ]),
  );
  return wrap;
}

/**
 * Send the next turn: append the user message, POST /plan-build, fold the reply.
 *
 * `forcePlan` is the "Build the tickets now" escape — it fires WITHOUT requiring
 * new input (it builds from the brief + answers so far) and asks the decomposer to
 * stop clarifying and return a plan. The normal (Continue/Send) path keeps refining.
 */
async function submitPlanBuildTurn(opts = {}) {
  const forcePlan = opts.forcePlan === true;
  const { input, sendBtn } = planBuildEls;
  const text = input.value.trim();
  // Continue/Send needs text; "Build the tickets" does not — it forces a plan from
  // whatever has been said so far. Either way, never fire while a turn is in flight.
  if (planBuildState.busy) return;
  if (!forcePlan && !text) return;

  const isFirst = planBuildState.history.length === 0;
  // Extend mode requires a target before the first turn, otherwise "extend" has
  // nothing to extend. Later turns inherit the locked target, so only gate the first.
  // Both refusals are said inline, next to the composer, not in a toast.
  if (isFirst && planBuildState.mode === "extend" && !planBuildState.target) {
    planBuildState.notice = "Pick the repo or scope to extend first.";
    renderPlanBuildLog();
    return;
  }
  // Force-plan with nothing said yet has nothing to plan from — ask for the brief.
  if (forcePlan && isFirst && !text) {
    planBuildState.notice = "Write the brief first: the tickets are built from it.";
    renderPlanBuildLog();
    input.focus();
    return;
  }
  planBuildState.notice = null;

  // Record the user's message. On a force-plan turn the input may be empty (the
  // user just pressed "Build the tickets"), so only push a message when there is text.
  if (text) {
    if (isFirst) planBuildState.brief = text;
    planBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    // Persist the user turn server-side (best-effort; never awaited before the render).
    persistPlanBuildTurn("user", text, isFirst ? { brief: text } : {}).catch(() => {});
    input.value = "";
    input.style.height = "auto";
  }

  // Build the extend-existing context once (locked for the whole conversation).
  // The target is either a direct repo ({kind:"repo"}) — its name flows straight
  // through as `repo` — or a scope node ({kind:"node"}) — its id/name/type plus
  // the resolved/disambiguated repo NAME (when one was chosen).
  const target = planBuildState.target;
  const context =
    planBuildState.mode === "extend" && target
      ? target.kind === "repo"
        ? { mode: "extend", repo: target.name }
        : {
            mode: "extend",
            scopeNodeId: target.id,
            scopeNodeName: target.name,
            scopeNodeType: target.type,
            // Brownfield: forward the resolved/disambiguated target repo NAME so
            // decompose takes the existing-repo path. Only included when resolved.
            ...(target.repo ? { repo: target.repo } : {}),
          }
      : undefined;

  planBuildState.busy = true;
  // Immediate running state: disable + relabel the send button to "Planning…"
  // (the inline "thinking" dots render from `busy` in renderPlanBuildLog), so the
  // turn visibly "took" rather than firing silently.
  sendBtn.disabled = true;
  sendBtn.classList.add("is-running");
  sendBtn.setAttribute("aria-busy", "true");
  clear(sendBtn);
  sendBtn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  sendBtn.appendChild(el("span", { class: "pb-send-label" }, "Planning…"));
  renderPlanBuildLog();

  // Send the brief + the answered turns; the helper treats answered Qs as settled.
  // On a force-plan turn the decomposer is told to stop clarifying and return a
  // plan now from what it has — so the user is never trapped in an endless chat.
  // NOTE: we handle errors explicitly (not via guard) so a failed turn leaves a
  // PERSISTENT error message in the chat + clears the thinking bubble, rather than
  // hanging on the typing dots with only a transient toast.
  let failure = null;
  try {
    const res = await api("POST", "/plan-build", {
      brief: planBuildState.brief,
      history: planBuildState.history
        .filter((t) => !(t.role === "assistant" && t.error)) // never resend a failed turn
        .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t)),
      ...(context !== undefined ? { context } : {}),
      ...(forcePlan ? { forcePlan: true } : {}),
      // SPEC-DRIVEN: thread the frozen spec's clauses so the decomposer satisfies each
      // and stamps spec_clause_id provenance on the ACs (drives the coverage read model).
      ...(Array.isArray(planBuildState.spec) && planBuildState.spec.length
        ? { spec: planBuildState.spec }
        : {}),
    });
    if (res.phase === "clarify") {
      planBuildState.history.push({ role: "assistant", questions: res.questions || [] });
      persistPlanBuildTurn("assistant", JSON.stringify(res)).catch(() => {});
    } else if (res.phase === "plan") {
      planBuildState.plan = res.plan || null;
      persistPlanBuildTurn("assistant", JSON.stringify(res), { plan: res.plan || null }).catch(
        () => {},
      );
    } else {
      failure = res.error || "The planner returned no result.";
      persistPlanBuildTurn("assistant", JSON.stringify(res)).catch(() => {});
    }
  } catch (e) {
    failure = e && e.message ? e.message : "The request errored before a plan came back.";
  }

  // Always land the UI in a resolved state — bubble cleared, composer usable.
  planBuildState.busy = false;
  if (failure) {
    planBuildState.history.push({ role: "assistant", error: failure });
    toast(failure, { code: "PLAN_BUILD" });
  }
  sendBtn.disabled = false;
  sendBtn.classList.remove("is-running");
  sendBtn.removeAttribute("aria-busy");
  clear(sendBtn);
  sendBtn.appendChild(icon("send"));
  renderPlanBuildLog();
}

/**
 * Human confirm → create_epic. Tickets land draft; toast + jump to the epic.
 *
 * Greenfield seam: a bootstrap plan names a repo that does NOT exist yet (the
 * runner greenfield mode registers it when the bootstrap ticket runs).
 * Shipped create_epic requires a named repo to already exist, so before posting
 * we drop `repo`/`access` for any ticket whose repo isn't registered yet. The
 * repo name stayed visible in the proposal for review; the link is established
 * later when the repo is onboarded. Everything else (ACs, deps, bootstrap,
 * priority) is preserved, so the draft epic still lands intact.
 */
// `opts.ready` (the "Create & ready" button) readies the created tickets in the
// same step so the human doesn't have to draft→ready each one by hand. It is
// GATE-AWARE, never a blind status flip: it POSTs /ready per ticket and lets the
// server's intake gate decide — a ticket with no acceptance criterion is refused
// and simply stays draft, so "Create & ready" can never push slop past the AC gate.
async function confirmPlanBuild(plan, opts = {}) {
  await guard(async () => {
    const known = new Set(
      ((await api("GET", "/repositories")).repositories || []).map((r) => r.name),
    );
    let deferred = 0;
    const tickets = (plan.tickets || []).map((t) => {
      if (t.repo && !known.has(t.repo)) {
        deferred++;
        const { repo, access, ...rest } = t;
        // Carry the intended repo NAME onto `source` so the runner bootstraps a
        // cleanly-named repo instead of falling back to a slug of the ticket title.
        // Only when the plan didn't already set `source`; the link itself stays
        // deferred until the repo is onboarded.
        return rest.source ? rest : { ...rest, source: repo };
      }
      return t;
    });
    // ACCEPTANCE GATE: the brief this plan came from rides on the epic so the
    // factory-created acceptance ticket carries it as its contract. The session's
    // recorded brief wins; else the first user turn of this chat.
    const firstTurn = ((planBuildState && planBuildState.history) || []).find(
      (h) => h && h.role === "user" && typeof h.brief === "string" && h.brief.trim(),
    );
    const brief =
      (planBuildState && planBuildState.brief) || (firstTurn ? firstTurn.brief : null) || null;
    const withBrief = brief ? { ...plan.epic, brief: String(brief).slice(0, 20000) } : plan.epic;
    // The answers given while the planner asked its questions ride on the epic as its
    // agreed requirements (the ones the human kept in the proposal), so the acceptance
    // ticket carries each as a criterion. Explicit even when empty: the server then
    // never re-derives what the human chose to drop.
    const keep = (planBuildState && planBuildState.agreedKeep) || {};
    const agreed = planAgreedRequirements().filter((_, i) => keep[i] !== false);
    const epic = { ...withBrief, agreed_requirements: agreed };
    const sessionId = planBuildState && planBuildState.sessionId;
    const res = await api("POST", "/epics", {
      epic,
      tickets,
      ...(sessionId ? { plan_session_id: sessionId } : {}),
    });
    // Archive the session as confirmed now that the epic has been created.
    await archivePlanBuildSession("confirmed");
    const numbers = res.ticket_numbers || [];
    const count = numbers.length;
    const tested = Number(res.testable_tickets) || 0;
    const note =
      (deferred
        ? ` (${deferred} repo link${deferred === 1 ? "" : "s"} deferred to bootstrap)`
        : "") +
      (tested
        ? `; ${tested} marked for the independent tester (set-testable --off unmarks one)`
        : "");

    let readied = 0;
    let heldDraft = 0;
    if (opts.ready && count) {
      // Resolve the just-created tickets by number, then let the server's ready
      // gate decide per ticket. A refusal (missing AC, unmet precondition) is
      // expected for some tickets — they stay draft, counted, never surfaced as an
      // error. Bootstrap-gated tickets are readied too; the loop honours deps.
      const all = (await allTickets()).tickets;
      const mine = all.filter((t) => numbers.includes(t.number));
      for (const t of mine) {
        try {
          await api("POST", `/tickets/${t.id}/ready`, {});
          readied++;
        } catch {
          heldDraft++;
        }
      }
    }

    const msg = opts.ready
      ? `Created ${count} ticket${count === 1 ? "" : "s"} — ${readied} readied` +
        (heldDraft ? `, ${heldDraft} held as draft (add an acceptance criterion)` : "") +
        note
      : `Created ${count} draft ticket${count === 1 ? "" : "s"} — ready them when set${note}`;
    toast(msg, { ok: true });
    closePlanBuild();
    navigate(`#/epics/${res.epic_node_id}`);
    // If already on the epics view, navigate() with the same view won't re-fire
    // the hashchange when the param differs only — force a refresh to be safe.
    router();
  });
}

// ---------------------------------------------------------------------------
//  Author a spec — the spec-author chat step (Spec-Driven Development, Phase 1c)
// ---------------------------------------------------------------------------
//
// A sibling to "Plan a build": a one-line brief becomes an AI-drafted, EDITABLE
// spec (clauses), which the human refines, then CREATES (POST /specs) and FREEZES
// (POST /specs/:id/freeze). It PROPOSES ONLY — nothing is created until the human
// presses "Create spec", and nothing is immutable until "Freeze". This flow is
// entirely additive: the one-liner plan-build path above is untouched. It reuses
// the pb-* panel styling (the spec panel is a second pb-panel instance) plus a few
// spec-specific classes (sb-*) for the editable clause list.
//
// The chat half mirrors submitPlanBuildTurn: clarify turns show questions and let
// the user continue; a "spec" turn hands its clauses to the editable draft. The
// "Draft the spec now" (forcePlan) escape is always available so the user is never
// stuck clarifying — exactly like plan-build's "Build the tickets".
//
// The three clause kinds match the dispatch/spec-author contract exactly.
const SPEC_CLAUSE_KINDS = ["requirement", "non-goal", "decision"];

let specBuildEls = null;
let specBuildState = null;

function ensureSpecBuild() {
  if (specBuildEls) return specBuildEls;
  const scrim = el("div", { class: "pb-scrim", onclick: closeSpecBuild });
  const log = el("div", { class: "pb-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", {
    class: "pb-input",
    rows: "1",
    placeholder: "Describe what the product must do, in one line…",
    "aria-label": "Your message",
  });
  const sendBtn = el(
    "button",
    { class: "btn pb-send", type: "submit", "aria-label": "Send" },
    icon("send"),
  );
  // "Draft the spec now" escape: forces the author to emit a spec from the brief +
  // answers so far. Always visible so the user is NEVER stuck clarifying.
  const forceBtn = el(
    "button",
    {
      class: "btn primary pb-force",
      type: "button",
      "aria-label": "Draft the spec now from what you've told me",
      onclick: () => submitSpecBuildTurn({ forcePlan: true }),
    },
    [icon("check"), el("span", {}, "Draft the spec")],
  );
  const actions = el("div", { class: "pb-actions" }, [forceBtn, sendBtn]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Author a spec" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [
          el("div", { class: "pb-title" }, "Author a spec"),
          el(
            "div",
            { class: "pb-sub" },
            "Your brief → clauses you edit → frozen into the playbook",
          ),
        ]),
        el("div", { class: "pb-head-actions" }, [
          el(
            "button",
            {
              class: "btn pb-new-plan",
              type: "button",
              "aria-label": "Start a new spec (clears this conversation)",
              onclick: startNewSpecBuild,
            },
            "New spec",
          ),
          el(
            "button",
            {
              class: "icon-btn pb-close",
              type: "button",
              "aria-label": "Close",
              onclick: closeSpecBuild,
            },
            icon("close", "", 20),
          ),
        ]),
      ]),
      el("p", { class: "pb-guardrail" }, [
        el("b", {}, "Proposes only. "),
        "Nothing is created until you press Create spec, and nothing is locked until you freeze it.",
      ]),
      log,
      form,
    ],
  );
  panel.addEventListener("click", (e) => e.stopPropagation());

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitSpecBuildTurn();
  });
  scrim.appendChild(panel);
  document.body.appendChild(scrim);

  specBuildEls = { scrim, panel, log, input, sendBtn, forceBtn, form };
  return specBuildEls;
}

function openSpecBuild() {
  const { scrim, input } = ensureSpecBuild();
  // `history` accumulates clarify turns; `draft` is the editable clause set once
  // the author returns a spec; `createdSpec` is the persisted spec (with id) after
  // Create; once `createdSpec` exists the flow shows the Freeze action.
  // `targetRepo` is the repo the spec is FOR: it rides on POST /specs as
  // `target_repo`, so the lore the freeze seeds is tagged with that repo and the
  // delivery primer's per-repo `memory search --repo <name>` can surface it —
  // untagged clauses never reached a delivery agent. `repos` feeds its picker.
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
    targetRepo: "",
    repos: [],
  };
  renderSpecBuildLog();
  scrim.classList.add("open");
  document.addEventListener("keydown", specBuildKeydown);
  setTimeout(() => input.focus(), 50);
  loadSpecBuildRepos();
}

/** Best-effort: populate the target-repo picker. The panel works without it. */
function loadSpecBuildRepos() {
  guard(async () => {
    const res = await api("GET", "/repositories").catch(() => null);
    if (!specBuildState || !res) return; // panel closed / repos unavailable
    specBuildState.repos = res.repositories || [];
    if (specBuildState.draft) renderSpecBuildLog();
  });
}

function startNewSpecBuild() {
  if (!specBuildState || specBuildState.busy) return;
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
    targetRepo: "",
    repos: specBuildState.repos || [],
  };
  renderSpecBuildLog();
  if (specBuildEls) specBuildEls.input.focus();
}

function closeSpecBuild() {
  if (!specBuildEls) return;
  specBuildEls.scrim.classList.remove("open");
  document.removeEventListener("keydown", specBuildKeydown);
}
function specBuildKeydown(e) {
  if (e.key === "Escape") closeSpecBuild();
}

/** Repaint the spec conversation log from state (turns + the editable draft). */
function renderSpecBuildLog() {
  const { log } = specBuildEls;
  clear(log);

  if (specBuildState.history.length === 0 && !specBuildState.draft) {
    log.appendChild(
      el("div", { class: "pb-intro" }, [
        el("p", {}, "Describe the product in one line and I'll draft a spec. For example:"),
        el(
          "ul",
          { class: "pb-examples" },
          ["a web app that tracks gym workouts", "an API that summarises PDFs"].map((ex) =>
            el(
              "li",
              {},
              el(
                "button",
                {
                  class: "pb-example",
                  type: "button",
                  onclick: () => {
                    specBuildEls.input.value = ex;
                    specBuildEls.input.focus();
                  },
                },
                ex,
              ),
            ),
          ),
        ),
      ]),
    );
  }

  for (const turn of specBuildState.history) {
    if (turn.role === "user") {
      log.appendChild(el("div", { class: "pb-msg pb-user" }, turn.answer || turn.brief || ""));
    } else if (turn.role === "assistant" && turn.questions) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot" }, [
          el("div", { class: "pb-bot-label dim" }, "Clarifying questions"),
          el(
            "ul",
            { class: "pb-questions" },
            turn.questions.map((q) => el("li", {}, q)),
          ),
        ]),
      );
    } else if (turn.role === "assistant" && turn.error) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot pb-error-msg" }, [
          el("div", { class: "pb-bot-label" }, "Couldn't draft the spec"),
          el("div", {}, turn.error),
          el(
            "div",
            { class: "pb-error-hint dim" },
            'Edit your brief and try again, or press "Draft the spec".',
          ),
        ]),
      );
    }
  }

  if (specBuildState.draft) {
    log.appendChild(renderSpecDraft(specBuildState.draft));
  }

  if (specBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking" }, [
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
      ]),
    );
  }

  updateSpecBuildActions();
  log.scrollTop = log.scrollHeight;
}

/**
 * Composer state: the "Draft the spec" force button is always available so the
 * user is never stuck clarifying. Once a draft is on screen the chat's job is done
 * (edit/create takes over), so the whole composer is hidden.
 */
function updateSpecBuildActions() {
  if (!specBuildEls) return;
  const { forceBtn, form } = specBuildEls;
  const turns = specBuildState.history.filter((t) => t.role === "user").length;
  form.hidden = !!specBuildState.draft;
  if (specBuildState.draft) return;
  forceBtn.disabled = specBuildState.busy || turns === 0;
}

/**
 * Render the editable clause draft. Each clause is a kind chip (select) + editable
 * text + editable rationale, with a remove button; a footer allows adding a clause
 * and — once at least one clause exists — Create spec. After Create, the row swaps
 * to a Freeze action. All edits mutate the in-memory draft (the panel's UI state);
 * the persisted spec is only written on Create / Freeze.
 */
function renderSpecDraft(draft) {
  const clauses = draft.clauses || [];
  const created = specBuildState.createdSpec;
  const frozen = created && created.status === "frozen";
  const wrap = el("section", { class: "pb-proposal sb-draft", "aria-label": "Proposed spec" });

  wrap.appendChild(
    el("header", { class: "pb-proposal-head" }, [
      el("h3", { class: "pb-proposal-name" }, "Proposed spec"),
      el(
        "p",
        { class: "pb-proposal-aux" },
        `${frozen ? "Frozen: in the playbook" : created ? "Created as a draft spec" : "A draft: edit any clause"} · ${plural(clauses.length, "clause")}`,
      ),
    ]),
  );

  // Title field — required by create_spec; defaults to the brief. Editable until
  // the spec is created (immutable server-side after that).
  const titleInput = el("input", {
    class: "sb-title",
    type: "text",
    value: specBuildState.title || "",
    placeholder: "Spec title",
    "aria-label": "Spec title",
    maxlength: "300",
    disabled: created ? "" : undefined,
  });
  titleInput.addEventListener("input", () => {
    specBuildState.title = titleInput.value;
    updateSpecCreateEnabled();
  });
  wrap.appendChild(field("Title", titleInput, { class: "sb-title-field" }));

  // Target repo — which repo this spec is FOR. Sent as `target_repo` on Create so
  // the clauses the freeze seeds into Memory carry that repo tag; the delivery
  // primer searches lore per repo, so an untagged clause never reaches an agent.
  // Optional (an org-wide spec may span repos), locked once the spec is created.
  const repos = specBuildState.repos || [];
  const repoSel = el(
    "select",
    {
      class: "select sb-target-repo",
      "aria-label": "Target repo",
      disabled: created ? "" : undefined,
    },
    [
      el("option", { value: "" }, repos.length ? "No target repo (org-wide)" : "No repos known"),
      ...repos.map((r) =>
        el(
          "option",
          { value: r.name, selected: specBuildState.targetRepo === r.name ? "" : undefined },
          r.name,
        ),
      ),
    ],
  );
  if (created && created.target_repo && !repos.some((r) => r.name === created.target_repo)) {
    repoSel.appendChild(
      el("option", { value: created.target_repo, selected: "" }, created.target_repo),
    );
  }
  repoSel.addEventListener("change", () => {
    specBuildState.targetRepo = repoSel.value;
  });
  repoSel.title = "Tags the lore seeded at freeze so this repo's delivery agents see it.";
  wrap.appendChild(field("Target repo", repoSel, { class: "sb-target-repo-field" }));

  const list = el("ol", { class: "pb-tickets sb-clauses" });
  clauses.forEach((clause, i) => list.appendChild(renderSpecClauseRow(clause, i, !!created)));
  wrap.appendChild(list);

  if (!created) {
    wrap.appendChild(
      el("div", { class: "sb-add-row" }, [
        el(
          "button",
          {
            class: "btn sb-add",
            type: "button",
            onclick: () => {
              specBuildState.draft.clauses.push({ kind: "requirement", text: "", rationale: "" });
              renderSpecBuildLog();
            },
          },
          [icon("plus"), el("span", {}, "Add clause")],
        ),
      ]),
    );
  }

  // Persistent error slot (not just a toast) — mirrors pb-error-msg styling.
  if (specBuildState.actionError) {
    wrap.appendChild(
      el("div", { class: "pb-msg pb-bot pb-error-msg sb-action-error" }, [
        el("div", { class: "pb-bot-label" }, "Action failed"),
        el("div", {}, specBuildState.actionError),
      ]),
    );
  }

  const confirmRow = el("div", { class: "pb-confirm-row" });
  if (!created) {
    const createBtn = el(
      "button",
      {
        class: "btn primary sb-create",
        type: "button",
        onclick: () => createSpecFromDraft(),
      },
      [icon("check"), el("span", {}, "Create spec")],
    );
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        `${clauses.length} clause${clauses.length === 1 ? "" : "s"}, created as a draft spec you can freeze when ready.`,
      ),
    );
    confirmRow.appendChild(createBtn);
  } else if (!frozen) {
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        "Spec created as draft. Freeze to lock the clauses and seed product-intent lore.",
      ),
    );
    confirmRow.appendChild(
      el(
        "button",
        { class: "btn primary sb-freeze", type: "button", onclick: () => freezeCreatedSpec() },
        [icon("check"), el("span", {}, "Freeze spec")],
      ),
    );
  } else {
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        "Spec frozen: its clauses can no longer change. Plan a build from it, and each ticket carries the clauses it proves.",
      ),
    );
    confirmRow.appendChild(
      el(
        "button",
        { class: "btn primary sb-build", type: "button", onclick: () => buildFromFrozenSpec() },
        [icon("check"), el("span", {}, "Build the tickets from this spec")],
      ),
    );
  }
  wrap.appendChild(confirmRow);
  return wrap;
}

/** One editable clause row: kind chip + text + rationale + remove. */
function renderSpecClauseRow(clause, i, locked) {
  const kindSel = el(
    "select",
    {
      class: "select sb-kind",
      "aria-label": `Clause ${i + 1} kind`,
      disabled: locked ? "" : undefined,
    },
    SPEC_CLAUSE_KINDS.map((k) =>
      el("option", { value: k, selected: clause.kind === k ? "" : undefined }, k),
    ),
  );
  kindSel.addEventListener("change", () => {
    specBuildState.draft.clauses[i].kind = kindSel.value;
  });

  const textArea = el("textarea", {
    class: "pb-input sb-clause-text",
    rows: "2",
    value: clause.text || "",
    placeholder: "One testable statement…",
    "aria-label": `Clause ${i + 1} text`,
    disabled: locked ? "" : undefined,
  });
  textArea.value = clause.text || "";
  textArea.addEventListener("input", () => {
    specBuildState.draft.clauses[i].text = textArea.value;
    updateSpecCreateEnabled();
  });

  const rationaleInput = el("input", {
    class: "sb-clause-rationale",
    type: "text",
    value: clause.rationale || "",
    placeholder: "Rationale (optional)",
    "aria-label": `Clause ${i + 1} rationale`,
    disabled: locked ? "" : undefined,
  });
  rationaleInput.addEventListener("input", () => {
    specBuildState.draft.clauses[i].rationale = rationaleInput.value;
  });

  const top = el("div", { class: "pb-ticket-top sb-clause-top" }, [
    el("span", { class: "sb-clause-no tabnum", "aria-hidden": "true" }, String(i + 1)),
    kindSel,
    !locked
      ? el(
          "button",
          {
            class: "icon-btn sb-remove",
            type: "button",
            "aria-label": `Remove clause ${i + 1}`,
            onclick: () => {
              specBuildState.draft.clauses.splice(i, 1);
              renderSpecBuildLog();
            },
          },
          el("span", { html: "✕" }),
        )
      : null,
  ]);

  return el("li", { class: "pb-ticket sb-clause" }, [top, textArea, rationaleInput]);
}

/** Enable/disable the Create button live from title + at-least-one-non-empty-clause. */
function updateSpecCreateEnabled() {
  if (!specBuildEls) return;
  const btn = specBuildEls.panel.querySelector(".sb-create");
  if (!btn) return;
  const clauses = (specBuildState.draft && specBuildState.draft.clauses) || [];
  const ok =
    (specBuildState.title || "").trim().length > 0 && clauses.some((c) => (c.text || "").trim());
  btn.disabled = !ok || specBuildState.busy;
}

/**
 * Send the next spec-author turn. Mirrors submitPlanBuildTurn: append the user
 * message, POST /spec-build, fold the reply (clarify → questions; spec → editable
 * draft; error → persistent in-chat error + toast). `forcePlan` drafts the spec now.
 */
async function submitSpecBuildTurn(opts = {}) {
  const forcePlan = opts.forcePlan === true;
  const { input, sendBtn } = specBuildEls;
  const text = input.value.trim();
  if (specBuildState.busy) return;
  if (!forcePlan && !text) return;

  const isFirst = specBuildState.history.length === 0;
  if (forcePlan && isFirst && !text) {
    toast("Tell me what to build first, then I can draft the spec.");
    return;
  }

  if (text) {
    if (isFirst) {
      specBuildState.brief = text;
      // Seed a sensible default title from the brief (editable in the draft view).
      specBuildState.title = text.slice(0, 120);
    }
    specBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    input.value = "";
    input.style.height = "auto";
  }

  specBuildState.busy = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("is-running");
  sendBtn.setAttribute("aria-busy", "true");
  clear(sendBtn);
  sendBtn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  sendBtn.appendChild(el("span", { class: "pb-send-label" }, "Drafting…"));
  renderSpecBuildLog();

  let failure = null;
  try {
    const res = await api("POST", "/spec-build", {
      brief: specBuildState.brief,
      history: specBuildState.history
        .filter((t) => !(t.role === "assistant" && t.error))
        .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t)),
      ...(forcePlan ? { forcePlan: true } : {}),
    });
    if (res.phase === "clarify") {
      specBuildState.history.push({ role: "assistant", questions: res.questions || [] });
    } else if (res.phase === "spec") {
      const clauses = (res.spec && Array.isArray(res.spec.clauses) ? res.spec.clauses : []).map(
        (c) => ({
          clause_id: c.clause_id,
          kind: SPEC_CLAUSE_KINDS.includes(c.kind) ? c.kind : "requirement",
          text: c.text || "",
          rationale: c.rationale || "",
        }),
      );
      specBuildState.draft = { clauses };
    } else {
      failure = res.error || "The spec author returned no result.";
    }
  } catch (e) {
    failure = e && e.message ? e.message : "The request errored before a spec came back.";
  }

  specBuildState.busy = false;
  if (failure) {
    specBuildState.history.push({ role: "assistant", error: failure });
    toast(failure, { code: "SPEC_BUILD" });
  }
  sendBtn.disabled = false;
  sendBtn.classList.remove("is-running");
  sendBtn.removeAttribute("aria-busy");
  clear(sendBtn);
  sendBtn.appendChild(icon("send"));
  renderSpecBuildLog();
}

/** Human confirm → POST /specs. Clauses land as a draft spec, then Freeze appears. */
async function createSpecFromDraft() {
  if (!specBuildState || !specBuildState.draft || specBuildState.busy) return;
  const title = (specBuildState.title || "").trim();
  if (!title) {
    toast("Give the spec a title first.");
    return;
  }
  // Only send non-empty clauses; the server rejects blank text at its boundary.
  const clauses = specBuildState.draft.clauses
    .filter((c) => (c.text || "").trim())
    .map((c) => ({
      ...(c.clause_id ? { clause_id: c.clause_id } : {}),
      kind: c.kind,
      text: c.text.trim(),
      ...(c.rationale && c.rationale.trim() ? { rationale: c.rationale.trim() } : {}),
    }));
  if (clauses.length === 0) {
    toast("Add at least one clause with text before creating the spec.");
    return;
  }

  specBuildState.busy = true;
  specBuildState.actionError = null;
  renderSpecBuildLog();
  try {
    const res = await api("POST", "/specs", {
      title,
      ...(specBuildState.brief ? { brief: specBuildState.brief } : {}),
      clauses,
      // The repo this spec is for. The freeze tags every seeded clause with it so the
      // delivery primer's per-repo lore search surfaces the clauses to that repo's
      // agents; omitted (org-wide) when none was picked.
      ...(specBuildState.targetRepo ? { target_repo: specBuildState.targetRepo } : {}),
    });
    specBuildState.createdSpec = res.spec || null;
    // Reflect the server-assigned clause ids/order back into the editable draft.
    if (res.spec && Array.isArray(res.spec.clauses)) {
      specBuildState.draft = {
        clauses: res.spec.clauses.map((c) => ({
          clause_id: c.clause_id,
          kind: c.kind,
          text: c.text,
          rationale: c.rationale || "",
        })),
      };
    }
    toast("Spec created as a draft. Freeze it when it is ready.", { ok: true });
  } catch (e) {
    // Persistent error (rendered in the draft card), plus a toast for immediacy.
    specBuildState.actionError = e && e.message ? e.message : "Could not create the spec.";
    toast(specBuildState.actionError, { code: e && e.code });
  } finally {
    specBuildState.busy = false;
    renderSpecBuildLog();
  }
}

/** Freeze the created spec → immutable clauses + seeded product-intent lore. */
async function freezeCreatedSpec() {
  if (!specBuildState || !specBuildState.createdSpec || specBuildState.busy) return;
  const id = specBuildState.createdSpec.id;
  specBuildState.busy = true;
  specBuildState.actionError = null;
  renderSpecBuildLog();
  try {
    const res = await api("POST", `/specs/${id}/freeze`);
    specBuildState.createdSpec = res.spec || specBuildState.createdSpec;
    toast("Spec frozen: its clauses can no longer change.", { ok: true });
  } catch (e) {
    specBuildState.actionError = e && e.message ? e.message : "Could not freeze the spec.";
    toast(specBuildState.actionError, { code: e && e.code });
  } finally {
    specBuildState.busy = false;
    renderSpecBuildLog();
  }
}

/**
 * Hand a FROZEN spec off to the "Plan a build" decomposer. Its clauses ride along on the
 * plan-build POST so the decomposer satisfies each clause and stamps spec_clause_id
 * provenance on the ACs — the coverage/traceability read model depends on this. Closes the
 * spec panel and opens plan-build seeded with the clauses + a brief; the user then presses
 * "Build the tickets". Without this handoff the frozen spec never reaches decompose and the
 * Specs coverage view reads 0% for every spec even when the work fully delivers.
 */
function buildFromFrozenSpec() {
  const spec = specBuildState && specBuildState.createdSpec;
  if (!spec || spec.status !== "frozen") return;
  // The server's spec row carries its clauses as `clauses_json` (a string); only a
  // locally built object has a `clauses` array. Reading only the array made this
  // button do nothing at all on a real spec.
  let raw = spec.clauses;
  if (!Array.isArray(raw)) {
    try {
      raw = JSON.parse(spec.clauses_json || "[]");
    } catch {
      raw = [];
    }
  }
  const clauses = (Array.isArray(raw) ? raw : [])
    .filter((c) => c && c.clause_id && c.kind && c.text)
    .map((c) => ({
      clause_id: c.clause_id,
      kind: c.kind,
      text: c.text,
      ...(c.rationale ? { rationale: c.rationale } : {}),
    }));
  if (!clauses.length) return;
  const brief =
    (specBuildState && specBuildState.brief) ||
    spec.brief ||
    spec.title ||
    "Build from the frozen spec.";
  closeSpecBuild();
  // Carry the spec's target repo into the plan: the decomposer then takes the
  // existing-repo (brownfield) path for that repo instead of scaffolding a new one.
  openPlanBuild({ spec: clauses, brief, ...(spec.target_repo ? { repo: spec.target_repo } : {}) });
}

// --- View: Memory (Repo Digest · Feature ledger · Lore) ---------------------
//
// The unified control room reads the SEPARATE memory product (memory) through
// the Dispatch API's server-side read endpoints — ONE origin, one process. This
// view surfaces three read-only memory artefacts and never mutates anything:
//   • Repo Digest   — the repo's understanding (overview/structure/conventions/
//                     stack) with its freshness line + honesty caveat.
//   • Features      — the ledger split Shipped / Building / Backlog,
//                     filterable by scope node.
//   • Lore          — the team's recorded lore (read-only).
//
// Memory is OPTIONAL: each endpoint answers `{ available:false, reason }` when
// the memory store isn't configured/built, and this view renders a clean
// "memory unavailable" panel from that — it never errors the dashboard.

const FEATURE_GROUPS = [
  { status: "shipped", label: "Shipped", note: "Live in the repo." },
  { status: "building", label: "Building", note: "In flight right now." },
  { status: "backlog", label: "Backlog", note: "Proposed, not yet started." },
];

// Hash-driven so links + the router re-render cleanly:
//   #/memory                      → repo picker, nothing selected
//   #/memory/<repo>               → digest + features + lore for <repo>
//   #/memory/<repo>?node=<n>      → features narrowed to one scope node
const memoryState = { repo: "", node: "" };

function writeMemoryStateToUrl() {
  const repo = memoryState.repo;
  if (!repo) {
    navigate("#/memory");
    return;
  }
  const qs = memoryState.node ? `?node=${encodeURIComponent(memoryState.node)}` : "";
  navigate(`#/memory/${encodeURIComponent(repo)}${qs}`);
}

/** Render the structured "memory unavailable" panel from an unavailable result. */
function memoryUnavailable(reason) {
  return el("div", { class: "memory-unavailable", dataset: { state: "unavailable" } }, [
    el("p", { class: "es-title" }, "Memory unavailable"),
    el("p", { class: "es-sub" }, reason || "The memory product is not reachable right now."),
    el("p", { class: "section-note" }, [
      "The dashboard keeps working without it. Configure the memory CLI (",
      el("code", { class: "mono" }, "MEMORY_CLI_BIN"),
      " + ",
      el("code", { class: "mono" }, "MEMORY_DB"),
      ") on the Dispatch server to light these surfaces up.",
    ]),
  ]);
}

/**
 * "Onboard a repo" — POST /repos/onboard to scan a repo, register it in Dispatch,
 * and build its Memory digest + feature inventory (the data the Repo Digest +
 * Feature ledger below read). The endpoint spawns the configured DISPATCH_ONBOARD_CMD
 * detached, so the scan + digest build run async; we show an immediate running state
 * (via the shared runAsyncAction helper the other spawn buttons use), then re-read the
 * Memory view so the freshly-built digest + features surface. A NOT_CONFIGURED (no
 * DISPATCH_ONBOARD_CMD) toasts its message via the shared guard. `presetRepo` (when
 * given) pre-selects the repo so the digest empty-state can offer "onboard THIS repo".
 */
/**
 * Does Memory already hold a digest for this registered repo? true / false, or null when
 * it cannot say (memory unavailable, the read failed): the caller then asks first.
 */
async function repoHasDigest(name) {
  try {
    const res = await api("GET", `/api/memory/digest/${encodeURIComponent(name)}`);
    if (!res || res.available === false) return null;
    return !!res.digest;
  } catch {
    return null;
  }
}

/**
 * The "Onboard a repo" sheet: a registered repo (the select) OR a typed path. What the
 * person typed wins: typing a path resets the select, and picking a repo clears the
 * path. Onboarding a repo Memory already knows (it has a digest, or that cannot be
 * read) is a deliberate choice: a confirmation names the cost before anything runs.
 * `opts.onboarded` maps repo name → whether it has a digest, when the caller knows.
 */
function openOnboardPicker(repos, presetRepo, opts = {}) {
  const known = opts.onboarded || {};
  const repoSel = el("select", {}, [
    el("option", { value: "" }, repos.length ? "Pick a registered repo…" : "No registered repos"),
    ...repos.map((r) => el("option", { value: r.name, selected: presetRepo === r.name }, r.name)),
  ]);
  const pathInput = el("input", {
    type: "text",
    name: "onboard-path",
    placeholder: "/path/to/a/local/repo",
    autocomplete: "off",
    spellcheck: "false",
  });
  if (presetRepo) repoSel.value = presetRepo;
  pathInput.addEventListener("input", () => {
    if (pathInput.value.trim()) repoSel.value = "";
  });
  repoSel.addEventListener("change", () => {
    if (repoSel.value) pathInput.value = "";
  });

  const bare = (p) => String(p || "").replace(/\/+$/, "");
  const runBtn = el("button", { class: "btn primary", type: "submit" }, "Onboard");
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        // A typed path wins over the select; the endpoint resolves which kind it is.
        const typed = pathInput.value.trim();
        const target = typed || repoSel.value.trim();
        if (!target) {
          toast("Pick a registered repo or type a path to onboard.");
          return;
        }
        // A registered repo by name, or a typed path that is its checkout.
        const registered = repos.find(
          (r) => r.name === target || (typed && r.local_path && bare(r.local_path) === bare(typed)),
        );
        const go = async () => {
          await api("POST", "/repos/onboard", { repo: target });
          toast(`Onboarding '${target}' — its digest + features will appear shortly.`, {
            ok: true,
          });
          if (sheetOpen()) closeSheet();
          // Re-read the Memory view focused on the onboarded repo so the digest +
          // feature ledger refresh once the producer lands them.
          memoryState.repo = registered ? registered.name : memoryState.repo;
          memoryState.node = "";
          writeMemoryStateToUrl();
          router();
        };
        if (!registered) {
          runAsyncAction(runBtn, "Onboarding…", go);
          return;
        }
        runAsyncAction(runBtn, "Checking…", async () => {
          const name = registered.name;
          const has = name in known ? known[name] : await repoHasDigest(name);
          if (has === false) {
            await go();
            return;
          }
          confirmSheet({
            title: `Onboard ${name} again?`,
            intro:
              `${name} is ${has ? "already onboarded: Memory holds its digest and feature inventory" : "already registered, and Memory may already hold its digest"}, ` +
              "and refreshes them itself as agents deliver. Onboarding it again cards the whole repo once more: " +
              "several minutes and model calls for a larger repo, and a fresh onboarding intake decision on the Team Sheet.",
            confirm: `Re-onboard ${name}`,
            onConfirm: go,
          });
        });
      },
    },
    [
      el(
        "p",
        { class: "mode-note dim" },
        "Scans the repo, registers it in Dispatch, and builds its Memory digest + feature inventory.",
      ),
      el(
        "p",
        { class: "mode-note dim" },
        "Cards the whole repo — a sizeable one-off (several minutes + model calls for larger repos). " +
          "Memory then refreshes itself incrementally as agents deliver, so you don't need to re-run it.",
      ),
      field("Registered repo", repoSel),
      el("div", { class: "or-divider dim" }, "or"),
      field("Local path", pathInput),
      el("div", { class: "btn-row" }, [runBtn]),
    ],
  );

  openSheet("Onboard a repo", form);
}

/** The Memory view's "Onboard a repo" trigger (header + empty-state share it). */
function onboardButton(repos, presetRepo, opts) {
  const o = opts || {};
  const pickerOpts = o.onboarded ? { onboarded: o.onboarded } : {};
  const btn = el(
    "button",
    {
      class: o.primary ? "btn primary" : "btn",
      type: "button",
      title: "Scan a repo and build its Memory digest + feature inventory",
      onclick: () => openOnboardPicker(repos, presetRepo, pickerOpts),
    },
    [icon("plus"), el("span", {}, o.label || "Onboard a repo")],
  );
  return roLock(btn, "repo");
}

// --- Specs (Spec-Driven Development, Phase 3: coverage & traceability) -------

const SPEC_STATUS_LABEL = { draft: "Draft", frozen: "Frozen", superseded: "Superseded" };
const CLAUSE_KIND_LABEL = {
  requirement: "Requirement",
  "non-goal": "Non-goal",
  decision: "Decision",
};
const LORE_STATUS_LABEL = {
  active: "reaching agents",
  draft: "unratified",
  absent: "not seeded",
  unknown: "",
};

/** Count clauses on a spec row without throwing on a malformed clauses_json. */
function specClauseCount(spec) {
  try {
    const parsed = JSON.parse(spec.clauses_json || "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Specs view. Two surfaces on one route: a list of specs (#/specs) and, for a
 * given spec (#/specs/:id), the coverage TRACE — each clause → its covering ACs
 * (satisfied vs open), the coverage gaps (orphan clauses) called out, per-clause
 * bounce counts, and the seeded-lore ratification status. Modelled on renderEpics.
 */
async function renderSpecs(param) {
  const specId = param ? decodeURIComponent(param) : "";
  return specId ? renderSpecDetail(specId) : renderSpecList();
}

/** A spec's status: its mark + its word (a lock when frozen: the clauses cannot change). */
function specStatusMark(status) {
  const word = SPEC_STATUS_LABEL[status] || status || "—";
  const mark =
    status === "frozen"
      ? icon("lock", "spec-lock", 16)
      : glyph(status === "superseded" ? "cancelled" : "draft", 16);
  return el("span", { class: `spec-card-status status-${status}` }, [mark, el("span", {}, word)]);
}

/** How many of a clause's covering criteria are met, of how many. */
function clauseMet(c) {
  const acs = Array.isArray(c.covering_acs) ? c.covering_acs : [];
  return { met: acs.filter((ac) => ac.satisfied).length, of: acs.length };
}

/**
 * One clause's coverage state (the data-state hook). The server's `satisfied`
 * flag is true when ANY covering criterion is met, so the state is read from the
 * criteria themselves: satisfied only when every one is met, partly met when
 * some are, open when none are. A clause is proven only when all of it is.
 */
function clauseState(c) {
  if (c.orphan) return "orphan";
  const { met, of } = clauseMet(c);
  if (!of) return c.satisfied ? "satisfied" : "open";
  return met === of ? "satisfied" : met > 0 ? "partial" : "open";
}

/** Clause kinds that record intent rather than behaviour: no criterion is not a gap. */
const INTENT_KINDS = new Set(["non-goal", "decision"]);

/**
 * A spec not built yet: a draft, or a frozen spec with no campaign playing it and
 * no criterion naming any clause (the state between "Freeze spec" and "Plan a
 * build from it"). Its clauses read "not covered yet" everywhere (the squares,
 * the board line, the lede and the list), never as gaps: nothing has failed.
 */
function specUnbuilt(status, clauses, scopeNodeId) {
  if (status === "draft") return true;
  return !scopeNodeId && !(clauses || []).some((c) => c.covered);
}

/**
 * A gap is a clause that should be proven and is not: a requirement of a spec
 * whose build is under way with no criterion covering it. A spec not built yet
 * (specUnbuilt) has no gaps by design, and a non-goal or a decision with no
 * criterion is not a failure; those read quietly, never red.
 */
function clauseIsGap(c, status, unbuilt = false) {
  return !!c.orphan && !unbuilt && status !== "draft" && !INTENT_KINDS.has(c.kind);
}

/** How many of a coverage payload's clauses are gaps (see clauseIsGap). */
function specGapCount(coverage, status) {
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses) {
    const unbuilt = specUnbuilt(status, clauses, coverage.scope_node_id);
    return clauses.filter((c) => clauseIsGap(c, status, unbuilt)).length;
  }
  const r = specCoverageRollup(coverage);
  return r && status !== "draft" && (r.covered || coverage.scope_node_id) ? r.orphans : 0;
}

/**
 * The form guide: one square per clause, in the order written — filled when
 * every criterion is met, outlined with a filled corner when some are, outlined
 * when covered but none is met yet, red when it is a gap, dashed when it has no
 * criterion and is not a gap (a spec not built yet, a non-goal, a decision).
 * Decorative next to the sentence that states the same counts.
 */
function specFormGuide(clauses, status, scopeNodeId) {
  const unbuilt = specUnbuilt(status, clauses, scopeNodeId);
  return el(
    "span",
    { class: "spec-form", "aria-hidden": "true" },
    clauses.map((c, i) => {
      const state = clauseState(c);
      const cls =
        state === "orphan" ? (clauseIsGap(c, status, unbuilt) ? "orphan" : "none") : state;
      return el(
        "i",
        {
          class: `fg fg-${cls}`,
          title: `Clause ${i + 1} (${CLAUSE_KIND_LABEL[c.kind] || c.kind}): ${c.text}`,
        },
        String(i + 1),
      );
    }),
  );
}

/**
 * "6 of 8 covered · 1 satisfied · 2 partly met · 1 gap" — the counts the form
 * guide draws. Satisfied means every criterion on the clause is met.
 */
function specCoverageWords(r, gaps) {
  if (!r) return "Coverage unavailable";
  if (!r.total) return "No clauses yet";
  if (!r.covered)
    return gaps
      ? `Nothing covered: ${plural(gaps, "gap")}`
      : `Not covered yet: no criterion names ${r.total === 1 ? "it" : "them"}`;
  return [
    `${r.covered} of ${r.total} covered`,
    r.satisfied != null ? `${r.satisfied} satisfied` : null,
    r.partial ? `${r.partial} partly met` : null,
    gaps ? plural(gaps, "gap") : "no gaps",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function renderSpecList() {
  const signal = routeSignal();
  const res = await api("GET", "/specs", undefined, { signal });
  const specs = res.specs || [];

  const wrap = el("div", { class: "view view-specs", dataset: { view: "specs" } });
  const author = roLock(
    el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
      icon("spark"),
      el("span", {}, "Author a spec"),
    ]),
  );
  const by = (st) => specs.filter((s) => s.status === st).length;
  wrap.appendChild(
    viewHead(
      "The playbook",
      specs.length
        ? [
            plural(specs.length, "spec"),
            by("frozen") ? `${by("frozen")} frozen` : null,
            by("draft") ? `${by("draft")} draft` : null,
            by("superseded") ? `${by("superseded")} superseded` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "No specs written yet.",
      author,
    ),
  );

  if (specs.length === 0) {
    // What is on the pitch without a written play: the campaigns and live tickets,
    // so the empty page still says something true about this club.
    const [nodesRes, ticketsRes] = await Promise.all([
      api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
      allTickets("", { signal }).catch(() => ({ tickets: [] })),
    ]);
    const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
    const live = (ticketsRes.tickets || []).filter((t) => !TERMINAL.has(t.status));
    wrap.appendChild(
      el("section", { class: "card playbook-empty" }, [
        panelHead("No specs yet", null, null, { kit: "ink" }),
        el(
          "div",
          { class: "pb-steps", role: "list" },
          [
            ["1", "The brief", "Say what to build in a paragraph."],
            ["2", "The clauses", "Gaffer drafts testable clauses; you edit them."],
            ["3", "Frozen", "Each clause is traced to the acceptance criteria that prove it."],
          ].map(([n, h, t]) =>
            el("div", { class: "pb-step", role: "listitem" }, [
              el("span", { class: "pb-n", "aria-hidden": "true" }, n),
              el("h3", {}, h),
              el("p", {}, t),
            ]),
          ),
        ),
        el(
          "p",
          { class: "pb-now" },
          epics.length || live.length
            ? [
                `Playing without a written spec right now: ${plural(epics.length, "campaign")}${epics.length ? ` (${epics.map((e) => e.name).join(", ")})` : ""} and ${plural(live.length, "live ticket")}. `,
                el("a", { href: "#/epics" }, "See the season"),
                ".",
              ]
            : "Nothing is on the pitch yet: a spec is a good first play.",
        ),
        el("div", { class: "btn-row" }, [
          roLock(
            el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
              icon("spark"),
              el("span", {}, "Write the first play"),
            ]),
          ),
        ]),
      ]),
    );
    return wrap;
  }

  // Coverage per spec (best-effort: a failed read shows "Coverage unavailable" on
  // that row, never a broken page) and the campaign names the specs are played in.
  const [coverages, nodesRes] = await Promise.all([
    Promise.all(
      specs.map((s) =>
        api("GET", `/specs/${encodeURIComponent(s.id)}/coverage`, undefined, { signal })
          .then((r) => (r && r.coverage) || null)
          .catch(() => null),
      ),
    ),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const covById = new Map(specs.map((s, i) => [s.id, coverages[i]]));
  const nodeName = new Map(((nodesRes && nodesRes.nodes) || []).map((n) => [n.id, n.name]));

  // The newest spec (by when it was written, the order the server lists them in)
  // is marked: it is the one most likely in play.
  const stamp = (x) => Date.parse(x.created_at || x.updated_at || 0) || 0;
  const newestId = specs.slice().sort((a, b) => stamp(b) - stamp(a))[0]?.id;

  const list = el("div", { class: "spec-list", role: "list" });
  for (const spec of specs)
    list.appendChild(
      el(
        "div",
        { role: "listitem" },
        renderSpecCard(spec, {
          coverage: covById.get(spec.id),
          isPrimary: spec.id === newestId,
          campaign: spec.scope_node_id ? nodeName.get(spec.scope_node_id) : null,
        }),
      ),
    );
  wrap.appendChild(
    el("section", { class: "card prog spec-plays", "aria-labelledby": "spec-plays-h" }, [
      (() => {
        const h = panelHead("The plays", `${plural(specs.length, "spec")}, as written`, null, {
          kit: "claret",
        });
        h.querySelector(".panel-title").id = "spec-plays-h";
        return h;
      })(),
      list,
      el("p", { class: "spec-key" }, [
        ...[
          ["satisfied", "1", "satisfied: every criterion met"],
          ["partial", "2", "partly met: some criteria met"],
          ["open", "3", "covered, none met yet"],
          ["orphan", "4", "a gap: a requirement nothing covers while it is built"],
          [
            "none",
            "5",
            "no criterion yet, not a gap (a spec not built yet, a non-goal, a decision)",
          ],
        ].map(([cls, n, words]) =>
          el("span", { class: "spec-key-item" }, [
            el("span", { class: "spec-form", "aria-hidden": "true" }, [
              el("i", { class: `fg fg-${cls}` }, n),
            ]),
            el("span", {}, words),
          ]),
        ),
        el("span", {}, "Each square is a clause, in the order written."),
      ]),
    ]),
  );
  return wrap;
}

/**
 * A rollup {total,covered,satisfied,partial,orphans} from a coverage payload,
 * defensively read. Satisfied and partly met are counted from the clauses when
 * they are there (clauseState): the server's own `satisfied` counts a clause
 * with any criterion met, which is not the same as proven.
 */
function specCoverageRollup(coverage) {
  const src =
    coverage && coverage.rollup && typeof coverage.rollup === "object" ? coverage.rollup : null;
  if (!src) return null;
  const total = Number(src.total) || 0;
  const covered = Number(src.covered) || 0;
  const orphans = Array.isArray(src.orphans) ? src.orphans.length : Number(src.orphans) || 0;
  const clauses = Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses && clauses.length) {
    const states = clauses.map(clauseState);
    const n = (st) => states.filter((x) => x === st).length;
    return { total, covered, satisfied: n("satisfied"), partial: n("partial"), orphans };
  }
  const satisfied = src.satisfied != null ? Number(src.satisfied) || 0 : null;
  return { total, covered, satisfied, partial: 0, orphans };
}

/** One spec = one line of the playbook, linking to its clause-by-clause trace. */
function renderSpecCard(spec, { coverage, isPrimary = false, campaign = null } = {}) {
  const count = specClauseCount(spec);
  const rollup = specCoverageRollup(coverage);
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : [];
  const statusLabel = SPEC_STATUS_LABEL[spec.status] || spec.status;
  const gaps = coverage ? specGapCount(coverage, spec.status) : 0;
  const words = specCoverageWords(rollup, gaps);
  return el(
    "a",
    {
      class: `spec-card${isPrimary ? " spec-card--primary" : ""}${gaps ? " has-gaps" : ""}`,
      href: `#/specs/${encodeURIComponent(spec.id)}`,
      dataset: { specId: spec.id, status: spec.status },
      "aria-label": `${spec.title}: ${statusLabel}, ${plural(count, "clause")}, ${words}${campaign ? `, played in ${campaign}` : ""}`,
    },
    [
      el("span", { class: "spec-card-lead" }, [
        specStatusMark(spec.status),
        isPrimary ? el("span", { class: "spec-card-new" }, "newest") : null,
      ]),
      el("span", { class: "spec-card-body" }, [
        el("span", { class: "spec-card-title" }, spec.title),
        spec.brief ? el("span", { class: "spec-card-brief" }, spec.brief) : null,
        el("span", { class: "spec-card-meta" }, [
          el("span", {}, plural(count, "clause")),
          spec.target_repo ? repoTag(spec.target_repo, 16) : null,
          campaign ? el("span", {}, `Campaign: ${campaign}`) : null,
          spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
        ]),
      ]),
      el("span", { class: "spec-card-cov" }, [
        clauses.length ? specFormGuide(clauses, spec.status, coverage.scope_node_id) : null,
        el("span", { class: `spec-card-words${gaps ? " is-red" : ""}` }, words),
      ]),
    ],
  );
}

async function renderSpecDetail(specId) {
  const signal = routeSignal();
  const [res, specRes, nodesRes] = await Promise.all([
    api("GET", `/specs/${encodeURIComponent(specId)}/coverage`, undefined, { signal }),
    api("GET", `/specs/${encodeURIComponent(specId)}`, undefined, { signal }).catch(() => null),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const cov = res && res.coverage;
  // GET /specs/:id answers { spec }; tolerate a list-shaped answer too.
  const spec =
    (specRes && specRes.spec) ||
    ((specRes && specRes.specs) || []).find((s) => s.id === specId) ||
    null;

  const wrap = el("div", { class: "view view-spec", dataset: { view: "specs" } });
  const back = backLink("#/specs", "Back to the playbook");
  wrap.appendChild(back);

  // Defensive: a missing / empty / malformed coverage payload must render a
  // clean empty state, not blank the whole spec view.
  if (!cov || typeof cov !== "object") {
    wrap.appendChild(viewHead((spec && spec.title) || "Spec", "Coverage"));
    wrap.appendChild(
      emptyState(
        "Coverage unavailable",
        "This spec's coverage report could not be loaded. It may have been removed, or the report is still being built.",
        null,
        el("a", { class: "btn", href: "#/specs" }, "Back to the playbook"),
      ),
    );
    return wrap;
  }

  const clauses = Array.isArray(cov.clauses) ? cov.clauses : [];
  const r = specCoverageRollup(cov.rollup ? cov : { ...cov, rollup: {} });
  r.satisfied = r.satisfied || 0;
  const status = cov.status || (spec && spec.status) || "";
  const targetRepo = (spec && spec.target_repo) || cov.target_repo || null;
  const campaign = cov.scope_node_id
    ? ((nodesRes && nodesRes.nodes) || []).find((n) => n.id === cov.scope_node_id)
    : null;
  const brief = (spec && spec.brief) || cov.brief || null;

  // The lede: where the spec stands, from its coverage. A gap is a requirement
  // nothing proves while it is built (clauseIsGap); a spec not built yet (a draft,
  // or frozen with no campaign and nothing covering it) reads as one calm "not
  // covered yet" in the squares, the board, the lede and the list, never as red.
  const unbuilt = specUnbuilt(status, clauses, cov.scope_node_id);
  const gapClauses = clauses.filter((c) => clauseIsGap(c, status, unbuilt));
  const gapsN = gapClauses.length;
  const quietN = clauses.filter((c) => c.orphan && !clauseIsGap(c, status, unbuilt)).length;
  const uncovered = unbuilt && r.total > 0 && r.covered === 0;
  // "1 already satisfied and 2 partly met": satisfied means every criterion is met.
  const metWords =
    r.satisfied && r.partial
      ? `, ${r.satisfied} already satisfied and ${r.partial} partly met`
      : r.satisfied
        ? `, ${r.satisfied} already satisfied`
        : r.partial
          ? `, none fully proven yet: ${r.partial} partly met`
          : "";
  const quietOf = (k) => clauses.filter((c) => c.orphan && c.kind === k).length;
  const quietWords = [
    quietOf("non-goal") ? plural(quietOf("non-goal"), "non-goal") : null,
    quietOf("decision") ? plural(quietOf("decision"), "decision") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const total = plural(r.total, "clause");
  let lede;
  if (!r.total)
    lede = [el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `), "It has no clauses yet."];
  else if (uncovered)
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      // Not built yet: said the same way here, on the board, and in the list.
      status === "draft"
        ? `Not covered yet, and no gaps: freeze it to lock its ${total} and seed them as lore for the agents; the criteria that prove them come with the build you plan from it.`
        : status === "frozen"
          ? `Not covered yet, and no gaps until it is built: plan a build from it, and each ticket's criteria will name the ${r.total === 1 ? "clause it proves" : "clauses they prove"}.`
          : `None of its ${total} is covered.`,
    ];
  else
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      `${r.covered} of its ${total} ${r.covered === 1 ? "is" : "are"} covered by acceptance criteria${metWords}.`,
      gapsN
        ? [
            " ",
            el(
              "span",
              { class: "is-red" },
              `${gapsN === 1 ? "1 requirement has" : `${gapsN} requirements have`} no criterion, so nothing proves ${gapsN === 1 ? "it" : "them"} yet.`,
            ),
          ]
        : "",
      quietN
        ? status === "draft"
          ? ` ${quietN} ${quietN === 1 ? "is" : "are"} not covered yet.`
          : ` ${quietWords} ${quietN === 1 ? "has" : "have"} none, which is not counted as a gap.`
        : !gapsN
          ? " Every clause has a criterion."
          : "",
      status === "draft"
        ? " Freeze it to lock the clauses and seed them as lore for the agents."
        : "",
    ];

  const actions = [];
  if (cov.scope_node_id) {
    actions.push(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => navigate(`#/epics/${encodeURIComponent(cov.scope_node_id)}`),
        },
        [icon("epics"), el("span", {}, "Open campaign")],
      ),
    );
  }
  if (status === "draft") {
    actions.unshift(
      roLock(
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: (e) =>
              runAsyncAction(e.currentTarget, "Freezing…", async () => {
                await api("POST", `/specs/${encodeURIComponent(specId)}/freeze`);
                toast("Spec frozen: its clauses are locked and seeded as lore.", { ok: true });
                router();
              }),
          },
          [icon("lock", "", 18), el("span", {}, "Freeze spec")],
        ),
      ),
    );
  } else if (status === "frozen" && !cov.scope_node_id && clauses.length) {
    // A frozen spec with no campaign yet: build one from it, clause provenance and all.
    actions.unshift(
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            openPlanBuild({
              spec: clauses
                .filter((c) => c.clause_id && c.kind && c.text)
                .map((c) => ({
                  clause_id: c.clause_id,
                  kind: c.kind,
                  text: c.text,
                  ...(c.rationale ? { rationale: c.rationale } : {}),
                })),
              brief: brief || cov.title || "Build from the frozen spec.",
              ...(targetRepo ? { repo: targetRepo } : {}),
            }),
        },
        [icon("spark"), el("span", {}, "Plan a build from it")],
      ),
    );
    roLock(actions[0]);
  }

  wrap.appendChild(
    el("header", { class: "spec-head" }, [
      el("p", { class: "spec-meta" }, [
        specStatusMark(status),
        targetRepo ? repoTag(targetRepo, 20) : el("span", {}, "Every repo"),
        campaign
          ? el(
              "a",
              { href: `#/epics/${encodeURIComponent(campaign.id)}` },
              `Campaign: ${campaign.name}`,
            )
          : null,
        el("span", {}, plural(r.total, "clause")),
        spec && spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
      ]),
      el("h1", { class: "detail-title" }, cov.title || (spec && spec.title) || "Spec"),
      el("p", { class: "spec-lede" }, lede),
      brief ? el("p", { class: "spec-brief" }, [el("b", {}, "The brief: "), `“${brief}”`]) : null,
      actions.length ? el("div", { class: "btn-row" }, actions) : null,
    ]),
  );

  const indexOf = new Map(clauses.map((c, i) => [c.clause_id, i + 1]));
  // Coverage gaps: requirements nothing proves, called out first. Only when some
  // clauses are covered: a spec nothing covers yet says so once, on the board.
  if (gapsN > 0 && !uncovered) {
    wrap.appendChild(
      el(
        "section",
        {
          class: "card coverage-gaps",
          dataset: { count: String(gapsN) },
          "aria-label": "Coverage gaps",
        },
        [
          panelHead(
            `${gapsN} coverage gap${gapsN === 1 ? "" : "s"}`,
            `${gapsN === 1 ? "a requirement" : "requirements"} with no acceptance criterion covering ${gapsN === 1 ? "it" : "them"}`,
            null,
            { kit: "red" },
          ),
          el(
            "ul",
            { class: "coverage-gaps-list" },
            gapClauses.map((c) =>
              el("li", { dataset: { clauseId: c.clause_id } }, [
                el(
                  "a",
                  {
                    class: "sc-no",
                    href: `#clause-${indexOf.get(c.clause_id) || ""}`,
                    "aria-label": `Clause ${indexOf.get(c.clause_id) || ""}, in the trace below`,
                  },
                  String(indexOf.get(c.clause_id) || ""),
                ),
                el("span", { class: "cg-text" }, c.text),
              ]),
            ),
          ),
          el(
            "p",
            { class: "cg-hint" },
            "Cover a gap with an acceptance criterion that names the clause, on the ticket that delivers it.",
          ),
        ],
      ),
    );
  }

  // Lore and bounces are said once for the spec when every clause shares them,
  // and per clause only where they differ.
  const loreSet = new Set(clauses.map((c) => c.lore_status || "unknown"));
  const loreOnce = loreSet.size === 1 ? [...loreSet][0] : null;
  const anyBounce = clauses.some((c) => c.bounce_count > 0);
  const notes = [];
  const uncoveredNote = !uncovered
    ? null
    : el("p", { class: "spec-board-note spec-uncovered" }, [
        glyph("draft", 16),
        el(
          "span",
          {},
          `Not covered yet: none of the ${total} has an acceptance criterion naming it. That is not a gap until a build is under way.`,
        ),
      ]);
  if (loreOnce && loreOnce !== "unknown")
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        loreOnce === "active"
          ? "Lore: every clause is seeded and reaching the agents."
          : loreOnce === "draft"
            ? [
                "Lore: every clause is seeded as draft lore, unratified, so it is not reaching the agents yet. ",
                el("a", { href: "#/memory" }, "Ratify it in Memory"),
                ".",
              ]
            : `Lore: no clause is seeded yet.${status === "draft" ? " Freezing the spec seeds them." : ""}`,
      ),
    );
  if (anyBounce)
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        "Bounced: how many times work on the tickets covering a clause was sent back.",
      ),
    );

  // The trace: one row per clause → its covering ACs → satisfied / open.
  const opts = { status, uncovered, unbuilt, loreOnce };
  const trace = el(
    "ol",
    { class: "spec-trace" },
    clauses.map((c, i) => el("li", { id: `clause-${i + 1}` }, renderClauseTrace(c, i + 1, opts))),
  );
  wrap.appendChild(
    progPage(
      "spec-clauses",
      "ink",
      "The clauses",
      `${plural(clauses.length, "clause")}, in the order written`,
      [
        specFormGuide(clauses, status, cov.scope_node_id),
        uncoveredNote,
        trace,
        notes.length ? el("div", { class: "spec-board-notes" }, notes) : null,
      ],
    ),
  );

  if (cov.gate_enabled) {
    wrap.appendChild(
      el(
        "p",
        { class: "section-note" },
        "The spec-coverage gate is on (advisory): a clause with no met criterion is flagged at the Definition of Done.",
      ),
    );
  }
  return wrap;
}

/**
 * One clause's trace row: its number, kind and text, its state, and the criteria
 * that prove it. A gap is red; a clause with no criterion that is not a gap is
 * quiet; when nothing in the spec is covered yet the board says so once and the
 * rows carry no state of their own.
 */
function renderClauseTrace(
  clause,
  n,
  { status, uncovered = false, unbuilt = false, loreOnce = null } = {},
) {
  const state = clauseState(clause);
  const isGap = clauseIsGap(clause, status, unbuilt);
  const acs = Array.isArray(clause.covering_acs) ? clause.covering_acs : [];
  const { met } = clauseMet(clause);
  const block = el("div", {
    class: `spec-clause${isGap ? " is-gap" : ""}`,
    dataset: {
      clauseId: clause.clause_id,
      state,
      covered: String(clause.covered),
      orphan: String(clause.orphan),
      // Proven: every covering criterion met (the server's flag means "any").
      satisfied: String(state === "satisfied"),
      met: String(met),
    },
  });
  const ofMet = acs.length > 1 ? ` · ${met} of ${acs.length} met` : "";
  const stateMark =
    state === "orphan"
      ? uncovered
        ? null
        : isGap
          ? el("span", { class: "sc-state is-red" }, [
              glyph("failed", 16),
              el("span", {}, "Gap: nothing proves it"),
            ])
          : el("span", { class: "sc-state is-quiet" }, [
              glyph("draft", 16),
              el("span", {}, status === "draft" ? "Not covered yet" : "No criterion"),
            ])
      : state === "satisfied"
        ? el("span", { class: "sc-state is-ok" }, [
            glyph("done", 16),
            el("span", {}, acs.length > 1 ? `Satisfied · all ${acs.length} met` : "Satisfied"),
          ])
        : state === "partial"
          ? el("span", { class: "sc-state is-part" }, [
              glyph("in_progress", 16),
              el("span", {}, `Partly met · ${met} of ${acs.length}`),
            ])
          : el("span", { class: "sc-state" }, [glyph("ready", 16), el("span", {}, `Open${ofMet}`)]);

  const tags = el("div", { class: "spec-clause-tags" }, [stateMark]);
  if (clause.bounce_count > 0) {
    const b = badge(`bounced ${clause.bounce_count}×`, "clause-bounce");
    b.title = `Work covering this clause was sent back ${plural(clause.bounce_count, "time")}`;
    tags.appendChild(b);
  }
  if (!loreOnce && clause.lore_status && clause.lore_status !== "unknown") {
    const label = LORE_STATUS_LABEL[clause.lore_status] || clause.lore_status;
    tags.appendChild(
      badge(
        `lore: ${clause.lore_status}${label ? ` (${label})` : ""}`,
        `lore-${clause.lore_status === "active" ? "active" : "draft"}`,
      ),
    );
  }

  const main = el("div", { class: "spec-clause-main" }, [
    el("div", { class: "spec-clause-head" }, [
      badge(CLAUSE_KIND_LABEL[clause.kind] || clause.kind, `clause-kind kind-${clause.kind}`),
      el("span", { class: "spec-clause-text" }, clause.text),
    ]),
    clause.rationale ? el("p", { class: "spec-clause-rationale" }, clause.rationale) : null,
  ]);
  if (acs.length) {
    main.appendChild(
      el(
        "ul",
        { class: "spec-clause-acs" },
        acs.map((ac) =>
          el("li", { class: "spec-ac", dataset: { satisfied: String(ac.satisfied) } }, [
            glyph(ac.satisfied ? "done" : "ready", 14, ac.satisfied ? "satisfied" : ac.ac_status),
            el("span", { class: "spec-ac-text" }, ac.ac_text),
            // The ticket and its status are one unit: they never wrap apart.
            el("span", { class: "spec-ac-tk" }, [
              el(
                "a",
                {
                  class: "spec-ac-ticket",
                  href: `#/ticket/${encodeURIComponent(ac.ticket_id)}`,
                  title: ac.ticket_title || "",
                },
                ac.ticket_number != null ? `#${ac.ticket_number}` : ac.ticket_title,
              ),
              ac.ticket_status
                ? el("span", { class: "spec-ac-st" }, statusLabel(ac.ticket_status))
                : null,
            ]),
          ]),
        ),
      ),
    );
  }
  block.appendChild(el("span", { class: "sc-no", "aria-hidden": "true" }, String(n)));
  block.appendChild(main);
  block.appendChild(tags);
  return block;
}

async function renderMemory(param) {
  const { query } = parseHash();
  memoryState.repo = param ? decodeURIComponent(param) : "";
  memoryState.node = query.get("node") || "";
  const signal = routeSignal();

  // The repos, and every draft across the club in one read: the drafts say which
  // repo needs the gaffer (its tab carries a yellow card), and which repo to open
  // when the address names none (the one whose draft is newest).
  const [reposRes, draftsRes] = await Promise.all([
    api("GET", "/repositories", undefined, { signal }),
    api("GET", "/api/memory/lore?status=draft&limit=200", undefined, { signal }).catch(() => null),
  ]);
  const repos = reposRes.repositories || [];
  const allDrafts =
    draftsRes && draftsRes.available !== false && Array.isArray(draftsRes.lore)
      ? draftsRes.lore.filter((l) => l && l.status === "draft")
      : null;
  const draftsFor = (name) =>
    allDrafts ? allDrafts.filter((l) => (l.repos || []).includes(name)).length : 0;

  // With no repo in the address, open one (a blank page asks a question the
  // operator should not have to answer to read anything): the repo with the
  // newest draft (the server lists newest first), else the first repo.
  if (!memoryState.repo && repos.length) {
    const names = new Set(repos.map((r) => r.name));
    const withDraft = (allDrafts || []).flatMap((l) => l.repos || []).find((n) => names.has(n));
    memoryState.repo = withDraft || repos[0].name;
  }
  const repo = memoryState.repo;

  const [digestRes, featuresRes] = repo
    ? await Promise.all([
        api("GET", `/api/memory/digest/${encodeURIComponent(repo)}`, undefined, { signal }),
        api(
          "GET",
          `/api/memory/features/${encodeURIComponent(repo)}${memoryState.node ? `?node=${encodeURIComponent(memoryState.node)}` : ""}`,
          undefined,
          { signal },
        ),
      ])
    : [null, null];

  const clubDrafts = allDrafts ? allDrafts.length : null;
  // Whether the repo on show already has a digest, so the onboard sheet knows a
  // re-onboard without asking the server again (unknown when memory is off).
  const onboarded =
    repo && digestRes && digestRes.available !== false ? { [repo]: !!digestRes.digest } : null;
  const wrap = el("div", { class: "view view-memory", dataset: { view: "memory" } });
  wrap.appendChild(
    viewHead(
      "Club history",
      [
        plural(repos.length, "repo") + " on the books",
        clubDrafts == null
          ? null
          : clubDrafts
            ? `${plural(clubDrafts, "lore draft")} across the club ${clubDrafts === 1 ? "awaits" : "await"} your signature`
            : "no lore drafts waiting",
      ]
        .filter(Boolean)
        .join(" · "),
      onboardButton(repos, repo, { onboarded }),
    ),
  );

  // The squad of repos: one kit per repo, the one being read marked, a yellow
  // card on every repo whose lore drafts wait for you.
  if (repos.length > 1) {
    wrap.appendChild(
      el(
        "nav",
        { class: "mem-repos", "aria-label": "Repos" },
        repos.map((r) => {
          const n = draftsFor(r.name);
          return el(
            "a",
            {
              class: "mem-repo",
              href: `#/memory/${encodeURIComponent(r.name)}`,
              "aria-current": r.name === repo ? "page" : null,
              "aria-label": n ? `${r.name}, ${plural(n, "lore draft")} waiting` : null,
            },
            [
              kitShirt(r.name, 22),
              el("span", {}, r.name),
              n
                ? el("span", { class: "mem-repo-n" }, [ycard(14), el("span", {}, String(n))])
                : null,
            ],
          );
        }),
      ),
    );
  }

  // Repo picker for a phone (the kits fold away there) — drives the page.
  const repoSel = el(
    "select",
    {
      "aria-label": "Select a repo",
      onchange: (e) => {
        memoryState.repo = e.target.value;
        memoryState.node = "";
        writeMemoryStateToUrl();
      },
    },
    [
      el("option", { value: "" }, repos.length ? "Select a repo…" : "No repos known"),
      ...repos.map((r) =>
        el(
          "option",
          { value: r.name, selected: repo === r.name },
          draftsFor(r.name) ? `${r.name} (${plural(draftsFor(r.name), "draft")})` : r.name,
        ),
      ),
    ],
  );
  // On a phone the header's Onboard folds into this row (one line, not two), so
  // the first draft to sign sits above the fold.
  const pickOnboard = onboardButton(repos, repo, { label: "Onboard", onboarded });
  pickOnboard.classList.add("mem-pick-onboard");
  wrap.appendChild(
    el("div", { class: `filters mem-pick${repos.length > 1 ? "" : " is-solo"}` }, [
      field("Repo", repoSel),
      pickOnboard,
    ]),
  );

  if (repo) wrap.appendChild(memoryStats(repo, digestRes, featuresRes, allDrafts, draftsFor));

  // Lore first (the drafts are the one thing here that needs you), the report
  // and the honours board beside it. The lore card mounts into a slot so a
  // filter change re-fetches ONLY that card, not the whole view.
  const loreSlot = el("div", { class: "lore-slot" });
  const side = el("div", { class: "mem-side" });
  if (repo) {
    side.appendChild(renderDigestCard(repo, digestRes, repos));
    side.appendChild(renderFeatureLedger(repo, featuresRes));
  } else {
    side.appendChild(
      emptyState(
        "No repos on the books yet.",
        "Onboard one and its scouting report and honours board land here.",
        null,
        onboardButton(repos, "", { primary: true }),
      ),
    );
  }
  wrap.appendChild(el("div", { class: "mem-grid" }, [loreSlot, side]));
  const reload = () => remountMemory(param);
  await mountLoreCard(loreSlot, repos, reload);

  // Refresh without moving anything: an unchanged read keeps the DOM (and the
  // open folds, the focus and the scroll) as it is. The lore card re-reads on its
  // own (a filter or a page change) and then re-signs the view (mountLoreCard),
  // so the next refresh compares against what is on screen, not the first read.
  wrap._memSigBase = [repos.map((r) => r.name), allDrafts, digestRes, featuresRes];
  wrap.dataset.sig = memorySignature(wrap._memSigBase, loreSlot._res);
  return wrap;
}

/** The Memory view's data signature: the view's reads, the lore page and its filters. */
function memorySignature(base, loreRes) {
  return hashText(
    JSON.stringify([...base, loreRes || null, { ...loreFilter, foldOpen: undefined }, memoryState]),
  );
}

/**
 * The club's numbers for this repo, on the stadium board: drafts that wait
 * for you (lit yellow when any), the honours (features shipped of all), and the
 * date of the scouting report. Every figure is one the responses gave us.
 */
function memoryStats(repo, digestRes, featuresRes, allDrafts, draftsFor) {
  const drafts = allDrafts ? draftsFor(repo) : null;
  const elsewhere = allDrafts ? allDrafts.length - drafts : 0;
  const feats = featuresRes && featuresRes.available !== false ? featuresRes.features || [] : null;
  const by = (s) => (feats ? feats.filter((f) => f.status === s).length : 0);
  const digest = digestRes && digestRes.available !== false ? digestRes.digest : null;
  const meta = (digest && digest.meta) || {};
  return el(
    "div",
    { class: "kpi-row mem-stats", role: "group", "aria-label": `${repo} in numbers` },
    [
      statCell({
        label: "Drafts await you",
        value: drafts == null ? "—" : String(drafts),
        needs: !!drafts,
        href: "#lore",
        sub:
          drafts == null
            ? "lore unavailable"
            : elsewhere
              ? `${elsewhere} more waiting in other repos`
              : drafts
                ? "lore to approve or reject"
                : "nothing to sign",
      }),
      statCell({
        label: "Honours",
        value: feats ? String(by("shipped")) : "—",
        unit: feats && feats.length ? `of ${feats.length}` : null,
        sub: !feats
          ? "ledger unavailable"
          : feats.length
            ? `${by("building")} building · ${by("backlog")} in the backlog`
            : "no features recorded yet",
      }),
      statCell({
        label: "Scouting report",
        value: digest && meta.updatedAt ? fmtDay(meta.updatedAt, { weekday: false }) : "—",
        sub: digest
          ? `source: ${meta.source || "—"}`
          : digestRes && digestRes.available === false
            ? "memory unavailable"
            : "not scouted yet",
      }),
    ],
  );
}

/** Re-read the whole Memory view in place (after a ratification), keeping the scroll. */
async function remountMemory(param) {
  const gen = routeGen;
  const focusIdx = (() => {
    const rows = [...document.querySelectorAll(".lore-row[data-status='draft']")];
    const i = rows.findIndex((r) => r.contains(document.activeElement));
    return i;
  })();
  let content;
  try {
    content = await renderMemory(param);
  } catch (e) {
    if (e && e.code !== "ABORTED")
      toast(e.message || "Could not re-read Memory.", { code: e.code });
    return;
  }
  if (gen !== routeGen) {
    disposeView(content);
    return;
  }
  const se = document.scrollingElement || document.documentElement;
  const y = se.scrollTop;
  const restoreForms = carryOpenForms(app.firstElementChild, content);
  mountView(content);
  se.scrollTop = y;
  // A form still open (a reject the server refused keeps its reason) keeps the focus.
  if (restoreForms()) return;
  // Triage keeps its place: focus goes to the next draft's Approve (or the card).
  if (focusIdx >= 0) {
    const next = [...content.querySelectorAll(".lore-row[data-status='draft'] .lore-approve")];
    const target = next[Math.min(focusIdx, next.length - 1)] || content.querySelector("#lore");
    if (target) {
      if (!target.hasAttribute("tabindex") && target.id === "lore")
        target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  }
}

// Lore card filters. They persist across the live re-render (the SSE refresh
// re-runs renderMemory every few seconds, and a reviewer mid-queue must not lose
// their "drafts only" view); the repo filter follows the page's repo whenever
// that changes. `limit` is a page, not a cap — the pager walks `total`.
const LORE_STATUSES = ["draft", "active", "deprecated", "superseded"];
const LORE_KINDS = ["decision", "requirement", "non-goal", "convention", "gotcha", "other"];
const loreFilter = {
  status: "",
  kind: "",
  repo: "",
  q: "", // the search box over the page shown (kept across a refresh)
  pageRepo: null,
  offset: 0,
  limit: 50,
  foldOpen: false,
};

/** The lore read for the current filters: GET /api/memory/lore?repo&status&kind&limit&offset. */
function loreQueryPath() {
  const q = new URLSearchParams();
  if (loreFilter.repo) q.set("repo", loreFilter.repo);
  if (loreFilter.status) q.set("status", loreFilter.status);
  if (loreFilter.kind) q.set("kind", loreFilter.kind);
  q.set("limit", String(loreFilter.limit));
  if (loreFilter.offset > 0) q.set("offset", String(loreFilter.offset));
  return `/api/memory/lore?${q.toString()}`;
}

/** Fetch the current lore page and (re)render the card into `slot`. */
async function mountLoreCard(slot, repos, reload) {
  if (loreFilter.pageRepo !== memoryState.repo) {
    loreFilter.pageRepo = memoryState.repo;
    loreFilter.repo = memoryState.repo;
    loreFilter.offset = 0;
  }
  // Only the newest read lands: two quick filter changes must not let the older
  // answer paint over the newer one.
  const seq = (slot._seq = (slot._seq || 0) + 1);
  let res;
  try {
    res = await api("GET", loreQueryPath(), undefined, { signal: routeSignal() });
  } catch (e) {
    if (e && e.code === "ABORTED") throw e;
    res = { available: false, reason: e && e.message ? e.message : "The lore request failed." };
  }
  if (seq !== slot._seq) return;
  if (!slot.isConnected && slot.childNodes.length) return; // view was torn down mid-fetch
  slot._res = res;
  const card = renderLoreList(res, loreFilter.repo, {
    repos,
    refresh: () => mountLoreCard(slot, repos, reload),
    reload: reload || (() => mountLoreCard(slot, repos, reload)),
  });
  // The read can land after the operator opened a reject on the card it replaces
  // (a slow server): the open form moves over to its row in the new page.
  const restoreForms = carryOpenForms(slot.firstElementChild, card);
  clear(slot);
  slot.appendChild(card);
  restoreForms();
  // Re-sign the view: what is on screen is now this page under these filters.
  const view = slot.closest(".view-memory");
  if (view && view._memSigBase) view.dataset.sig = memorySignature(view._memSigBase, res);
}

/**
 * Ratify a draft from the dashboard: POST /api/memory/lore/:id/approve|reject. The
 * server calls the memory CLI (its write boundary); success re-reads the view so
 * the row shows its new state (or leaves a drafts-only filter) and the counts on
 * the tabs and the strip agree. A refused decision (already ratified elsewhere,
 * unknown id) surfaces as a toast, never a silent no-op.
 */
async function ratifyLore(l, action, refresh, btn, reason) {
  // Busy without the `disabled` attribute: the browser blurs a disabled button to
  // <body>, and keyboard triage would then lose its place (WCAG 2.4.3). aria-disabled
  // keeps focus on the row so the re-render can hand it to the next draft's Approve.
  const group = btn ? [...(btn.closest(".lore-actions")?.querySelectorAll("button") || [btn])] : [];
  if (btn && btn.getAttribute("aria-disabled") === "true") return;
  for (const b of group) b.setAttribute("aria-disabled", "true");
  if (btn) {
    btn.classList.add("is-busy");
    btn.setAttribute("aria-busy", "true");
  }
  try {
    await api(
      "POST",
      `/api/memory/lore/${encodeURIComponent(l.id)}/${action}`,
      action === "reject" ? (reason ? { reason } : {}) : undefined,
    );
    toast(
      action === "approve"
        ? `Approved "${l.title}" — active for delivery agents from the next tick.`
        : `Rejected "${l.title}".`,
      { ok: true },
    );
  } catch (e) {
    toast(e && e.message ? e.message : `Could not ${action} the draft.`, { code: e && e.code });
    for (const b of group) b.removeAttribute("aria-disabled");
    if (btn) {
      btn.classList.remove("is-busy");
      btn.removeAttribute("aria-busy");
    }
  }
  if (refresh) await refresh();
}

/** Ticket references in a provenance line ("merge:#5", "epic Repeat orders · #6") become links. */
function provenanceNodes(text) {
  const out = [];
  const re = /#(\d+)/g;
  let last = 0;
  let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(el("a", { href: `#/ticket/${m[1]}` }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/**
 * The scouting report (Repo Digest): the factory's read of a repo, set as a calm
 * document. The overview is the lede; structure, conventions and stack follow as
 * labelled paragraphs; the freshness line and the CLI's caveat close it.
 */
function renderDigestCard(repo, res, repos = []) {
  const card = el("section", {
    class: "card mem-page mem-report",
    dataset: { section: "digest" },
    "aria-label": "Scouting report",
  });
  card.appendChild(panelHead("Scouting report", `Repo Digest · ${repo}`, null, { kit: "claret" }));
  if (!res || res.available === false) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  const digest = res.digest;
  if (!digest) {
    // No digest yet — onboard this repo to populate it. The button POSTs to
    // /repos/onboard pre-targeting THIS repo, so it's a one-click action here.
    card.appendChild(
      emptyState(
        `No digest for ${repo} yet`,
        "Onboard this repo to scan it and build its Memory digest + feature inventory.",
        null,
        onboardButton(repos, repo, { onboarded: { [repo]: false } }),
      ),
    );
    return card;
  }
  const SECTIONS = [
    ["Overview", digest.overview],
    ["Structure", digest.structure],
    ["Conventions", digest.conventions],
    ["Stack", digest.stack],
  ];
  card.appendChild(
    el(
      "dl",
      { class: "scout" },
      SECTIONS.map(([label, body], i) =>
        el("div", { class: `scout-sec${i === 0 ? " scout-lede" : ""}` }, [
          el("dt", {}, label),
          el("dd", { class: body ? "" : "dim" }, body || "Not written yet."),
        ]),
      ),
    ),
  );
  // Freshness line ("updated_at · source") — the load-bearing provenance.
  const meta = digest.meta || {};
  card.appendChild(
    el("p", { class: "digest-fresh" }, [
      icon("clock", "fresh-ico", 16),
      el("span", {}, `updated ${fmtTime(meta.updatedAt)}`),
      el("span", { "aria-hidden": "true" }, "·"),
      el("span", {}, `source: ${meta.source || "—"}`),
    ]),
  );
  // The honesty caveat — surfaced verbatim so nobody over-trusts the summary.
  if (digest.caveat) card.appendChild(el("p", { class: "digest-caveat" }, digest.caveat));
  return card;
}

/**
 * The honours board (Feature ledger): what has shipped, what is building and what
 * waits in the backlog, one mown band per stage, each feature grouped under its
 * scope node and linked to the ticket its provenance names.
 */
function renderFeatureLedger(repo, res) {
  const ok = res && res.available !== false;
  const features = ok ? res.features || [] : [];
  const card = el("section", {
    class: "card mem-page mem-honours",
    dataset: { section: "features" },
    "aria-label": "Honours board",
  });
  card.appendChild(
    panelHead(
      ["Honours board", ok ? el("span", { class: "count" }, String(features.length)) : null],
      `Feature ledger · ${repo}`,
      null,
      { kit: "sky" },
    ),
  );
  if (!ok) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }

  // Scope-node filter — group/filter by `scope_node`. Built from the features
  // actually present so the options reflect reality.
  const nodes = Array.from(new Set(features.map((f) => f.scopeNode).filter(Boolean))).sort();
  if (nodes.length || memoryState.node) {
    const nodeSel = el(
      "select",
      {
        "aria-label": "Filter features by scope node",
        onchange: (e) => {
          memoryState.node = e.target.value;
          writeMemoryStateToUrl();
        },
      },
      [
        el("option", { value: "" }, "All scope nodes"),
        ...nodes.map((n) => el("option", { value: n, selected: memoryState.node === n }, `@${n}`)),
      ],
    );
    card.appendChild(el("div", { class: "filters mem-node" }, [field("Scope node", nodeSel)]));
  }

  if (features.length === 0) {
    card.appendChild(
      emptyState(
        `No features recorded for ${repo}${memoryState.node ? ` @${memoryState.node}` : ""}`,
        "The merge pipeline ships features into this ledger as work lands.",
      ),
    );
    return card;
  }

  // Shipped / Building / Backlog, each grouped by scope node.
  const lanes = el("div", { class: "ledger" });
  for (const group of FEATURE_GROUPS) {
    const inGroup = features.filter((f) => f.status === group.status);
    const lane = el("div", { class: "ledger-lane", dataset: { status: group.status } }, [
      el("div", { class: "ledger-head" }, [
        el("span", { class: "ledger-n tabnum" }, String(inGroup.length)),
        el("span", { class: "ledger-label" }, group.label),
        el("span", { class: "ledger-note" }, group.note),
      ]),
    ]);
    const list = el("div", { class: "ledger-list" });
    if (inGroup.length === 0) {
      list.appendChild(el("p", { class: "ledger-empty" }, "Nothing here."));
    } else {
      const byNode = new Map();
      for (const f of inGroup) {
        const key = f.scopeNode || "";
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key).push(f);
      }
      for (const [node, items] of byNode) {
        if (node) list.appendChild(el("div", { class: "ledger-node" }, `@${node}`));
        for (const f of items) list.appendChild(renderFeatureCard(f));
      }
    }
    lane.appendChild(list);
    lanes.appendChild(lane);
  }
  card.appendChild(lanes);
  return card;
}

function renderFeatureCard(f) {
  return el("div", { class: "feature-card", dataset: { status: f.status } }, [
    el("div", { class: "feature-top" }, [
      el("span", { class: "feature-name" }, f.name),
      f.area ? el("span", { class: "feature-area" }, f.area) : null,
    ]),
    f.summary ? el("p", { class: "feature-summary" }, f.summary) : null,
    f.provenance
      ? el("p", { class: "feature-prov" }, [
          icon("link", "prov-ico", 14),
          el("span", {}, provenanceNodes(f.provenance)),
        ])
      : null,
  ]);
}

/** Lore groups on a page, in the order the gaffer works them. */
const LORE_GROUPS = [
  { id: "draft", label: "Awaiting your signature", statuses: ["draft"] },
  { id: "active", label: "On the record", statuses: ["active"] },
  { id: "retired", label: "Retired", statuses: ["deprecated", "superseded"] },
];

/**
 * The Lore card: a repo / status / kind filter row, the current page of records
 * (the SERVER filters and pages — `total` is the true count) grouped drafts
 * first, approve / reject on every draft, and a pager. `repo` is the lore-card
 * repo filter (tagged records only; "All repos" shows everything, org-wide lore
 * included).
 */
function renderLoreList(res, repo, opts = {}) {
  const lore = (res && res.lore) || [];
  const refresh = opts.refresh || null;
  const reload = opts.reload || refresh;
  const ok = !!res && res.available !== false;
  const total = res && typeof res.total === "number" ? res.total : lore.length;
  const flaggedCount = lore.filter((l) => l && l.flagged).length;
  const draftCount = lore.filter((l) => l && l.status === "draft").length;
  const card = el("section", {
    class: "card mem-page mem-lore",
    id: "lore",
    dataset: { section: "lore" },
    "aria-label": "Club lore",
  });
  card.appendChild(
    panelHead(
      ["Club lore", ok ? el("span", { class: "count" }, String(total)) : null],
      ok
        ? [
            // Ratification queue at a glance: drafts on this page awaiting a decision.
            draftCount > 0 ? badge(plural(draftCount, "draft"), "lore-draft") : null,
            // Learn-loop signal: how many conventions the loop flagged for review.
            flaggedCount > 0 ? badge(`${flaggedCount} flagged`, "lore-flagged") : null,
            draftCount || flaggedCount ? null : "what the club has learned",
          ]
        : null,
      null,
      { kit: "ink" },
    ),
  );

  const loreNote = el(
    "p",
    { class: "section-note lore-note" },
    `${repo ? `Lore tagged ${repo}.` : "Lore across every repo, the club's own included."} Approve a draft and delivery agents read it from the next tick; \`gaffer lore review\` does the same from a terminal.`,
  );

  // Filter row — each change re-fetches from the first page.
  const onFilter = (patch) => {
    Object.assign(loreFilter, patch, { offset: 0 });
    if (refresh) refresh();
  };
  const repoSel = el(
    "select",
    { class: "select lore-filter-repo", "aria-label": "Lore repo filter" },
    [
      el("option", { value: "", selected: !repo ? "" : undefined }, "All repos"),
      ...(opts.repos || []).map((r) =>
        el("option", { value: r.name, selected: repo === r.name ? "" : undefined }, r.name),
      ),
    ],
  );
  if (repo && !(opts.repos || []).some((r) => r.name === repo)) {
    repoSel.appendChild(el("option", { value: repo, selected: "" }, repo));
  }
  repoSel.addEventListener("change", () => onFilter({ repo: repoSel.value }));
  const statusSel = el(
    "select",
    { class: "select lore-filter-status", "aria-label": "Lore status filter" },
    [
      el("option", { value: "" }, "Any status"),
      ...LORE_STATUSES.map((s) =>
        el(
          "option",
          { value: s, selected: loreFilter.status === s ? "" : undefined },
          s === "draft" ? "draft — awaiting ratification" : s,
        ),
      ),
    ],
  );
  statusSel.addEventListener("change", () => onFilter({ status: statusSel.value }));
  const kindSel = el(
    "select",
    { class: "select lore-filter-kind", "aria-label": "Lore kind filter" },
    [
      el("option", { value: "" }, "Any kind"),
      ...LORE_KINDS.map((k) =>
        el("option", { value: k, selected: loreFilter.kind === k ? "" : undefined }, k),
      ),
    ],
  );
  kindSel.addEventListener("change", () => onFilter({ kind: kindSel.value }));
  // The filters fold behind one line on a phone (the repo filter follows the
  // page's repo anyway), so "Awaiting your signature" and the first Approve are on
  // screen at load; on a desk they stay open and the summary line is hidden. The
  // fold remembers being opened across the live re-render.
  const narrow =
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const setBits = [
    loreFilter.repo !== (memoryState.repo || "")
      ? loreFilter.repo
        ? loreFilter.repo
        : "all repos"
      : null,
    loreFilter.status ? (loreFilter.status === "draft" ? "drafts" : loreFilter.status) : null,
    loreFilter.kind || null,
  ].filter(Boolean);
  const fold = el(
    "details",
    { class: "lore-fold", open: !narrow || loreFilter.foldOpen ? "" : undefined },
    [
      el("summary", { class: "lore-fold-sum" }, [
        el("span", { class: "lore-fold-label" }, "Filter"),
        el(
          "span",
          { class: "lore-fold-set" },
          setBits.length ? setBits.join(" · ") : `${repo || "all repos"} · all lore`,
        ),
      ]),
      el("div", { class: "filters lore-filters" }, [
        field("Repo", repoSel),
        field("Status", statusSel),
        field("Kind", kindSel),
      ]),
    ],
  );
  fold.addEventListener("toggle", () => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches)
      loreFilter.foldOpen = fold.open;
  });
  card.appendChild(fold);

  if (!ok) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  if (lore.length === 0) {
    card.appendChild(
      emptyState(
        loreFilter.status === "draft"
          ? repo
            ? `No drafts awaiting review for ${repo}`
            : "No drafts awaiting review"
          : repo
            ? `No lore tagged ${repo} yet`
            : "No lore recorded yet",
        loreFilter.status === "draft"
          ? "Agents, onboarding and the distiller file drafts here; approving one makes it active for delivery agents."
          : "Lore captures the conventions and decisions agents should respect.",
      ),
    );
    card.appendChild(loreNote);
    return card;
  }

  let firstDraft = true;
  const row = (l) => {
    const isDraft = l.status === "draft" && l.id;
    const actions = isDraft
      ? (() => {
          // One sign-off per view: the first draft's Approve is the primary.
          const approve = el(
            "button",
            {
              class: `btn ${firstDraft ? "primary " : ""}small lore-approve`,
              type: "button",
              "aria-label": `Approve “${l.title}”`,
            },
            [icon("check"), el("span", {}, "Approve")],
          );
          firstDraft = false;
          approve.addEventListener("click", () => ratifyLore(l, "approve", reload, approve));
          const reject = el(
            "button",
            { class: "btn small lore-reject", type: "button", "aria-label": `Reject “${l.title}”` },
            "Reject",
          );
          roLock(approve);
          roLock(reject);
          // Keyed by the draft's id, so an open reject survives a re-render (carryOpenForms).
          const actionsEl = el(
            "div",
            { class: "lore-actions", dataset: { keepKey: `lore:${l.id}` } },
            [approve, reject],
          );
          // Reject asks for an optional reason in place (the memory CLI recommends
          // one: the agent that filed the draft reads it). Enter rejects, with or
          // without words; Escape puts the buttons back.
          reject.addEventListener("click", () => {
            const why = el("input", {
              type: "text",
              class: "lore-reason",
              maxlength: "2000",
              placeholder: "Why? Optional; the agent reads it",
              "aria-label": `Reason for rejecting “${l.title}” (optional)`,
            });
            const confirm = el(
              "button",
              { class: "btn small danger lore-reject-confirm", type: "submit" },
              "Reject",
            );
            const cancel = el("button", { class: "btn small quiet", type: "button" }, "Cancel");
            const form = el("form", { class: "lore-reject-form" }, [
              why,
              el("div", { class: "lore-reject-btns" }, [confirm, cancel]),
            ]);
            const close = () => {
              delete actionsEl.dataset.keepOpen;
              actionsEl.replaceChildren(approve, reject);
              reject.focus();
            };
            cancel.addEventListener("click", close);
            form.addEventListener("keydown", (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            });
            form.addEventListener("submit", (e) => {
              e.preventDefault();
              // Focus rides on the confirm button so the re-render can hand it on.
              confirm.focus();
              why.readOnly = true;
              ratifyLore(l, "reject", reload, confirm, why.value.trim()).finally(() => {
                why.readOnly = false; // a refused reject leaves the reason editable
              });
            });
            actionsEl.replaceChildren(form);
            actionsEl.dataset.keepOpen = "1";
            why.focus();
          });
          return actionsEl;
        })()
      : null;
    return el(
      "article",
      {
        class: `lore-row${l.flagged ? " is-flagged" : ""}`,
        dataset: { loreId: l.id || "", status: l.status || "" },
      },
      [
        el("div", { class: "lore-mark" }, [
          isDraft || l.flagged ? ycard(26, "lore-card") : null,
          l.kind ? el("span", { class: "lore-kind" }, l.kind) : null,
        ]),
        el("div", { class: "lore-body" }, [
          el("div", { class: "lore-head" }, [
            el("h4", { class: "lore-title" }, l.title),
            // The group already says draft / on the record; retired rows name their state.
            l.status && !["active", "draft"].includes(l.status)
              ? badge(l.status, `lore-${l.status}`)
              : null,
            l.stale ? badge("stale", "lore-stale") : null,
            // Learn-loop signal: this convention was served into a ticket that then
            // reworked/blocked. Badge it so the operator can spot conventions dragging
            // delivery down and curate them (an active record: the memory CLI's lifecycle verbs).
            l.flagged ? badge("flagged", "lore-flagged") : null,
          ]),
          l.summary ? el("p", { class: "lore-summary" }, l.summary) : null,
          el("div", { class: "lore-meta" }, [
            ...(l.repos || []).map((r) => repoTag(r, 16)),
            ...(l.tags || []).map((t) => el("span", { class: "tag-chip" }, t)),
            l.confidence ? el("span", { class: "lore-conf" }, `${l.confidence} confidence`) : null,
            l.source ? el("span", { class: "lore-src" }, l.source) : null,
          ]),
          l.flagged
            ? el(
                "p",
                { class: "lore-flag-hint" },
                `Served into a ticket that was then reworked or blocked: read it with \`gaffer lore show ${l.id}\`, then deprecate or update it with the memory CLI.`,
              )
            : null,
          l.id ? loreHistory(l) : null,
        ]),
        // Ratification: only a DRAFT can be approved or rejected (an active record is
        // deprecated/superseded through the CLI's lifecycle verbs, not from here).
        actions,
      ],
    );
  };
  const list = el("div", { class: "lore-list" });
  // The search box narrows the rows shown in place (what each row says: title,
  // summary, kind, repos, tags, source); every word must match.
  const searchText = new Map();
  const rowOf = (l) => {
    const node = row(l);
    searchText.set(
      node,
      [l.title, l.summary, l.kind, l.source, ...(l.repos || []), ...(l.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    );
    return node;
  };
  for (const g of LORE_GROUPS) {
    const items = lore.filter((l) => g.statuses.includes(l.status));
    if (!items.length) continue;
    list.appendChild(
      el("h3", { class: `lore-group lore-group-${g.id}` }, [
        g.label,
        el("span", { class: "count" }, String(items.length)),
      ]),
    );
    for (const l of items) list.appendChild(rowOf(l));
  }
  const other = lore.filter((l) => !LORE_GROUPS.some((g) => g.statuses.includes(l.status)));
  if (other.length) {
    list.appendChild(
      el("h3", { class: "lore-group" }, [
        "Other",
        el("span", { class: "count" }, String(other.length)),
      ]),
    );
    for (const l of other) list.appendChild(rowOf(l));
  }
  card.appendChild(loreSearch(list, searchText, lore.length, total));
  card.appendChild(list);
  card.appendChild(loreNote);

  // Pager — the server pages; show where this page sits in `total`.
  const from = loreFilter.offset + 1;
  const to = loreFilter.offset + lore.length;
  if (total > lore.length || loreFilter.offset > 0) {
    const page = (delta) => {
      loreFilter.offset = Math.max(0, loreFilter.offset + delta);
      if (refresh) refresh();
    };
    card.appendChild(
      el("div", { class: "lore-pager" }, [
        el("span", { class: "tabnum" }, `Showing ${from}–${to} of ${total}`),
        el(
          "button",
          {
            class: "btn small lore-prev",
            type: "button",
            disabled: loreFilter.offset === 0 ? "" : undefined,
            onclick: () => page(-loreFilter.limit),
          },
          "Previous",
        ),
        el(
          "button",
          {
            class: "btn small lore-next",
            type: "button",
            disabled: to >= total ? "" : undefined,
            onclick: () => page(loreFilter.limit),
          },
          "Next",
        ),
      ]),
    );
  }
  return card;
}

/**
 * The search box over the lore rows shown: every word must appear in a row (title,
 * summary, kind, repos, tags, source). It narrows in place, hides a group heading
 * left with no row, and says how many match; when the store holds more than this
 * page it says the search covers this page, which the filters above narrow.
 */
function loreSearch(list, searchText, shown, total) {
  const input = el("input", {
    type: "search",
    class: "lore-search-input",
    value: loreFilter.q,
    autocomplete: "off",
    placeholder: "Words in a title, summary, tag or repo",
  });
  const count = el("p", { class: "lore-search-count dim", role: "status" });
  const apply = () => {
    loreFilter.q = input.value;
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let hits = 0;
    let heading = null;
    let headingHits = 0;
    const closeHeading = () => {
      if (heading) heading.hidden = words.length > 0 && headingHits === 0;
    };
    for (const node of list.children) {
      if (node.tagName === "H3") {
        closeHeading();
        heading = node;
        headingHits = 0;
        continue;
      }
      const text = searchText.get(node) || "";
      const match = words.every((w) => text.includes(w));
      node.hidden = !match;
      if (match) {
        hits += 1;
        headingHits += 1;
      }
    }
    closeHeading();
    count.textContent = words.length
      ? `${hits} of the ${plural(shown, "record")} shown ${hits === 1 ? "matches" : "match"}${total > shown ? ` (the store holds ${total}: the filters above reach the rest)` : ""}.`
      : "";
    count.hidden = !words.length;
  };
  input.addEventListener("input", apply);
  apply();
  return el("div", { class: "lore-search" }, [field("Search lore", input), count]);
}

/**
 * A lore row's History: every earlier version of the record (each update snapshots
 * the one before), newest first, read on first open from
 * GET /api/memory/lore/:id/history. Read-only: it changes nothing. Which rows are
 * open, and what they read, outlive a live refresh of the Memory view: an open
 * History is never folded away (or read again) under the reader.
 */
const loreHistoryOpen = new Set();
const loreHistoryRead = new Map(); // lore id → the pending or settled read
function loreHistory(l) {
  const body = el("div", { class: "lore-history-body" });
  const box = el("details", { class: "lore-history" }, [el("summary", {}, "History"), body]);
  const line = (v, current) =>
    el("li", { class: `lore-version${current ? " is-current" : ""}` }, [
      el("p", { class: "lv-head" }, [
        el("b", { class: "tabnum" }, `v${v.version}`),
        ` · ${current ? "current" : v.status} · `,
        el("time", { datetime: v.at }, v.at ? fmtDay(v.at) : "undated"),
      ]),
      v.title && v.title !== l.title ? el("p", { class: "lv-title" }, v.title) : null,
      v.summary ? el("p", { class: "lv-summary" }, v.summary) : null,
    ]);
  const load = async () => {
    let read = loreHistoryRead.get(l.id);
    if (!read) {
      body.replaceChildren(el("p", { class: "dim" }, "Reading the history…"));
      read = api("GET", `/api/memory/lore/${encodeURIComponent(l.id)}/history`).catch((e) => ({
        available: false,
        reason: (e && e.message) || "the request failed",
      }));
      loreHistoryRead.set(l.id, read);
    }
    const h = await read;
    if (!h || !h.available) {
      loreHistoryRead.delete(l.id); // let a later open try again
      body.replaceChildren(
        el("p", { class: "dim" }, `History unavailable: ${(h && h.reason) || "no answer"}.`),
      );
      return;
    }
    body.replaceChildren(
      h.versions.length
        ? el(
            "ol",
            { class: "lore-versions", "aria-label": `Versions of “${l.title}”, newest first` },
            [line(h.current, true), ...h.versions.map((v) => line(v, false))],
          )
        : el("p", { class: "dim" }, "No earlier versions: this record has not been edited."),
    );
  };
  box.addEventListener("toggle", () => {
    if (box.open) {
      loreHistoryOpen.add(l.id);
      void load();
    } else loreHistoryOpen.delete(l.id);
  });
  if (loreHistoryOpen.has(l.id)) {
    box.open = true;
    void load();
  }
  return box;
}

// ===========================================================================
//  The club and the squad: "Name your club" (the crest) and #/squad
// ===========================================================================

/** The crest letters the server would derive: initials of up to 4 words, or 3 letters. */
function deriveShortName(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "GAF";
  if (words.length === 1) return [...words[0]].slice(0, 3).join("").toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => [...w][0])
    .join("")
    .toUpperCase();
}
/** The house kit's two colours as #rrggbb (the colour pickers' starting point). */
function houseColours() {
  const read = (token, fallback) => {
    const v = readHouseKit()[token];
    if (!v || typeof window.getComputedStyle !== "function") return rgbHex(fallback);
    const probe = el("span", { hidden: "" });
    probe.style.color = v;
    document.body.appendChild(probe);
    const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(window.getComputedStyle(probe).color || "");
    probe.remove();
    return m ? rgbHex([+m[1], +m[2], +m[3]]) : rgbHex(fallback);
  };
  return { primary: read("--claret", RGB_HOUSE_CLARET), secondary: read("--sky", RGB_HOUSE_SKY) };
}
/** Redraw the view on screen after a name or the club changed (its signature may not have). */
function redrawForSquad() {
  const cur = app.firstElementChild;
  if (cur && cur.dataset) delete cur.dataset.sig;
  refreshCurrentView();
}

/**
 * "Name your club": the club's name, the crest's short name (1–4 characters) and
 * the two kit colours, with a live preview of the header crest and a shirt. Save
 * PATCHes /api/club; a refusal (422) is shown under the form, never toasted. Only
 * a full token opens it (the crest is a plain badge for a read token).
 */
function openClubSheet() {
  if (!canEditSquad()) return;
  const club = squad.club || {};
  const house = houseColours();
  const dirty = { primary: false, secondary: false, cleared: false };
  const hintId = `club-hint-${++appState.fieldSeq}`;
  const nameIn = el("input", {
    type: "text",
    name: "club_name",
    class: "club-name-in",
    maxlength: "60",
    value: club.name || "",
    placeholder: "Gaffer",
    autocomplete: "off",
  });
  const shortIn = el("input", {
    type: "text",
    name: "short_name",
    class: "club-short-in",
    maxlength: "4",
    value: club.short_name || "",
    placeholder: deriveShortName(club.name || "Gaffer"),
    autocomplete: "off",
    "aria-describedby": hintId,
  });
  const primIn = el("input", {
    type: "color",
    name: "kit_primary",
    class: "club-kit-in",
    value: club.kit_primary || house.primary,
  });
  const secIn = el("input", {
    type: "color",
    name: "kit_secondary",
    class: "club-kit-in",
    value: club.kit_secondary || house.secondary,
  });
  const err = el("p", { class: "form-error club-err", role: "alert", hidden: "" });
  const note = el("p", { class: "club-note", "aria-live": "polite" });
  const prevName = el("span", { class: "cp-name" });
  const prevCrest = el("span", { class: "cp-crest" });
  const prevShirt = el("span", { class: "cp-shirt" });
  const preview = el("div", { class: "club-preview", "aria-hidden": "true" }, [
    el("div", { class: "cp-bar" }, [prevCrest, prevName]),
    el("div", { class: "cp-pitch" }, [prevShirt, el("span", { class: "cp-cap" }, "Delivery 1")]),
  ]);
  const kit = () => ({
    primary: dirty.cleared ? null : dirty.primary || club.kit_primary ? primIn.value : null,
    secondary: dirty.cleared ? null : dirty.secondary || club.kit_secondary ? secIn.value : null,
  });
  const paint = () => {
    const name = nameIn.value.trim() || "Gaffer";
    const letters = shortIn.value.trim() || deriveShortName(name);
    shortIn.placeholder = deriveShortName(name);
    prevName.textContent = name;
    prevCrest.replaceChildren(crest("crest", 34, 40, letters));
    prevShirt.replaceChildren(agentShirt("Delivery 1", 56, "9"));
    const k = kit();
    const tokens = kitTokens(k.primary, k.secondary);
    setKitTokens(preview, tokens);
    note.textContent = tokens["--on-claret"]
      ? "A light kit: the words on it turn dark so they stay readable."
      : "";
  };
  nameIn.addEventListener("input", paint);
  shortIn.addEventListener("input", paint);
  primIn.addEventListener("input", () => {
    dirty.primary = true;
    dirty.cleared = false;
    paint();
  });
  secIn.addEventListener("input", () => {
    dirty.secondary = true;
    dirty.cleared = false;
    paint();
  });
  const houseBtn = el(
    "button",
    {
      class: "btn club-house",
      type: "button",
      onclick: () => {
        dirty.cleared = true;
        dirty.primary = dirty.secondary = false;
        primIn.value = house.primary;
        secIn.value = house.secondary;
        paint();
      },
    },
    "House kit",
  );
  const save = el("button", { class: "btn primary club-save", type: "submit" }, "Save");
  const form = el(
    "form",
    {
      class: "act-sheet club-form",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const short = shortIn.value.trim();
        if (short && !/^[\p{L}\p{N}&.]{1,4}$/u.test(short)) {
          err.textContent =
            "The short name is 1 to 4 letters or digits ('&' and '.' allowed), no spaces.";
          err.hidden = false;
          shortIn.setAttribute("aria-invalid", "true");
          shortIn.focus();
          return;
        }
        shortIn.removeAttribute("aria-invalid");
        const body = { name: nameIn.value.trim() || null, short_name: short || null };
        if (dirty.cleared) {
          body.kit_primary = null;
          body.kit_secondary = null;
        } else {
          if (dirty.primary) body.kit_primary = primIn.value;
          if (dirty.secondary) body.kit_secondary = secIn.value;
        }
        save.disabled = true;
        try {
          const res = await api("PATCH", "/api/club", body);
          if (res && res.club) applyClub(res.club);
          closeSheet();
          toast(`Saved: ${clubName()}`, { ok: true });
          redrawForSquad();
        } catch (x) {
          if (x && x.code === "UNAUTHORIZED") return;
          if (x && (x.status === 403 || x.code === "READ_ONLY_TOKEN")) {
            squad.capability = "read";
            err.textContent = "This token can only read: naming the club needs the full token.";
            paintBrand();
          } else err.textContent = (x && x.message) || "The club could not be saved.";
          err.hidden = false;
        } finally {
          save.disabled = false;
        }
      },
    },
    [
      el(
        "p",
        { class: "act-intro" },
        "The club's name and badge head every page; the kit colours dress the header, the crest and every agent's shirt.",
      ),
      preview,
      note,
      el(
        "p",
        { class: "act-hint club-hint", id: hintId },
        "The short name is 1–4 characters, shown on the crest; leave it blank to use the club's initials.",
      ),
      el("div", { class: "form-grid cols-2" }, [
        field("Club name", nameIn),
        field("Short name", shortIn),
        field("Primary kit", primIn),
        field("Secondary kit", secIn),
      ]),
      err,
      el("div", { class: "btn-row act-actions" }, [
        save,
        houseBtn,
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      ]),
    ],
  );
  paint();
  openSheet("Name your club", form, { focus: nameIn });
}

/** One row of the squad table; with a full token its Rename edits it in place. */
function squadRow(a, edit) {
  const tr = el("tr", { class: "sq-row", dataset: { id: a.agent_id } });
  const reg = a.registered_name || String(a.agent_id).slice(0, 8);
  let renameBtn = null;
  const view = () => {
    const w = agentWho(a.agent_id, a.registered_name);
    renameBtn = edit
      ? el(
          "button",
          {
            class: "btn small sq-rename",
            type: "button",
            "aria-label": `Rename ${w.name} (${reg})`,
            onclick: editRow,
          },
          "Rename",
        )
      : null;
    tr.classList.remove("is-editing");
    tr.replaceChildren(
      el(
        "td",
        { class: "c-shirt", "data-label": "No." },
        el("span", { class: "sq-shirt" }, [
          agentShirt(w.name, 36, w.no),
          el(
            "span",
            { class: "sq-num tabnum" },
            a.shirt_number != null ? String(a.shirt_number) : "—",
          ),
        ]),
      ),
      el("th", { scope: "row", class: "c-name", "data-label": "Name" }, [
        a.display_name
          ? el("span", { class: "sq-dn" }, a.display_name)
          : el(
              "span",
              { class: "sq-dn is-default", title: "The default name, until you rename it" },
              [a.default_display_name, el("span", { class: "sr-only" }, " (default name)")],
            ),
      ]),
      el("td", { class: "c-role", "data-label": "Role" }, ROLE_LABELS[a.role] || a.role || "—"),
      el(
        "td",
        { class: "c-reg", "data-label": "Registered as" },
        el("code", { class: "mono" }, reg),
      ),
      el("td", { class: "c-status", "data-label": "Status" }, badge(a.status || "—")),
      el(
        "td",
        { class: "c-seen tabnum", "data-label": "Last seen" },
        a.last_seen_at
          ? el(
              "time",
              { datetime: a.last_seen_at, title: fmtTime(a.last_seen_at) },
              fmtRelative(a.last_seen_at),
            )
          : "never",
      ),
      edit ? el("td", { class: "c-act" }, renameBtn) : null,
    );
  };
  function editRow() {
    const w = agentWho(a.agent_id, a.registered_name);
    const errId = `sq-err-${++appState.fieldSeq}`;
    const nameIn = el("input", {
      type: "text",
      class: "sq-name-in",
      maxlength: "40",
      value: a.display_name || "",
      placeholder: a.default_display_name || "",
      "aria-label": `Name for ${reg}`,
      "aria-describedby": errId,
      autocomplete: "off",
    });
    const noIn = el("input", {
      type: "number",
      class: "sq-no-in",
      min: "1",
      max: "99",
      step: "1",
      inputmode: "numeric",
      value: a.shirt_number != null ? String(a.shirt_number) : "",
      placeholder: "—",
      "aria-label": `Shirt number for ${reg} (1–99, or blank)`,
      "aria-describedby": errId,
    });
    const err = el("p", { class: "form-error sq-err", id: errId, role: "alert", hidden: "" });
    const fail = (msg, input) => {
      err.textContent = msg;
      err.hidden = false;
      for (const i of [nameIn, noIn]) i.removeAttribute("aria-invalid");
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    };
    const save = el("button", { class: "btn small primary sq-save", type: "button" }, "Save");
    const cancel = () => {
      view();
      if (renameBtn) renameBtn.focus();
    };
    const doSave = async () => {
      const name = nameIn.value.trim();
      const raw = String(noIn.value || "").trim();
      if (name.length > 40) return fail("A name is at most 40 characters.", nameIn);
      let no = null;
      if (raw !== "") {
        no = Number(raw);
        if (!Number.isInteger(no) || no < 1 || no > 99)
          return fail("A shirt number is a whole number from 1 to 99, or blank.", noIn);
      }
      const body = {};
      if (name !== (a.display_name || "")) body.display_name = name || null;
      if (no !== (a.shirt_number ?? null)) body.shirt_number = no;
      if (!Object.keys(body).length) return cancel();
      save.disabled = true;
      try {
        const res = await api("PATCH", `/api/squad/agents/${encodeURIComponent(a.agent_id)}`, body);
        if (res && res.agent) {
          Object.assign(a, res.agent);
          learnDisplay(res.agent);
        }
        const now = agentWho(a.agent_id, a.registered_name);
        view();
        if (renameBtn) renameBtn.focus();
        toast(
          a.shirt_number != null ? `${now.name} wears No. ${a.shirt_number}` : `Saved: ${now.name}`,
          { ok: true },
        );
      } catch (x) {
        if (x && x.code === "UNAUTHORIZED") return;
        if (x && (x.status === 409 || x.code === "DUPLICATE")) {
          const holder = x.details && x.details.agent_id;
          const hn = holder ? agentWho(holder).name : null;
          fail(hn ? `That number is taken by ${hn}.` : x.message || "That number is taken.", noIn);
        } else if (x && (x.status === 403 || x.code === "READ_ONLY_TOKEN")) {
          squad.capability = "read";
          paintBrand();
          fail("This token can only read: renaming needs the full token.");
        } else fail((x && x.message) || "The name could not be saved.", nameIn);
      } finally {
        save.disabled = false;
      }
    };
    save.addEventListener("click", doSave);
    const keys = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    nameIn.addEventListener("keydown", keys);
    noIn.addEventListener("keydown", keys);
    tr.classList.add("is-editing");
    tr.replaceChildren(
      el(
        "td",
        { class: "c-shirt", "data-label": "No." },
        el("span", { class: "sq-shirt" }, [agentShirt(w.name, 36, w.no), noIn]),
      ),
      el("th", { scope: "row", class: "c-name", "data-label": "Name" }, [nameIn, err]),
      el("td", { class: "c-role", "data-label": "Role" }, ROLE_LABELS[a.role] || a.role || "—"),
      el(
        "td",
        { class: "c-reg", "data-label": "Registered as" },
        el("code", { class: "mono" }, reg),
      ),
      el("td", { class: "c-status", "data-label": "Status" }, badge(a.status || "—")),
      el(
        "td",
        { class: "c-seen tabnum", "data-label": "Last seen" },
        a.last_seen_at ? fmtRelative(a.last_seen_at) : "never",
      ),
      el("td", { class: "c-act" }, [
        save,
        el("button", { class: "btn small sq-cancel", type: "button", onclick: cancel }, "Cancel"),
      ]),
    );
    nameIn.focus();
  }
  view();
  return tr;
}

/**
 * #/squad: the club's squad as a team sheet. Shirt number, name (the default
 * "Delivery 1" until renamed), role, the label it registered with, status and when
 * it was last seen. A full token renames in place; a read token only reads.
 */
async function renderSquad() {
  const signal = routeSignal();
  const [res] = await Promise.all([api("GET", "/api/squad", undefined, { signal }), ensureSquad()]);
  applySquad(res);
  const agents = (res && res.agents) || [];
  const edit = canEditSquad();
  const wrap = el("div", { class: "view view-squad" });
  wrap.dataset.sig = hashText(
    JSON.stringify([
      edit,
      res && res.club,
      agents.map((a) => [a.agent_id, a.display_name, a.shirt_number, a.status, a.last_seen_at]),
    ]),
  );
  const named = agents.filter((a) => a.display_name).length;
  const numbered = agents.filter((a) => a.shirt_number != null).length;
  wrap.appendChild(
    viewHead(
      "Squad",
      agents.length
        ? `${plural(agents.length, "agent")} · ${named} named · ${numbered} with a shirt number`
        : "No agents registered yet",
      edit
        ? el(
            "button",
            { class: "btn sq-club-btn", type: "button", onclick: () => openClubSheet() },
            [crest("crest sq-club-crest", 20, 24, clubLetters()), el("span", {}, "Name your club")],
          )
        : null,
    ),
  );
  if (!edit)
    wrap.appendChild(
      el(
        "p",
        { class: "section-note sq-readonly" },
        "You are signed in with a read token: you can see the squad, and renaming needs the full token.",
      ),
    );
  const th = (label, cls) => el("th", { scope: "col", class: cls }, label);
  const body = agents.length
    ? el("div", { class: "sq-table-wrap" }, [
        el("table", { class: "sq-table", "aria-label": "The squad" }, [
          el("thead", {}, [
            el("tr", {}, [
              th("No.", "c-shirt"),
              th("Name", "c-name"),
              th("Role", "c-role"),
              th("Registered as", "c-reg"),
              th("Status", "c-status"),
              th("Last seen", "c-seen"),
              edit ? th(el("span", { class: "sr-only" }, "Rename"), "c-act") : null,
            ]),
          ]),
          el(
            "tbody",
            {},
            agents.map((a) => squadRow(a, edit)),
          ),
        ]),
      ])
    : emptyState(
        "No agents in the squad yet.",
        "An agent joins the squad when it registers with the control plane; it gets a default name like “Delivery 1”.",
      );
  wrap.appendChild(progPage("squad-sheet", "claret", "The squad", clubName(), body));
  wrap.appendChild(
    el(
      "p",
      { class: "section-note sq-foot" },
      "Names and shirt numbers are labels: every claim, event and gate still records the agent by its id. A shirt number is worn by one agent at a time.",
    ),
  );
  return wrap;
}

// ===========================================================================
//  View: Floor (#/floor) — the factory floor
//    An isometric drawing of the real factory state. A conveyor bent into an L
//    runs past the stations in lifecycle order (Drawing office, Stores, Assembly,
//    Inspection, Test rig, Loading bay, Despatch); every open ticket is a parcel
//    at its station; every live claim is a robot wearing its agent's shirt
//    number (the same agentWho() the Tactics Board's shirts use); blocked,
//    paused and failed tickets sit in the hazard-taped jam bay, whose beacon is
//    lit while it holds anything; the spend tank is filled to today's wage bill
//    against the daily budget; and the lorry carries what was despatched today.
//    Everything is read through loadMatchDay(), the Overview's own reads, so the
//    floor and the scoreboard can never disagree. Drawn from one set of box and
//    prism primitives so the light falls the same way on every object: the top
//    face is the lightest, the +y face mid, the +x face the darkest.
// ===========================================================================

/** Tile size (px per tile) and the height squash of the 2:1 dimetric projection. */
const FU = 40;
const FZK = 0.9;
/** Tile (x, y, z) to the drawing's (sx, sy). */
const fP = (x, y, z = 0, u = FU) => [(x - y) * u, ((x + y) * u) / 2 - z * u * FZK];
const fPt = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1);
const fShade = (c, k) => (k ? `color-mix(in oklab, ${c}, var(--fl-shade) ${k}%)` : c);
const fTint = (c, k) => `color-mix(in oklab, ${c}, var(--fl-lift) ${k}%)`;
function fFace(pts, fill, u = FU, cls = "f") {
  return svgEl("polygon", {
    points: pts.map((q) => fPt(fP(q[0], q[1], q[2], u))).join(" "),
    style: `fill:${fill};stroke:${fill}`,
    class: cls,
  });
}
/** An axis-aligned box. c = { base } or explicit { top, front, side }. */
function fBox(x, y, z, w, d, h, c, u = FU, cls) {
  return svgEl("g", cls ? { class: cls } : {}, [
    fFace(
      [
        [x, y + d, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      c.front ?? fShade(c.base, 9),
      u,
    ),
    fFace(
      [
        [x + w, y, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x + w, y, z + h],
      ],
      c.side ?? fShade(c.base, 22),
      u,
    ),
    fFace(
      [
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      c.top ?? c.base,
      u,
    ),
  ]);
}
/** The silhouette of a box (focus rings and hit areas). */
function fHull(x, y, z, w, d, h, u = FU) {
  return [
    [x, y, z + h],
    [x + w, y, z + h],
    [x + w, y, z],
    [x + w, y + d, z],
    [x, y + d, z],
    [x, y + d, z + h],
  ]
    .map((p) => fPt(fP(p[0], p[1], p[2], u)))
    .join(" ");
}
/** A sawtooth roof over a footprint; `along` is the direction the teeth repeat. */
function fSawtooth(x, y, w, d, z, rise, hue, glass, along) {
  const g = svgEl("g");
  const len = along === "x" ? w : d;
  const n = Math.max(1, Math.round(len / 0.75));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const a = (along === "x" ? x : y) + i * step;
    const b = a + step;
    if (along === "x")
      g.append(
        fFace(
          [
            [a, y, z],
            [b, y, z + rise],
            [b, y + d, z + rise],
            [a, y + d, z],
          ],
          fTint(hue, 8),
        ),
        fFace(
          [
            [a, y + d, z],
            [b, y + d, z],
            [b, y + d, z + rise],
          ],
          fShade(hue, 14),
        ),
        fFace(
          [
            [b, y, z],
            [b, y + d, z],
            [b, y + d, z + rise],
            [b, y, z + rise],
          ],
          glass,
          FU,
          "f glass",
        ),
      );
    else
      g.append(
        fFace(
          [
            [x, a, z],
            [x, b, z + rise],
            [x + w, b, z + rise],
            [x + w, a, z],
          ],
          fTint(hue, 8),
        ),
        fFace(
          [
            [x + w, a, z],
            [x + w, b, z],
            [x + w, b, z + rise],
          ],
          fShade(hue, 26),
        ),
        fFace(
          [
            [x, b, z],
            [x + w, b, z],
            [x + w, b, z + rise],
            [x, b, z + rise],
          ],
          glass,
          FU,
          "f glass",
        ),
      );
  }
  return g;
}
const fRect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
/**
 * A sign painted on a wall, on its own layer above the floor (nothing on the
 * floor may cover a station's name). It registers its sheared outline so the tag
 * pass keeps clear of it. along "x": the +y face; along "y": the +x face.
 */
function fSign(C, x0, y0, z, along, widthTiles, label) {
  const [ox, oy] = fP(x0, y0, z);
  const k = along === "x" ? 0.5 : -0.5;
  const W = widthTiles * FU;
  C.signs.push(
    svgEl(
      "g",
      { transform: `matrix(1,${k},0,1,${ox.toFixed(1)},${oy.toFixed(1)})`, class: "fl-sign" },
      [
        svgEl("rect", { x: 0, y: 0, width: W, height: 21, rx: 2, class: "fl-sign-board" }),
        svgEl("text", { x: 6, y: 15, class: "fl-sign-text" }, label),
      ],
    ),
  );
  C.obstacles.push([
    [ox, oy],
    [ox + W, oy + k * W],
    [ox + W, oy + k * W + 21],
    [ox, oy + 21],
  ]);
}

/* ---- tag placement: clear of every sign, scale and other tag (SAT test) ---- */
function fOverlaps(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const v of a) {
        const d = v[0] * nx + v[1] * ny;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = v[0] * nx + v[1] * ny;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}
/** A leader from an anchor to the nearest point of a tag box: [x0, y0, x1, y1]. */
function fLeader(x, y, bx, by, w, h) {
  if (x < bx || x > bx + w) return [x, y - 2, x < bx ? bx : bx + w, by + h / 2];
  return [x, y - 2, Math.max(bx + 4, Math.min(bx + w - 4, x)), by > y ? by : by + h];
}
function fSegPoly([a, b, c, d]) {
  const L = Math.hypot(c - a, d - b) || 1;
  const nx = ((d - b) / L) * 1.5;
  const ny = (-(c - a) / L) * 1.5;
  const k = 4 / L;
  const a2 = a + (c - a) * k;
  const b2 = b + (d - b) * k;
  const c2 = c - (c - a) * k;
  const d2 = d - (d - b) * k;
  return [
    [a2 + nx, b2 + ny],
    [c2 + nx, d2 + ny],
    [c2 - nx, d2 - ny],
    [a2 - nx, b2 - ny],
  ];
}
function fSegCross([a, b, c, d], [e, f, g, h]) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return (
    o(a, b, c, d, e, f) * o(a, b, c, d, g, h) < 0 && o(e, f, g, h, a, b) * o(e, f, g, h, c, d) < 0
  );
}
/**
 * Place every tag. Candidates run from straight up outward (higher, either side,
 * below), each scored by how far it strays; an overlap costs more than any
 * distance and a crossed leader costs extra. A tag that moves keeps a leader.
 */
function fPlaceTags(tags, obstacles, bounds) {
  const placed = [];
  const leaders = [];
  const prio = (t) => (t.kind === "danger" ? 0 : t.kind === "needs" ? 1 : 2);
  const order = tags.map((t, i) => [t, i]).sort((a, b) => prio(a[0]) - prio(b[0]) || a[1] - b[1]);
  for (const [t] of order) {
    const [x, y] = t.at;
    const w = t.w;
    const h = 20;
    const base = -t.lift - h;
    const cand = [];
    for (const up of [0, 14, 28, 42, 58]) cand.push([0, base - up, up * 0.6]);
    for (const side of [1, -1])
      for (const [dx, dy] of [
        [w / 2 + 18, base + 6],
        [w / 2 + 18, base - 12],
        [w / 2 + 30, base - 30],
        [w / 2 + 22, 4],
      ])
        cand.push([
          side * dx,
          dy,
          Math.abs(dx) * 0.55 + Math.abs(dy - base) * 0.3 + (side < 0 ? 2 : 0),
        ]);
    cand.push([0, 10, 40]);
    let best = null;
    for (const [dx, dy, cost] of cand) {
      const bx = x + dx - w / 2;
      const by = y + dy;
      const rect = fRect(bx - 3, by - 3, w + 6, h + 6);
      let hits = 0;
      for (const o of obstacles) if (fOverlaps(rect, o)) hits++;
      for (const p of placed) if (fOverlaps(rect, p)) hits++;
      if (bx < bounds[0] + 2 || bx + w > bounds[0] + bounds[2] - 2 || by < bounds[1] + 2) hits++;
      const lead = fLeader(x, y, bx, by, w, h);
      const lp = fSegPoly(lead);
      let cross = 0;
      for (const p of placed) if (fOverlaps(lp, p)) cross++;
      for (const l of leaders) if (fSegCross(lead, l)) cross++;
      const score = hits * 1000 + cross * 400 + cost;
      if (!best || score < best.score) best = { score, bx, by, lead };
      if (score < 1) break;
    }
    placed.push(fRect(best.bx - 2, best.by - 2, w + 4, h + 4));
    leaders.push(best.lead);
    t.box = [best.bx, best.by, w, h];
  }
}

/* ---- stations ------------------------------------------------------------ */
const FLOOR_STATIONS = {
  drawing: { name: "Drawing office", statuses: ["draft", "refining"], hue: "var(--fl-draft)" },
  stores: { name: "Stores", statuses: ["ready"], hue: "var(--fl-ready)" },
  assembly: { name: "Assembly", statuses: ["claimed", "in_progress"], hue: "var(--fl-build)" },
  inspection: { name: "Inspection", statuses: ["in_review"], hue: "var(--fl-inspect)" },
  testrig: { name: "Test rig", statuses: ["in_testing"], hue: "var(--fl-test)" },
  loading: { name: "Loading bay", statuses: ["ready_for_merge"], hue: "var(--fl-inspect)" },
  despatch: { name: "Despatch", statuses: ["done"], hue: "var(--fl-done)" },
  jam: { name: "Jam bay", statuses: ["blocked", "paused", "failed"], hue: "var(--red)" },
};
/** Lifecycle order: the stations along the line, then the bay off it. */
const FLOOR_ORDER = [
  "drawing",
  "stores",
  "assembly",
  "inspection",
  "testrig",
  "loading",
  "despatch",
  "jam",
];
const FLOOR_STATION_OF = {};
for (const [k, st] of Object.entries(FLOOR_STATIONS))
  for (const s of st.statuses) FLOOR_STATION_OF[s] = k;
/** Each ticket status as the floor says it in a sentence. */
const FLOOR_WORDS = {
  draft: "a draft",
  refining: "refining",
  ready: "ready",
  claimed: "claimed",
  in_progress: "in progress",
  in_review: "in review",
  in_testing: "in testing",
  ready_for_merge: "approved, waiting to merge",
  done: "despatched today",
  blocked: "blocked",
  paused: "paused",
  failed: "failed",
};
/** The sheds: footprint in tiles, height, and the direction the roof teeth run. */
const FLOOR_SHEDS = {
  drawing: { x: 0.3, y: 0.1, w: 2.75, d: 1.0, h: 1.05, along: "x" },
  assembly: { x: 5.6, y: 0.05, w: 2.95, d: 1.08, h: 1.25, along: "x" },
  inspection: { x: 8.8, y: 0.1, w: 2.2, d: 1.0, h: 1.1, along: "x" },
  testrig: { x: 9.75, y: 2.45, w: 1.2, d: 1.75, h: 0.95, along: "y" },
  loading: { x: 9.75, y: 4.45, w: 1.2, d: 2.55, h: 1.1, along: "y" },
  despatch: { x: 9.75, y: 7.2, w: 1.2, d: 2.45, h: 1.05, along: "y" },
};
/** The painted benches in Assembly (one per agent slot, at most four fit the bay). */
const FLOOR_MAX_BENCHES = 4;
const fBenchX = (i) => 5.8 + i * 1.02;
/** Where a station's parcels sit (tile coordinates); past the last slot is "+n". */
function floorSlots(k) {
  const out = [];
  if (k === "drawing")
    for (let i = 0; i < 6; i++) out.push({ x: 0.6 + i * 0.44, y: 1.6, z: 0.3, sz: 0.38, flat: 1 });
  if (k === "stores")
    for (const z of [0.42, 0.98])
      for (let i = 0; i < 4; i++) out.push({ x: 3.55 + i * 0.5, y: 0.62, z, sz: 0.4 });
  // claimed tickets whose robot is not on a bench wait on the belt by Assembly
  if (k === "assembly")
    for (let i = 0; i < 5; i++) out.push({ x: 5.9 + i * 0.5, y: 1.6, z: 0.3, sz: 0.4 });
  if (k === "inspection")
    for (let i = 0; i < 3; i++) out.push({ x: 9.3 + i * 0.78, y: 1.6, z: 0.3, sz: 0.46 });
  if (k === "testrig")
    for (let i = 0; i < 3; i++) out.push({ x: 11.5, y: 2.3 + i * 0.62, z: 0.3, sz: 0.44 });
  if (k === "loading")
    for (let i = 0; i < 3; i++)
      out.push({ x: 11.5, y: 4.95 + i * 0.85, z: 0.3, sz: 0.46, lift: i % 2 ? 46 : 22 });
  // the lorry's deck: what was despatched today, loaded mid-deck first (in view)
  if (k === "despatch")
    for (let l = 0; l < 2; l++)
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 2; c++)
          out.push({
            x: 11.22 + c * 0.56,
            y: [10.95, 10.35, 11.55][r],
            z: 0.54 + l * 0.38,
            sz: 0.42,
          });
  if (k === "jam")
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 3; c++)
        out.push({ x: 5.9 + c * 0.55, y: 4.45 + r * 0.6, z: 0, sz: 0.42, tilt: true });
  return out;
}
/** Where a robot stands beside a parcel it holds off the benches. */
function floorBeside(k, sl) {
  if (k === "testrig" || k === "loading") return [12.3, sl.y];
  if (k === "jam") return [sl.x, 5.75];
  if (k === "despatch") return [12.45, sl.y];
  return [sl.x, 2.45];
}

/** A kraft parcel (or a blue flat-pack: a draft). */
function floorParcel(x, y, z, sz, flat) {
  const g = svgEl("g", { class: "fl-pk" });
  if (flat) {
    g.append(
      fBox(x - sz / 2, y - sz / 2, z, sz, sz, 0.07, {
        top: "var(--fl-flat-t)",
        front: "var(--fl-flat-f)",
        side: "var(--fl-flat-s)",
      }),
    );
    const a = fP(x - sz / 4, y - sz / 2 + 0.04, z + 0.07);
    const b = fP(x - sz / 4, y + sz / 2 - 0.04, z + 0.07);
    const c = fP(x + sz / 4, y - sz / 2 + 0.04, z + 0.07);
    const d = fP(x + sz / 4, y + sz / 2 - 0.04, z + 0.07);
    g.append(
      svgEl("path", { d: `M${fPt(a)}L${fPt(b)}M${fPt(c)}L${fPt(d)}`, class: "fl-flat-line" }),
    );
    return g;
  }
  const h = sz * 0.86;
  g.append(fBox(x - sz / 2, y - sz / 2, z, sz, sz, h, FLOOR_KRAFT));
  const t = [
    fP(x - 0.05, y - sz / 2, z + h),
    fP(x + 0.05, y - sz / 2, z + h),
    fP(x + 0.05, y + sz / 2, z + h),
    fP(x - 0.05, y + sz / 2, z + h),
  ];
  g.append(svgEl("polygon", { points: t.map(fPt).join(" "), class: "fl-tape" }));
  return g;
}
const FLOOR_KRAFT = {
  top: "var(--fl-kraft-t)",
  front: "var(--fl-kraft-f)",
  side: "var(--fl-kraft-s)",
};

/**
 * A robot in a hard hat, facing down the line (+x), its agent's shirt number on
 * its chest plate in the club kit (the Tactics Board's shirt tokens). `carry`
 * puts its parcel in its arms. Returns { g, top } (top: above the parcel).
 */
function floorRobot(x0, y0, no, carry) {
  const k = 1.6;
  const u = FU * k;
  const x = x0 / k;
  const y = y0 / k;
  const g = svgEl("g", { class: "fl-bot" });
  const body = { top: "var(--fl-bot-t)", front: "var(--fl-bot-f)", side: "var(--fl-bot-s)" };
  const leg = { base: "var(--fl-bot-leg)" };
  g.append(fBox(x - 0.09, y - 0.12, 0, 0.08, 0.08, 0.2, leg, u));
  if (carry) g.append(fBox(x - 0.02, y - 0.2, 0.23, 0.44, 0.06, 0.06, body, u));
  g.append(fBox(x - 0.09, y + 0.04, 0, 0.08, 0.08, 0.2, leg, u));
  g.append(fBox(x - 0.15, y - 0.15, 0.2, 0.3, 0.3, 0.36, body, u));
  // the chest plate on the +y face: the club shirt colour with the stencil number
  g.append(
    fFace(
      [
        [x - 0.14, y + 0.15, 0.3],
        [x + 0.14, y + 0.15, 0.3],
        [x + 0.14, y + 0.15, 0.555],
        [x - 0.14, y + 0.15, 0.555],
      ],
      "var(--claret)",
      u,
      "f fl-bot-plate",
    ),
  );
  if (no) {
    const [ox, oy] = fP(x - 0.14, y + 0.15, 0.555, u);
    const pw = 0.28 * u;
    g.append(
      svgEl(
        "text",
        {
          transform: `matrix(1,0.5,0,1,${ox.toFixed(1)},${oy.toFixed(1)})`,
          x: (pw / 2).toFixed(1),
          y: 12.4,
          "text-anchor": "middle",
          class: "fl-bot-no",
        },
        String(no),
      ),
    );
  }
  g.append(fBox(x - 0.04, y - 0.04, 0.56, 0.08, 0.08, 0.05, leg, u));
  g.append(fBox(x - 0.12, y - 0.12, 0.6, 0.24, 0.24, 0.22, body, u));
  g.append(
    fFace(
      [
        [x + 0.12, y - 0.1, 0.66],
        [x + 0.12, y + 0.1, 0.66],
        [x + 0.12, y + 0.1, 0.78],
        [x + 0.12, y - 0.1, 0.78],
      ],
      "var(--fl-bot-visor)",
      u,
    ),
  );
  for (const ey of [-0.07, 0.03])
    g.append(
      fFace(
        [
          [x + 0.12, y + ey, 0.7],
          [x + 0.12, y + ey + 0.04, 0.7],
          [x + 0.12, y + ey + 0.04, 0.75],
          [x + 0.12, y + ey, 0.75],
        ],
        "var(--fl-bot-eye)",
        u,
      ),
    );
  const [hx, hy] = fP(x, y, 0.83, u);
  const r = 0.2 * u;
  g.append(
    svgEl("ellipse", { cx: hx, cy: hy + 1, rx: r * 1.35, ry: r * 0.68, class: "fl-hat-brim" }),
    svgEl("path", {
      d: `M${(hx - r).toFixed(1)},${hy.toFixed(1)} a${r.toFixed(1)},${(r * 0.95).toFixed(1)} 0 0 1 ${(2 * r).toFixed(1)},0 z`,
      class: "fl-hat",
    }),
    svgEl("path", {
      d: `M${hx.toFixed(1)},${(hy - r * 0.95).toFixed(1)} v-5`,
      class: "fl-antenna",
    }),
    svgEl("circle", { cx: hx, cy: hy - r * 0.95 - 6.5, r: 2.1, class: "fl-antenna-tip" }),
  );
  let top = fP(x, y, 1.0, u);
  if (carry) {
    g.append(fBox(x + 0.16, y - 0.16, 0.26, 0.32, 0.32, 0.28, FLOOR_KRAFT, u));
    const t = [
      fP(x + 0.28, y - 0.16, 0.54, u),
      fP(x + 0.36, y - 0.16, 0.54, u),
      fP(x + 0.36, y + 0.16, 0.54, u),
      fP(x + 0.28, y + 0.16, 0.54, u),
    ];
    g.append(svgEl("polygon", { points: t.map(fPt).join(" "), class: "fl-tape" }));
    g.append(fBox(x - 0.02, y + 0.14, 0.23, 0.44, 0.06, 0.06, body, u));
    top = fP(x + 0.32, y, 0.56, u);
  }
  return { g, top };
}
function floorCylinder(cx, cy, z0, z1, r, cls) {
  const [bx, by] = fP(cx, cy, z0);
  const [tx, ty] = fP(cx, cy, z1);
  const rx = r * FU * 1.414;
  const ry = r * FU * 0.707;
  return svgEl("g", { class: cls }, [
    svgEl("path", {
      d: `M${bx - rx},${by} L${tx - rx},${ty} A${rx},${ry} 0 0 1 ${tx + rx},${ty} L${bx + rx},${by} A${rx},${ry} 0 0 1 ${bx - rx},${by} Z`,
      class: "fl-cyl-body",
    }),
    svgEl("ellipse", { cx: tx, cy: ty, rx, ry, class: "fl-cyl-top" }),
  ]);
}
/** A tick step for the tank's scale: 3 to 6 graduations up to the budget. */
function floorTickStep(budget) {
  for (const m of [0.01, 0.1, 1, 10, 100, 1000])
    for (const k of [1, 2, 2.5, 5]) if (budget / (m * k) <= 6) return m * k;
  return Math.ceil(budget / 5);
}

/**
 * What the floor shows, from the Overview's match-day read: every open ticket as
 * a parcel at its station, the live claims (robots), today's despatches, the
 * wage bill against the budget and the decisions on the desk.
 */
function floorModel(f) {
  const now = f.now;
  // "Today" is the server's day (UTC midnight), the same day the scoreboard's
  // Delivered today counts, so the lorry and the tile never disagree.
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const needs = new Set(f.items.map((i) => i.ticket && i.ticket.id).filter(Boolean));
  const parkedWhy = new Map();
  for (const i of f.items)
    if (i.kind === "parked" && i.ticket) parkedWhy.set(i.ticket.id, i.reason);
  // A live claim: held now (a stale claim, past its heartbeat, has no robot).
  const live = new Map();
  for (const [tid, c] of f.claimByTicket) {
    if (c.expires_at && Date.parse(c.expires_at) < now) continue;
    const t = f.byId.get(tid);
    if (!t || t.status === "done" || t.status === "cancelled") continue;
    live.set(tid, { claim: c, who: agentWho(c.agent_id, c.agent_display_name) });
  }
  const parcel = (t) => {
    const ev = f.details.get(t.id)?.events;
    const hold = live.get(t.id);
    const run = t.number != null ? f.runByTicket.get(t.number) : null;
    return {
      id: t.id,
      number: t.number,
      title: t.title || "(untitled)",
      status: t.status,
      station: FLOOR_STATION_OF[t.status],
      needs: needs.has(t.id),
      why: parkedWhy.get(t.id) || null,
      who: hold ? hold.who : null,
      agentId: hold ? hold.claim.agent_id : null,
      running: Boolean(hold && run && !run.outcome),
      by:
        !hold && ["in_review", "in_testing", "ready_for_merge", "done"].includes(t.status)
          ? deliveredBy(ev)
          : null,
    };
  };
  const open = f.tickets
    .filter((t) => t.status !== "done" && t.status !== "cancelled" && FLOOR_STATION_OF[t.status])
    .map(parcel);
  const despatched = f.tickets
    .filter((t) => t.status === "done")
    .filter((t) => {
      const at = Date.parse(sinceStatus(f.details.get(t.id)?.events, "done") || t.updated_at);
      return Number.isFinite(at) && at >= dayStart.getTime();
    })
    .map(parcel);
  const all = [...open, ...despatched].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const byStation = {};
  for (const p of all) (byStation[p.station] ||= []).push(p);
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  return {
    open,
    despatched,
    byStation,
    robots: all.filter((p) => p.who),
    // one bench per agent slot, and one for every robot at Assembly beyond them
    benches: Math.max(
      1,
      Math.min(
        FLOOR_MAX_BENCHES,
        Math.max(f.slots || 3, (byStation.assembly || []).filter((p) => p.who).length),
      ),
    ),
    decisions: f.items.filter((i) => i.kind === "decision").length,
    today,
    budget: f.budget,
  };
}

/** The sentence a parcel reads as: "#12 Fix the login redirect, in review, delivered by Kev (No. 9)". */
function floorSentence(p) {
  const named = (w) => `${w.name}${w.no ? ` (No. ${Number(w.no)})` : ""}`;
  let s = `#${p.number} ${p.title}, ${FLOOR_WORDS[p.status] || statusLabel(p.status, p.landing_state)}`;
  if (p.who) s += `, ${named(p.who)} on it${p.running ? ", its run in progress" : ""}`;
  else if (p.by) s += `, delivered by ${named(p.by)}`;
  if (p.needs) s += ", needs you";
  return s;
}

/** Draw the floor: one SVG, every parcel, robot and station a link. */
function floorScene(m) {
  const C = { items: [], tags: [], obstacles: [], signs: [] };
  const add = (depth, node) => C.items.push({ depth, node });
  const count = (k) => (m.byStation[k] || []).length;
  const SLAB = { w: 12.8, d: 10 };

  // the slab, its tile joints, the painted walkways and the lorry's yard
  const floor = svgEl("g", { class: "fl-floor" }, [
    fFace(
      [
        [0, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, 0],
        [0, SLAB.d, 0],
      ],
      "var(--fl-slab-l)",
    ),
    fFace(
      [
        [SLAB.w, 0, -0.35],
        [SLAB.w, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, 0],
        [SLAB.w, 0, 0],
      ],
      "var(--fl-slab-r)",
    ),
    fFace(
      [
        [0, 0, 0],
        [SLAB.w, 0, 0],
        [SLAB.w, SLAB.d, 0],
        [0, SLAB.d, 0],
      ],
      "var(--fl-ground)",
    ),
    fFace(
      [
        [10.6, SLAB.d, 0],
        [12.6, SLAB.d, 0],
        [12.6, 13.2, 0],
        [10.6, 13.2, 0],
      ],
      "var(--fl-yard)",
    ),
  ]);
  let joints = "";
  for (let i = 1; i < SLAB.w; i++) joints += `M${fPt(fP(i, 0))}L${fPt(fP(i, SLAB.d))}`;
  for (let j = 1; j < SLAB.d; j++) joints += `M${fPt(fP(0, j))}L${fPt(fP(SLAB.w, j))}`;
  floor.append(svgEl("path", { d: joints, class: "fl-joints" }));
  const walk = [
    [fP(0.3, 2.1), fP(11.0, 2.1)],
    [fP(11.0, 2.1), fP(11.0, 9.75)],
    [fP(0.3, 1.12), fP(5.55, 1.12)],
    [fP(12.0, 1.12), fP(12.0, 9.75)],
  ];
  floor.append(
    svgEl("path", { d: walk.map(([a, b]) => `M${fPt(a)}L${fPt(b)}`).join(""), class: "fl-walk" }),
  );

  // the belt, in one-tile chunks so the painter's sort stays honest
  const beltC = {
    top: "var(--fl-belt)",
    front: "var(--fl-belt-side)",
    side: fShade("var(--fl-belt-side)", 18),
  };
  for (let x = 0.3; x < 11.8 - 0.001; x += 1) {
    const w = Math.min(1, 11.8 - x);
    add(x + w / 2 + 1.1, fBox(x, 1.3, 0, w, 0.6, 0.3, beltC));
  }
  for (let y = 1.9; y < 9.75 - 0.001; y += 1) {
    const d = Math.min(1, 9.75 - y);
    add(11 + y + d / 2, fBox(11.2, y, 0, 0.6, d, 0.3, beltC));
  }
  let rollers = "";
  for (let x = 0.5; x < 11.2; x += 0.3)
    rollers += `M${fPt(fP(x, 1.32, 0.3))}L${fPt(fP(x, 1.88, 0.3))}`;
  for (let y = 2.1; y < 9.7; y += 0.3)
    rollers += `M${fPt(fP(11.22, y, 0.3))}L${fPt(fP(11.78, y, 0.3))}`;
  add(0.05, svgEl("path", { d: rollers, class: "fl-rollers" }));

  const glassFor = (k) => (count(k) ? "var(--fl-glass-lit)" : "var(--fl-glass)");
  const needsAt = (k) => (m.byStation[k] || []).some((p) => p.needs);
  // A station is a link to Work, filtered to its first status.
  const stationLink = (k, depth, node, hullPts) => {
    const st = FLOOR_STATIONS[k];
    const n = count(k);
    const what =
      k === "despatch"
        ? `${n} despatched today`
        : `${n} ${n === 1 ? "ticket" : "tickets"}${needsAt(k) ? ", needs you" : ""}`;
    const a = svgEl("a", {
      href: `#/work?status=${k === "assembly" ? "in_progress" : st.statuses[0]}`,
      class: "fl-hit fl-station",
      "aria-label": `${st.name}: ${what}. Open in Work.`,
      "data-station": k,
    });
    a.append(node, svgEl("polygon", { points: hullPts, class: "fl-ring" }));
    add(depth, a);
  };

  // the sheds: a plinth in the station hue, white walls, a sawtooth roof whose
  // glass is lit while the station holds work, the sign on the face to the belt
  const wall = { top: "var(--fl-wall)", front: "var(--fl-wall-f)", side: "var(--fl-wall-s)" };
  for (const [k, b] of Object.entries(FLOOR_SHEDS)) {
    const st = FLOOR_STATIONS[k];
    const g = svgEl("g", { class: `fl-shed fl-shed-${k}` });
    g.append(fBox(b.x, b.y, 0, b.w, b.d, 0.12, { base: st.hue }));
    g.append(fBox(b.x, b.y, 0.12, b.w, b.d, b.h - 0.12, wall));
    g.append(fSawtooth(b.x, b.y, b.w, b.d, b.h, 0.42, st.hue, glassFor(k), b.along));
    if (b.along === "x") fSign(C, b.x + 0.14, b.y + b.d, b.h - 0.04, "x", b.w - 0.28, st.name);
    else {
      if (k !== "testrig") {
        const y0 = b.y + 0.35;
        const y1 = b.y + b.d - 0.35;
        const X = b.x + b.w;
        let lines = "";
        for (let zz = 0.08; zz < 0.46; zz += 0.07)
          lines += `M${fPt(fP(X, y1, zz))}L${fPt(fP(X, y0, zz))}`;
        g.append(
          fFace(
            [
              [X, y0, 0.05],
              [X, y1, 0.05],
              [X, y1, 0.48],
              [X, y0, 0.48],
            ],
            "var(--fl-shutter)",
          ),
          svgEl("path", { d: lines, class: "fl-shutter-lines" }),
        );
      }
      fSign(C, b.x + b.w, b.y + b.d - 0.14, b.h - 0.04, "y", b.d - 0.28, st.name);
    }
    // a needs-you lamp on the roof: the referee's yellow card colour
    if (needsAt(k)) {
      const [lx, ly] = fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.55);
      g.append(
        svgEl("path", { d: `M${lx},${ly + 2} v10`, class: "fl-lamp-post" }),
        svgEl("rect", { x: lx - 6, y: ly - 9, width: 12, height: 12, rx: 2, class: "fl-lamp" }),
      );
    }
    stationLink(k, b.x + b.w / 2 + b.y + b.d / 2, g, fHull(b.x, b.y, 0, b.w, b.d, b.h + 0.42));
  }

  // Stores: an open shelving rack
  {
    const g = svgEl("g", { class: "fl-rack" });
    const steel = { base: "var(--fl-ready)" };
    for (const [px, py] of [
      [3.25, 0.2],
      [5.3, 0.2],
      [3.25, 1.0],
      [5.3, 1.0],
    ])
      g.append(fBox(px - 0.04, py - 0.04, 0, 0.08, 0.08, 1.48, steel));
    for (const z of [0.34, 0.9, 1.44])
      g.append(
        fBox(3.2, 0.18, z, 2.15, 0.88, 0.06, {
          top: "var(--fl-shelf)",
          front: fShade("var(--fl-shelf)", 10),
          side: fShade("var(--fl-shelf)", 20),
        }),
      );
    fSign(C, 3.32, 1.04, 1.86, "x", 1.95, "Stores");
    stationLink("stores", 3.4, g, fHull(3.2, 0.16, 0, 2.15, 0.9, 1.9));
  }

  // the benches: one painted bay per agent slot
  {
    let d = "";
    for (let i = 0; i < m.benches; i++) {
      const x = fBenchX(i);
      const c = [
        [x - 0.42, 2.38],
        [x + 0.42, 2.38],
        [x + 0.42, 3.2],
        [x - 0.42, 3.2],
      ].map(([a, b]) => fP(a, b, 0.004));
      d += `M${c.map(fPt).join("L")}Z`;
    }
    add(0.06, svgEl("path", { d, class: "fl-bay" }));
  }

  // the test-rig gantry over leg 2
  {
    const frame = { base: "var(--fl-test)" };
    const GY = 2.25;
    add(11.05 + GY - 0.3, fBox(11.0, GY - 0.05, 0, 0.1, 0.1, 1.15, frame));
    const front = svgEl("g", {}, [
      fBox(11.95, GY - 0.05, 0, 0.1, 0.1, 1.15, frame),
      fBox(10.98, GY - 0.07, 1.12, 1.1, 0.14, 0.12, frame),
    ]);
    for (const xx of [11.2, 11.5, 11.8]) {
      const [lx, ly] = fP(xx, GY + 0.07, 1.06);
      front.append(svgEl("circle", { cx: lx, cy: ly, r: 2.6, class: "fl-gate-lamp" }));
    }
    add(12.0 + GY + 0.4, front);
  }

  // the jam bay: hazard tape round the floor and a beacon, lit while it holds anything
  const jam = m.byStation.jam || [];
  {
    const g = svgEl("g", { class: `fl-jam${jam.length ? " is-jammed" : ""}` });
    g.append(
      fFace(
        [
          [5.6, 4.0, 0.005],
          [7.6, 4.0, 0.005],
          [7.6, 5.55, 0.005],
          [5.6, 5.55, 0.005],
        ],
        jam.length ? "var(--fl-jam-floor)" : "var(--fl-ground)",
      ),
    );
    if (jam.length) {
      const C4 = [
        [5.6, 4.0],
        [7.6, 4.0],
        [7.6, 5.55],
        [5.6, 5.55],
      ];
      const edges = [
        [C4[0], C4[1], 12],
        [C4[1], C4[2], 10],
        [C4[2], C4[3], 12],
        [C4[3], C4[0], 10],
      ];
      const dash = (a, b, n) => {
        let d = "";
        for (let i = 0; i < n; i += 2) {
          const p0 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
          const p1 = [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n];
          d += `M${fPt(fP(p0[0], p0[1], 0.01))}L${fPt(fP(p1[0], p1[1], 0.01))}`;
        }
        return d;
      };
      g.append(
        svgEl("path", {
          d: edges
            .map(([a, b]) => `M${fPt(fP(a[0], a[1], 0.01))}L${fPt(fP(b[0], b[1], 0.01))}`)
            .join(""),
          class: "fl-hazard-base",
        }),
        svgEl("path", { d: edges.map(([a, b, n]) => dash(a, b, n)).join(""), class: "fl-hazard" }),
      );
    }
    g.append(fBox(5.67, 5.38, 0, 0.06, 0.06, 0.55, { base: "var(--fl-post)" }));
    fSign(C, 5.65, 5.52, 0.98, "x", 1.36, "Jam bay");
    stationLink("jam", 1.0, g, fHull(5.6, 4.0, 0, 2.0, 1.55, 0.01));
    const bg = svgEl("g", { class: "fl-beacon-wrap" });
    bg.append(fBox(7.32, 4.13, 0, 0.08, 0.08, 1.0, { base: "var(--fl-post)" }));
    const [bx, by] = fP(7.36, 4.17, 1.05);
    bg.append(
      svgEl("rect", {
        x: bx - 6,
        y: by - 12,
        width: 12,
        height: 14,
        rx: 3,
        class: jam.length ? "fl-beacon is-on" : "fl-beacon",
      }),
      svgEl("rect", { x: bx - 8, y: by + 1, width: 16, height: 3, rx: 1, class: "fl-beacon-cap" }),
    );
    add(7.36 + 4.17 + 0.3, bg);
  }

  // your desk: a glass-fronted cabin, lit while a decision waits for you
  {
    const g = svgEl("g", { class: "fl-desk" });
    const b = { x: 0.9, y: 6.4, w: 2.5, d: 2.4, h: 0.95 };
    g.append(fBox(b.x, b.y, 0, b.w, b.d, 0.12, { base: "var(--claret)" }));
    g.append(
      fBox(b.x, b.y, 0.12, b.w, b.d, b.h - 0.12, {
        top: "var(--fl-roof)",
        front: "var(--fl-wall-f)",
        side: "var(--fl-wall-s)",
      }),
    );
    const lit = m.decisions ? "var(--fl-glass-lit)" : "var(--fl-glass)";
    g.append(
      fFace(
        [
          [b.x + 0.2, b.y + b.d, 0.28],
          [b.x + b.w - 0.2, b.y + b.d, 0.28],
          [b.x + b.w - 0.2, b.y + b.d, 0.72],
          [b.x + 0.2, b.y + b.d, 0.72],
        ],
        lit,
        FU,
        "f glass",
      ),
      fFace(
        [
          [b.x + b.w, b.y + 0.2, 0.28],
          [b.x + b.w, b.y + b.d - 0.95, 0.28],
          [b.x + b.w, b.y + b.d - 0.95, 0.72],
          [b.x + b.w, b.y + 0.2, 0.72],
        ],
        lit,
        FU,
        "f glass",
      ),
    );
    fSign(C, b.x + b.w, b.y + b.d - 0.12, 1.26, "y", 0.95, "Desk");
    if (m.decisions) {
      const [lx, ly] = fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.1);
      g.append(
        svgEl("path", { d: `M${lx},${ly + 2} v10`, class: "fl-lamp-post" }),
        svgEl("rect", { x: lx - 6, y: ly - 9, width: 12, height: 12, rx: 2, class: "fl-lamp" }),
      );
      C.tags.push({
        at: fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.6),
        text: m.decisions === 1 ? "Decision" : `${m.decisions} decisions`,
        kind: "needs",
        lift: 10,
      });
    }
    const a = svgEl("a", {
      href: "#/overview",
      class: "fl-hit fl-station",
      "aria-label": m.decisions
        ? `Your desk: ${plural(m.decisions, "decision")} ${m.decisions === 1 ? "waits" : "wait"} for you. Answer on the Team sheet.`
        : "Your desk: no decision waits for you. Open the Overview.",
      "data-station": "desk",
    });
    a.append(g, svgEl("polygon", { points: fHull(b.x, b.y, 0, b.w, b.d, b.h), class: "fl-ring" }));
    add(b.x + b.w / 2 + b.y + b.d / 2, a);
  }

  // the spend tank: a glass cylinder filled to today's wage bill over the budget
  {
    const { today, budget } = m;
    const cx = 5.7;
    const cy = 7.5;
    const r = 0.62;
    const zMax = 2.6;
    const frac = budget && today != null ? Math.max(0, Math.min(1, today / budget)) : 0;
    const hot = budget && today != null && today / budget >= 0.9;
    const label =
      today == null
        ? "Spend tank: no spend recorded today."
        : budget
          ? `Spend tank: ${money(today)} of today's ${moneyW(budget)} budget (${Math.round((today / budget) * 100)}%).`
          : `Spend tank: ${money(today)} spent today. No daily budget is set, so the tank has no scale.`;
    const g = svgEl("g", {
      class: `fl-tank${hot ? " is-hot" : ""}`,
      role: "img",
      "aria-label": label,
    });
    g.append(floorCylinder(cx, cy, 0, 0.14, r + 0.08, "fl-tank-base"));
    g.append(floorCylinder(cx, cy, 0.14, 0.14 + zMax, r, "fl-tank-glass"));
    if (frac > 0)
      g.append(floorCylinder(cx, cy, 0.14, 0.14 + zMax * frac, r - 0.05, "fl-tank-fuel"));
    g.append(floorCylinder(cx, cy, 0.14 + zMax, 0.24 + zMax, r + 0.06, "fl-tank-cap"));
    if (budget) {
      const [bx0] = fP(cx, cy, 0);
      const rx = r * FU * 1.414;
      const ry = r * FU * 0.707;
      const step = floorTickStep(budget);
      // a graduation every step, the budget itself last; only the two ends are
      // figured, so the scale never crowds the jam bay's sign beside it
      const marks = [];
      for (let i = 0; i * step < budget - 1e-9; i++) marks.push(Math.round(i * step * 100) / 100);
      marks.push(budget);
      marks.forEach((v, i) => {
        const [, yy] = fP(cx, cy, 0.14 + (zMax * v) / budget);
        g.append(
          svgEl("path", {
            d: `M${(bx0 - rx).toFixed(1)},${yy.toFixed(1)} A${rx.toFixed(1)},${ry.toFixed(1)} 0 0 0 ${(bx0 + rx).toFixed(1)},${yy.toFixed(1)}`,
            class: "fl-grad",
          }),
          svgEl("path", {
            d: `M${(bx0 + rx - 4).toFixed(1)},${yy.toFixed(1)}h11`,
            class: "fl-tick",
          }),
        );
        if (i && i < marks.length - 1) return;
        const lab = v === 0 ? "$0" : moneyW(v);
        g.append(svgEl("text", { x: bx0 + rx + 11, y: yy + 4, class: "fl-tick-label" }, lab));
        C.obstacles.push(fRect(bx0 + rx + 9, yy - 8, lab.length * 7.6 + 4, 15));
      });
    }
    add(cx + cy, g);
    C.tags.push({
      at: fP(cx, cy, 0.3 + zMax),
      text:
        today == null
          ? "No spend today"
          : budget
            ? `${money(today)} of ${moneyW(budget)}`
            : `${money(today)} today`,
      kind: hot ? "danger" : "plain",
      lift: 16,
    });
  }

  // the lorry at the end of the line (its deck carries today's despatches)
  {
    const g = svgEl("g", { class: "fl-lorry" });
    const wheel = (wx, wy) => {
      const [ex, ey] = fP(wx, wy, 0.16);
      return svgEl("ellipse", { cx: ex, cy: ey, rx: 5.2, ry: 7, class: "fl-wheel" });
    };
    // the far wheels go under the deck, the near ones over it
    g.append(wheel(10.95, 10.35), wheel(10.95, 11.6));
    g.append(fBox(10.95, 10.0, 0.32, 1.2, 2.05, 0.22, { base: "var(--fl-lorry-deck)" }));
    g.append(wheel(12.15, 10.35), wheel(12.15, 11.6));
    add(22.1, g);
    const cab = svgEl("g", { class: "fl-lorry" });
    cab.append(wheel(10.95, 12.6));
    cab.append(fBox(10.95, 12.12, 0.24, 1.2, 0.8, 0.95, { base: "var(--fl-lorry)" }));
    cab.append(
      fFace(
        [
          [11.05, 12.92, 0.72],
          [12.05, 12.92, 0.72],
          [12.05, 12.92, 1.08],
          [11.05, 12.92, 1.08],
        ],
        "var(--fl-glass)",
        FU,
        "f glass",
      ),
    );
    cab.append(wheel(12.15, 12.6));
    add(24.1, cab);
  }

  // the parcels, station by station; a ticket held on a bench is carried by its robot
  const benchRobots = [];
  const tagKind = (p) =>
    p.status === "blocked" || p.status === "failed" ? "danger" : p.needs ? "needs" : null;
  const linkFor = (p, cls) =>
    svgEl("a", {
      href: `#/ticket/${p.id}`,
      class: `fl-hit ${cls}`,
      "aria-label": floorSentence(p),
      "data-n": p.number,
      "data-id": p.id,
      "data-status": p.status,
      "data-tip-title": p.title,
    });
  let order = 0;
  for (const k of FLOOR_ORDER) {
    let list = m.byStation[k] || [];
    if (k === "assembly") {
      const held = list.filter((p) => p.who);
      held.sort(
        (a, b) => (Number(a.who.no) || 1e3) - (Number(b.who.no) || 1e3) || a.number - b.number,
      );
      benchRobots.push(...held.slice(0, m.benches));
      list = [...held.slice(m.benches), ...list.filter((p) => !p.who)];
    }
    const slots = floorSlots(k);
    list.forEach((p, i) => {
      const sl = slots[i];
      if (!sl) return;
      const top = fP(sl.x, sl.y, sl.z + sl.sz * 0.86 + 0.02);
      const a = linkFor(p, "fl-parcel");
      const inner = svgEl("g", { class: "fl-drop", style: `--i:${order++}` });
      if (sl.tilt)
        inner.setAttribute(
          "transform",
          `rotate(${p.number % 2 ? -9 : 7} ${top[0].toFixed(1)} ${(top[1] + 10).toFixed(1)})`,
        );
      inner.append(floorParcel(sl.x, sl.y, sl.z, sl.sz, sl.flat));
      a.append(
        inner,
        svgEl("polygon", {
          points: fHull(
            sl.x - sl.sz / 2,
            sl.y - sl.sz / 2,
            sl.z,
            sl.sz,
            sl.sz,
            sl.flat ? 0.07 : sl.sz * 0.86,
          ),
          class: "fl-ring",
        }),
      );
      add(sl.x + sl.y + 0.2 + (sl.z > 0.6 ? sl.z * 0.1 : 0), a);
      const tk = tagKind(p);
      if (k === "jam")
        C.tags.push({
          at: top,
          text: p.status === "paused" ? `#${p.number} paused` : `#${p.number}`,
          kind: tk || "plain",
          lift: 6,
        });
      else if (tk) C.tags.push({ at: top, text: `#${p.number}`, kind: tk, lift: sl.lift ?? 22 });
      // a robot holding a ticket off the benches stands beside its parcel
      if (p.who) {
        const [rx, ry] = floorBeside(k, sl);
        const { g } = floorRobot(rx, ry, p.who.no, false);
        const ra = linkFor(p, "fl-robot");
        ra.setAttribute("data-agent", p.agentId);
        ra.append(
          g,
          svgEl("polygon", {
            points: fHull(rx - 0.28, ry - 0.28, 0, 0.56, 0.56, 1.55),
            class: "fl-ring",
          }),
        );
        add(rx + ry + 0.3, ra);
      }
    });
    if (list.length > slots.length) {
      const last = slots[slots.length - 1];
      C.tags.push({
        at: fP(last.x, last.y, last.z + 0.5),
        text: `+${list.length - slots.length}`,
        kind: "plain",
        lift: 8,
      });
    }
  }
  // robots on the benches, each carrying the parcel of the ticket it holds
  benchRobots.forEach((p, idx) => {
    const x = fBenchX(idx) - 0.12;
    const y = 2.8;
    const { g, top } = floorRobot(x, y, p.who.no, true);
    const a = linkFor(p, "fl-parcel fl-robot");
    a.setAttribute("data-agent", p.agentId);
    const inner = svgEl("g", { class: "fl-bot-wrap", style: `--i:${idx}` });
    inner.append(g);
    a.append(
      inner,
      svgEl("polygon", {
        points: fHull(x - 0.28, y - 0.28, 0, 1.08, 0.56, 1.55),
        class: "fl-ring",
      }),
    );
    add(x + y + 0.3, a);
    if (p.needs) C.tags.push({ at: top, text: `#${p.number}`, kind: "needs", lift: 18 });
  });

  C.items.sort((a, b) => a.depth - b.depth);
  const vb = [-410, -56, 930, 580];
  for (const t of C.tags) t.w = Math.max(34, t.text.length * 7.4 + 14);
  fPlaceTags(C.tags, C.obstacles, vb);
  const tagLayer = svgEl("g", { class: "fl-tags", "aria-hidden": "true" });
  for (const t of C.tags) {
    const [x, y] = t.at;
    const [bx, by, w, h] = t.box;
    const [x0, y0, x1, y1] = fLeader(x, y, bx, by, w, h);
    const straight = Math.abs(x1 - x0) < 1;
    tagLayer.append(
      svgEl("g", { class: `fl-tag fl-tag-${t.kind}` }, [
        svgEl("path", {
          d: `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`,
          class: "fl-tag-stem",
        }),
        straight ? null : svgEl("circle", { cx: x, cy: y - 2, r: 2.6, class: "fl-tag-dot" }),
        svgEl("rect", { x: bx, y: by, width: w, height: h, rx: 2, class: "fl-tag-box" }),
        svgEl(
          "text",
          { x: bx + w / 2, y: by + 14.5, "text-anchor": "middle", class: "fl-tag-text" },
          t.text,
        ),
      ]),
    );
  }
  const world = svgEl("g", { class: "fl-world" }, [floor, ...C.items.map((i) => i.node)]);
  const signLayer = svgEl("g", { class: "fl-signs", "aria-hidden": "true" }, C.signs);
  const svg = svgEl(
    "svg",
    {
      viewBox: vb.join(" "),
      class: "fl-svg",
      role: "group",
      "aria-label":
        "The factory floor, drawn from live data. Every parcel, robot and station is a link.",
    },
    [world, signLayer, tagLayer],
  );
  // The drawing itself is no Tab stop (Chromium made it one); its links are.
  svg.setAttribute("tabindex", "-1");
  floorTabOrder(svg);
  return svg;
}

/**
 * The drawing is painted back to front (its DOM order is depth), so the browser's
 * Tab order wandered: Drawing office, three of its parcels, Stores, then two more
 * drawing-office parcels. Tab and Shift+Tab inside the floor follow the stations
 * instead, in lifecycle order: each station, then its parcels and robots by ticket
 * number, the desk last. Leaving the floor at either end is the browser's own Tab.
 */
function floorTabOrder(svg) {
  const rank = (a) => {
    const k = a.dataset.station || FLOOR_STATION_OF[a.dataset.status] || "desk";
    const i = FLOOR_ORDER.indexOf(k);
    return [i < 0 ? FLOOR_ORDER.length : i, a.dataset.station ? 0 : 1, Number(a.dataset.n) || 0];
  };
  const ordered = () =>
    [...svg.querySelectorAll("a.fl-hit")]
      .map((a, dom) => ({ a, dom, r: rank(a) }))
      .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.r[2] - y.r[2] || x.dom - y.dom)
      .map((x) => x.a);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = ordered();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = list[i + (e.shiftKey ? -1 : 1)];
    if (next) {
      e.preventDefault();
      next.focus();
      return;
    }
    // Off the end: hand the browser the anchor at that end of the DOM, and its own
    // Tab carries on out of the floor from there.
    const all = [...svg.querySelectorAll("a.fl-hit")];
    all[e.shiftKey ? 0 : all.length - 1]?.focus();
  });
  // Tabbing IN lands on the first station going forward, the last thing going back
  // (a click focuses what was clicked: only keyboard entry is redirected).
  let pointing = false;
  svg.addEventListener("pointerdown", () => {
    pointing = true;
    setTimeout(() => (pointing = false), 0);
  });
  svg.addEventListener("focusin", (e) => {
    const from = e.relatedTarget;
    if (pointing || !from || (from !== svg && svg.contains(from))) return;
    if (!e.target.closest?.("a.fl-hit")) return;
    const list = ordered();
    const forward = Boolean(from.compareDocumentPosition(svg) & from.DOCUMENT_POSITION_FOLLOWING);
    const want = forward ? list[0] : list[list.length - 1];
    if (want && want !== e.target) want.focus();
  });
}

/**
 * The hover and focus card: the ticket number and title (and what the floor says
 * about it), kept inside the stage so it can never widen the page.
 */
function wireFloorTips(stage, tip) {
  const show = (a) => {
    clear(tip);
    const n = a.getAttribute("data-n");
    const label = a.getAttribute("aria-label") || "";
    if (n) {
      const title = a.getAttribute("data-tip-title") || "";
      const rest = label.slice(`#${n} ${title}`.length).replace(/^,\s*/, "");
      tip.append(
        el("b", {}, `#${n}`),
        " ",
        el("span", { class: "fl-tip-title" }, title),
        rest ? el("span", { class: "fl-tip-sub" }, rest) : null,
      );
    } else tip.append(el("span", { class: "fl-tip-title" }, label.replace(/ Open in Work\.$/, "")));
    tip.hidden = false;
    const sr = stage.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left - sr.left + r.width / 2 - tw / 2;
    let y = r.top - sr.top - th - 8;
    if (y < 4) y = r.bottom - sr.top + 8;
    x = Math.max(4, Math.min(sr.width - tw - 4, x));
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  const hitOf = (e) => (e.target && e.target.closest ? e.target.closest("a.fl-hit") : null);
  stage.addEventListener("pointerover", (e) => {
    const a = hitOf(e);
    if (a) show(a);
  });
  stage.addEventListener("pointerout", (e) => {
    const a = hitOf(e);
    if (a && !a.contains(e.relatedTarget)) hide();
  });
  stage.addEventListener("focusin", (e) => {
    const a = hitOf(e);
    if (a) show(a);
  });
  stage.addEventListener("focusout", hide);
}

/** The stream's state in the floor's words (null while live or still connecting). */
function floorStreamLine() {
  const st = freshness.state();
  if (st === "offline") {
    const at = freshness.lastOkAt;
    return at
      ? `Can't reach the factory: this is the floor as it stood at ${clockTime(at)}. It moves again when the factory answers.`
      : "Can't reach the factory: the floor moves again when the factory answers.";
  }
  if (st === "polling")
    return "The live stream is down: the floor redraws every 9 seconds instead of the moment a ticket moves.";
  return null;
}

let floorArrived = false;
let floorBootAt = 0;
/** #/floor: the factory floor, live. */
async function renderFloor() {
  const f = await loadMatchDay();
  const m = floorModel(f);
  const wrap = el("div", { class: "view view-floor" });
  const robots = m.robots.length;
  const jam = (m.byStation.jam || []).length;
  const facts = [
    plural(m.open.length, "parcel") + " on the floor",
    `${plural(robots, "robot")} on ${plural(m.benches, "bench", "benches")}`,
    `${jam} in the jam bay`,
    `${m.despatched.length} despatched today`,
    m.today == null
      ? "no wage bill recorded today"
      : m.budget
        ? `${money(m.today)} of the ${moneyW(m.budget)} wage bill`
        : `${money(m.today)} wage bill today`,
  ];
  wrap.appendChild(
    viewHead(
      "Floor",
      "The factory floor: every ticket as a parcel moving station to station, every agent a robot on the one it holds.",
    ),
  );
  wrap.appendChild(el("p", { class: "fl-facts" }, facts.join(" · ")));

  // The stream line lives outside the data signature: it follows the tracker.
  const streamP = el("p", { class: "fl-stream", hidden: true });
  const paintStream = () => {
    // A page that has only just loaded is still connecting: give the stream a moment.
    const line = floorStreamLine();
    const early = Date.now() - floorBootAt < 6000 && freshness.state() === "polling";
    streamP.hidden = !line || early;
    clear(streamP);
    if (line && !early) streamP.append(glyph("blocked", 16), el("span", {}, line));
  };
  if (!floorBootAt) floorBootAt = Date.now();
  paintStream();
  freshness.listeners.add(paintStream);
  const streamTimer = setTimeout(paintStream, 6500);
  wrap.appendChild(streamP);

  // Quiet whenever no parcel is in play, not only before the first despatch: after
  // the day's last merge the floor is just as empty, so say so, with the day's count.
  if (!m.open.length)
    wrap.appendChild(
      el("div", { class: "empty-state fl-quiet" }, [
        el(
          "p",
          { class: "es-title" },
          m.despatched.length
            ? [
                `The floor is quiet: no tickets in play, ${m.despatched.length} despatched today. `,
                el("a", { href: "#/create" }, "Plan a build"),
                " to start the next one.",
              ]
            : [
                "The floor is quiet: no tickets in play. ",
                el("a", { href: "#/create" }, "Plan a build"),
                " to start the shift.",
              ],
        ),
      ]),
    );

  const svg = floorScene(m);
  if (!floorArrived && !prefersReducedMotion()) svg.classList.add("is-arriving");
  const tip = el("div", { class: "fl-tip", "aria-hidden": "true", hidden: true });
  const stage = el("div", { class: "fl-stage" }, [svg, tip]);
  wireFloorTips(stage, tip);

  // The key and the text of the floor: stations in lifecycle order with their
  // tickets, and who is on the benches (shirt, name, ticket).
  const key = el("ul", { class: "fl-key", "aria-label": "Key" }, [
    el("li", {}, [el("i", { class: "fl-sw fl-sw-needs" }), "Needs you"]),
    el("li", {}, [el("i", { class: "fl-sw fl-sw-red" }), "Blocked or failed"]),
    el("li", {}, [el("i", { class: "fl-sw fl-sw-lit" }), "Lit glass: the station holds work"]),
    el("li", {}, [
      el("i", { class: "fl-sw fl-sw-bot" }),
      "A robot: an agent (shirt number) on a live claim",
    ]),
    el("li", {}, [
      el("i", { class: "fl-sw fl-sw-tank" }),
      "Tank: today's wage bill against the daily budget",
    ]),
  ]);
  const stations = el(
    "ol",
    { class: "fl-stations", "aria-label": "Stations, in lifecycle order" },
    FLOOR_ORDER.map((k) => {
      const st = FLOOR_STATIONS[k];
      const list = m.byStation[k] || [];
      return el("li", { dataset: { station: k } }, [
        el("i", { class: `fl-sw fl-sw-${k}`, "aria-hidden": "true" }),
        el("span", { class: "fl-st-name" }, st.name),
        el(
          "span",
          { class: "fl-st-what" },
          k === "despatch"
            ? "done today"
            : st.statuses.map((s) => statusLabel(s).toLowerCase()).join(", "),
        ),
        el("span", { class: "fl-st-n tabnum" }, String(list.length)),
        list.length
          ? el(
              "span",
              { class: "fl-st-tickets" },
              list.map((p) =>
                el("a", { href: `#/ticket/${p.id}`, title: p.title }, `#${p.number}`),
              ),
            )
          : null,
      ]);
    }),
  );
  const bench = el("div", { class: "fl-bench" }, [
    el("h3", {}, "On the benches"),
    m.robots.length
      ? el(
          "ul",
          {},
          m.robots.map((p) =>
            el("li", {}, [
              agentTag(p.who.name, 22, p.who.no, agentTitle(p.who)),
              el("a", { href: `#/ticket/${p.id}` }, [el("b", {}, `#${p.number}`), " ", p.title]),
              el(
                "span",
                { class: "fl-bench-st" },
                FLOOR_WORDS[p.status] || statusLabel(p.status, p.landing_state),
              ),
            ]),
          ),
        )
      : el("p", {}, `No robot is on the floor: ${plural(m.benches, "bench", "benches")} free.`),
  ]);
  wrap.appendChild(
    el("section", { class: "fl-panel", "aria-labelledby": "fl-h" }, [
      el("div", { class: "fl-head" }, [
        el("h2", { id: "fl-h", class: "fl-title" }, [
          "The floor",
          el("span", { class: "panel-aux" }, `${m.open.length} in play`),
        ]),
        el(
          "p",
          { class: "fl-note" },
          "The line runs from the drawing office to the lorry; the jam bay is off it. Hover or focus a parcel for its ticket.",
        ),
      ]),
      stage,
      el("div", { class: "fl-legend" }, [key, el("div", { class: "fl-lists" }, [stations, bench])]),
    ]),
  );

  wrap.dataset.sig = hashText(
    JSON.stringify([
      [...m.open, ...m.despatched].map((p) => [
        p.id,
        p.status,
        p.title,
        p.needs,
        p.who && [p.who.name, p.who.no],
        p.by && [p.by.name, p.by.no],
        p.running,
      ]),
      m.benches,
      m.decisions,
      m.today,
      m.budget,
    ]),
  );
  wrap._mounted = () => {
    floorArrived = true;
  };
  wrap._dispose = () => {
    freshness.listeners.delete(paintStream);
    clearTimeout(streamTimer);
  };
  return wrap;
}
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

export {
  openPlanBuild,
  mountPlanBuildInline,
  resolveTargetRepos,
  targetPicker,
  openSpecBuild,
  onboardButton,
  SPEC_STATUS_LABEL,
  renderSpecs,
  specGapCount,
  specCoverageRollup,
  renderMemory,
  openClubSheet,
  renderSquad,
  renderFloor,
};
