// Plan a build: the decompose chat panel (a docked, mobile-first sheet).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { readOnly, roLockAll } from "../access.js";
import { api } from "../api.js";
import { clear, el, field, prefersReducedMotion } from "../dom.js";
import { plural } from "../format.js";
import { badge, icon, kitShirt, repoTag } from "../icons.js";
import { allTickets } from "../matchday.js";
import { navigate, router } from "../router.js";
import { guard, toast } from "../toast.js";
import { typeLabel } from "./map.js";

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

export { openPlanBuild, mountPlanBuildInline, resolveTargetRepos, targetPicker };
