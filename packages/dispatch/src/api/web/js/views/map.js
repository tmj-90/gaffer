// View: Map (UI-000 / UI-001 / UI-002 / UI-003).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock } from "../access.js";
import { api } from "../api.js";
import { emptyState, panelHead, viewHead } from "../components.js";
import { el, field } from "../dom.js";
import { plural } from "../format.js";
import { clockTime } from "../freshness.js";
import { glyph, icon, learnKits, repoTag, ycard } from "../icons.js";
import { ON_BENCH, ON_PITCH, boardAll, ticketDetails } from "../matchday.js";
import { navigate, routeSignal, router } from "../router.js";
import { hideRepoSheet } from "../sheets.js";
import { riskBadge, statusLabel } from "../status.js";
import { guard, toast } from "../toast.js";
import { progPage } from "./programme.js";
import { hashText } from "./work.js";
import { onboardButton } from "../../app.js";

// ===========================================================================
//  Map (UI-000 / UI-001 / UI-002 / UI-003)
// ===========================================================================

const SCOPE_NODE_TYPES = [
  "factory",
  "domain",
  "product",
  "capability",
  "system",
  "service",
  "library",
  "external_dependency",
];
const SCOPE_EDGE_RELATIONS_V1 = ["contains", "depends_on"];
const SCOPE_EDGE_RELATIONS_ADVANCED = [
  "calls",
  "publishes_to",
  "consumes_from",
  "shares_library",
  "deployed_with",
];
const SCOPE_REPO_RELATIONS = [
  "owns",
  "contains",
  "uses",
  "depends_on",
  "shared_by",
  "deployed_with",
  "read_context",
  "write_target",
  "test_target",
];
const SCOPE_REPO_ACCESS = ["write", "read", "test", "none"];

const factoryState = { query: "" };

function parseTags(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
function typeLabel(type) {
  return String(type || "").replace(/_/g, " ");
}
// The Map's live overlay: what each ticket on the board means at a ground.
// Red = blocked or failed, yellow = waits on your sign-off, paused = off the pitch
// in the dugout (held at a budget cap or by hand), in play = the rest of the pitch.
// Drafts and refining tickets are on the bench and are not shown as counters.
const MAP_RED = new Set(["blocked", "failed"]);
const MAP_YELLOW = new Set(["in_review", "ready_for_merge"]);
function mapTone(status) {
  if (MAP_RED.has(status)) return "red";
  if (MAP_YELLOW.has(status)) return "yellow";
  if (status === "paused") return "paused";
  if (ON_PITCH.has(status)) return "play";
  return null;
}
const MAP_TONE_RANK = { red: 0, yellow: 1, paused: 2, play: 3 };
/**
 * The scope the server records for a ticket that targets a repo with no ground:
 * an external_dependency node named "repo:<name>". It is the free agent playing
 * as its own single-repo scope, never a third party, so the Map leaves it off the
 * grounds and shows the repo under Free agents.
 */
function isImplicitScope(n) {
  return (
    !!n &&
    n.type === "external_dependency" &&
    /^repo:/.test(n.name || "") &&
    (/^Implicit single-repo scope/i.test(n.description || "") || !n.description)
  );
}
const MAP_COUNTERS = 6;

/** Every ticket on the board once: the live columns, the closed area and won't-do. */
function boardCards(board) {
  const seen = new Set();
  const out = [];
  for (const c of [
    ...((board && board.columns) || []).flatMap((col) => col.cards || []),
    ...((board && board.closed) || []),
    ...((board && board.wontDo) || []),
  ]) {
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/**
 * Who plays at each ground and which tickets are there: the ONE source the Map,
 * a ground's page and a repo's page all count from. A ticket is at a ground when
 * a repo it delivers to (the board's write boundary) plays there, or when the
 * ticket is linked to the ground itself (as campaign members are). Reads: the
 * board, each repo's scope links, and the details of the tickets in the book.
 * `all` puts every ticket in the book (a ground's page counts its results too);
 * the Map only needs the live ones.
 */
async function mapOverlay(nodes, repos, signal, { all = false } = {}) {
  const opt = (p, fb) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fb;
    });
  // The whole board, and every repo's grounds in ONE read (it was one per repo).
  const [board, scopeLinks] = await Promise.all([
    boardAll("", { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return null;
    }),
    opt("/scope/repos?all=1", { by_repo: {} }),
  ]);
  const links = repos.map((r) => ({
    scopes: (scopeLinks && scopeLinks.by_repo && scopeLinks.by_repo[r.id]) || [],
  }));
  const every = boardCards(board);
  const cards = every.filter((c) => mapTone(c.status));
  const book = all ? every.filter((c) => c.status !== "cancelled") : cards;
  // node id → [{ repo, relation, access }]
  const reposAt = new Map(nodes.map((n) => [n.id, []]));
  // repo id → [{ node, relation, access }]
  const groundsOf = new Map(repos.map((r) => [r.id, []]));
  repos.forEach((r, i) => {
    for (const s of (links[i] && links[i].scopes) || []) {
      if (!reposAt.has(s.id)) continue;
      reposAt.get(s.id).push({ repo: r, relation: s.relation, access: s.default_access });
      groundsOf.get(r.id).push({ node: s, relation: s.relation, access: s.default_access });
    }
  });
  const repoIdByName = new Map(repos.map((r) => [r.name, r.id]));
  const nodesOfRepo = new Map();
  for (const [nid, list] of reposAt)
    for (const { repo } of list) {
      if (!nodesOfRepo.has(repo.id)) nodesOfRepo.set(repo.id, new Set());
      nodesOfRepo.get(repo.id).add(nid);
    }
  // Direct links (a ticket scoped to a ground, as campaign members are).
  const details = book.length
    ? await ticketDetails(book, signal).catch((e) => {
        if (e && e.code === "ABORTED") throw e;
        return new Map();
      })
    : new Map();
  const at = new Map(nodes.map((n) => [n.id, new Map()]));
  const ofRepo = new Map(repos.map((r) => [r.id, new Map()]));
  for (const c of book) {
    const here = new Set();
    for (const r of c.repos || []) {
      const rid = r.id || repoIdByName.get(r.name);
      if (ofRepo.has(rid)) ofRepo.get(rid).set(c.id, c);
      for (const nid of nodesOfRepo.get(rid) || []) here.add(nid);
    }
    for (const s of (details.get(c.id) && details.get(c.id).scopes) || []) here.add(s.id);
    for (const nid of here) if (at.has(nid)) at.get(nid).set(c.id, c);
  }
  const sorted = (m) =>
    [...m.values()].sort(
      (a, b) =>
        (MAP_TONE_RANK[mapTone(a.status)] ?? 9) - (MAP_TONE_RANK[mapTone(b.status)] ?? 9) ||
        (b.priority || 0) - (a.priority || 0) ||
        (a.number || 0) - (b.number || 0),
    );
  const live = (list) => list.filter((c) => mapTone(c.status));
  const ticketsAt = new Map([...at].map(([k, v]) => [k, sorted(v)]));
  const ticketsOfRepo = new Map([...ofRepo].map(([k, v]) => [k, sorted(v)]));
  return {
    board: !!board,
    cards: sorted(new Map(cards.map((c) => [c.id, c]))),
    book: sorted(new Map(book.map((c) => [c.id, c]))),
    reposAt,
    groundsOf,
    ticketsAt,
    ticketsOfRepo,
    liveAt: new Map([...ticketsAt].map(([k, v]) => [k, live(v)])),
    liveOfRepo: new Map([...ticketsOfRepo].map(([k, v]) => [k, live(v)])),
  };
}

/** The tickets at a ground, from the overlay. The club holds every ticket. */
function groundBook(n, ov, { live = true } = {}) {
  if (!ov) return [];
  if (n.type === "factory") return live ? ov.cards : ov.book;
  return (live ? ov.liveAt : ov.ticketsAt).get(n.id) || [];
}

/**
 * Counts, each ticket in exactly one: red (blocked or failed), yellow (waits on
 * your sign-off), paused (in the dugout) and play (the rest of the pitch).
 * live = red + yellow + paused + play, so the words on a card add up to its
 * counters, and live + done + bench is every ticket in the book.
 */
function mapTally(list) {
  // merge: the yellow that is already signed off and waits only on the merge, so
  // the words can say "2 to review · 1 to merge" (Health counts the 2).
  const t = { red: 0, yellow: 0, merge: 0, paused: 0, play: 0, live: 0, done: 0, bench: 0 };
  for (const c of list || []) {
    const tone = mapTone(c.status);
    if (tone) {
      t[tone] += 1;
      t.live += 1;
      if (c.status === "ready_for_merge") t.merge += 1;
    } else if (c.status === "done") t.done += 1;
    else if (ON_BENCH.has(c.status)) t.bench += 1;
  }
  return t;
}
/** A tally in words, worst first: "1 blocked · 2 to review · 1 paused · 3 in play". */
function tallyWords(t) {
  return [
    t.red ? el("span", { class: "is-red" }, `${t.red} blocked`) : null,
    t.yellow - t.merge ? el("span", {}, `${t.yellow - t.merge} to review`) : null,
    t.merge ? el("span", {}, `${t.merge} to merge`) : null,
    t.paused ? el("span", {}, `${t.paused} paused`) : null,
    t.play ? el("span", {}, `${t.play} in play`) : null,
  ]
    .filter(Boolean)
    .flatMap((x, i) => (i ? [" · ", x] : [x]));
}
/** Where a counter goes: a change waiting on you opens in Review, the rest on its page. */
function mapCounterHref(c) {
  return c.status === "in_review" ? `#/review/${c.id}` : `#/ticket/${c.id}`;
}
/**
 * A ticket as a magnet counter: its number on a disc, carded when it needs you.
 * On the Map it is a link to the ticket (as the tactics board's are); inside a
 * row that is already a link, pass `link: false`.
 */
function mapCounter(c, { link = true } = {}) {
  const tone = mapTone(c.status);
  const word = statusLabel(c.status, c.landing_state);
  const marks = [
    el("span", { class: "mag-n tabnum" }, String(c.number ?? "?")),
    tone === "yellow" ? ycard(12, "mag-card") : null,
    tone === "red" ? el("span", { class: "mag-red", "aria-hidden": "true" }) : null,
    tone === "paused" ? el("span", { class: "mag-pause", "aria-hidden": "true" }) : null,
  ];
  if (!link)
    return el(
      "span",
      { class: `mag is-${tone}`, title: `#${c.number} ${c.title || ""} · ${word}` },
      marks,
    );
  return el(
    "a",
    {
      class: `mag is-${tone}`,
      href: mapCounterHref(c),
      title: `#${c.number} ${c.title || ""} · ${word}`,
      "aria-label": `#${c.number} ${word}${tone === "yellow" ? ", needs you" : ""}: ${c.title || ""}`,
    },
    marks,
  );
}

/** One ground on the map: name (the link), type and risk, who plays here, what is live. */
function mapGround(n, ov, relLine) {
  const repos = (ov && ov.reposAt.get(n.id)) || [];
  // The club holds everything: its card tallies every live ticket, without counters.
  const club = n.type === "factory" && ov;
  const live = groundBook(n, ov);
  const t = mapTally(live);
  const search = [n.name, n.type, n.owner, ...repos.map((r) => r.repo.name)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const shown = club ? [] : live.slice(0, MAP_COUNTERS);
  const more = club ? 0 : live.length - shown.length;
  return el(
    "div",
    {
      class: `scope-gnode type-${n.type}${t.red ? " has-red" : ""}`,
      dataset: { name: (n.name || "").toLowerCase(), search, node: n.id },
    },
    [
      el("div", { class: "sg-top" }, [
        el("a", { class: "sg-name", href: `#/node/${n.id}` }, n.name),
        n.risk_level ? riskBadge(n.risk_level) : null,
      ]),
      el("span", { class: "sg-meta" }, [
        el("span", { class: "sg-type" }, typeLabel(n.type)),
        n.owner ? el("span", {}, `@${n.owner}`) : null,
      ]),
      relLine ? el("span", { class: "sg-rel" }, relLine) : null,
      repos.length
        ? el("span", { class: "sg-repos" }, [
            ...repos.slice(0, 2).map((r) => repoTag(r.repo.name, 16)),
            repos.length > 2 ? el("span", { class: "sg-more" }, `+${repos.length - 2}`) : null,
          ])
        : null,
      live.length
        ? el("span", { class: "sg-live" }, [
            club
              ? el("span", { class: "sg-club" }, [
                  el("b", { class: "tabnum" }, String(live.length)),
                  " live across the club",
                ])
              : el("span", { class: "sg-mags" }, [
                  ...shown.map((c) => mapCounter(c)),
                  more > 0
                    ? el(
                        "a",
                        {
                          class: "sg-more mag-more",
                          href: `#/node/${n.id}`,
                          "aria-label": `${more} more live at ${n.name}`,
                        },
                        `+${more}`,
                      )
                    : null,
                ]),
            el("span", { class: "sg-words" }, tallyWords(t)),
          ])
        : el("span", { class: "sg-words is-quiet" }, ov && ov.board ? "Nothing in play" : ""),
    ],
  );
}

/** The map key: what the lines, counters and cards mean. */
function mapKey() {
  const disc = (cls, extra) =>
    el("span", { class: `mag is-${cls}`, "aria-hidden": "true" }, [
      el("span", { class: "mag-n" }, "12"),
      extra,
    ]);
  return el("ul", { class: "clean map-key", "aria-label": "Map key" }, [
    el("li", {}, [el("span", { class: "mk-line contains" }), "contains"]),
    el("li", {}, [el("span", { class: "mk-line dep" }), "depends on"]),
    el("li", {}, [disc("play"), "a ticket on the pitch"]),
    el("li", {}, [disc("yellow", ycard(12, "mag-card")), "waits on your sign-off"]),
    el("li", {}, [
      disc("red", el("span", { class: "mag-red", "aria-hidden": "true" })),
      "blocked or failed",
    ]),
    el("li", {}, [
      disc("paused", el("span", { class: "mag-pause", "aria-hidden": "true" })),
      "paused, in the dugout",
    ]),
  ]);
}

async function renderFactory() {
  const signal = routeSignal();
  const soft = (p, fb) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fb;
    });
  const [nodesRes, edgesRes, unmappedRes, reposRes, hiddenRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    api("GET", "/scope/edges", undefined, { signal }),
    api("GET", "/scope/unmapped-repos", undefined, { signal }),
    soft("/repositories", { repositories: [] }),
    soft("/repositories?hidden=only", null),
  ]);
  const hiddenN = hiddenRes ? (hiddenRes.repositories || []).length : 0;
  // The server's synthetic "repo:<name>" scopes are free agents, not grounds.
  const implicitIds = new Set((nodesRes.nodes || []).filter(isImplicitScope).map((n) => n.id));
  const nodes = (nodesRes.nodes || []).filter((n) => !implicitIds.has(n.id));
  const edges = (edgesRes.edges || []).filter(
    (e) => !implicitIds.has(e.from_node_id) && !implicitIds.has(e.to_node_id),
  );
  const unmapped = unmappedRes.repositories || [];
  const repos = reposRes.repositories || [];
  learnKits(repos.map((r) => r.name));
  const ov = await mapOverlay(nodes, repos, signal);
  const readAt = Date.now();

  const wrap = el("div", { class: "view view-map" });
  const campaigns = nodes.filter((n) => n.type === "epic").length;
  wrap.appendChild(
    viewHead(
      "The scouting map",
      [
        plural(nodes.length, "ground"),
        plural(repos.length, "repo"),
        campaigns ? plural(campaigns, "campaign") : null,
        ov.board ? `${ov.cards.length} live ${ov.cards.length === 1 ? "ticket" : "tickets"}` : null,
        unmapped.length ? plural(unmapped.length, "free agent") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      [
        roLock(
          el("button", { class: "btn", type: "button", onclick: () => navigate("#/node") }, [
            icon("plus"),
            "New ground",
          ]),
        ),
        onboardButton(repos, null, { primary: true }),
      ],
    ),
  );

  const graphCard = renderScopeGraph(nodes, edges, ov, readAt);
  wrap.appendChild(graphCard);
  wrap._mounted = () => graphCard._fit && graphCard._fit();

  const register = renderRepoRegister(repos, unmapped, ov);
  const freeAgents = renderUnmappedSection(unmapped, repos, hiddenN, {
    ov,
    grounds: nodes.length,
  });
  const side = el("div", { class: "stack map-side" }, [
    unmapped.length ? null : freeAgents,
    el("details", { class: "card map-help" }, [
      el("summary", {}, "How the map works"),
      el("p", {}, [
        "A ground is a scope node: the club, a product, a service, a campaign or something outside the ground. ",
        el("b", {}, "Contains"),
        " lines show what sits inside what; dashed ",
        el("b", {}, "depends on"),
        " lines show who leans on whom.",
      ]),
      el(
        "p",
        {},
        "Repos play at one or more grounds, each with its own access (write, read or test). A repo with no ground plays as its own single-repo scope, and can be given a ground later without touching its tickets.",
      ),
    ]),
    renderFactoryFooter(),
  ]);
  wrap.appendChild(el("div", { class: "map-lower" }, [register, side]));
  if (unmapped.length) wrap.appendChild(freeAgents);

  wrap.dataset.sig = hashText(
    JSON.stringify([
      nodes.map((n) => [n.id, n.updated_at]),
      edges.map((e) => e.id),
      repos.map((r) => [r.id, r.updated_at]),
      unmapped.map((r) => r.id),
      hiddenN,
      [...ov.reposAt].map(([k, v]) => [k, v.map((x) => `${x.repo.id}:${x.access}`)]),
      ov.cards.map((c) => `${c.id}:${c.status}`),
    ]),
  );
  applyFactoryFilter(wrap, factoryState.query.trim().toLowerCase());
  return wrap;
}

// Low-key entry point to the (deliberately unadvertised) "Hidden repos" page.
// Not a nav tab — a small footer link under the Map, so a hidden repo
// can be brought back without surfacing the capability prominently.
function renderFactoryFooter() {
  return el("div", { class: "factory-footer dim" }, [
    el(
      "a",
      {
        class: "hidden-repos-link",
        href: "#/hidden",
        title: "Repos hidden from the dashboard",
      },
      "Hidden repos",
    ),
  ]);
}

/** Column names from what stands in them (the club, its products, its services…). */
const MAP_COL_WORD = {
  factory: "The club",
  domain: "Domains",
  product: "Products",
  capability: "Capabilities",
  system: "Systems",
  service: "Services",
  library: "Libraries",
  component: "Components",
  external_dependency: "Outside the ground",
  epic: "Campaigns",
};
/**
 * The map's columns, by what a ground IS, so a column's name is always true and
 * outside grounds always stand at the far touchline: the club and its campaigns,
 * domains, products, services (and the other parts that run), outside the ground.
 * Empty tiers are dropped.
 */
const MAP_TIER = {
  factory: 0,
  epic: 0,
  domain: 1,
  product: 2,
  capability: 2,
  system: 3,
  service: 3,
  library: 3,
  component: 3,
  external_dependency: 4,
};
const mapTierOf = (n) => MAP_TIER[n.type] ?? 3;

/**
 * Lay the grounds out in tiers (columns) and order each column by where the
 * grounds it is linked to sit in the columns before it (barycentre), so contains
 * lines cross as little as they can.
 */
function mapLayout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map();
  for (const e of edges) {
    if (e.relation !== "contains") continue;
    if (byId.has(e.from_node_id) && byId.has(e.to_node_id))
      parents.set(e.to_node_id, e.from_node_id);
  }
  const tiers = [...new Set(nodes.map(mapTierOf))].sort((x, y) => x - y);
  const cols = tiers.map((tier) => nodes.filter((n) => mapTierOf(n) === tier));
  const colOf = new Map();
  cols.forEach((list, ci) => list.forEach((n) => colOf.set(n.id, ci)));
  const rowOf = new Map();
  const typeRank = (n) => (n.type === "factory" ? 0 : n.type === "epic" ? 2 : 1);
  cols.forEach((list, ci) => {
    const key = (n) => {
      const ups = edges
        .map((e) =>
          e.to_node_id === n.id ? e.from_node_id : e.from_node_id === n.id ? e.to_node_id : null,
        )
        .filter((id) => id && rowOf.has(id) && colOf.get(id) < ci)
        .map((id) => rowOf.get(id));
      return ups.length
        ? ups.reduce((x, y) => x + y, 0) / ups.length
        : ci === 0
          ? typeRank(n) * 100
          : 999;
    };
    const keys = new Map(list.map((n) => [n.id, key(n)]));
    list.sort((x, y) => keys.get(x.id) - keys.get(y.id) || x.name.localeCompare(y.name));
    list.forEach((n, ri) => rowOf.set(n.id, ri));
  });
  const word = (t) => MAP_COL_WORD[t] || typeLabel(t);
  const colName = (list) => {
    const types = [...new Set(list.map((n) => n.type))];
    if (types.length === 1) return word(types[0]);
    if (types.includes("factory")) return "The club and its campaigns";
    const ws = types.map(word);
    return ws.length === 2
      ? `${ws[0]} and ${ws[1].toLowerCase()}`
      : `${ws.slice(0, -1).join(", ")} and ${ws[ws.length - 1].toLowerCase()}`;
  };
  return { byId, parents, cols, colOf, rowOf, colName };
}

/** "Part of Checkout · depends on Stripe": a ground's lines, read as words (the phone list). */
function mapRelLine(n, edges, byId) {
  const parts = [];
  for (const e of edges) {
    if (e.to_node_id === n.id && e.relation === "contains" && byId.has(e.from_node_id))
      parts.push(`part of ${byId.get(e.from_node_id).name}`);
    if (e.from_node_id === n.id && e.relation !== "contains" && byId.has(e.to_node_id))
      parts.push(
        `${e.relation === "depends_on" ? "depends on" : typeLabel(e.relation)} ${byId.get(e.to_node_id).name}`,
      );
  }
  if (!parts.length) return null;
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderScopeGraph(nodes, edges, ov, readAt = Date.now()) {
  const live = ov ? ov.cards.length : 0;
  const card = el("section", { class: "card panel scope-graph", "aria-label": "The grounds" }, [
    panelHead(
      "The grounds",
      [
        plural(nodes.length, "ground"),
        ov && ov.board ? `${live} live` : null,
        `as of ${clockTime(readAt)}`,
      ]
        .filter(Boolean)
        .join(" · "),
      null,
      { kit: "ink" },
    ),
  ]);
  const search = el("input", {
    type: "search",
    placeholder: "A ground, a repo, an owner…",
    value: factoryState.query,
    "aria-label": "Search the Map",
    oninput: (e) => {
      factoryState.query = e.target.value;
      const root = e.target.closest(".view") || card;
      applyFactoryFilter(root, e.target.value.trim().toLowerCase());
    },
  });
  card.appendChild(
    el("div", { class: "map-tools" }, [
      el("label", { class: "map-find" }, [el("span", { class: "map-find-l" }, "Find"), search]),
      nodes.length ? mapKey() : null,
    ]),
  );
  card.appendChild(el("p", { class: "map-found", role: "status", "aria-live": "polite" }));
  if (nodes.length === 0) {
    card.appendChild(
      el("p", { class: "map-none" }, [
        "No grounds on the map yet, so every repo plays as a free agent. ",
        el("a", { href: "#/node" }, "Mark out the club's first ground"),
        ": the club itself, then its products and the services they run on.",
      ]),
    );
    return card;
  }
  const { byId, cols, colOf, rowOf, colName } = mapLayout(nodes, edges);
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  // The drawing is a CSS grid: a label row, then one row per rank, so a card is as
  // tall as what it says (a long name or a second row of counters never clips) and
  // the gaps between rows run clear across every column. The chalk lines are drawn
  // once the cards are placed, through those gaps (see drawMapEdges).
  const cells = [];
  cols.forEach((list, ci) => {
    cells.push(
      el("div", {
        class: `graph-lane${ci % 2 ? " is-alt" : ""}`,
        style: `grid-column:${ci + 1};grid-row:1 / ${maxRows + 2}`,
        "aria-hidden": "true",
      }),
      el(
        "h3",
        { class: "graph-collabel", style: `grid-column:${ci + 1};grid-row:1` },
        colName(list),
      ),
    );
    for (const n of list) {
      const g = mapGround(n, ov, null);
      g.style.gridColumn = String(ci + 1);
      g.style.gridRow = String(rowOf.get(n.id) + 2);
      cells.push(g);
    }
  });
  const svgHost = el("div", { class: "graph-edges", "aria-hidden": "true" });
  const graph = el(
    "div",
    {
      class: "graph",
      dataset: { cols: String(cols.length) },
      style: `grid-template-columns:repeat(${cols.length}, minmax(0, 1fr));grid-template-rows:auto repeat(${maxRows}, auto)`,
    },
    [svgHost, ...cells],
  );
  const scroller = el(
    "div",
    {
      class: "graph-scroll",
      role: "region",
      "aria-label": "The scope graph: grounds in columns, lines for contains and depends on",
    },
    [graph],
  );
  card.appendChild(scroller);
  // The same grounds as a list, tier by tier, the lines as words: the phone reads
  // this, and so does a desktop too narrow for every column at a readable width.
  card.appendChild(
    el(
      "div",
      { class: "map-list" },
      cols.map((list) =>
        el("section", { class: "ml-col", "aria-label": colName(list) }, [
          el("h3", { class: "ml-head" }, colName(list)),
          el(
            "div",
            { class: "ml-cards" },
            list.map((n) => mapGround(n, ov, mapRelLine(n, edges, byId))),
          ),
        ]),
      ),
    ),
  );
  // The narrowest a column may get before the map reads as the list instead.
  const COL_MIN = 176,
    COL_GAP = 36,
    PAD = 18;
  const need = cols.length * COL_MIN + (cols.length - 1) * COL_GAP + PAD * 2;
  let ro = null;
  let lastW = -1;
  const fit = () => {
    const w = card.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    // The card's padding is inside clientWidth; the scroller sits in its content box.
    const cs = window.getComputedStyle(card);
    const inner = w - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const asList = inner < need;
    card.classList.toggle("is-list", asList);
    card.classList.toggle("is-graph", !asList);
    if (!asList) drawMapEdges(graph, svgHost, edges, colOf);
  };
  card._fit = () => {
    fit();
    if (!ro && typeof window.ResizeObserver === "function") {
      ro = new window.ResizeObserver(() => {
        lastW = -1;
        fit();
      });
      ro.observe(card);
    }
  };
  card._dispose = () => ro && ro.disconnect();
  return card;
}

/**
 * Draw the chalk lines between placed cards. Neighbouring columns join with a
 * curve through the gap between them. A line that skips a column never runs
 * under a card: it drops down its own gap to the nearest clear gap between rows,
 * runs along it, and climbs the gap before its target. Same-column links bow out
 * into the gap beside them.
 */
function drawMapEdges(graph, host, edges, colOf) {
  const W = graph.offsetWidth,
    H = graph.offsetHeight;
  if (!W || !H) return;
  const box = new Map();
  for (const g of graph.querySelectorAll(".scope-gnode")) {
    box.set(g.dataset.node, {
      x: g.offsetLeft,
      y: g.offsetTop,
      w: g.offsetWidth,
      h: g.offsetHeight,
    });
  }
  // Column edges, and the clear channels between rows (and above the first, below the last).
  const colL = [],
    colR = [];
  const rowTop = [],
    rowBot = [];
  for (const g of graph.querySelectorAll(".scope-gnode")) {
    const b = box.get(g.dataset.node);
    const ci = colOf.get(g.dataset.node);
    const ri = Number(g.style.gridRow) - 2;
    colL[ci] = Math.min(colL[ci] ?? Infinity, b.x);
    colR[ci] = Math.max(colR[ci] ?? -Infinity, b.x + b.w);
    rowTop[ri] = Math.min(rowTop[ri] ?? Infinity, b.y);
    rowBot[ri] = Math.max(rowBot[ri] ?? -Infinity, b.y + b.h);
  }
  const rows = rowTop.length;
  const channels = [];
  for (let r = 0; r <= rows; r++) {
    const above = r === 0 ? null : rowBot[r - 1];
    const below = r === rows ? null : rowTop[r];
    if (above == null && below != null) channels.push(below - 12);
    else if (below == null && above != null) channels.push(Math.min(H - 8, above + 12));
    else if (above != null) channels.push((above + below) / 2);
  }
  const gapAfter = (ci) =>
    colL[ci + 1] != null ? (colR[ci] + colL[ci + 1]) / 2 : Math.min(W - 6, colR[ci] + 14);
  const gapBefore = (ci) => (ci > 0 ? (colR[ci - 1] + colL[ci]) / 2 : Math.max(6, colL[ci] - 14));
  const used = new Map();
  const lane = (key) => {
    const k = used.get(key) || 0;
    used.set(key, k + 1);
    return (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 5;
  };
  // A polyline with rounded corners.
  const round = (pts, r = 10) => {
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1],
        [x1, y1] = pts[i],
        [x2, y2] = pts[i + 1];
      const l1 = Math.hypot(x1 - x0, y1 - y0),
        l2 = Math.hypot(x2 - x1, y2 - y1);
      const k = Math.min(r, l1 / 2, l2 / 2);
      if (!k) {
        d += ` L${x1} ${y1}`;
        continue;
      }
      const ax = x1 - ((x1 - x0) / l1) * k,
        ay = y1 - ((y1 - y0) / l1) * k;
      const bx = x1 + ((x2 - x1) / l2) * k,
        by = y1 + ((y2 - y1) / l2) * k;
      d += ` L${ax.toFixed(1)} ${ay.toFixed(1)} Q${x1} ${y1} ${bx.toFixed(1)} ${by.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L${last[0]} ${last[1]}`;
  };
  let paths = "";
  for (const e of edges) {
    const a = box.get(e.from_node_id),
      b = box.get(e.to_node_id);
    if (!a || !b) continue;
    const ca = colOf.get(e.from_node_id),
      cb = colOf.get(e.to_node_id);
    const cls = e.relation === "contains" ? "contains" : "dep";
    const ya = a.y + a.h / 2,
      yb = b.y + b.h / 2;
    let d;
    if (ca === cb) {
      // Bow into the gap beside the column (the left one at the far touchline).
      const right = colL[ca + 1] != null || ca === 0;
      const x = right ? a.x + a.w : a.x;
      const bow = right ? gapAfter(ca) + 8 : gapBefore(ca) - 8;
      const xb = right ? b.x + b.w : b.x;
      d = `M${x} ${ya} C ${bow} ${ya}, ${bow} ${yb}, ${xb} ${yb}`;
    } else {
      const fwd = cb > ca;
      const x1 = fwd ? a.x + a.w : a.x,
        x2 = fwd ? b.x : b.x + b.w;
      if (Math.abs(cb - ca) === 1) {
        const mx = (x1 + x2) / 2;
        d = `M${x1} ${ya} C ${mx} ${ya}, ${mx} ${yb}, ${x2} ${yb}`;
      } else {
        const gx1 = (fwd ? gapAfter(ca) : gapBefore(ca)) + lane(`g${fwd ? ca : ca - 1}`);
        const gx2 = (fwd ? gapBefore(cb) : gapAfter(cb)) + lane(`g${fwd ? cb - 1 : cb}`);
        // The clear channel nearest the straight line between the two ends.
        const want = (ya + yb) / 2;
        const ch = channels.length
          ? channels.reduce((p, c) => (Math.abs(c - want) < Math.abs(p - want) ? c : p))
          : want;
        const cy = ch + lane(`c${ch}`);
        d = round([
          [x1, ya],
          [gx1, ya],
          [gx1, cy],
          [gx2, cy],
          [gx2, yb],
          [x2, yb],
        ]);
      }
    }
    paths += `<path class="gedge ${cls}" d="${d}"/>`;
  }
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" focusable="false">${paths}</svg>`;
}

/** A labelled cell: the label shows on a phone, where a row stacks. */
function regCell(label, body, cls = "") {
  return el("td", { class: cls }, [el("span", { class: "reg-l" }, label), body]);
}
/** A count with its mark: red square for blocked, yellow card for review. */
function regCount(n, tone) {
  return el("span", { class: `reg-n${n ? "" : " is-zero"}${n && tone ? ` is-${tone}` : ""}` }, [
    n && tone === "red" ? glyph("blocked", 14) : null,
    n && tone === "yellow" ? ycard(14) : null,
    n && tone === "paused" ? glyph("paused", 14) : null,
    el("span", { class: "tabnum" }, String(n)),
  ]);
}
/** The gates a repo's deliveries must pass, in words. */
function regGates(r) {
  const set = [
    r.test_command ? "tests" : null,
    r.lint_command ? "lint" : null,
    r.coverage_command ? "coverage" : null,
  ].filter(Boolean);
  return set.length
    ? el("span", { class: "reg-gates" }, set.join(" · "))
    : el("span", { class: "reg-gates is-none" }, [glyph("failed", 14), "No gates"]);
}

/** Who plays where: every mapped repo, its grounds and what is live in it. */
function renderRepoRegister(repos, unmapped, ov) {
  const free = new Set(unmapped.map((r) => r.id));
  const mapped = repos.filter((r) => !free.has(r.id));
  const head = panelHead("Who plays where", `${plural(mapped.length, "repo")} at a ground`, null, {
    kit: "claret",
  });
  if (!mapped.length)
    return el("section", { class: "card prog map-register", "aria-label": "Who plays where" }, [
      head,
      el(
        "p",
        { class: "quiet" },
        repos.length
          ? "No repo plays at a ground yet. Open a repo and give it one."
          : "No repos signed yet. Onboard a repo to bring it into the club.",
      ),
    ]);
  // A Paused column only when a mapped repo has a ticket in the dugout.
  const anyPaused = mapped.some((r) => mapTally(ov.liveOfRepo.get(r.id)).paused > 0);
  const rows = mapped.map((r) => {
    const t = mapTally(ov.liveOfRepo.get(r.id));
    const grounds = ov.groundsOf.get(r.id) || [];
    return el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("th", { scope: "row", class: "reg-repo" }, [
        el("a", { href: `#/repo/${r.id}` }, repoTag(r.name, 22)),
        el(
          "span",
          { class: "reg-sub" },
          [r.stack, r.default_branch].filter(Boolean).join(" · ") || null,
        ),
      ]),
      regCell(
        "Grounds",
        el(
          "span",
          { class: "reg-grounds" },
          grounds.map((g) =>
            el("span", { class: "reg-ground" }, [
              el("a", { href: `#/node/${g.node.id}` }, g.node.name),
              el("span", { class: "reg-acc" }, [g.relation, g.access].filter(Boolean).join(" · ")),
            ]),
          ),
        ),
      ),
      regCell("Blocked", regCount(t.red, "red"), "reg-num"),
      regCell("To review", regCount(t.yellow, "yellow"), "reg-num"),
      anyPaused ? regCell("Paused", regCount(t.paused, "paused"), "reg-num") : null,
      regCell("In play", regCount(t.play), "reg-num"),
      regCell("Gates", regGates(r), "reg-gc"),
    ]);
  });
  return el("section", { class: "card prog map-register", "aria-label": "Who plays where" }, [
    head,
    el("table", { class: "reg-table" }, [
      el(
        "thead",
        {},
        el("tr", {}, [
          el("th", { scope: "col" }, "Repo"),
          el("th", { scope: "col" }, "Plays at"),
          el("th", { scope: "col", class: "reg-num" }, "Blocked"),
          el("th", { scope: "col", class: "reg-num" }, "To review"),
          anyPaused ? el("th", { scope: "col", class: "reg-num" }, "Paused") : null,
          el("th", { scope: "col", class: "reg-num" }, "In play"),
          el("th", { scope: "col" }, "Gates"),
        ]),
      ),
      el("tbody", {}, rows),
    ]),
  ]);
}

/** Free agents: repos with no ground, each playing as its own single-repo scope. */
function renderUnmappedSection(unmapped, repos = [], hiddenN = 0, { ov = null, grounds = 0 } = {}) {
  const head = panelHead("Free agents", `${plural(unmapped.length, "repo")} with no ground`, null, {
    kit: "sky",
  });
  const card = el(
    "section",
    { class: "card prog map-free", dataset: { section: "unmapped" }, "aria-label": "Free agents" },
    [head],
  );
  if (unmapped.length === 0) {
    card.appendChild(
      el("div", { class: "quiet map-free-none" }, [
        el(
          "p",
          {},
          hiddenN
            ? [
                "Every repo in the squad has a ground. ",
                el("a", { href: "#/hidden" }, `${plural(hiddenN, "hidden repo")}`),
                ` ${hiddenN === 1 ? "is" : "are"} left out.`,
              ]
            : "Every repo in the squad has a ground.",
        ),
        onboardButton(repos, null),
      ]),
    );
    return card;
  }
  card.appendChild(
    el(
      "p",
      { class: "gr-note" },
      grounds
        ? "No ground yet, so each plays as its own single-repo scope and its tickets count only here. Give one a ground from its page."
        : "No ground on the map yet, so each plays as its own single-repo scope. Mark out a ground, or give one a ground from its page.",
    ),
  );
  const rows = unmapped.map((r) => {
    const live = (ov && ov.liveOfRepo.get(r.id)) || [];
    const t = mapTally(live);
    return el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("th", { scope: "row", class: "reg-repo" }, [
        el("a", { href: `#/repo/${r.id}` }, repoTag(r.name, 22)),
        live.length
          ? el("span", { class: "reg-live" }, [
              el("span", { class: "sg-mags" }, [
                ...live.slice(0, MAP_COUNTERS).map((c) => mapCounter(c)),
                live.length > MAP_COUNTERS
                  ? el(
                      "a",
                      {
                        class: "sg-more mag-more",
                        href: `#/repo/${r.id}`,
                        "aria-label": `${live.length - MAP_COUNTERS} more live in ${r.name}`,
                      },
                      `+${live.length - MAP_COUNTERS}`,
                    )
                  : null,
              ]),
              el("span", { class: "sg-words" }, tallyWords(t)),
            ])
          : ov && ov.board
            ? el("span", { class: "reg-sub" }, "Nothing in play")
            : null,
      ]),
      regCell(
        "Path",
        r.local_path
          ? el("code", { class: "mono reg-path" }, r.local_path)
          : el("span", { class: "dim" }, "—"),
      ),
      regCell("Stack", el("span", {}, r.stack || "—")),
      regCell("Branch", el("span", {}, r.default_branch || "—")),
      regCell("Gates", renderRepoCommands(r)),
      el("td", { class: "row-actions" }, hideRepoBtn(r)),
    ]);
  });
  card.appendChild(
    el("table", { class: "reg-table reg-free" }, [
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ["Repo", "Path", "Stack", "Branch", "Gate commands", ""].map((h) =>
            el("th", { scope: "col" }, h || el("span", { class: "sr-only" }, "Actions")),
          ),
        ),
      ),
      el("tbody", {}, rows),
    ]),
  );
  card.appendChild(el("div", { class: "map-free-act" }, onboardButton(repos, null)));
  return card;
}

function renderRepoCommands(repo) {
  const cmds = [
    repo.test_command ? ["test", repo.test_command] : null,
    repo.lint_command ? ["lint", repo.lint_command] : null,
    repo.coverage_command ? ["coverage", repo.coverage_command] : null,
  ].filter(Boolean);
  if (cmds.length === 0) return el("span", { class: "dim" }, "—");
  return el(
    "div",
    { class: "cmd-list" },
    cmds.map(([label, cmd]) =>
      el("div", { class: "cmd-row" }, [
        el("span", { class: "cmd-label" }, label),
        el("code", { class: "mono" }, cmd),
      ]),
    ),
  );
}

/**
 * Repo detail: the Definition-of-Done gate commands, EDITABLE. Onboarding
 * auto-detects them from the manifest; a wrong or missing command is the top
 * reason a delivery bounces (tests gate FAIL) or ships unverified (all gates
 * SKIP), so the operator can correct them here. Empty clears a gate (skipped).
 * The coverage command sits here too but is NOT a DoD gate: it feeds the idle
 * coverage scan (coverage-did-not-decrease is a deferred gate).
 */
function renderRepoCommandsEditor(repo) {
  // Named distinctly from the global `field()` labelled-control helper it calls.
  const commandField = (name, label, value, ph) => {
    const input = el("input", {
      type: "text",
      name,
      value: value || "",
      placeholder: ph,
      class: "mono",
    });
    return { input, row: field(label, input) };
  };
  const test = commandField("test_command", "Test command", repo.test_command, "e.g. npm test");
  const lint = commandField("lint_command", "Lint command", repo.lint_command, "e.g. npm run lint");
  const cov = commandField(
    "coverage_command",
    "Coverage command (idle scan, not a gate)",
    repo.coverage_command,
    "optional — e.g. npm run coverage",
  );
  const form = el(
    "form",
    {
      class: "cmd-editor",
      onsubmit: (e) => {
        e.preventDefault();
        guard(async () => {
          await api("POST", `/repos/${repo.id}/commands`, {
            test_command: test.input.value.trim(),
            lint_command: lint.input.value.trim(),
            coverage_command: cov.input.value.trim(),
          });
          toast("Gate commands saved", { ok: true });
          router();
        });
      },
    },
    [
      el("div", { class: "cmd-fields" }, [test.row, lint.row, cov.row]),
      el("div", { class: "cmd-save" }, el("button", { class: "btn", type: "submit" }, "Save")),
    ],
  );
  return el("div", { class: "cmd-block" }, [
    el(
      "p",
      { class: "gr-note" },
      "The runner runs these on every delivery, in its worktree. A failing check sends the delivery back; an empty one is skipped. The coverage command is not a gate: it feeds the idle coverage scan.",
    ),
    form,
  ]);
}

// A discreet "Hide" button for a repo row (WG-006). Stops the row's navigate
// click, asks in the shared sheet, then hides the repo and refreshes — it drops off the list and
// reappears on the "Hidden repos" page.
function hideRepoBtn(repo) {
  return roLock(hideRepoBtnControl(repo), "repo");
}
function hideRepoBtnControl(repo) {
  return el(
    "button",
    {
      class: "btn small repo-hide-btn",
      type: "button",
      "aria-label": `Hide ${repo.name} from the dashboard`,
      title: "Hide this repo from the dashboard (reversible)",
      onclick: (e) => {
        e.stopPropagation();
        hideRepoSheet(repo, () => router());
      },
    },
    "Hide",
  );
}

/**
 * The one way back from a detail page: a real link (it opens in a new tab like any
 * other), the back arrow, and "Back to <where>". Ticket, ground, repo and spec
 * pages all use it, so the way back reads and sits the same everywhere.
 */
function backLink(href, label) {
  return el("a", { class: "back-link", href }, [icon("backarrow", "", 16), el("span", {}, label)]);
}

/** The way back from a ground or repo page to the Map. */
function backToMap() {
  return backLink("#/factory", "Back to Map");
}

// View: Hidden repos (WG-006). A deliberately low-key surface — reached only via
// the small footer link on the Map — listing every hidden repo with an
// "Unhide" button that returns it to its normal place.
async function renderHidden() {
  const repos = (await api("GET", "/repositories?hidden=only")).repositories || [];
  learnKits(repos.map((r) => r.name));
  const wrap = el("div", { class: "view view-hidden" });
  wrap.appendChild(backToMap());
  wrap.appendChild(
    viewHead(
      "Hidden repos",
      repos.length ? `${plural(repos.length, "repo")} left out of the squad` : "None hidden",
    ),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "gr-note hidden-note" },
      "A hidden repo stays registered with its links and grounds, but is left out of the repo list, the Map's free agents and the repo pickers. Unhide one to bring it back.",
    ),
  );

  if (!repos.length) {
    wrap.appendChild(emptyState("Nothing is hidden. Every registered repo is in the squad."));
    return wrap;
  }

  const rows = repos.map((r) =>
    el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("th", { scope: "row", class: "reg-repo" }, repoTag(r.name, 22)),
      regCell(
        "Path",
        r.local_path
          ? el("code", { class: "mono reg-path" }, r.local_path)
          : el("span", { class: "dim" }, "—"),
      ),
      regCell("Stack", el("span", {}, r.stack || "—")),
      el(
        "td",
        { class: "row-actions" },
        roLock(
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              "aria-label": `Unhide ${r.name}`,
              onclick: () =>
                guard(async () => {
                  await api("POST", `/repos/${r.id}/hidden`, { hidden: false });
                  toast(`${r.name} un-hidden`, { ok: true });
                  router();
                }),
            },
            "Unhide",
          ),
        ),
      ),
    ]),
  );
  wrap.appendChild(
    progPage("map-free", "ink", "Left out of the squad", plural(repos.length, "repo"), [
      el("table", { class: "reg-table reg-free" }, [
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            ["Repo", "Path", "Stack", ""].map((h) =>
              el("th", { scope: "col" }, h || el("span", { class: "sr-only" }, "Actions")),
            ),
          ),
        ),
        el("tbody", {}, rows),
      ]),
    ]),
  );
  return wrap;
}

function applyFactoryFilter(wrap, q) {
  // Dim the grounds that don't match (the layout stays where it is); hide repo rows.
  const hits = new Set();
  wrap.querySelectorAll(".scope-gnode").forEach((node) => {
    const text = (node.dataset.search || node.dataset.name || node.textContent || "").toLowerCase();
    const miss = !!q && !text.includes(q);
    node.classList.toggle("is-dim", miss);
    if (!miss) hits.add(node.dataset.name);
  });
  let rows = 0;
  wrap.querySelectorAll(".repo-row").forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.hidden = !!q && !text.includes(q);
    if (!row.hidden) rows += 1;
  });
  // Say what the filter found, for everyone (a live region, not just dimming).
  const out = wrap.querySelector(".map-found");
  if (out) {
    const grounds = hits.size;
    out.textContent = !q
      ? ""
      : grounds || rows
        ? `${plural(grounds, "ground")} and ${plural(rows, "repo")} match “${q}”.`
        : `Nothing on the map matches “${q}”. Try a ground, a repo or an owner.`;
    out.classList.toggle("is-none", !!q && !grounds && !rows);
  }
}

export {
  SCOPE_NODE_TYPES,
  SCOPE_EDGE_RELATIONS_V1,
  SCOPE_EDGE_RELATIONS_ADVANCED,
  SCOPE_REPO_RELATIONS,
  SCOPE_REPO_ACCESS,
  parseTags,
  typeLabel,
  mapTone,
  MAP_TONE_RANK,
  isImplicitScope,
  boardCards,
  mapOverlay,
  groundBook,
  mapTally,
  tallyWords,
  mapCounter,
  renderFactory,
  renderRepoCommandsEditor,
  backLink,
  backToMap,
  renderHidden,
};
