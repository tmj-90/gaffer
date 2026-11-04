// The Overview's reads, shared by the views: pitch zones, ticket details, loadMatchDay, the headline and scoreboard.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "./api.js";
import { ensureSquad, learnAgents, squad } from "./club.js";
import { band, statCell } from "./components.js";
import { el, svgEl } from "./dom.js";
import { fmtDay, money, moneyW, plural } from "./format.js";
import { clockTime } from "./freshness.js";
import { SHIRT_PATH, glyph, learnKits } from "./icons.js";
import { routeSignal } from "./router.js";
import { appState } from "./state.js";

// ===========================================================================
//  View: Overview — the control room
//  Lead with "what needs you now" → live activity → bento stats → repo pressure.
// ===========================================================================

// ===========================================================================
//  View: Overview — the match-day programme's front page
//    the stadium scoreboard (headline + four counters), the Team Sheet (what
//    needs you, each row with one real action), the Tactics Board (every ticket
//    in play on a drawn pitch, agents in numbered shirts, chalk arrows for the
//    real moves), then the programme pages: Cup runs, Injury list, League table,
//    Wage bill, Squad & form, Full time, Fixtures and the Match report.
//  Every mark is a field a server response carried. The flow numbers, governance
//  rates and run list live in the Health view (the physio room).
// ===========================================================================

/** The statuses drawn on the pitch, left (ready) to right (to merge). */
const PITCH_ZONES = [
  { key: "ready", label: "Ready", x0: 0, x1: 210 },
  { key: "claimed", label: "Claimed", x0: 210, x1: 360 },
  { key: "in_progress", label: "In progress", x0: 360, x1: 525 },
  { key: "in_review", label: "In review", x0: 525, x1: 700 },
  { key: "in_testing", label: "In testing", x0: 700, x1: 860 },
  { key: "ready_for_merge", label: "To merge", x0: 860, x1: 1050 },
];
const ON_PITCH = new Set(PITCH_ZONES.map((z) => z.key));
const OFF_PITCH = new Set(["blocked", "paused", "failed"]);
const ON_BENCH = new Set(["draft", "refining"]);
/**
 * A campaign whose every unfinished ticket is still a draft (or refining) is not
 * being played, it is waiting for someone to ready its tickets: "Nothing is holding
 * it" said the opposite. Answers that sentence, or null when anything is in play.
 */
function benchedCampaignLine(members) {
  const left = members.filter((t) => t.status !== "done" && t.status !== "cancelled");
  if (!left.length || !left.every((t) => ON_BENCH.has(t.status))) return null;
  const drafts = left.filter((t) => t.status === "draft").length;
  return drafts === left.length
    ? `Not kicked off: ${left.length === 1 ? "its ticket is a draft" : `all ${left.length} tickets left are drafts`} nobody has marked ready yet.`
    : `Not kicked off: its ${plural(left.length, "ticket")} left ${left.length === 1 ? "is" : "are"} still drafts or refining, none ready yet.`;
}
const PITCH_MAX_CHANNELS = 6;
const ARROW_WINDOW_MS = 3 * 3600e3;

/** SVG builder for the drawings: like svgEl, but `style` may be an object. */
function svgS(tag, attrs = {}, ...children) {
  const a = { ...attrs };
  if (a.style && typeof a.style === "object") {
    a.style = Object.entries(a.style)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
      .join(";");
  }
  return svgEl(tag, a, children.flat());
}

// Text measurement for the board's layout engine (tags, label boxes). jsdom and
// some locked-down browsers have no 2D canvas: fall back to an average glyph width.
let measureCtx;
/**
 * Break a name into at most `max` lines that each fit `width` (breaking after
 * - _ / . first); the last line is cut with an ellipsis if it still overflows.
 */
function wrapLabel(str, size, width, max = 2, face = "cond") {
  const parts = String(str).match(/[^-_/.]+[-_/.]?/g) || [String(str)];
  const lines = [];
  let cur = "";
  for (const p of parts) {
    if (cur && textWidth(cur + p, size, 0, face) > width && lines.length < max - 1) {
      lines.push(cur);
      cur = p;
    } else cur += p;
  }
  lines.push(cur);
  const last = lines.length - 1;
  if (textWidth(lines[last], size, 0, face) > width) {
    let t = lines[last];
    while (t.length > 1 && textWidth(t + "…", size, 0, face) > width) t = t.slice(0, -1);
    lines[last] = t + "…";
  }
  return lines;
}
/**
 * `face` is the face the label is drawn in: "cond" for the board's condensed labels
 * (zone names, tallies), "text" for the operational detail drawn in the body face
 * (channel labels, the tags beside a shirt), so a measured box fits what is drawn.
 */
function textWidth(str, size, track = 0, face = "cond") {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d") || null;
    } catch {
      measureCtx = null;
    }
  }
  const s = String(str);
  if (!measureCtx) return s.length * size * ((face === "text" ? 0.56 : 0.5) + track);
  measureCtx.font =
    face === "text"
      ? `600 ${size}px "Sofia Sans", system-ui, sans-serif`
      : `700 ${size}px "Sofia Sans Condensed", "Arial Narrow", sans-serif`;
  return measureCtx.measureText(s).width + s.length * size * track;
}

/** A ball, for the net tallies. */
function pitchBall(r = 7) {
  return svgS(
    "g",
    { class: "ball" },
    svgS("circle", { r, fill: "var(--chalk)", stroke: "var(--ink-on-pitch)", "stroke-width": 1 }),
    svgS("path", {
      d: `M0 ${-r * 0.42} L${r * 0.4} ${-r * 0.13} L${r * 0.25} ${r * 0.34} L${-r * 0.25} ${r * 0.34} L${-r * 0.4} ${-r * 0.13} Z`,
      fill: "var(--ink-on-pitch)",
    }),
  );
}
/** The club shirt as a group, placed at (x, y) and scaled (40 units across). */
function shirtGroup(no, x = 0, y = 0, scale = 1, numPx) {
  const id = "sg" + ++appState.svgUid;
  return svgS(
    "g",
    { transform: `translate(${x} ${y}) scale(${scale})` },
    svgS("defs", {}, svgS("clipPath", { id }, svgS("path", { d: SHIRT_PATH }))),
    svgS("path", { d: SHIRT_PATH, fill: "var(--claret)" }),
    svgS(
      "g",
      { "clip-path": `url(#${id})`, fill: "var(--sky)" },
      svgS("path", { d: "M13 4 Q20 9.5 27 4 L27 6.4 Q20 12 13 6.4 Z" }),
      svgS("path", { d: "M10 9.6 L20 15 L30 9.6 L30 12.6 L20 18 L10 12.6 Z" }),
      svgS("rect", { x: 0, y: 15.5, width: 6.5, height: 3 }),
      svgS("rect", { x: 33.5, y: 15.5, width: 6.5, height: 3 }),
    ),
    svgS("path", {
      d: SHIRT_PATH,
      fill: "none",
      stroke: "var(--shirt-edge)",
      "stroke-width": 1.4,
      "stroke-linejoin": "round",
    }),
    svgS(
      "text",
      {
        x: 20,
        y: 34,
        "text-anchor": "middle",
        class: "shirt-no",
        style: numPx ? { fontSize: (numPx / scale).toFixed(2) + "px" } : undefined,
      },
      no,
    ),
  );
}

/**
 * Every ticket, page by page: GET /tickets answers a bounded page (500 by default) with
 * `next_offset`, so a view that needs the whole list follows it. Summary rows (no
 * description, test contract or review feedback: no list view shows them) unless
 * `full`. `qs` is the filter (`status=in_review`, `repo=…`), without paging.
 */
async function allTickets(qs = "", opts = {}) {
  const base = new URLSearchParams(qs);
  if (!opts.full) base.set("fields", "summary");
  base.set("limit", "1000");
  const out = [];
  // A ticket created (or re-prioritised) between two pages shifts the rows after it, so
  // the next page can repeat one: keep each ticket once.
  const seen = new Set();
  let offset = 0;
  let total = 0;
  for (let guard = 0; guard < 1000; guard++) {
    base.set("offset", String(offset));
    const res = await api(
      "GET",
      `/tickets?${base}`,
      undefined,
      opts.signal ? { signal: opts.signal } : {},
    );
    const rows = (res && res.tickets) || [];
    for (const r of rows) {
      if (r && seen.has(r.id)) continue;
      if (r) seen.add(r.id);
      out.push(r);
    }
    total = res && typeof res.total === "number" ? res.total : out.length;
    if (!res || res.next_offset == null || !rows.length) break;
    offset = res.next_offset;
  }
  return { tickets: out, total };
}

/**
 * The whole board: GET /api/board answers a window of each area (500 cards by default),
 * so ask for the widest window and page any area whose `counts` says there is more.
 */
async function boardAll(qs = "", opts = {}) {
  const LIMIT = 1000;
  const q = new URLSearchParams(qs);
  q.set("limit", String(LIMIT));
  const get = (extra) => {
    const u = new URLSearchParams(q);
    for (const [k, v] of Object.entries(extra || {})) u.set(k, v);
    return api("GET", `/api/board?${u}`, undefined, opts.signal ? { signal: opts.signal } : {});
  };
  const board = await get();
  if (!board || !board.counts) return board;
  const areaCards = (b, area) =>
    area === "closed"
      ? b.closed || []
      : area === "wontDo"
        ? b.wontDo || []
        : ((b.columns || []).find((c) => c.column === area) || {}).cards || [];
  const areas = [...Object.keys(board.counts.columns || {}), "closed", "wontDo"];
  for (const area of areas) {
    const want =
      area === "closed" || area === "wontDo" ? board.counts[area] : board.counts.columns[area];
    const have = areaCards(board, area);
    // Keep each card once: a ticket that moved between two reads shifts the window.
    const seen = new Set(have.map((c) => c && c.id));
    let pos = have.length;
    while (typeof want === "number" && have.length < want) {
      const page = areaCards(await get({ area, offset: String(pos) }), area);
      if (!page.length) break;
      pos += page.length;
      const more = page.filter((c) => c && !seen.has(c.id));
      for (const c of more) seen.add(c.id);
      have.push(...more);
      if (area === "ready_for_merge" && Array.isArray(board.readyForMerge))
        board.readyForMerge.push(...more);
    }
  }
  board.window = null;
  return board;
}

/**
 * Ticket details cached by updated_at. Read in batches through GET /tickets/details
 * (exploratory finding api-robustness/F9: one GET /tickets/:id per ticket made the Map
 * at 2000 tickets ~1000 requests), with only the parts the caller needs: the links
 * (repositories, scopes, dependencies) by default, `DETAIL_FULL` for the views that
 * also read a ticket's events, evidence and rework trail.
 */
const DETAIL_LINKS = ["repositories", "scopes", "dependencies"];
const DETAIL_FULL = [...DETAIL_LINKS, "rework_trail", "events", "evidence"];
const DETAIL_IDS_PER_READ = 150;
const DETAIL_PAGE = 1000;
const ticketDetailCache = new Map();
const TICKET_DETAIL_TTL_MS = 120000;
async function ticketDetails(tickets, signal, include = DETAIL_LINKS) {
  const now = Date.now();
  const fresh = (c) =>
    c && now - c.at <= TICKET_DETAIL_TTL_MS && include.every((k) => c.parts.has(k));
  const need = tickets.filter((t) => {
    const c = ticketDetailCache.get(t.id);
    return !fresh(c) || c.stamp !== t.updated_at;
  });
  const keep = (rows) => {
    for (const d of rows || []) {
      if (!d || !d.ticket) continue;
      const old = ticketDetailCache.get(d.ticket.id);
      // A fuller entry for the same revision keeps the parts this read did not ask for.
      const base = old && old.stamp === d.ticket.updated_at ? old.data : {};
      ticketDetailCache.set(d.ticket.id, {
        stamp: d.ticket.updated_at,
        at: now,
        parts: new Set([
          ...(old && old.stamp === d.ticket.updated_at ? old.parts : []),
          ...include,
        ]),
        data: { ...base, ...d },
      });
    }
  };
  const opts = { signal };
  const inc = include.join(",");
  try {
    if (need.length > DETAIL_PAGE / 2) {
      // Most of the club: page through every ticket instead of naming each one.
      let offset = 0;
      for (let guard = 0; guard < 1000; guard++) {
        const res = await api(
          "GET",
          `/tickets/details?include=${inc}&limit=${DETAIL_PAGE}&offset=${offset}`,
          undefined,
          opts,
        );
        keep(res && res.details);
        if (!res || res.next_offset == null) break;
        offset = res.next_offset;
      }
    } else {
      const chunks = [];
      for (let i = 0; i < need.length; i += DETAIL_IDS_PER_READ)
        chunks.push(need.slice(i, i + DETAIL_IDS_PER_READ));
      const got = await Promise.all(
        chunks.map((c) =>
          api(
            "GET",
            `/tickets/details?include=${inc}&ids=${c.map((t) => encodeURIComponent(t.id)).join(",")}`,
            undefined,
            opts,
          ),
        ),
      );
      for (const res of got) keep(res && res.details);
    }
  } catch (e) {
    if (e && e.code === "ABORTED") throw e;
    // A failed batch leaves those tickets without details (as a failed read did before).
  }
  const out = new Map();
  for (const t of tickets) {
    const c = ticketDetailCache.get(t.id);
    if (c) out.set(t.id, c.data);
  }
  return out;
}
const runDetailCache = new Map();
async function activeRunDetails(active, signal) {
  const out = new Map();
  await Promise.all(
    (active || []).map(async (r) => {
      const c = runDetailCache.get(r.id);
      let d = c && Date.now() - c.at < 20000 ? c.data : null;
      if (!d) {
        d = await api("GET", `/api/runs/${r.id}`, undefined, { signal })
          .then((x) => x.detail || x)
          .catch((e) => {
            if (e && e.code === "ABORTED") throw e;
            return null;
          });
        if (d) runDetailCache.set(r.id, { at: Date.now(), data: d });
      }
      if (d && d.ticket_number != null) out.set(d.ticket_number, d);
    }),
  );
  return out;
}

/** How many details the overview may read (the newest first): a big club stays fast. */
const OVERVIEW_DETAIL_CAP = 150;
const TERMINAL = new Set(["done", "cancelled", "failed"]);

/** Everything the Overview draws, read once per render. */
async function loadMatchDay() {
  const signal = routeSignal();
  const opt = (p, fb) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && (e.code === "ABORTED" || e.code === "UNAUTHORIZED")) throw e;
      return fb;
    });
  const [
    dash,
    queue,
    board,
    cost,
    health,
    settings,
    claimsRes,
    agentsRes,
    runsRes,
    activity,
    decs,
    nodes,
  ] = await Promise.all([
    api("GET", "/api/dashboard", undefined, { signal }),
    opt("/api/human-queue", { items: [], counts: { total: 0 } }),
    boardAll("", { signal }).catch((e) => {
      if (e && (e.code === "ABORTED" || e.code === "UNAUTHORIZED")) throw e;
      return null;
    }),
    opt("/api/cost", null),
    opt("/api/health", null),
    opt("/api/settings", null),
    opt("/claims", { claims: [] }),
    opt("/agents", { agents: [] }),
    opt("/api/runs?active=1", { active: [] }),
    opt("/api/activity?limit=200", { events: [] }),
    opt("/decisions", { decisions: [] }),
    opt("/scope/nodes", { nodes: [] }),
    ensureSquad(),
  ]);
  const summary = dash.summary || {};
  const claims = (claimsRes && claimsRes.claims) || [];
  const agents = (agentsRes && agentsRes.agents) || [];
  learnAgents(agents);
  learnAgents(claims);

  // Tickets: the board's cards carry the repo and the claim; the board covers
  // every status (lanes + closed + won't do).
  let tickets = [];
  if (board) {
    for (const c of board.columns || []) tickets.push(...(c.cards || []));
    tickets.push(...(board.closed || []), ...(board.wontDo || []));
  } else {
    tickets = (
      (
        await allTickets("", { signal }).catch((e) => {
          if (e && e.code === "ABORTED") throw e;
          return { tickets: [] };
        })
      ).tickets || []
    ).map((t) => ({
      ...t,
      repos: [],
    }));
  }
  const seen = new Set();
  tickets = tickets.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  const byId = new Map(tickets.map((t) => [t.id, t]));

  // Details for the live tickets and the most recent closed ones (capped).
  const ranked = tickets
    .filter((t) => t.status !== "cancelled")
    .sort(
      (a, b) =>
        TERMINAL.has(a.status) - TERMINAL.has(b.status) ||
        String(b.updated_at).localeCompare(String(a.updated_at)),
    );
  const detailCapped = ranked.length > OVERVIEW_DETAIL_CAP;
  const details = await ticketDetails(ranked.slice(0, OVERVIEW_DETAIL_CAP), signal, DETAIL_FULL);
  const runByTicket = await activeRunDetails((runsRes && runsRes.active) || [], signal);

  const repoOf = new Map();
  for (const t of tickets) {
    const d = details.get(t.id);
    const write = d?.repositories?.find((r) => r.access === "write") || d?.repositories?.[0];
    const name = write?.name || t.repos?.[0]?.name || null;
    if (name) repoOf.set(t.id, name);
  }
  learnKits([...repoOf.values()].sort());

  const setting = (k) => {
    const s = (settings?.settings || []).find((x) => x.key === k);
    const v = s ? Number(s.effective ?? s.value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  // Epics: membership from each ticket's scopes; phases from in-epic dependencies.
  const epicNodes = ((nodes && nodes.nodes) || []).filter((n) => n.type === "epic");
  const epics = epicNodes.map((n) => ({ node: n, members: [] }));
  const epicById = new Map(epics.map((e) => [e.node.id, e]));
  const epicOf = new Map();
  for (const t of tickets) {
    for (const s of details.get(t.id)?.scopes || []) {
      const e = epicById.get(s.id);
      if (e) {
        e.members.push(t);
        if (!epicOf.has(t.id)) epicOf.set(t.id, e.node.name);
      }
    }
  }
  const factoryNode = ((nodes && nodes.nodes) || []).find((n) => n.type === "factory");

  const claimByTicket = new Map(claims.map((c) => [c.ticket_id, c]));
  for (const t of tickets) {
    if (!claimByTicket.has(t.id) && t.claim && !t.claim.stale) {
      claimByTicket.set(t.id, {
        ticket_id: t.id,
        ticket_number: t.number,
        agent_id: t.claim.agentId,
        agent_display_name: t.claim.agentDisplayName,
        agent_display: t.claim.agent_display || null,
      });
    }
  }

  return {
    now: Date.now(),
    summary,
    queue,
    items: (queue && queue.items) || [],
    tickets,
    byId,
    byNo: new Map(tickets.filter((t) => t.number != null).map((t) => [t.number, t])),
    details,
    detailCapped,
    repoOf,
    epics: epics.filter((e) => e.members.length),
    epicOf,
    claims,
    claimByTicket,
    agents,
    runByTicket,
    cost,
    health,
    budget: setting("GAFFER_DAILY_BUDGET_USD"),
    slots: setting("GAFFER_CONCURRENCY"),
    autoMerge: (settings?.settings || []).find((x) => x.key === "AUTO_MERGE")?.effective,
    decisions: (decs && decs.decisions) || [],
    events: (activity && activity.events) || [],
    clubName: (squad.club && squad.club.name) || summary.clubName || factoryNode?.name || null,
  };
}

/** The ticket a team-sheet row is about (with its current status), if any. */
function rowTicket(f, it) {
  return it.ticket ? f.byId.get(it.ticket.id) || it.ticket : null;
}
/** Did a parked ticket stop on a failing test? (the rework trail or the reason says so) */
function parkedOnTest(f, t, reason) {
  const trail = (t && f.details.get(t.id)?.rework_trail) || [];
  if (trail.length) return trail[trail.length - 1].gate === "tests";
  return /\btests?\b/i.test(reason || "");
}

/**
 * A ticket's title as a headline names it: the WHOLE title (the work, in its own words),
 * without a trailing "(…)" (a run id, a date), cut only by length, at a word boundary,
 * with an ellipsis. Never cut at a word like "for / with / via": "Add retry with backoff"
 * is not "Add retry". The full title stays on the element's title and accessible name.
 */
function headTitle(title, max = 60) {
  const full = String(title || "").trim();
  if (!full) return "";
  // A trailing parenthetical (a run id, a date) is reference, not the work.
  let short = full.replace(/\s+\([^()]*\)$/, "") || full;
  if (short.length > max) {
    const cut = short
      .slice(0, max + 1)
      .replace(/\s+\S*$/, "")
      .replace(/[\s,;:.-]+$/, "");
    short = `${cut || short.slice(0, max)}…`;
  }
  return short;
}
/** The ticket's number as the reference after its title: muted, never the subject. */
function hlRef(t) {
  return t && t.number != null ? el("span", { class: "hl-ref" }, `#${t.number}`) : null;
}
/** "<title> #N": the work, then its reference. */
function hlWork(t, fallback = "A ticket") {
  const what = t ? headTitle(t.title) : "";
  if (!what) return [fallback];
  const ref = hlRef(t);
  return [el("span", { class: "hl-what" }, what), ref ? " " : "", ref];
}

/**
 * The scoreboard's headline: one specific sentence from the queue, every clause a
 * link to its object, and the WORK leads, never a ticket number: "5 things need you.
 * ■ Webhook delivery for task events #10 is blocked by a failing test." (the number is the muted
 * reference after the title). With nothing parked the first thing waiting leads
 * ("Export to CSV #12 awaits your sign-off."). On a phone the count gives way to that
 * clause: the Team Sheet says how many, once. When nothing needs you, it says what the
 * squad is doing instead.
 */
function matchHeadline(f) {
  const items = f.items;
  const kind = (k) => items.filter((i) => i.kind === k);
  const parked = kind("parked");
  const reviews = kind("review");
  const decisions = kind("decision");
  const merges = kind("awaiting_merge");
  const others = items.filter(
    (i) => !["parked", "review", "decision", "awaiting_merge"].includes(i.kind),
  );
  const onPitch = f.summary.activeClaims ?? f.claims.length;
  const slots = f.slots;
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  const wage =
    today == null
      ? null
      : f.budget
        ? `${money(today)} of ${moneyW(f.budget)} wage bill today`
        : `${money(today)} wage bill today`;
  const squadLine = slots
    ? `${onPitch} of ${slots} agents on the pitch`
    : `${plural(onPitch, "agent")} on the pitch`;
  const sub = [];
  let lead;
  if (items.length) {
    lead = [
      el(
        "span",
        { class: "hl-count" },
        `${plural(items.length, "thing")} ${items.length === 1 ? "needs" : "need"} you.`,
      ),
    ];
    for (const p of parked.slice(0, 2)) {
      const t = rowTicket(f, p);
      const epic = t && f.epicOf.get(t.id);
      const test = parkedOnTest(f, t, p.reason);
      const verb = t && t.status === "blocked" ? "is blocked" : "is parked";
      lead.push(
        " ",
        el(
          "a",
          {
            class: "hl-block",
            href: t ? `#/ticket/${t.id}` : "#what-i-own",
            title: t ? t.title : null,
          },
          [
            el("span", { class: "hl-nb" }, [
              glyph("blocked", 34),
              epic
                ? "Epic"
                : el("span", { class: "hl-what" }, (t && headTitle(t.title)) || "A ticket"),
            ]),
            " ",
            epic
              ? [el("q", {}, epic), " is blocked at ", ...hlWork(t)]
              : t && t.number != null
                ? [hlRef(t), " ", verb]
                : verb,
            test ? " by a failing test." : ".",
          ],
        ),
      );
    }
    // Nothing parked: the first thing waiting leads, named by its work.
    if (!parked.length) {
      const r0 = reviews[0] && rowTicket(f, reviews[0]);
      const m0 = merges[0] && rowTicket(f, merges[0]);
      if (r0)
        lead.push(
          " ",
          el("a", { class: "hl-block hl-wait", href: `#/review/${r0.id}`, title: r0.title }, [
            ...hlWork(r0),
            " awaits your sign-off.",
          ]),
        );
      else if (m0)
        lead.push(
          " ",
          el("a", { class: "hl-block hl-wait", href: `#/ticket/${m0.id}`, title: m0.title }, [
            ...hlWork(m0),
            " is approved, not merged.",
          ]),
        );
      else if (decisions.length)
        lead.push(
          " ",
          el(
            "a",
            { class: "hl-block hl-wait", href: "#what-i-own" },
            `${plural(decisions.length, "decision")} ${decisions.length === 1 ? "waits" : "wait"} for your answer.`,
          ),
        );
      else if (others.length)
        lead.push(
          " ",
          el(
            "a",
            { class: "hl-block hl-wait", href: "#what-i-own" },
            `${plural(others.length, "call")} ${others.length === 1 ? "waits" : "wait"} for you.`,
          ),
        );
    }
    if (reviews.length) {
      const first = rowTicket(f, reviews[0]);
      sub.push(
        el(
          "a",
          { href: first ? `#/review/${first.id}` : "#/review" },
          `${plural(reviews.length, "diff")} ${reviews.length === 1 ? "awaits" : "await"} review`,
        ),
      );
    }
    if (decisions.length)
      sub.push(el("a", { href: "#what-i-own" }, plural(decisions.length, "decision")));
    // The lead already names the first approved-but-unmerged change when nothing is
    // parked or in review; the sub line names the rest, work first.
    const leadMerge = !parked.length && !reviews.length ? 1 : 0;
    for (const m of merges.slice(leadMerge, 2)) {
      const t = rowTicket(f, m);
      if (t)
        sub.push(
          el("a", { href: `#/ticket/${t.id}`, title: t.title }, [
            ...hlWork(t),
            " approved, not merged",
          ]),
        );
    }
    if (merges.length > 2) sub.push(`${merges.length - 2} more approved, not merged`);
    if (others.length)
      sub.push(el("a", { href: "#what-i-own" }, plural(others.length, "other call")));
    sub.push(squadLine);
  } else {
    lead = [el("span", { class: "hl-count hl-calm" }, "Nothing needs you.")];
    // What the squad is on, by the work (the number after it): at most two named.
    const on = f.claims
      .filter((c) => c.ticket_number != null)
      .sort((a, b) => a.ticket_number - b.ticket_number);
    const named = on
      .slice(0, 2)
      .map((c) =>
        hlWork({ number: c.ticket_number, title: c.ticket_title || "" }, `#${c.ticket_number}`),
      );
    const free = slots ? Math.max(0, slots - onPitch) : null;
    sub.push(
      el("span", {}, [
        squadLine,
        ...(named.length
          ? [
              ", on ",
              ...named.flatMap((w, i) => (i ? [" and ", ...w] : w)),
              on.length > 2 ? ` and ${on.length - 2} more` : "",
            ]
          : []),
        free != null ? `; ${plural(free, "slot")} free` : "",
      ]),
    );
  }
  if (f.summary.staleClaims > 0)
    sub.push(
      el("a", { href: "#/work" }, `${plural(f.summary.staleClaims, "stale claim")} (no heartbeat)`),
    );
  if (wage) sub.push(wage);
  return { lead, sub };
}

/**
 * The stadium scoreboard: the headline sentence plus four counters (need you ·
 * on the pitch against the slots · delivered today · the wage bill against the
 * daily budget). Full-bleed and always dark; the digits flip once on arrival.
 */
function overviewScoreboard(f) {
  const { lead, sub } = matchHeadline(f);
  const total = f.items.length;
  const onPitch = f.summary.activeClaims ?? f.claims.length;
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  const subP = el("p", { class: "hl-sub" });
  sub.forEach((c, i) => {
    if (i) subP.appendChild(el("span", { class: "sep", "aria-hidden": "true" }, " · "));
    subP.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  const chain = f.health?.event_log;
  const logStatus =
    chain?.chain_ok === false
      ? `Ledger: event log ALTERED at seq ${chain.broken_at_seq} — see Health`
      : chain?.chain_ok === true
        ? `Ledger: event log intact (${chain.events} events)`
        : null;
  const nowIso = new Date(f.now).toISOString();
  return el("section", { class: "scoreboard bleed", "aria-label": "Scoreboard" }, [
    el("div", { class: "scoreboard-in" }, [
      el("div", { class: "sb-main" }, [el("h1", { class: "hl" }, lead), subP]),
      el("div", { class: "sb-side" }, [
        el("div", { class: "sb-cells kpi-row", role: "group", "aria-label": "Today" }, [
          statCell({
            label: "Need you",
            // Plain figures in every cell: "Need you 03" beside "On the pitch 4" read as
            // two different kinds of number.
            value: String(total),
            needs: total > 0,
            href: "#what-i-own",
            flip: "needs",
            title: `${total} waiting for you`,
            cls: "sc-needs",
          }),
          statCell({
            label: "On the pitch",
            value: f.slots ? `${onPitch}/${f.slots}` : String(onPitch),
            href: "#tactics",
            flip: "pitch",
            title: f.slots
              ? `${onPitch} of ${f.slots} agent slots working`
              : `${onPitch} agents working`,
          }),
          statCell({
            label: "Delivered today",
            value: String(f.summary.deliveredToday ?? 0),
            // The tickets that landed today are the Floor's lorry ("N despatched
            // today"); the done list holds every landing ever, so it never matched.
            href: "#/floor",
            flip: "delivered",
            title: `${plural(f.summary.deliveredToday ?? 0, "ticket")} landed (done) today: the Floor's lorry shows them`,
          }),
          statCell({
            label: "Wage bill",
            value: today == null ? "—" : money(today),
            flip: "wage",
            title: "API-equivalent spend today, from the usage ledger",
            after:
              today != null && f.budget
                ? el("div", { class: "sc-band" }, [
                    band(
                      today,
                      f.budget,
                      `${money(today)} of the ${moneyW(f.budget)} daily budget (${Math.round((today / f.budget) * 100)}%)`,
                    ),
                    el("span", { class: "kpi-sub" }, `of ${moneyW(f.budget)} today`),
                  ])
                : el("span", { class: "kpi-sub" }, "today, API-equivalent"),
          }),
        ]),
      ]),
      // The board's small print, top right: when it was read and the ledger's
      // integrity (an altered log reads red and bold).
      el("div", { class: "sb-small" }, [
        el(
          "time",
          { class: "sb-clock", datetime: nowIso },
          `${fmtDay(nowIso)} · ${clockTime(f.now)}`,
        ),
        logStatus
          ? el("p", { class: `view-hero-status${chain?.chain_ok !== false ? " ok" : ""}` }, [
              chain?.chain_ok !== false ? glyph("done", 14) : glyph("failed", 14),
              el("span", {}, logStatus),
            ])
          : null,
      ]),
    ]),
  ]);
}

export {
  PITCH_ZONES,
  ON_PITCH,
  OFF_PITCH,
  ON_BENCH,
  benchedCampaignLine,
  PITCH_MAX_CHANNELS,
  ARROW_WINDOW_MS,
  svgS,
  wrapLabel,
  textWidth,
  pitchBall,
  shirtGroup,
  allTickets,
  boardAll,
  DETAIL_FULL,
  ticketDetails,
  TERMINAL,
  loadMatchDay,
  hlWork,
  overviewScoreboard,
};
