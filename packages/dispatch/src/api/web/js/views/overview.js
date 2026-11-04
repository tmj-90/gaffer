// View: Overview, the control room.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { panelHead } from "../components.js";
import { el } from "../dom.js";
import { glyph } from "../icons.js";
import { loadMatchDay, overviewScoreboard } from "../matchday.js";
import { router } from "../router.js";
import {
  cupRuns,
  fixtures,
  fullTime,
  injuryList,
  leagueTable,
  matchReport,
  squadForm,
  wageBill,
} from "./programme.js";
import { pitchBoard, tacticsBoard } from "./tactics.js";
import { whatIOwnPanel } from "./teamsheet.js";
import { hashText } from "./work.js";

/**
 * The Overview while it loads: the ground before kick-off. The scoreboard is lit
 * with its four counters named but blank ("––", never a number the server has
 * not given), the Team Sheet's block with three empty rows, and the pitch drawn
 * with its markings and stage names but nobody on it. Same shape as the view, so
 * nothing jumps when the data lands; invisible for its first 300ms.
 */
function overviewSkeleton() {
  const empty = {
    now: Date.now(),
    tickets: [],
    items: [],
    events: [],
    claims: [],
    repoOf: new Map(),
    details: new Map(),
    byId: new Map(),
    claimByTicket: new Map(),
    runByTicket: new Map(),
  };
  let pitch;
  try {
    pitch = el("div", { class: "pitch-wrap" }, [
      el("div", { class: "pw-land" }, pitchBoard(empty, "landscape").svg),
      el("div", { class: "pw-port" }, pitchBoard(empty, "portrait").svg),
    ]);
    for (const svg of pitch.querySelectorAll("svg")) {
      svg.setAttribute("aria-hidden", "true");
      svg.removeAttribute("role");
    }
  } catch {
    pitch = el("div", { class: "skeleton sk-board" });
  }
  const cell = (label) =>
    el("div", { class: "kpi" }, [
      el("div", { class: "kpi-top" }, el("span", { class: "kpi-label" }, label)),
      el("span", { class: "kpi-val sk-digits" }, "––"),
    ]);
  const row = () =>
    el("li", { class: "sk-own" }, [
      el("span", { class: "skeleton sk-rank" }),
      el("span", { class: "sk-own-lines" }, [
        el("span", { class: "skeleton sk-l1" }),
        el("span", { class: "skeleton sk-l2" }),
        el("span", { class: "skeleton sk-l3" }),
      ]),
    ]);
  return el(
    "div",
    {
      class: "view view-overview skeleton-view sk-overview",
      "aria-busy": "true",
      "aria-label": "Loading the Overview",
    },
    [
      el("section", { class: "scoreboard bleed", "aria-hidden": "true" }, [
        el("div", { class: "scoreboard-in" }, [
          el("div", { class: "sb-main sk-hl" }, [
            el("span", { class: "skeleton sk-hl1" }),
            el("span", { class: "skeleton sk-hl2" }),
            el("span", { class: "skeleton sk-hl3" }),
          ]),
          el("div", { class: "sb-side" }, [
            el("div", { class: "sb-cells kpi-row" }, [
              cell("Need you"),
              cell("On the pitch"),
              cell("Delivered today"),
              cell("Wage bill"),
            ]),
          ]),
        ]),
      ]),
      el("div", { class: "ov-main", "aria-hidden": "true" }, [
        el("div", { class: "card what-i-own" }, [
          panelHead("Team sheet", null, null, { kit: "claret" }),
          el("ol", { class: "own-well" }, [row(), row(), row()]),
        ]),
        el("section", { class: "tactics" }, [
          el("div", { class: "tactics-head" }, [el("h2", { class: "tb-title" }, "Tactics board")]),
          pitch,
        ]),
      ]),
    ],
  );
}

/**
 * The Overview when its read fails: the scoreboard stays dark and says what
 * happened in one sentence (no number it could not read), the server's own words
 * under it, and one way on: Try again. A background refresh retries every 9s and
 * replaces this page as soon as the factory answers.
 */
function overviewError(e) {
  const code = (e && e.code) || "";
  const head =
    code === "NETWORK"
      ? "Can’t reach the factory."
      : code === "BAD_GATEWAY"
        ? "Something else answered for the factory."
        : "The factory couldn’t make up the scoreboard.";
  const detail =
    code === "NETWORK"
      ? "The dashboard server isn’t answering. Check it is still running; this page tries again by itself every 9 seconds."
      : code === "BAD_GATEWAY"
        ? `${e.message} A proxy or another server is in the way; this page tries again every 9 seconds.`
        : `It said: “${(e && e.message) || "the request failed"}”. This page tries again every 9 seconds.`;
  const retry = el(
    "button",
    { class: "btn primary", type: "button", onclick: () => router() },
    "Try again",
  );
  return el("div", { class: "view view-overview ov-error" }, [
    el("section", { class: "scoreboard bleed sb-dark", "aria-label": "Scoreboard" }, [
      el("div", { class: "scoreboard-in" }, [
        el("div", { class: "sb-main" }, [
          el("h1", { class: "hl" }, [el("span", { class: "hl-nb" }, [glyph("failed", 34), head])]),
          el("p", { class: "hl-sub" }, detail),
        ]),
        el("div", { class: "sb-side" }, [
          el(
            "div",
            { class: "sb-cells kpi-row sb-off", role: "group", "aria-label": "Today (not read)" },
            ["Need you", "On the pitch", "Delivered today", "Wage bill"].map((label) =>
              el("div", { class: "kpi" }, [
                el("div", { class: "kpi-top" }, el("span", { class: "kpi-label" }, label)),
                el("span", { class: "kpi-val sk-digits" }, [
                  el("span", { "aria-hidden": "true" }, "––"),
                  el("span", { class: "sr-only" }, "not read"),
                ]),
              ]),
            ),
          ),
        ]),
      ]),
    ]),
    el("div", { class: "empty-state is-error ov-error-act" }, [
      el("div", { class: "es-actions" }, [
        retry,
        el("a", { class: "btn", href: "#/work" }, "Open the Work board"),
        el("a", { class: "btn", href: "#/health" }, "Open Health"),
      ]),
      code ? el("p", { class: "es-sub" }, `Error code: ${code}`) : null,
    ]),
  ]);
}

async function renderOverview() {
  const [f] = await Promise.all([
    loadMatchDay(),
    document.fonts?.load?.('700 16px "Sofia Sans Condensed"').catch(() => null),
  ]);
  const wrap = el("div", { class: "view view-overview" });
  // A short Team Sheet (nothing, or one or two rows) leaves the column beside
  // the pitch mostly empty: Squad & form moves up into it, as in the idle comp.
  const idle = f.items.length <= 2;
  wrap.appendChild(overviewScoreboard(f));
  const sheet = whatIOwnPanel(f.queue, f);
  const board = tacticsBoard(f);
  const squad = squadForm(f);
  const wage = wageBill(f);
  wrap.appendChild(
    el("div", { class: "ov-main" }, [
      idle ? el("div", { class: "ov-left" }, [sheet, squad]) : sheet,
      board,
    ]),
  );
  wrap.appendChild(
    el("div", { class: `ov-prog${idle ? " is-idle" : ""}` }, [
      cupRuns(f),
      injuryList(f),
      leagueTable(f),
      wage,
      idle ? null : squad,
      fullTime(f),
      fixtures(f),
      matchReport(f),
    ]),
  );
  // A signature of what was drawn: an unchanged factory keeps its DOM on refresh.
  wrap.dataset.sig = hashText(
    JSON.stringify([
      f.items.map((i) => [
        i.kind,
        i.ticket?.id,
        i.decisionId,
        Math.floor((i.waitedMs || 0) / 60000),
      ]),
      f.tickets.map((t) => [t.id, t.status, t.updated_at]),
      f.claims.map((c) => [c.ticket_id, c.agent_id]),
      [...f.runByTicket].map(([n, r]) => [n, r.num_turns, r.cost_usd]),
      f.cost?.today_usd,
      f.cost?.total_usd,
      f.summary.deliveredToday,
      f.events[0]?.id,
      f.health?.event_log?.events,
    ]),
  );
  // Draw the board at its real size (labels keep their pixel floor) once mounted.
  wrap._mounted = () => {
    board._arrive?.();
    wage._arrive?.();
  };
  wrap._dispose = () => board._dispose?.();
  if (typeof window.ResizeObserver === "function") {
    const ro = new window.ResizeObserver(() => wage._arrive?.());
    const host = wage.querySelector(".wage-host");
    if (host) ro.observe(host);
    const prev = wrap._dispose;
    wrap._dispose = () => {
      prev();
      ro.disconnect();
    };
  }
  return wrap;
}

export { overviewSkeleton, overviewError, renderOverview };
