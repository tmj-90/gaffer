// View: Scope node editor and detail (UI-001).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock, roLockAll } from "../access.js";
import { api } from "../api.js";
import { panelHead, statCell, viewHead } from "../components.js";
import { clear, el, field } from "../dom.js";
import { fmtTime, plural } from "../format.js";
import { kitShirt, learnKits } from "../icons.js";
import { navigate, routeSignal, router, setDocTitle } from "../router.js";
import { confirmSheet } from "../sheets.js";
import { accessBadge, riskBadge, statusBadge } from "../status.js";
import { guard, toast } from "../toast.js";
import {
  SCOPE_EDGE_RELATIONS_ADVANCED,
  SCOPE_EDGE_RELATIONS_V1,
  SCOPE_NODE_TYPES,
  SCOPE_REPO_ACCESS,
  SCOPE_REPO_RELATIONS,
  backToMap,
  groundBook,
  isImplicitScope,
  mapCounter,
  mapOverlay,
  mapTally,
  mapTone,
  parseTags,
  tallyWords,
  typeLabel,
} from "./map.js";
import { RISK_LEVELS } from "./work.js";

// --- View: Scope node editor + detail (UI-001) ------------------------------

/**
 * Fixtures or results: each ticket a row with its counter (carded when it needs
 * you), its title and its status. Links to the ticket.
 */
function fixtureList(list, { empty, limit = 8, byTime = false } = {}) {
  if (!list || !list.length) return el("p", { class: "quiet" }, empty);
  const rows = byTime
    ? [...list].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    : list;
  const shown = rows.slice(0, limit);
  return el("div", { class: "repo-tickets" }, [
    el(
      "ul",
      { class: "clean repo-ticket-list gr-fx-list" },
      shown.map((t) =>
        el(
          "li",
          {},
          el("a", { class: "repo-ticket-row gr-fx-row", href: `#/ticket/${t.id}` }, [
            mapTone(t.status)
              ? el("span", { class: "gr-fx-mag" }, [
                  el("span", { class: "sr-only" }, "#"),
                  mapCounter(t, { link: false }),
                ])
              : el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
            el("span", { class: "repo-ticket-title" }, t.title),
            el("span", { class: "repo-ticket-side" }, [
              statusBadge(t.status, t.landing_state),
              t.updated_at
                ? el(
                    "time",
                    { class: "repo-ticket-time", datetime: t.updated_at },
                    fmtTime(t.updated_at),
                  )
                : null,
            ]),
          ]),
        ),
      ),
    ),
    rows.length > shown.length
      ? el("p", { class: "repo-ticket-more" }, [
          `${rows.length - shown.length} more on the `,
          el("a", { href: "#/work" }, "Work board"),
          ".",
        ])
      : null,
  ]);
}

/** The stat strip a ground or repo page opens on: the Map's counts, nothing else. */
function groundStats(t) {
  return el("div", { class: `kpi-row gr-stats${t.paused ? " has-paused" : ""}` }, [
    statCell({
      label: "Live",
      value: String(t.live),
      sub: t.paused ? "the next four, added up" : "the next three, added up",
    }),
    statCell({ label: "Blocked", value: String(t.red), sub: "blocked or failed" }),
    statCell({
      label: "To review",
      value: String(t.yellow),
      sub: t.merge
        ? `${t.yellow - t.merge} to sign off, ${t.merge} approved to merge`
        : "waits on your sign-off",
      needs: t.yellow > 0,
    }),
    // Paused is rare: its cell shows only when something sits in the dugout.
    t.paused ? statCell({ label: "Paused", value: String(t.paused), sub: "in the dugout" }) : null,
    statCell({ label: "In play", value: String(t.play), sub: "the rest of the pitch" }),
    statCell({ label: "Done", value: String(t.done), sub: "shipped" }),
    statCell({ label: "Bench", value: String(t.bench), sub: "drafts and refining" }),
  ]);
}

/** One line from the same counts: "13 live here: 2 blocked · 3 to review · 8 in play. 6 done." */
function groundCountLine(t, { club = false, where = "here" } = {}) {
  if (!t.live && !t.done && !t.bench)
    return el(
      "p",
      { class: "gr-count is-quiet" },
      club ? "No ticket in the club yet." : `No ticket plays ${where} yet.`,
    );
  return el("p", { class: "gr-count" }, [
    el("b", { class: "tabnum" }, String(t.live)),
    club ? " live across the club" : ` live ${where}`,
    t.live ? [": ", ...tallyWords(t)] : null,
    ". ",
    `${t.done} done`,
    t.bench ? ` · ${t.bench} on the bench` : null,
    ".",
  ]);
}

async function renderNode(id) {
  const signal = routeSignal();
  const [nodesRes, edgesRes, reposRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    api("GET", "/scope/edges", undefined, { signal }),
    api("GET", "/repositories", undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return { repositories: [] };
    }),
  ]);
  const allNodes = nodesRes.nodes || [];
  const allEdges = edgesRes.edges || [];
  const allRepos = reposRes.repositories || [];
  learnKits(allRepos.map((r) => r.name));

  if (!id) return renderNewGround(allNodes);

  const view = await api("GET", `/scope/nodes/${id}`, undefined, { signal });
  const node = view.node;
  if (node?.name) setDocTitle("node", node.name, id);
  const repos = view.repos || [];

  // The ground's tickets, counted exactly as its card on the Map counts them.
  const ov = await mapOverlay(allNodes, allRepos, signal, { all: true }).catch((e) => {
    if (e && e.code === "ABORTED") throw e;
    return null;
  });
  const isClub = node.type === "factory";
  const book = ov && ov.board ? groundBook(node, ov, { live: false }) : null;
  const t = book ? mapTally(book) : null;
  const live = book ? book.filter((c) => mapTone(c.status)) : [];
  const results = book ? book.filter((c) => c.status === "done") : [];

  const wrap = el("div", { class: "view view-ground" });
  wrap.appendChild(backToMap());

  const tags = parseTags(node.tags_json);
  const loreTags = parseTags(node.lore_tags_json);
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const incoming = allEdges.filter((e) => e.to_node_id === node.id);
  const parent = incoming.find((e) => e.relation === "contains");
  const parentNode = parent ? byId.get(parent.from_node_id) : null;

  const editDetails = el("details", { class: "edit-panel gr-edit" }, [
    el("summary", { class: "btn small" }, "Edit ground"),
    el("div", { class: "card gr-edit-body" }, renderNodeForm(node, allNodes)),
  ]);
  const deleteBtn = roLock(
    el(
      "button",
      {
        class: "btn danger small",
        type: "button",
        onclick: () =>
          confirmSheet({
            title: `Delete ${node.name}`,
            intro: `The ground “${node.name}” is deleted from the Map. This cannot be undone.`,
            confirm: "Delete ground",
            tone: "danger",
            onConfirm: async () => {
              await api("DELETE", `/scope/nodes/${node.id}`);
              toast("Ground deleted", { ok: true });
              navigate("#/factory");
            },
          }),
      },
      "Delete ground",
    ),
  );

  wrap.appendChild(
    el("header", { class: `gr-head is-node type-${node.type}` }, [
      el("div", { class: "gr-head-main" }, [
        el("div", { class: "tk-meta" }, [
          el("span", { class: "gr-type" }, typeLabel(node.type)),
          riskBadge(node.risk_level),
          node.owner ? el("span", { class: "gr-owner" }, `Run by @${node.owner}`) : null,
          parentNode
            ? el("span", {}, [
                "Part of ",
                el(
                  "a",
                  { class: "tk-epic-link", href: `#/node/${parentNode.id}` },
                  parentNode.name,
                ),
              ])
            : null,
        ]),
        el("h1", { class: "detail-title" }, node.name),
        t ? groundCountLine(t, { club: isClub }) : null,
        node.description
          ? el("p", { class: "gr-lede desc" }, node.description)
          : el("p", { class: "gr-lede dim" }, "No description yet."),
        tags.length || loreTags.length
          ? el("div", { class: "tag-row" }, [
              ...tags.map((x) => el("span", { class: "tag-chip" }, x)),
              ...loreTags.map((x) => el("span", { class: "tag-chip lore" }, `lore:${x}`)),
            ])
          : null,
        el("div", { class: "gr-actions" }, [
          node.type === "epic"
            ? el("a", { class: "btn small", href: `#/epics/${node.id}` }, "Open the campaign")
            : null,
          editDetails,
          deleteBtn,
        ]),
      ]),
    ]),
  );
  if (isImplicitScope(node)) {
    const repoName = node.name.slice(5);
    const r = allRepos.find((x) => x.name === repoName);
    wrap.appendChild(
      el("p", { class: "gr-implicit" }, [
        el("b", {}, "Not a ground. "),
        "The factory records this scope when a ticket targets ",
        r ? el("a", { href: `#/repo/${r.id}` }, repoName) : repoName,
        ", a repo with no ground, so the ticket still has a scope. On the Map it plays as a free agent; give it a ground from its page.",
      ]),
    );
  }
  if (t) wrap.appendChild(groundStats(t));

  const fixtures = el("section", { class: "card gr-card", "aria-label": "Fixtures" }, [
    panelHead(
      "Fixtures",
      book ? (live.length ? `${live.length} live, worst first` : "nothing live") : "",
      null,
      { kit: "claret" },
    ),
    book
      ? fixtureList(live, {
          limit: 12,
          empty: isClub
            ? "Nothing in play anywhere in the club."
            : repos.length
              ? "Nothing in play here. The repos that play here have no live ticket."
              : "Nothing in play here. Link a repo, or put a ticket on this ground from its page.",
        })
      : el("p", { class: "quiet" }, "The board did not answer, so the fixtures are unknown."),
  ]);
  const resultsCard = book
    ? el("section", { class: "card gr-card", "aria-label": "Results" }, [
        panelHead(
          "Results",
          results.length ? `latest ${Math.min(8, results.length)} of ${results.length} done` : "",
          null,
          { kit: "ink" },
        ),
        fixtureList(results, { byTime: true, empty: "Nothing shipped from here yet." }),
      ])
    : null;

  const repoCard = el("section", { class: "card gr-card", "aria-label": "Who plays here" }, [
    panelHead("Who plays here", plural(repos.length, "repo"), null, { kit: "sky" }),
    isClub
      ? el(
          "p",
          { class: "gr-note" },
          "The club holds every ground, so its fixtures are every live ticket. Repos play at the grounds inside it.",
        )
      : null,
    repos.length
      ? el(
          "ul",
          { class: "clean gr-rows" },
          repos.map((r) =>
            el(
              "li",
              {},
              el("div", { class: "assoc-row" }, [
                el("a", { class: "assoc-name gr-repo", href: `#/repo/${r.id}` }, [
                  kitShirt(r.name || r.id, 22),
                  el("span", {}, r.name || r.id),
                ]),
                el("div", { class: "assoc-meta" }, [
                  el("span", { class: "gr-rel" }, r.relation),
                  accessBadge(r.default_access),
                ]),
              ]),
            ),
          ),
        )
      : el("p", { class: "quiet" }, "No repo plays here yet. Link one below."),
    el("h3", { class: "gr-sub" }, "Link a repo"),
    roLockAll(renderLinkRepoForm(node.id)),
  ]);

  const connCard = renderConnectionsCard(node, allNodes, allEdges);

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", { class: "stack" }, [fixtures, resultsCard]),
      el("div", { class: "stack" }, [repoCard, connCard]),
    ]),
  );
  return wrap;
}

/** A new ground: what it is, where it stands, then the form. */
function renderNewGround(allNodes) {
  const wrap = el("div", { class: "view view-ground view-new-ground" });
  wrap.appendChild(backToMap());
  const hasClub = allNodes.some((n) => n.type === "factory");
  wrap.appendChild(
    viewHead(
      "New ground",
      allNodes.length
        ? `${plural(allNodes.length, "ground")} on the map already`
        : "The first ground on the map",
    ),
  );
  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("section", { class: "card gr-card", "aria-label": "The ground" }, [
        panelHead("The ground", "name, type, owner, risk", null, { kit: "claret" }),
        renderNodeForm(null, allNodes),
      ]),
      el("section", { class: "card gr-card gr-types", "aria-label": "Which type" }, [
        panelHead("Which type", "where it stands on the map", null, { kit: "sky" }),
        el(
          "dl",
          { class: "kv gr-kv gr-typekey" },
          [
            ["Factory", hasClub ? "The club itself. You have one already." : "The club itself."],
            ["Product", "Something customers use: Checkout, Catalogue."],
            ["Service", "Something products lean on: Payments, Stock sync."],
            ["Domain or capability", "A wider area that holds products or services."],
            ["External dependency", "Outside the ground: Stripe, an ERP."],
          ].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]),
        ),
        el(
          "p",
          { class: "gr-note" },
          "After it is made, link the repos that play here and connect it to its neighbours from its page.",
        ),
      ]),
    ]),
  );
  return wrap;
}

function renderNodeForm(node, allNodes = []) {
  const isEdit = !!node;
  // An existing ground keeps its own type, even one this list does not offer (epic).
  const types =
    node && node.type && !SCOPE_NODE_TYPES.includes(node.type)
      ? [node.type, ...SCOPE_NODE_TYPES]
      : SCOPE_NODE_TYPES;
  const hasClub = allNodes.some((n) => n.type === "factory");
  const typeNow = node ? node.type : hasClub ? "product" : "factory";
  const name = el("input", {
    type: "text",
    required: "",
    value: node?.name || "",
    placeholder: "e.g. Trading Platform",
  });
  const type = el(
    "select",
    {},
    types.map((t) => el("option", { value: t, selected: typeNow === t }, typeLabel(t))),
  );
  const owner = el("input", {
    type: "text",
    value: node?.owner || "",
    placeholder: "team or person",
  });
  const risk = el(
    "select",
    {},
    RISK_LEVELS.map((r) =>
      el("option", { value: r, selected: (node?.risk_level || "low") === r }, r),
    ),
  );
  const desc = el("textarea", { placeholder: "What is this ground, and what does it own?" });
  desc.value = node?.description || "";
  const tags = el("input", {
    type: "text",
    value: parseTags(node?.tags_json).join(", "),
    placeholder: "comma,separated,tags",
  });
  const loreTags = el("input", {
    type: "text",
    value: parseTags(node?.lore_tags_json).join(", "),
    placeholder: "comma,separated,lore tags",
  });
  const splitTags = (v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { name: name.value.trim(), type: type.value, risk_level: risk.value };
        if (!body.name) return;
        if (owner.value.trim()) body.owner = owner.value.trim();
        if (desc.value.trim()) body.description = desc.value.trim();
        body.tags = splitTags(tags.value);
        body.lore_tags = splitTags(loreTags.value);
        guard(async () => {
          if (isEdit) {
            await api("PATCH", `/scope/nodes/${node.id}`, body);
            toast("Ground updated", { ok: true });
            router();
          } else {
            const r = await api("POST", "/scope/nodes", body);
            toast("Ground created", { ok: true });
            navigate(`#/node/${r.node.id}`);
          }
        });
      },
    },
    [
      el("div", { class: "form-grid cols-2" }, [
        field("Name", name),
        field("Type", type),
        field("Owner", owner),
        field("Risk level", risk),
      ]),
      field("Description", desc),
      el("div", { class: "form-grid cols-2" }, [field("Tags", tags), field("Lore tags", loreTags)]),
      el("div", { class: "btn-row" }, [
        el(
          "button",
          { class: "btn primary", type: "submit" },
          isEdit ? "Save changes" : "Create ground",
        ),
      ]),
    ],
  );
  return roLockAll(form);
}

function renderConnectionsCard(node, allNodes, allEdges) {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const outgoing = allEdges.filter((e) => e.from_node_id === node.id);
  const incoming = allEdges.filter((e) => e.to_node_id === node.id);
  const edgeRow = (e, dir) => {
    const otherId = dir === "out" ? e.to_node_id : e.from_node_id;
    const other = byId.get(otherId);
    return el(
      "li",
      {},
      el("div", { class: "assoc-row" }, [
        el("span", { class: "edge-text" }, [
          el("span", { class: "gr-rel" }, edgePhrase(e.relation, dir)),
          other
            ? el("a", { class: "assoc-name", href: `#/node/${otherId}` }, other.name)
            : el("span", { class: "dim" }, otherId.slice(0, 8)),
        ]),
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            "aria-label": `Remove ${e.relation} edge`,
            onclick: () =>
              guard(async () => {
                await api("DELETE", `/scope/edges/${e.id}`);
                toast("Edge removed", { ok: true });
                router();
              }),
          },
          "✕",
        ),
      ]),
    );
  };
  const list =
    outgoing.length || incoming.length
      ? el("ul", { class: "clean" }, [
          ...outgoing.map((e) => edgeRow(e, "out")),
          ...incoming.map((e) => edgeRow(e, "in")),
        ])
      : el("p", { class: "quiet" }, "No connections yet: this ground stands alone on the map.");
  return roLockAll(
    el("section", { class: "card gr-card", "aria-label": "Neighbours" }, [
      panelHead("Neighbours", `${outgoing.length + incoming.length} on the map`, null, {
        kit: "sky",
      }),
      list,
      el("h3", { class: "gr-sub" }, "Add a connection"),
      renderAddEdgeForm(node, allNodes),
    ]),
  );
}
/** An edge read from this node's side: "Contains", "Depends on", "Part of", "Needed by". */
function edgePhrase(relation, dir) {
  const words = String(relation || "").replace(/_/g, " ");
  if (dir === "out") return words.charAt(0).toUpperCase() + words.slice(1);
  if (relation === "contains") return "Part of";
  if (relation === "depends_on") return "Needed by";
  return `${words.charAt(0).toUpperCase() + words.slice(1)} (from)`;
}

function renderAddEdgeForm(node, allNodes) {
  const others = allNodes.filter((n) => n.id !== node.id);
  const target = el("select", {}, [
    el("option", { value: "" }, others.length ? "Select target node…" : "No other nodes"),
    ...others.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  const relation = el(
    "select",
    {},
    SCOPE_EDGE_RELATIONS_V1.map((r, i) => el("option", { value: r, selected: i === 0 }, r)),
  );
  const advancedToggle = el("input", { type: "checkbox" });
  const advancedWrap = el("label", { class: "checkbox-line" }, [
    advancedToggle,
    " Advanced relations",
  ]);
  advancedToggle.addEventListener("change", () => {
    clear(relation);
    const rels = advancedToggle.checked
      ? [...SCOPE_EDGE_RELATIONS_V1, ...SCOPE_EDGE_RELATIONS_ADVANCED]
      : SCOPE_EDGE_RELATIONS_V1;
    rels.forEach((r, i) => relation.appendChild(el("option", { value: r, selected: i === 0 }, r)));
  });
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!target.value) {
          toast("Pick a target node first");
          return;
        }
        const body = { from_node_id: node.id, to_node_id: target.value, relation: relation.value };
        if (advancedToggle.checked && !SCOPE_EDGE_RELATIONS_V1.includes(relation.value))
          body.advanced = true;
        guard(async () => {
          await api("POST", "/scope/edges", body);
          toast("Connection added", { ok: true });
          router();
        });
      },
    },
    [
      field("Connect to", target),
      field("Relation", relation),
      el("div", { class: "field", style: "flex:0 0 auto" }, [
        el("label", { html: "&nbsp;" }),
        advancedWrap,
      ]),
      el("button", { class: "btn", type: "submit" }, "Add connection"),
    ],
  );
  return form;
}

function renderLinkRepoForm(nodeId) {
  const repoSel = el("select", { required: "" }, [el("option", { value: "" }, "Loading repos…")]);
  guard(async () => {
    const repos = (await api("GET", "/repositories")).repositories || [];
    clear(repoSel);
    repoSel.appendChild(el("option", { value: "" }, "Select a repo…"));
    repos.forEach((r) => repoSel.appendChild(el("option", { value: r.id }, r.name)));
  });
  const relation = el(
    "select",
    {},
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: r === "owns" }, r)),
  );
  const access = el(
    "select",
    {},
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: a === "write" }, a)),
  );
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!repoSel.value) {
          toast("Pick a repo first");
          return;
        }
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeId,
            repo_id: repoSel.value,
            relation: relation.value,
            default_access: access.value,
          });
          toast("Repo linked", { ok: true });
          router();
        });
      },
    },
    [
      field("Repo", repoSel),
      field("Relation", relation),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Link repo"),
    ],
  );
  return form;
}

export { fixtureList, groundStats, groundCountLine, renderNode };
