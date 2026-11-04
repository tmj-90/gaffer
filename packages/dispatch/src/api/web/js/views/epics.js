// View: Epics, epic scope nodes and their tickets as a phased, dependency-aware board.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentTitle, agentWho, roLock } from "../access.js";
import { api } from "../api.js";
import { ensureSquad } from "../club.js";
import { emptyState, panelHead, viewHead } from "../components.js";
import { el, svgEl } from "../dom.js";
import { plural } from "../format.js";
import { agentShirt, glyph, icon, kitShirt, ycard } from "../icons.js";
import {
  DETAIL_FULL,
  OFF_PITCH,
  allTickets,
  benchedCampaignLine,
  ticketDetails,
} from "../matchday.js";
import { jumpTo, routeSignal } from "../router.js";
import { unblockSheet } from "../sheets.js";
import { statusBadge, statusLabel } from "../status.js";
import { progPage } from "./programme.js";
import { ticketLede } from "./ticket.js";
import { hashText } from "./work.js";
import { SPEC_STATUS_LABEL, openPlanBuild, specCoverageRollup, specGapCount } from "../../app.js";

// ===========================================================================
//  Epics — epic scope nodes + their tickets as a phased, dependency-aware board
// ===========================================================================
//
// An epic is a scope node of type "epic" that `contains` its tickets. There is
// no "tickets-for-epic" endpoint, so the view stitches the tree from the
// existing surfaces: GET /scope/nodes (the epics), GET /tickets (the universe),
// and GET /tickets/details (each ticket's `scopes` → epic membership, plus its
// `dependencies` → the "blocked by #N" edges). Tickets are grouped into phases
// by their dependency depth so the build order reads top-to-bottom.

/**
 * Assign each ticket a phase = longest dependency chain to a root, computed over
 * the epic's own tickets only. Phase 0 = no in-epic dependencies (e.g. the
 * bootstrap ticket); each subsequent phase hard-waits on the one before it.
 */
function computePhases(tickets, depsById) {
  const inEpic = new Set(tickets.map((t) => t.id));
  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0; // defensive: cycles are rejected server-side
    visiting.add(id);
    const deps = (depsById.get(id) || []).filter((d) => inEpic.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  const byPhase = new Map();
  for (const t of tickets) {
    const p = depth(t.id);
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p).push(t);
  }
  return byPhase;
}

/** The epic's acceptance ticket (its Final): flagged by the server, or named so. */
function isAcceptanceTicket(t) {
  return !!(
    t &&
    (t.acceptance === 1 || t.acceptance === true || /^Acceptance/i.test(t.title || ""))
  );
}

/**
 * The acceptance ticket is always the Final: it takes a round of its own after
 * every other round, whatever its dependency depth says (an acceptance ticket
 * whose edges were never drawn would otherwise share a round with the work).
 */
function pinAcceptanceLast(byPhase) {
  const keys = [...byPhase.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return byPhase;
  const moved = [];
  for (const k of keys) {
    const list = byPhase.get(k);
    moved.push(...list.filter(isAcceptanceTicket));
    const rest = list.filter((t) => !isAcceptanceTicket(t));
    if (rest.length) byPhase.set(k, rest);
    else byPhase.delete(k);
  }
  if (moved.length) {
    const left = [...byPhase.keys()];
    byPhase.set(left.length ? Math.max(...left) + 1 : 0, moved);
  }
  return byPhase;
}

/** Why a held ticket is held, in the ticket page's own words (its lede, minus the status word). */
function heldReason(t, detail) {
  if (!detail) return [];
  const parts = ticketLede(t, detail.rework_trail || [], detail.events || []);
  return parts.slice(1).filter((p) => typeof p === "string");
}

/** A small red card (held) for a block heading or a table cell: always next to words. */
function redCard(size = 16) {
  return svgEl(
    "svg",
    {
      viewBox: "0 0 12 16",
      width: (size * 0.75).toFixed(1),
      height: size,
      class: "rcard",
      "aria-hidden": "true",
      focusable: "false",
    },
    svgEl("rect", {
      x: 1,
      y: 1,
      width: 10,
      height: 14,
      rx: 1.4,
      fill: "var(--red)",
      stroke: "var(--ycard-edge)",
      "stroke-width": 1.2,
    }),
  );
}

const NEEDS_SIGN_OFF = new Set(["in_review", "ready_for_merge"]);

async function renderEpics(param) {
  // A deep link (#/epics/:nodeId) scrolls to that campaign.
  const focusId = param || null;
  const signal = routeSignal();
  // Claims (who wears which ticket) and specs (what a campaign is played to) are
  // extras: the season still reads without them.
  const extra = (p, fallback) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fallback;
    });
  const [nodesRes, ticketsRes, claimsRes, specsRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    allTickets("", { signal }),
    extra("/claims", { claims: [] }),
    extra("/specs", { specs: [] }),
    ensureSquad(),
  ]);
  const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
  const tickets = ticketsRes.tickets || [];
  const planBtn = roLock(
    el("button", { class: "btn primary", type: "button", onclick: () => openPlanBuild() }, [
      icon("spark"),
      el("span", {}, "Plan a build"),
    ]),
  );
  // Authoring a spec lives on Specs; the season links there.
  const specsLink = el("a", { class: "btn", href: "#/specs" }, "Specs");
  const wrap = el("div", { class: "view view-epics" });

  if (epics.length === 0) {
    wrap.dataset.sig = "empty";
    wrap.appendChild(viewHead("The season", "No campaigns yet", [specsLink, planBtn]));
    wrap.appendChild(
      emptyState(
        "No campaigns on the fixture list.",
        "Describe what to build in plain words: Plan a build proposes the draw (draft tickets, round by round), and the campaign lands here once you confirm it.",
        null,
        roLock(
          el("button", { class: "btn primary", type: "button", onclick: () => openPlanBuild() }, [
            icon("spark"),
            el("span", {}, "Plan a build"),
          ]),
        ),
      ),
    );
    return wrap;
  }

  // Membership + dependencies come from each ticket's detail (cached by updated_at).
  const detailById = await ticketDetails(
    tickets.filter((t) => t.status !== "cancelled"),
    signal,
  );
  // A held member's line says why (its rework trail and events): read those in full.
  const heldFull = await ticketDetails(
    tickets.filter((t) => OFF_PITCH.has(t.status)),
    signal,
    DETAIL_FULL,
  );
  for (const [k, v] of heldFull) detailById.set(k, v);
  const membersByEpic = new Map(epics.map((e) => [e.id, []]));
  const depsById = new Map();
  const depViewById = new Map();
  const repoByTicket = new Map();
  for (const t of tickets) {
    const detail = detailById.get(t.id);
    if (!detail) continue;
    const deps = detail.dependencies || [];
    depsById.set(
      t.id,
      deps.map((d) => d.depends_on_ticket_id),
    );
    depViewById.set(t.id, deps);
    const repos = detail.repositories || [];
    const repoW = repos.find((r) => r.access === "write") || repos[0];
    if (repoW) repoByTicket.set(t.id, repoW.name);
    for (const sc of detail.scopes || []) {
      if (membersByEpic.has(sc.id)) membersByEpic.get(sc.id).push({ ...t, ...detail.ticket });
    }
  }
  const agentByTicket = new Map();
  for (const c of (claimsRes && claimsRes.claims) || []) {
    if (c.status && c.status !== "active") continue;
    agentByTicket.set(c.ticket_id, agentWho(c.agent_id, c.agent_display_name));
  }

  // A campaign played to a spec: the spec names the epic as its scope node.
  const specByEpic = new Map();
  for (const s of (specsRes && specsRes.specs) || []) {
    if (s.scope_node_id && membersByEpic.has(s.scope_node_id) && !specByEpic.has(s.scope_node_id))
      specByEpic.set(s.scope_node_id, { spec: s, rollup: null });
  }
  await Promise.all(
    [...specByEpic.values()].map((v) =>
      extra(`/specs/${encodeURIComponent(v.spec.id)}/coverage`, null).then((r) => {
        v.rollup = specCoverageRollup(r && r.coverage);
        v.gaps = specGapCount(r && r.coverage, v.spec.status);
      }),
    ),
  );

  const ctx = { depsById, depViewById, detailById, repoByTicket, agentByTicket };
  const seasons = epics.map((epic) => campaignFacts(epic, membersByEpic.get(epic.id) || [], ctx));

  // Same data → same signature → the refresh leaves the page (and its open folds) alone.
  wrap.dataset.sig = hashText(
    JSON.stringify([
      epics.map((e) => [e.id, e.name, e.description || ""]),
      seasons.map((s) =>
        s.members.map((m) => [
          m.id,
          m.status,
          m.title,
          agentTitle(agentByTicket.get(m.id) || { name: "" }),
          (depViewById.get(m.id) || []).map((d) => `${d.depends_on_ticket_id}:${d.satisfied}`),
        ]),
      ),
      [...specByEpic.entries()].map(([k, v]) => [k, v.spec.id, v.spec.status, v.rollup, v.gaps]),
    ]),
  );

  const allMembers = seasons.flatMap((s) => s.members);
  const heldN = seasons.filter((s) => s.held.length).length;
  const doneN = allMembers.filter((m) => m.status === "done").length;
  wrap.appendChild(
    viewHead(
      "The season",
      `${plural(epics.length, "campaign")} · ${heldN ? `${heldN} held` : "none held"} · ${doneN} of ${plural(allMembers.length, "ticket")} done`,
      [specsLink, planBtn],
    ),
  );
  if (seasons.length > 1) wrap.appendChild(seasonTable(seasons));

  const list = el("div", { class: "epic-list" });
  for (const s of seasons)
    list.appendChild(renderEpicCard(s, ctx, specByEpic.get(s.epic.id), focusId === s.epic.id));
  wrap.appendChild(list);

  // The draw's bracket lines are measured once the page is laid out, and again
  // whenever a draw changes size (fonts landing, a resize, a fold opening).
  let ro = null;
  wrap._mounted = () => {
    const draws = [...wrap.querySelectorAll(".ep-draw")];
    draws.forEach(drawEpicLines);
    if (typeof window.ResizeObserver === "function") {
      ro = new window.ResizeObserver((entries) => {
        for (const e of entries) drawEpicLines(e.target);
      });
      draws.forEach((d) => ro.observe(d));
    }
    if (document.fonts && document.fonts.ready)
      document.fonts.ready.then(() => draws.forEach(drawEpicLines)).catch(() => {});
    // After the router's scroll-to-top, not before it.
    if (focusId) setTimeout(() => jumpTo(`epic-${focusId}`), 0);
  };
  wrap._dispose = () => {
    if (ro) ro.disconnect();
    ro = null;
  };
  return wrap;
}

/** Everything one campaign's page and its table row say, computed once. */
function campaignFacts(epic, members, ctx) {
  const byPhase = pinAcceptanceLast(computePhases(members, ctx.depsById));
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const done = members.filter((m) => m.status === "done").length;
  const held = members
    .filter((m) => OFF_PITCH.has(m.status))
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  const heldIds = new Set(held.map((m) => m.id));
  const waits = members.filter(
    (m) => m.status !== "done" && (ctx.depsById.get(m.id) || []).some((d) => heldIds.has(d)),
  );
  const needs = members.filter((m) => NEEDS_SIGN_OFF.has(m.status));
  // Next fixture: a ready ticket that can actually be claimed, i.e. every ticket
  // it waits on is done (the server refuses a claim with DEPENDENCY_BLOCKED otherwise).
  const nextUp = members.filter(
    (m) => m.status === "ready" && (ctx.depViewById.get(m.id) || []).every((d) => d.satisfied),
  );
  const liveIdx = phases.findIndex((p) => (byPhase.get(p) || []).some((t) => t.status !== "done"));
  const won = members.length > 0 && done === members.length;
  return {
    epic,
    members,
    byPhase,
    phases,
    done,
    held,
    heldIds,
    waits,
    needs,
    nextUp,
    liveIdx,
    won,
  };
}

/** "#8, #9 and #10" */
function ticketList(ts) {
  const ns = ts.map((t) => `#${t.number}`);
  return ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}` : ns[0] || "";
}

/** The table: one line per campaign — its rounds, how far it has got, what holds it. */
function seasonTable(seasons) {
  const rows = seasons.map((s) => {
    const name = s.epic.name;
    const where = s.held.length
      ? el("span", { class: "ep-where is-red" }, [
          redCard(16),
          el("span", {}, [
            "Held at ",
            el(
              "a",
              { href: `#/ticket/${s.held[0].id}`, title: s.held[0].title },
              `#${s.held[0].number}`,
            ),
            s.waits.length
              ? ` · ${ticketList(s.waits)} ${s.waits.length === 1 ? "waits" : "wait"}`
              : "",
          ]),
        ])
      : s.needs.length
        ? el("span", { class: "ep-where" }, [
            ycard(16),
            el("span", {}, [
              el("a", { href: `#/review/${s.needs[0].id}` }, `#${s.needs[0].number}`),
              s.needs[0].status === "in_review"
                ? " waits for your sign-off"
                : " waits for the merge",
            ]),
          ])
        : el(
            "span",
            { class: "ep-where" },
            s.won
              ? [glyph("done", 16), el("span", {}, "Won")]
              : !s.members.length
                ? "No tickets yet"
                : s.nextUp.length
                  ? [
                      glyph("ready", 16),
                      el("span", {}, [
                        "Next: ",
                        el(
                          "a",
                          { href: `#/ticket/${s.nextUp[0].id}`, title: s.nextUp[0].title },
                          `#${s.nextUp[0].number}`,
                        ),
                      ]),
                    ]
                  : [glyph("in_progress", 16), el("span", {}, "In play")],
          );
    const roundsLabel = s.phases.length
      ? s.won
        ? `All ${s.phases.length} rounds won`
        : `Round ${s.liveIdx + 1} of ${s.phases.length}`
      : "No rounds";
    return el("tr", { class: s.held.length ? "is-held" : "" }, [
      el(
        "th",
        { scope: "row", class: "ep-t-name" },
        el("a", { href: `#epic-${s.epic.id}`, title: name }, name),
      ),
      el("td", { class: "ep-t-rounds" }, [
        el(
          "span",
          { class: "ep-mini", role: "img", "aria-label": roundsLabel },
          s.phases.map((p, i) => {
            const tix = s.byPhase.get(p) || [];
            const d = tix.filter((t) => t.status === "done").length;
            const isHeld = tix.some((t) => s.heldIds.has(t.id));
            return el("i", {
              class: isHeld
                ? "is-held"
                : d === tix.length
                  ? "is-won"
                  : i === s.liveIdx
                    ? "is-live"
                    : "",
              style: { "--p": `${tix.length ? Math.round((d / tix.length) * 100) : 0}%` },
            });
          }),
        ),
        el("span", { class: "ep-t-sub", "aria-hidden": "true" }, roundsLabel),
      ]),
      el("td", { class: "ep-t-num tabnum" }, `${s.done}/${s.members.length}`),
      el("td", { class: "ep-t-where" }, where),
    ]);
  });
  return progPage("ep-table", "claret", "The table", `${plural(seasons.length, "campaign")}`, [
    el("div", { class: "ep-table-scroll" }, [
      el("table", { class: "ep-season" }, [
        el(
          "caption",
          { class: "sr-only" },
          "Every campaign: its rounds, tickets done and what holds it",
        ),
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col" }, "Campaign"),
            el("th", { scope: "col" }, "Rounds"),
            el("th", { scope: "col", class: "ep-t-num" }, "Done"),
            el("th", { scope: "col" }, "Where it stands"),
          ]),
        ]),
        el("tbody", {}, rows),
      ]),
    ]),
  ]);
}

/**
 * One campaign: a programme page. The sky block carries its name and how far it
 * has got (a red card when a ticket holds it); then what holds it and the one
 * thing to do about it, the brief, the spec it is played to, the draw (every
 * ticket, round by round, joined by bracket lines), and the next fixture.
 */
function renderEpicCard(s, ctx, specLink, focused) {
  const { epic, members, byPhase, phases, done, held, waits, needs, nextUp, liveIdx, won } = s;
  const aux = members.length
    ? `${won ? "all rounds won" : `round ${liveIdx + 1} of ${phases.length}`} · ${done} of ${members.length} done`
    : "no tickets";
  const head = panelHead(
    epic.name,
    aux,
    { text: "On the map", href: `#/node/${epic.id}` },
    { kit: "sky", level: "h2" },
  );
  if (held.length)
    head.appendChild(el("span", { class: "ep-flag" }, [redCard(22), el("span", {}, "Held")]));
  else if (needs.length)
    head.appendChild(el("span", { class: "ep-flag" }, [ycard(22), el("span", {}, "Needs you")]));
  else if (won) head.appendChild(el("span", { class: "ep-flag" }, [glyph("done", 20), "Won"]));

  const card = el("article", {
    class: `card epic-card campaign${held.length ? " is-held" : ""}${focused ? " card-accent" : ""}`,
    id: `epic-${epic.id}`,
    "aria-labelledby": `epic-h-${epic.id}`,
  });
  head.querySelector(".panel-title").id = `epic-h-${epic.id}`;
  card.appendChild(head);

  if (members.length === 0) {
    if (epic.description) card.appendChild(el("p", { class: "epic-desc" }, epic.description));
    card.appendChild(el("p", { class: "ep-lede" }, "This campaign has no tickets yet."));
    return card;
  }

  // Where it stands, in one sentence from the data, with the one thing to do.
  const h = held[0];
  const lede = held.length
    ? el("div", { class: "ep-stands is-held" }, [
        el("p", { class: "ep-lede" }, [
          el("b", { class: "is-red" }, [
            glyph("blocked", 18),
            " Held at ",
            el("a", { href: `#/ticket/${h.id}` }, `#${h.number}`),
            ".",
          ]),
          " ",
          el("span", { class: "ep-held-t" }, `“${h.title}”`),
          " ",
          ...heldReason(h, ctx.detailById.get(h.id)),
          waits.length
            ? ` ${ticketList(waits)} ${waits.length === 1 ? "waits" : "wait"} on it.`
            : "",
          held.length > 1
            ? ` ${held.length - 1} more ${held.length === 2 ? "is" : "are"} off the pitch.`
            : "",
        ]),
        el("div", { class: "btn-row" }, [
          h.status === "blocked"
            ? el(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onclick: () =>
                    unblockSheet(h, {
                      reason: heldReason(h, ctx.detailById.get(h.id)).join("").trim(),
                    }),
                },
                `Unblock #${h.number}…`,
              )
            : null,
          el("a", { class: "btn quiet", href: `#/ticket/${h.id}` }, `Open #${h.number}`),
        ]),
      ])
    : el(
        "p",
        { class: "ep-lede" },
        needs.length
          ? [
              ycard(16),
              " ",
              el("a", { href: `#/review/${needs[0].id}` }, `#${needs[0].number}`),
              needs[0].status === "in_review"
                ? " waits for your sign-off."
                : " is approved and waits for the merge.",
              needs.length > 1 ? ` ${needs.length - 1} more after it.` : "",
              " Nothing is holding the campaign.",
            ]
          : won
            ? "Won: every ticket is done, the Final included."
            : benchedCampaignLine(members)
              ? [
                  benchedCampaignLine(members),
                  " ",
                  el("a", { href: "#/work?status=draft" }, "Ready them on the Work board"),
                  ` to start round ${liveIdx + 1}.`,
                ]
              : `Round ${liveIdx + 1} of ${phases.length} is being played. Nothing is holding it.`,
      );
  card.appendChild(lede);
  if (epic.description) card.appendChild(el("p", { class: "epic-desc" }, epic.description));
  if (specLink) {
    const { spec, rollup, gaps } = specLink;
    card.appendChild(
      el("p", { class: "ep-spec" }, [
        "Played to the spec ",
        el("a", { href: `#/specs/${encodeURIComponent(spec.id)}` }, `“${spec.title}”`),
        ` (${(SPEC_STATUS_LABEL[spec.status] || spec.status || "").toLowerCase()})`,
        rollup && rollup.total
          ? `: ${rollup.covered} of ${plural(rollup.total, "clause")} covered${gaps ? `, ${plural(gaps, "gap")}` : ""}.`
          : ".",
      ]),
    );
  }

  const draw = renderEpicDag(byPhase, phases, { ...ctx, heldIds: s.heldIds, epicName: epic.name });
  const next = el("p", { class: "epic-next" }, [
    el("b", {}, "Next fixture: "),
    nextUp.length
      ? nextUp.flatMap((t, i) => [
          i ? ", " : "",
          el("a", { href: `#/ticket/${t.id}` }, `#${t.number} ${t.title}`),
        ])
      : held.length
        ? "nothing can be claimed until the hold is cleared."
        : won
          ? "none: the campaign is won."
          : (() => {
              // Ready, but waiting on unfinished work: say who, not "nothing is ready".
              const waiting = members.filter((m) => m.status === "ready");
              return waiting.length
                ? `nothing can be claimed yet: ${ticketList(waiting)} ${waiting.length === 1 ? "waits" : "wait"} on unfinished work.`
                : "nothing is ready to claim.";
            })(),
  ]);
  if (won) {
    // A won campaign keeps its page short: the draw folds away.
    card.appendChild(
      el("details", { class: "ep-fold" }, [
        el("summary", {}, `Show the draw (${plural(members.length, "ticket")})`),
        draw,
      ]),
    );
  } else {
    card.appendChild(draw);
    card.appendChild(next);
  }
  return card;
}

/** A round's name: the last round is the Final when it holds the acceptance ticket. */
function epicRoundName(byPhase, phases, i) {
  const p = phases[i];
  return i === phases.length - 1 && i > 0 && (byPhase.get(p) || []).some(isAcceptanceTicket)
    ? "Final"
    : `Round ${i + 1}`;
}

/**
 * The draw: one mown lane per round (a column at desktop, stacked on a phone),
 * every ticket a fixture card in its round, ordered so the bracket lines cross
 * as little as they can. The lines (drawn by drawEpicLines once laid out) join
 * each ticket to what it waits on: solid when met, dashed when not, red dashed
 * out of a held ticket.
 */
function renderEpicDag(byPhase, phases, ctx) {
  const { depViewById, agentByTicket, repoByTicket, heldIds } = ctx;
  const rowOf = new Map();
  const cols = phases.map((p, ci) => {
    const tix = (byPhase.get(p) || []).slice();
    const bary = (t) => {
      const ys = (depViewById.get(t.id) || [])
        .map((d) => rowOf.get(d.depends_on_ticket_id))
        .filter((y) => y != null);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    tix.sort((a, b) =>
      ci === 0
        ? (a.number || 0) - (b.number || 0)
        : bary(a) - bary(b) || (a.number || 0) - (b.number || 0),
    );
    tix.forEach((t, i) => rowOf.set(t.id, i));
    return tix;
  });

  const edges = [];
  const tie = (t) => {
    const deps = depViewById.get(t.id) || [];
    const blockers = deps.filter((d) => !d.satisfied);
    for (const d of deps) {
      if (!rowOf.has(d.depends_on_ticket_id)) continue;
      edges.push({
        from: d.depends_on_ticket_id,
        to: t.id,
        cls: heldIds.has(d.depends_on_ticket_id) ? "held" : d.satisfied ? "sat" : "pend",
      });
    }
    const agent = agentByTicket.get(t.id);
    const repo = repoByTicket.get(t.id);
    const needs = NEEDS_SIGN_OFF.has(t.status);
    const waitsOnHeld = blockers.some((b) => heldIds.has(b.depends_on_ticket_id));
    const label = [
      `#${t.number} ${statusLabel(t.status, t.landing_state)}: ${t.title}`,
      repo ? `in ${repo}` : "",
      agent ? `${agent.name} on it` : "",
      needs ? (t.status === "in_review" ? "waits for your sign-off" : "waits for the merge") : "",
      blockers.length ? `waiting on ${blockers.map((b) => "#" + b.number).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return el(
      "a",
      {
        class: `dag-node status-${t.status}${isAcceptanceTicket(t) ? " is-final" : ""}`,
        href: `#/ticket/${t.id}`,
        title: t.title,
        "aria-label": label,
        dataset: { id: t.id },
      },
      [
        el("span", { class: "dn-top" }, [
          el("span", { class: "dn-num" }, t.number != null ? `#${t.number}` : "—"),
          needs ? ycard(16) : null,
          statusBadge(t.status, t.landing_state),
        ]),
        el("span", { class: "dn-title" }, t.title),
        el("span", { class: "dn-foot" }, [
          repo
            ? el("span", { class: "dn-repo" }, [kitShirt(repo, 16), el("span", {}, repo)])
            : null,
          agent
            ? el("span", { class: "dn-agent", title: agentTitle(agent) }, [
                agentShirt(agent.name, 22, agent.no),
                el("span", {}, agent.no || agent.name),
              ])
            : null,
          blockers.length
            ? el("span", { class: `dn-block${waitsOnHeld ? " is-red" : ""}` }, [
                waitsOnHeld ? glyph("blocked", 12) : icon("clock", "dn-block-ico", 12),
                `waits on ${blockers.map((b) => (b.number != null ? "#" + b.number : "?")).join(", ")}`,
              ])
            : null,
        ]),
      ],
    );
  };

  const rounds = phases.map((p, ci) => {
    const tix = cols[ci];
    const name = epicRoundName(byPhase, phases, ci);
    const done = tix.filter((t) => t.status === "done").length;
    const isHeld = tix.some((t) => heldIds.has(t.id));
    return el(
      "section",
      {
        class: `ep-round${name === "Final" ? " is-final" : ""}${isHeld ? " is-held" : ""}`,
        "aria-label": `${name}: ${done} of ${tix.length} done`,
      },
      [
        el("header", { class: "ep-round-head" }, [
          el("h3", { class: "ep-round-name" }, name),
          el(
            "span",
            { class: "ep-round-frac tabnum", "aria-hidden": "true" },
            `${done}/${tix.length}`,
          ),
          el(
            "span",
            { class: "ep-round-bar", "aria-hidden": "true" },
            el("i", {
              style: { width: `${tix.length ? Math.round((done / tix.length) * 100) : 0}%` },
            }),
          ),
        ]),
        el(
          "ol",
          { class: "ep-ties" },
          tix.map((t) => el("li", {}, tie(t))),
        ),
      ],
    );
  });

  const lines = svgEl("svg", { class: "ep-lines", "aria-hidden": "true", focusable: "false" });
  const draw = el("div", { class: "ep-draw", style: { "--rounds": String(phases.length) } }, [
    lines,
    ...rounds,
  ]);
  draw._edges = edges;
  return el(
    "div",
    {
      class: "ep-draw-scroll",
      role: "region",
      "aria-label": `${ctx.epicName || "Campaign"}: the draw`,
      tabindex: phases.length >= 6 ? "0" : undefined,
    },
    draw,
  );
}

/**
 * Draw the bracket lines of one draw from where its cards actually are. Each
 * line leaves the right edge of the ticket waited on, turns at the lane edge of
 * the waiting ticket's round, and enters its left edge. Rounds that stack (a
 * phone) carry "waits on #N" on the cards instead, and no lines.
 */
function drawEpicLines(draw) {
  const svg = draw && draw.querySelector(".ep-lines");
  if (!svg || !draw.isConnected) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const rounds = [...draw.querySelectorAll(".ep-round")];
  const box = draw.getBoundingClientRect();
  const side =
    rounds.length > 1 &&
    Math.abs(rounds[0].getBoundingClientRect().top - rounds[1].getBoundingClientRect().top) < 2 &&
    box.width > 0;
  svg.style.display = side ? "" : "none";
  if (!side) return;
  const w = Math.round(draw.scrollWidth),
    h = Math.round(draw.scrollHeight);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const nodeOf = new Map([...draw.querySelectorAll(".dag-node")].map((n) => [n.dataset.id, n]));
  const roundOf = (n) => n.closest(".ep-round");
  const order = { sat: 0, pend: 1, held: 2 };
  const edges = (draw._edges || []).filter((e) => nodeOf.has(e.from) && nodeOf.has(e.to));
  const midY = (n) => {
    const r = n.getBoundingClientRect();
    return r.top + Math.min(r.height / 2, 28) - box.top;
  };
  // Lines that leave one card, or enter one, fan out a few pixels apart (ordered
  // by where the other end is), so two lines never share a segment: a met line
  // under an unmet one would read as met.
  const FAN = 6;
  const fan = (key, other) => {
    const groups = new Map();
    for (const e of edges) {
      const k = e[key];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const off = new Map();
    for (const list of groups.values()) {
      list.sort((p, q) => midY(nodeOf.get(p[other])) - midY(nodeOf.get(q[other])));
      list.forEach((e, i) => off.set(e, (i - (list.length - 1) / 2) * FAN));
    }
    return off;
  };
  const outOff = fan("from", "to");
  const inOff = fan("to", "from");
  // Each straight run is its own path whose dashes are phased to the page, not to
  // the path, so where two dashed runs still overlap their dashes coincide.
  const period = { pend: 8, held: 12 };
  const seg = (cls, xa, ya, xb, yb) => {
    const horiz = Math.abs(ya - yb) < 0.5;
    const lo = horiz ? Math.min(xa, xb) : Math.min(ya, yb);
    const hi = horiz ? Math.max(xa, xb) : Math.max(ya, yb);
    if (hi - lo < 0.5) return;
    const d = horiz
      ? `M${lo.toFixed(1)} ${ya.toFixed(1)} H${hi.toFixed(1)}`
      : `M${xa.toFixed(1)} ${lo.toFixed(1)} V${hi.toFixed(1)}`;
    const attrs = { class: `edge ${cls}`, d };
    if (period[cls]) attrs["stroke-dashoffset"] = (lo % period[cls]).toFixed(1);
    svg.appendChild(svgEl("path", attrs));
  };
  for (const e of edges.slice().sort((a, b) => order[a.cls] - order[b.cls])) {
    const a = nodeOf.get(e.from),
      b = nodeOf.get(e.to);
    const ra = a.getBoundingClientRect(),
      rb = b.getBoundingClientRect(),
      lane = roundOf(b).getBoundingClientRect();
    const x1 = ra.right - box.left,
      y1 = midY(a) + (outOff.get(e) || 0),
      x2 = rb.left - box.left,
      y2 = midY(b) + (inOff.get(e) || 0);
    if (x2 <= x1) continue;
    const xm = Math.max(x1 + 6, Math.min(x2 - 6, lane.left - box.left));
    seg(e.cls, x1, y1, xm, y1);
    seg(e.cls, xm, y1, xm, y2);
    seg(e.cls, xm, y2, x2, y2);
  }
}

export { computePhases, isAcceptanceTicket, redCard, renderEpics };
