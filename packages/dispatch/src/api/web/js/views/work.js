// View: Work, one ticket surface, board and list, filters kept in the URL.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { readOnly, roLock } from "../access.js";
import { api } from "../api.js";
import { ensureSquad, learnAgents } from "../club.js";
import { viewHead } from "../components.js";
import { el, field } from "../dom.js";
import { moneyW, plural } from "../format.js";
import { busyEditing } from "../live.js";
import { allTickets } from "../matchday.js";
import { navigate, parseHash, routeSignal, router } from "../router.js";
import { closeSheet, openSheet } from "../sheet.js";
import { appState } from "../state.js";
import { hasTicketAction, statusLabel } from "../status.js";
import { runAsyncAction, runAsyncActionUntilDone, toast } from "../toast.js";
import { renderBoard, renderClaimsPanel, renderWorkList } from "./board.js";
import { isModalOpen } from "./review-comments.js";
import { typeLabel } from "../../app.js";

// ===========================================================================
//  View: Work — one ticket surface, board ⇄ list, filters persist in URL
//  Replaces Board + Backlog + Claims. Claims surface as a folded panel.
// ===========================================================================

const TICKET_STATUSES = [
  "draft",
  "refining",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "in_review",
  "in_testing",
  "ready_for_merge",
  "done",
  "failed",
  "cancelled",
  "paused",
];
const RISK_LEVELS = ["low", "medium", "high", "critical"];
const BOARD_COLUMN_LABELS = {
  draft: "Draft",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  in_testing: "In testing",
  // The comp's lane head; one line at 1440, and the header line's own words.
  ready_for_merge: "Ready for merge",
  done: "Done",
};

// Work-view state, seeded from the URL query so filters/mode are shareable.
const workState = { mode: "board", status: "", repo: "", risk: "", q: "" };

function readWorkStateFromUrl() {
  const { query } = parseHash();
  workState.mode = query.get("mode") === "list" ? "list" : "board";
  workState.status = query.get("status") || "";
  workState.repo = query.get("repo") || "";
  workState.risk = query.get("risk") || "";
  workState.q = query.get("q") || "";
}
/** The Work address for the current mode and filters (the number-or-title filter too). */
function workUrl() {
  const qs = new URLSearchParams();
  if (workState.mode === "list") qs.set("mode", "list");
  if (workState.status) qs.set("status", workState.status);
  if (workState.repo) qs.set("repo", workState.repo);
  if (workState.risk) qs.set("risk", workState.risk);
  if (workState.q.trim()) qs.set("q", workState.q.trim());
  const q = qs.toString();
  return `#/work${q ? `?${q}` : ""}`;
}
function writeWorkStateToUrl() {
  navigate(workUrl());
}

/**
 * "Suggest work" — opens a target picker (Feature B) so the operator chooses a
 * single repo (repo-level) OR a scope node (node-level, fanned out server-side
 * to the node's repos), then kicks off the headless product-owner run.
 */
function suggestWorkButton(repos, nodes) {
  return roLock(
    el(
      "button",
      {
        class: "btn",
        type: "button",
        title: "Run the product-owner skill to propose new draft tickets",
        onclick: () => openSuggestWorkPicker(repos, nodes),
      },
      "Suggest work",
    ),
  );
}

/**
 * "Poll for work" — nudge the factory to run one tick now (POST /poll-work)
 * instead of waiting for its next scheduled cycle. Fire-and-gaffert: the tick runs
 * async, so we show an immediate running state, then refresh the board so any
 * freshly-claimed work surfaces. A NOT_CONFIGURED (no DISPATCH_TICK_CMD) toasts
 * its message via the shared guard.
 */
function pollWorkButton() {
  const btn = el(
    "button",
    {
      class: "btn primary",
      type: "button",
      title:
        "Run one factory tick now, so ready work is picked up without waiting for the next cycle",
      onclick: () =>
        runAsyncAction(btn, "Polling…", async () => {
          // A live tick needs a dollar cap (the runner refuses one without). With
          // neither budget set, ask for one first instead of firing a refused poll.
          if (!(await spendCapSet())) {
            openSpendCapSheet(() => runAsyncAction(btn, "Polling…", firePoll));
            return;
          }
          await firePoll();
        }),
    },
    [el("span", {}, "Poll for work")],
  );
  return roLock(btn);
}

/** Fire one tick (POST /poll-work) and say what it is doing. */
async function firePoll() {
  const res = await api("POST", "/poll-work");
  // The server refused for the runner (no dollar cap): say why, in the runner's words.
  if (res && res.polled === false && res.reason !== "no_ready_work" && res.message) {
    toast(`Poll refused — ${res.message}`, {});
    return;
  }
  if (res && res.polled === false) {
    toast(
      "Nothing for a tick to do — ready a ticket, press Continue on a paused one, or turn on maintenance when idle in Settings → Idle loops.",
      {},
    );
    return;
  }
  const p = (res && res.pending) || {};
  if (res && res.idle === "maintenance") {
    toast("No ready work — running the idle maintenance lane…", { ok: true });
  } else if (!res || res.readyCount > 0) {
    toast("Factory tick fired — refreshing the board…", { ok: true });
  } else if (p.resume > 0) {
    toast("Continuing the paused delivery…", { ok: true });
  } else if (p.review > 0) {
    toast("Running the reviewer agent on a ticket in Review…", { ok: true });
  } else if (p.testing > 0) {
    toast("Running the tester on a ticket in Testing…", { ok: true });
  } else if (p.merge > 0) {
    toast("Landing the approved work (merge lane)…", { ok: true });
  } else toast("Clarifying a draft (intake pass)…", { ok: true });
  router();
  // The tick runs detached, so a poll the runner REFUSES (a per-day tick or
  // USD cap already reached) would otherwise read as "fired". Watch the run
  // briefly — poll-once.sh refuses within a second or two — and say so.
  const runId = res && res.run && res.run.runId;
  if (runId) void reportPollRefusal(runId);
}

/** The two dollar caps a live run accepts (runner/lib/budget.sh gaffer_spend_cap_ok). */
const SPEND_CAP_KEYS = ["GAFFER_DAILY_BUDGET_USD", "GAFFER_BUDGET_USD"];

/**
 * Is a dollar cap in force? True when either budget is a positive figure, and
 * also when it cannot be told (settings unreadable, or the caps are set in the
 * environment): the runner makes the final call and its refusal is toasted.
 */
async function spendCapSet() {
  let list;
  try {
    list = (await api("GET", "/api/settings")).settings || [];
  } catch (x) {
    if (x && x.code === "UNAUTHORIZED") throw x;
    return true;
  }
  const rows = SPEND_CAP_KEYS.map((k) => list.find((s) => s.key === k)).filter(Boolean);
  if (!rows.length || rows.some((s) => s.envLocked)) return true;
  return rows.some((s) => {
    const v = Number(s.effective ?? s.value);
    return Number.isFinite(v) && v > 0;
  });
}

/**
 * The first live run's dollar cap: a daily budget prefilled at $5, saved to
 * settings.json (the runner re-reads it before every tick), then `onSaved` runs
 * the poll the operator asked for. Cancel leaves everything as it was.
 */
function openSpendCapSheet(onSaved) {
  const input = el("input", {
    type: "number",
    name: "daily-budget",
    id: "spend-cap-usd",
    min: "0.01",
    step: "0.01",
    inputmode: "decimal",
    value: "5",
    "aria-describedby": "spend-cap-hint",
  });
  const err = el("p", { class: "form-error", role: "alert", hidden: "" });
  const save = el(
    "button",
    { class: "btn primary spend-cap-save", type: "submit" },
    "Save and poll",
  );
  const form = el(
    "form",
    {
      class: "act-sheet spend-cap-form",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const v = Number(String(input.value).trim());
        if (!Number.isFinite(v) || v <= 0) {
          err.textContent = "Enter a daily budget above $0, for example 5.";
          err.hidden = false;
          input.setAttribute("aria-invalid", "true");
          input.focus();
          return;
        }
        input.removeAttribute("aria-invalid");
        save.disabled = true;
        try {
          const res = await api("POST", "/api/settings", {
            settings: { GAFFER_DAILY_BUDGET_USD: String(v) },
          });
          if (!(res.written || []).includes("GAFFER_DAILY_BUDGET_USD")) {
            err.textContent =
              "The daily budget was not saved. It may be set in the environment: check Settings → Budget & caps.";
            err.hidden = false;
            return;
          }
          closeSheet();
          toast(`Daily budget set: ${moneyW(v)} a day.`, { ok: true });
          onSaved();
        } catch (x) {
          if (x && x.code === "UNAUTHORIZED") return;
          err.textContent = (x && x.message) || "The daily budget could not be saved.";
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
        "A live run needs a dollar cap first. Once today's spend reaches it, the factory starts no new paid work until tomorrow (UTC).",
      ),
      field("Daily budget (USD)", input),
      el(
        "p",
        { class: "act-hint", id: "spend-cap-hint" },
        "Change it any time in Settings → Budget & caps. A lifetime ceiling there also counts.",
      ),
      err,
      el("div", { class: "btn-row act-actions" }, [
        save,
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      ]),
    ],
  );
  openSheet("Set a daily budget", form, { focus: input });
}

/**
 * Follow a just-fired poll run for a few seconds; when the runner refused it (the
 * run's outcome is REFUSED — a cap is reached or a setup check failed closed), toast
 * the runner's own reason instead of leaving the earlier "fired" toast standing.
 */
async function reportPollRefusal(runId) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 600));
    let detail;
    try {
      detail = (await api("GET", `/api/runs/${encodeURIComponent(runId)}`)).detail;
    } catch {
      return;
    }
    if (!detail || detail.run.status === "running") continue;
    if (detail.outcome === "REFUSED") {
      const line = String(detail.log_tail || "")
        .split("\n")
        .find((l) => l.startsWith("gaffer poll: "));
      toast(
        `Poll refused — ${line ? line.replace(/^gaffer poll: /, "") : "a cap is reached; see the run log."}`,
        {},
      );
    }
    return;
  }
}

/** The repo-level / node-level target picker for "Suggest work" (Feature B). */
function openSuggestWorkPicker(repos, nodes) {
  const state = { level: "repo" };

  const repoSel = el("select", {}, [
    el("option", { value: "" }, repos.length ? "Select a repo…" : "No repos yet"),
    ...repos.map((r) => el("option", { value: r.name }, r.name)),
  ]);
  const nodeSel = el("select", {}, [
    el("option", { value: "" }, nodes.length ? "Select a scope node…" : "No scope nodes yet"),
    ...nodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);

  const repoBlock = el("div", { class: "where-block" }, [field("Repository", repoSel)]);
  const nodeBlock = el("div", { class: "where-block" }, [
    field("Ground (scope node)", nodeSel),
    el(
      "p",
      { class: "mode-note dim" },
      "Runs the product-owner once per repo mapped to this node (bounded).",
    ),
  ]);

  const repoMode = el("input", { type: "radio", name: "po-level", value: "repo", checked: "" });
  const nodeMode = el("input", { type: "radio", name: "po-level", value: "node" });
  const applyMode = () => {
    repoBlock.hidden = state.level !== "repo";
    nodeBlock.hidden = state.level !== "node";
  };
  repoMode.addEventListener("change", () => {
    if (repoMode.checked) {
      state.level = "repo";
      applyMode();
    }
  });
  nodeMode.addEventListener("change", () => {
    if (nodeMode.checked) {
      state.level = "node";
      applyMode();
    }
  });
  applyMode();

  const runBtn = el("button", { class: "btn primary", type: "submit" }, "Run product-owner");
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        let body;
        if (state.level === "repo") {
          if (!repoSel.value) {
            toast("Pick a repo to target.");
            return;
          }
          body = { repo: repoSel.value };
        } else {
          if (!nodeSel.value) {
            toast("Pick a scope node to target.");
            return;
          }
          body = { scopeNodeId: nodeSel.value };
        }
        // RUN-ACTIVITY: keep the button "running" until the REAL product-owner
        // run finishes (not just the millisecond spawn-ack, which is the bug this
        // fixes). `fn` returns the tracked run id(s); runAsyncActionUntilDone keeps
        // the button disabled + spinning while any of them is active (polling
        // GET /api/runs), then restores it. The "Running now" panel reflects the
        // same run live in parallel.
        runAsyncActionUntilDone(runBtn, "Suggesting work…", async () => {
          const res = await api("POST", "/product-owner/runs", body);
          const t = res.target || {};
          const msg =
            t.level === "node"
              ? `Node run started for '${t.scope_node_name || ""}' — ${res.ran ?? 0} repo${res.ran === 1 ? "" : "s"}${res.truncated ? " (truncated)" : ""}.`
              : `Repo run started for '${t.repo || repoSel.value}'.`;
          toast(msg, { ok: true });
          // Surface the live run in the Overview panel immediately, but keep this
          // sheet open so the button itself stays in its true running state until
          // the run flips (the whole point of the fix).
          // Collect the tracked run id(s) to wait on: node-level fans out to
          // res.runs[].run.runId; repo-level is res.run.runId.
          if (t.level === "node") {
            return (res.runs || []).map((r) => r.run && r.run.runId).filter(Boolean);
          }
          return res.run && res.run.runId ? [res.run.runId] : [];
        }).then(() => {
          // Run finished (or the safety cap elapsed) — close the sheet and refresh.
          closeSheet();
          router();
        });
      },
    },
    [
      el(
        "p",
        { class: "suggest-intro" },
        "The product owner reads the code and proposes new tickets. They arrive in the Draft lane for you to read before anything is readied.",
      ),
      el("div", { class: "mode-toggle", role: "radiogroup", "aria-label": "What to scout" }, [
        el("label", { class: "mode-option" }, [
          repoMode,
          el("span", {}, [
            el("strong", {}, "One repo"),
            el("span", { class: "dim" }, "Scout a single repository"),
          ]),
        ]),
        el("label", { class: "mode-option" }, [
          nodeMode,
          el("span", {}, [
            el("strong", {}, "A ground"),
            el("span", { class: "dim" }, "Every repo on one Map node"),
          ]),
        ]),
      ]),
      repoBlock,
      nodeBlock,
      el("div", { class: "btn-row" }, [runBtn]),
    ],
  );

  form.classList.add("suggest-form");
  openSheet("Suggest work", form);
}

// Repos + scope nodes change rarely; the 9s refresh reuses them for a minute
// instead of re-fetching both on every tick (board-unbounded-render).
const WORK_REF_TTL_MS = 60000;
async function workReference() {
  if (appState.workRefCache && Date.now() - appState.workRefCache.at < WORK_REF_TTL_MS)
    return appState.workRefCache;
  const [reposRes, nodesRes] = await Promise.all([
    api("GET", "/repositories"),
    // A scoped token does not read the map (factory-wide): no nodes, the board still draws.
    api("GET", "/scope/nodes").catch((e) => {
      if (e && e.code === "SCOPE_DENIED") return { nodes: [] };
      throw e;
    }),
  ]);
  appState.workRefCache = {
    at: Date.now(),
    repos: reposRes.repositories || [],
    nodes: nodesRes.nodes || [],
  };
  return appState.workRefCache;
}

// --- View: Work (the board on mown lanes, and the list as a league table) ----
//
// The comp's Work board: scoreboard-black lane heads with their true counts over
// mown-grass lanes, paper cards with a hard counter shadow, a yellow card on what
// waits on you and a red frame on what is blocked. A card is an <article>: its
// title is the link (stretched over the card), so Move, the repo and the by-hand
// actions are real buttons beside it, never inside a link. On a phone the lanes
// stack in urgency order and fold, and the fold a viewer chose survives the 9s
// refresh. The list is a league table, most urgent first.

/** Urgency, the list's sort (the phone's lane order is the same, in CSS): paused with blocked, refining with draft … */
const STATUS_URGENCY = {
  blocked: 0,
  paused: 0,
  failed: 0,
  in_review: 1,
  claimed: 2,
  in_progress: 2,
  ready_for_merge: 3,
  in_testing: 4,
  ready: 5,
  draft: 6,
  refining: 6,
  done: 7,
  cancelled: 8,
};
/** True at phone width (≤760px); false where matchMedia is absent (tests). */
function isPhoneWidth() {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
}
// Phone lanes fold. What the viewer opened or closed is kept for the session, so
// the 9s refresh never re-folds a lane they are reading.
const laneOpenState = new Map();
function laneStartsOpen(column, count) {
  if (laneOpenState.has(column)) return laneOpenState.get(column);
  return count > 0 && column !== "draft" && column !== "done";
}

/**
 * Who waits on you, by ticket id: the server's human queue (the Overview's team
 * sheet reads the same list). Without it, the statuses that always wait on a
 * person stand in: a review, an approved merge, a blocked ticket.
 */
function workNeeds(queue) {
  const items = queue && Array.isArray(queue.items) ? queue.items : null;
  const map = new Map();
  if (!items) return { map, fallback: true };
  for (const it of items) if (it && it.ticket && it.ticket.id) map.set(it.ticket.id, it.label);
  return { map, fallback: false };
}
function needsLabel(t, needs) {
  if (!needs || needs.fallback) {
    if (t.status === "in_review") return "Review sign-off";
    if (t.status === "ready_for_merge") return "Approved, not merged";
    if (t.status === "blocked") return "Blocked";
    return null;
  }
  return needs.map.get(t.id) || null;
}

/** A card or row matches the filters (repo is filtered by the server). */
function workMatches(t) {
  if (workState.status && t.status !== workState.status) return false;
  if (workState.risk && t.risk_level !== workState.risk) return false;
  // "#6" is that ticket and no other; a bare "6" is ticket 6 or a title with a 6
  // in it (never #16 or #26); anything else is a title search.
  const q = workState.q.trim().toLowerCase();
  if (q) {
    const title = (t.title || "").toLowerCase();
    const num = /^#?(\d+)$/.exec(q);
    if (num) {
      const exact = String(t.number) === String(Number(num[1]));
      if (q.startsWith("#") ? !exact : !exact && !title.includes(num[1])) return false;
    } else if (!title.includes(q.replace(/^#/, ""))) return false;
  }
  return true;
}
function workFiltered() {
  return Boolean(workState.status || workState.risk || workState.q.trim() || workState.repo);
}

async function renderWork() {
  readWorkStateFromUrl();
  const signal = routeSignal();
  const get = (p) => api("GET", p, undefined, { signal });

  // The board endpoint powers the board; the filtered /tickets list powers list
  // mode (list mode does not fetch the board at all). Repos + scope nodes feed the
  // "Suggest work" target picker (Feature B) and the repo filter. The human queue
  // says which cards wait on you; the claims say who is on the pitch.
  // The board is fetched as a VISIBLE WINDOW (WORK_BOARD_WINDOW cards per lane, Done
  // newest first) plus whole-board counts: a factory with tens of thousands of
  // historical tickets once shipped every card to render ~60 per lane (and the
  // unfiltered board failed outright at 32,767 tickets). The rest is one link away in
  // the List view, which filters server-side.
  const boardParams = new URLSearchParams({ limit: String(WORK_BOARD_WINDOW) });
  if (workState.repo) boardParams.set("repo", workState.repo);
  const boardQs = `?${boardParams}`;
  const listQs = new URLSearchParams();
  if (workState.status) listQs.set("status", workState.status);
  if (workState.repo) listQs.set("repo", workState.repo);
  if (workState.risk) listQs.set("risk", workState.risk);
  const list = workState.mode === "list";
  const [board, listRes, ref, claimsRes, queue] = await Promise.all([
    list ? null : get(`/api/board${boardQs}`),
    list ? allTickets(listQs.toString(), { signal }) : null,
    workReference(),
    get("/claims"),
    get("/api/human-queue").catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return null;
    }),
    ensureSquad(),
  ]);
  const { repos, nodes } = ref;
  const counts = (board && board.counts) || null;
  // Each lane carries its TRUE size (`total`), whatever the window loaded.
  const columns = ((board && board.columns) || []).map((c) => ({
    ...c,
    total: counts && counts.columns ? (counts.columns[c.column] ?? c.cards.length) : undefined,
  }));
  const closed = (board && board.closed) || [];
  const wontDo = (board && board.wontDo) || [];
  const totals = counts ? { closed: counts.closed, wontDo: counts.wontDo } : null;
  const tickets = (listRes && listRes.tickets) || [];
  const claims = (claimsRes && claimsRes.claims) || [];
  learnAgents(claims);
  const needs = workNeeds(queue);
  const readAt = Date.now();

  const wrap = el("div", { class: `view view-work is-${workState.mode}` });

  // The line under the title and the flow bar count what the lanes show: with a
  // filter on they count the matching cards (BRIEF §2: header counts equal lane
  // counts), and they are redrawn as the viewer types.
  const subText = () =>
    list ? workListSummary(tickets, needs) : workSummaryLine(columns, closed, wontDo, totals);
  const head = viewHead("Work board", subText(), [
    pollWorkButton(),
    suggestWorkButton(repos, nodes),
  ]);
  let flow = list ? null : workFlowHeader(columns, closed);
  if (flow) head.querySelector(".view-head-main").appendChild(flow);
  const refreshHead = () => {
    const sub = head.querySelector(".view-sub");
    if (sub) sub.textContent = subText();
    if (!flow) return;
    const next = workFlowHeader(columns, closed);
    flow.replaceWith(next);
    flow = next;
  };
  wrap.appendChild(head);

  // The board or the list, rebuilt in place (no fetch) as the viewer types.
  const build = () =>
    list
      ? renderWorkList(tickets, needs, claims)
      : renderBoard(columns, closed, wontDo, needs, totals);
  let main = build();
  const toolbar = renderWorkToolbar(repos, () => {
    const next = build();
    main.replaceWith(next);
    main = next;
    refreshHead();
  });
  wrap.appendChild(toolbar);
  wrap.appendChild(main);

  wrap.appendChild(renderClaimsPanel(claims, readAt));

  // "/" puts the cursor in the filter, as in most boards; the phone/desktop lane
  // heads swap when the width crosses 760px.
  const onKey = (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!wrap.isConnected || isModalOpen() || busyEditing()) return;
    const input = wrap.querySelector(".work-q");
    if (!input) return;
    e.preventDefault();
    input.focus();
    input.select();
  };
  document.addEventListener("keydown", onKey);
  const mq =
    typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 760px)") : null;
  const onWidth = () => {
    if (list || !wrap.isConnected) return;
    const next = build();
    main.replaceWith(next);
    main = next;
  };
  if (mq && mq.addEventListener) mq.addEventListener("change", onWidth);
  wrap._dispose = () => {
    document.removeEventListener("keydown", onKey);
    if (mq && mq.removeEventListener) mq.removeEventListener("change", onWidth);
  };

  // Change signature: an unchanged board (same payload, same filters) is not
  // re-rendered by the background refresh, so nothing on it moves.
  const needSig = [...needs.map.entries()].map(([k, v]) => `${k}:${v}`).join(",");
  wrap.dataset.sig = `${hashText(JSON.stringify(board || tickets))}:${location.hash}:${hashText(JSON.stringify(claims))}:${hashText(needSig)}`;

  return wrap;
}

/** A short, stable hash of a string (djb2) for change signatures. */
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * One set of board counts, used by the header line, the flow strip and the lane
 * heads alike, so they can never disagree (work-shipped-count-wrong):
 *   live    = every lane except Done (draft … ready for merge)
 *   shipped = the Done lane
 *   failed  = the closed area (the board puts only `failed` tickets there)
 *   wontDo  = cancelled
 */
function boardCounts(columns, closed = [], wontDo = [], totals = null) {
  const by = {};
  for (const c of columns) by[c.column] = c.total ?? (c.cards || []).length;
  const live = Object.entries(by)
    .filter(([k]) => k !== "done")
    .reduce((n, [, v]) => n + v, 0);
  return {
    by,
    live,
    shipped: by.done || 0,
    failed: totals ? totals.closed : closed.length,
    wontDo: totals ? totals.wontDo : wontDo.length,
  };
}

/** Cards per lane the Work board loads (the API's visible window). */
const WORK_BOARD_WINDOW = 200;

/** True when some lane holds more cards than the window loaded. */
function boardTruncated(columns) {
  return columns.some((c) => c.total != null && c.total > (c.cards || []).length);
}

/**
 * The board's columns, closed and won't-do narrowed to the client-side filters.
 * Unfiltered, a lane keeps its true size (`total`); filtered, it counts the loaded
 * cards that match.
 */
function workVisible(columns, closed = [], wontDo = []) {
  const filtered = workFiltered();
  return {
    columns: columns.map((c) => {
      const cards = (c.cards || []).filter(workMatches);
      return { ...c, cards, total: filtered ? cards.length : (c.total ?? cards.length) };
    }),
    closed: closed.filter(workMatches),
    wontDo: wontDo.filter(workMatches),
  };
}
/** The client-side filters in words: “refund”, status blocked, high risk. */
function workFilterWords() {
  const words = [];
  const q = workState.q.trim();
  if (q) words.push(`\u201c${q}\u201d`);
  if (workState.status) words.push(`status ${statusLabel(workState.status).toLowerCase()}`);
  if (workState.risk) words.push(`${workState.risk} risk`);
  return words;
}

/**
 * "25 tickets in lanes: 6 draft · 4 ready … 6 done. 2 failed, listed under the board."
 * With a filter on: "4 of 25 tickets match “refund”: 1 draft · 1 blocked …", so
 * the line always equals the lane heads below it.
 */
function workSummaryLine(columns, closed = [], wontDo = [], totals = null) {
  const all = boardCounts(columns, closed, wontDo, totals);
  const vis = workVisible(columns, closed, wontDo);
  const counts = boardCounts(vis.columns, vis.closed, vis.wontDo, workFiltered() ? null : totals);
  const parts = columns
    .filter((c) => counts.by[c.column] > 0)
    // A count never wraps away from its lane name ("1 / done").
    .map((c) => {
      const word = (BOARD_COLUMN_LABELS[c.column] || c.column).toLowerCase();
      return `${counts.by[c.column]}\u00a0${word}`;
    });
  const extra = [];
  if (counts.failed) extra.push(`${counts.failed} failed`);
  if (counts.wontDo) extra.push(`${counts.wontDo} won't do`);
  const tail = extra.length ? ` ${extra.join(", ")}, listed under the board.` : "";
  const inLanes = counts.live + counts.shipped;
  const words = workFilterWords();
  const scope = workState.repo ? ` in ${workState.repo}` : "";
  if (!words.length)
    return (
      `${plural(inLanes, "ticket")}${scope ? `${scope}'s` : " in"} lanes${parts.length ? ": " + parts.join(" · ") : ""}.` +
      tail
    );
  const allInLanes = all.live + all.shipped;
  const what = words.join(", ");
  if (!inLanes && !extra.length)
    return `None of the ${plural(allInLanes, "ticket")}${scope} match ${what}.`;
  return (
    `${inLanes} of ${plural(allInLanes, "ticket")}${scope} ${inLanes === 1 ? "matches" : "match"} ${what}` +
    `${parts.length ? ": " + parts.join(" · ") : ""}.` +
    tail
  );
}

/** List mode's line: how many, in what order, and how many wait on you. */
function workListSummary(all, needs) {
  const tickets = all.filter(workMatches);
  const waiting = tickets.filter((t) => needsLabel(t, needs)).length;
  if (!tickets.length)
    return workFiltered() ? "No ticket matches these filters." : "No tickets yet.";
  const words = workFilterWords();
  const scope = workState.repo ? ` in ${workState.repo}` : "";
  const match = words.length
    ? ` ${tickets.length === 1 ? "matches" : "match"} ${words.join(", ")}`
    : "";
  return (
    `${plural(tickets.length, "ticket")}${scope}${match}, most urgent first.` +
    (waiting ? ` ${waiting} ${waiting === 1 ? "waits" : "wait"} on you.` : "")
  );
}

/** A flow-summary strip above the board: one cell per lane (built from the
 *  board's own columns, so none is ever left out) plus Failed, and a single
 *  distribution bar so the shape of the board reads before you scan the lanes.
 *  Shipped is the Done lane; failed tickets are counted as failed, never shipped. */
function workFlowHeader(allColumns, allClosed = []) {
  const vis = workVisible(allColumns, allClosed);
  const columns = vis.columns;
  const failed = vis.closed.length;
  const { by } = boardCounts(columns);
  const cells = columns.map((c) => ({
    key: c.column,
    label: c.column === "done" ? "Shipped" : BOARD_COLUMN_LABELS[c.column] || c.column,
    v: by[c.column] || 0,
  }));
  cells.push({ key: "failed", label: "Failed", v: failed });
  const flowTotal = Math.max(
    1,
    cells.reduce((n, c) => n + c.v, 0),
  );
  const seg = cells
    .filter((c) => c.v > 0)
    .map((c) =>
      el("span", {
        class: `wf-seg wf-${c.key}`,
        style: `width:${(c.v / flowTotal) * 100}%`,
        title: `${c.label}: ${c.v}`,
      }),
    );
  // The lane heads already carry each count, so this is one slim distribution
  // bar (the shape of the board before you scan it), its numbers in its name.
  const label = cells.map((c) => `${c.label} ${c.v}`).join(", ");
  return el(
    "div",
    {
      class: "work-flow",
      role: "img",
      "aria-label": `Tickets per lane: ${label}`,
      hidden: seg.length ? null : "",
    },
    [el("div", { class: "wf-bar" }, seg)],
  );
}

/**
 * The filter line: number-or-title (client-side, as you type), status, repo and
 * risk (in the address, so a filtered board can be shared), Reset when any is on,
 * and Board | List. `onQuery` rebuilds the board from the data already read.
 */
function renderWorkToolbar(repos, onQuery) {
  const reset = el(
    "button",
    {
      class: "btn small work-reset",
      type: "button",
      hidden: workFiltered() ? null : "",
      onclick: () => {
        workState.status = "";
        workState.repo = "";
        workState.risk = "";
        workState.q = "";
        writeWorkStateToUrl();
      },
    },
    "Reset",
  );
  let pending = 0;
  const q = el("input", {
    type: "search",
    class: "work-q",
    value: workState.q,
    placeholder: "Filter by number or title",
    "aria-label": "Filter tickets by number or title",
    "aria-keyshortcuts": "/",
    autocomplete: "off",
    spellcheck: "false",
  });
  q.addEventListener("input", () => {
    workState.q = q.value;
    reset.hidden = !workFiltered();
    // Into the address without a navigation, so a refresh (or a shared link)
    // keeps the filter; the board itself is rebuilt from what is already read.
    try {
      history.replaceState(null, "", workUrl());
    } catch {
      /* no history in this context */
    }
    if (pending) return;
    const tick = typeof requestAnimationFrame === "function" ? requestAnimationFrame : setTimeout;
    pending = tick(() => {
      pending = 0;
      onQuery();
    });
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && q.value) {
      e.stopPropagation();
      q.value = "";
      q.dispatchEvent(new Event("input"));
    }
  });
  const select = (label, key, all, options) =>
    el(
      "select",
      {
        class: `work-sel work-sel-${key}`,
        "aria-label": label,
        onchange: (e) => {
          workState[key] = e.target.value;
          writeWorkStateToUrl();
        },
      },
      [el("option", { value: "" }, all), ...options],
    );
  const statusSel = select(
    "Filter by status",
    "status",
    "All statuses",
    TICKET_STATUSES.map((s) =>
      el("option", { value: s, selected: workState.status === s }, statusLabel(s)),
    ),
  );
  const repoSel = select(
    "Filter by repo",
    "repo",
    "All repos",
    repos.map((r) => el("option", { value: r.name, selected: workState.repo === r.name }, r.name)),
  );
  const riskSel = select(
    "Filter by risk",
    "risk",
    "All risk",
    RISK_LEVELS.map((r) =>
      el(
        "option",
        { value: r, selected: workState.risk === r },
        `${r[0].toUpperCase()}${r.slice(1)} risk`,
      ),
    ),
  );
  const modeBtn = (mode, label) =>
    el(
      "button",
      {
        class: workState.mode === mode ? "active" : "",
        type: "button",
        "aria-pressed": String(workState.mode === mode),
        onclick: () => {
          if (workState.mode === mode) return;
          workState.mode = mode;
          writeWorkStateToUrl();
        },
      },
      label,
    );
  const modeToggle = el(
    "div",
    { class: "segmented work-mode", role: "group", "aria-label": "View" },
    [modeBtn("board", "Board"), modeBtn("list", "List")],
  );
  return el("div", { class: "view-toolbar work-toolbar" }, [
    el("div", { class: "filters work-filters" }, [
      el("span", { class: "work-q-wrap" }, [
        q,
        el("kbd", { class: "kbd", "aria-hidden": "true" }, "/"),
      ]),
      statusSel,
      repoSel,
      riskSel,
      reset,
    ]),
    modeToggle,
  ]);
}

// --- Board moves (drag-to-move + touch status menu) -------------------------
//
// The board lets a human re-organise work by dragging a card into another status
// column — the headline case being un-readying a ticket (Ready → Draft), which
// has no other path. The legal target columns per status MIRROR the backend
// state machine (src/services/transitionService.ts ALLOWED). This map is only a
// UX hint (it drives the not-allowed cue + the touch menu); the server is the
// source of truth and an illegal move is rolled back with an error toast.
//
// Column key → canonical status it represents. (claimed/in_progress collapse.)
const MOVE_TARGETS_BY_STATUS = {
  draft: ["ready"],
  refining: ["ready", "draft"],
  ready: ["draft"],
  blocked: ["ready"],
  // in_review can be un-readied back to `ready`. It does NOT drag to `done`
  // anymore — approval goes through Review (in_review -> ready_for_merge) and the
  // merge runner confirms the merge (ready_for_merge -> done), so `done` can never
  // be conjured by a board-drag.
  in_review: ["ready"],
  // ready_for_merge / claimed / in_progress / done / failed / cancelled: no safe
  // human board move — a card in these states is not draggable. ready_for_merge in
  // particular has NO board target: marking merged is a guarded system action and
  // rework/reopen go through the review surface, never a drag.
};
function legalTargetColumns(status) {
  return MOVE_TARGETS_BY_STATUS[status] || [];
}
function cardIsMovable(card) {
  return legalTargetColumns(card.status).length > 0 && !card.claim && !readOnly();
}
/** The card's Move menu: its legal lanes, plus Won't do… where that move is legal. */
function cardHasMoveMenu(card) {
  return (
    !card.claim &&
    (legalTargetColumns(card.status).length > 0 || hasTicketAction(card.status, "wont_do"))
  );
}

export {
  RISK_LEVELS,
  BOARD_COLUMN_LABELS,
  STATUS_URGENCY,
  isPhoneWidth,
  laneOpenState,
  laneStartsOpen,
  needsLabel,
  workMatches,
  workFiltered,
  renderWork,
  hashText,
  WORK_BOARD_WINDOW,
  boardTruncated,
  legalTargetColumns,
  cardIsMovable,
  cardHasMoveMenu,
};
