// View: Repo profile (UI-002 / UI-003 / UI-006).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock, roLockAll } from "../access.js";
import { api } from "../api.js";
import { emptyState, panelHead } from "../components.js";
import { el, field } from "../dom.js";
import { fmtTime, plural } from "../format.js";
import { badge, glyph, kitShirt, ycard } from "../icons.js";
import { boardAll } from "../matchday.js";
import { navigate, router, setDocTitle } from "../router.js";
import { confirmSheet, hideRepoSheet, valueSheet } from "../sheets.js";
import { riskBadge, statusBadge } from "../status.js";
import { guard, toast } from "../toast.js";
import {
  MAP_TONE_RANK,
  SCOPE_REPO_ACCESS,
  SCOPE_REPO_RELATIONS,
  backToMap,
  boardCards,
  mapTally,
  mapTone,
  renderFactory,
  renderRepoCommandsEditor,
  typeLabel,
} from "./map.js";
import { fixtureList, groundCountLine, groundStats } from "./scope-node.js";

// --- View: Repo profile (UI-002 / UI-003 / UI-006) --------------------------

async function renderRepo(id) {
  if (!id) return renderFactory();
  const [repos, scopesRes, nodesRes] = await Promise.all([
    // include hidden so a hidden repo's detail page still resolves (and can be un-hidden).
    api("GET", "/repositories?hidden=1"),
    api("GET", `/repos/${id}/scopes`),
    api("GET", "/scope/nodes"),
  ]);
  const repo = (repos.repositories || []).find((r) => r.id === id || r.name === id);
  const scopes = scopesRes.scopes || [];
  const allNodes = nodesRes.nodes || [];

  const wrap = el("div", { class: "view view-ground" });
  wrap.appendChild(backToMap());
  if (!repo) {
    wrap.appendChild(
      emptyState("Repository not found", "It may have been removed or renamed.", "map"),
    );
    return wrap;
  }
  // The repo's tickets: those that deliver to it (the board's write boundary), the
  // same source the Map's "Who plays where" counts from.
  let tickets = null;
  let ticketErr = null;
  try {
    const board = await boardAll();
    tickets = boardCards(board).filter(
      (c) =>
        c.status !== "cancelled" &&
        (c.repos || []).some((r) => r.id === repo.id || r.name === repo.name),
    );
  } catch (e) {
    if (e && e.code === "ABORTED") throw e;
    ticketErr = e;
  }

  setDocTitle("repo", repo.name, id);
  const isMapped = scopes.length > 0;
  const hasWrite = scopes.some((s) => s.default_access === "write");
  const t = tickets ? mapTally(tickets) : null;
  const sortedT = tickets
    ? [...tickets].sort(
        (a, b) =>
          (MAP_TONE_RANK[mapTone(a.status)] ?? 9) - (MAP_TONE_RANK[mapTone(b.status)] ?? 9) ||
          (b.priority || 0) - (a.priority || 0) ||
          (a.number || 0) - (b.number || 0),
      )
    : null;

  const hideBtn = repo.hidden
    ? el(
        "button",
        {
          class: "btn small",
          type: "button",
          "aria-label": `Unhide ${repo.name}`,
          onclick: () =>
            guard(async () => {
              await api("POST", `/repos/${repo.id}/hidden`, { hidden: false });
              toast(`${repo.name} un-hidden`, { ok: true });
              router();
            }),
        },
        "Unhide repo",
      )
    : el(
        "button",
        {
          class: "btn small",
          type: "button",
          "aria-label": `Hide ${repo.name} from the dashboard`,
          title: "Hide this repo from the dashboard (reversible)",
          onclick: () => hideRepoSheet(repo, () => navigate("#/factory")),
        },
        "Hide repo",
      );
  roLock(hideBtn, "repo");

  const lede = t ? groundCountLine(t, { where: "in this repo" }) : null;

  wrap.appendChild(
    el("header", { class: "gr-head" }, [
      el("div", { class: "gr-kit" }, kitShirt(repo.name, 96)),
      el("div", { class: "gr-head-main" }, [
        el("div", { class: "tk-meta" }, [
          el("span", { class: `gr-mapped${isMapped ? "" : " is-off"}` }, [
            glyph(isMapped ? "done" : "draft", 16),
            el(
              "span",
              {},
              isMapped
                ? `On the map · ${scopes.length} ground${scopes.length === 1 ? "" : "s"}`
                : "Not on the map",
            ),
          ]),
          riskBadge(repo.risk_level),
          repo.stack ? el("span", { class: "gr-owner" }, `Stack: ${repo.stack}`) : null,
          repo.hidden ? badge("hidden") : null,
        ]),
        el("h1", { class: "detail-title" }, repo.name),
        lede,
        el("div", { class: "gr-actions" }, [hideBtn]),
      ]),
    ]),
  );
  if (tickets && tickets.length) wrap.appendChild(groundStats(t));

  const branchBtn = el(
    "button",
    {
      class: "btn small",
      type: "button",
      "aria-label": `Edit default branch for ${repo.name}`,
      title:
        "The base branch every delivery worktree branches off. A wrong value fails delivery at worktree setup.",
      onclick: () =>
        valueSheet({
          title: `Default branch for ${repo.name}`,
          intro:
            "The base every delivery worktree branches off. A branch that does not exist fails delivery at worktree setup.",
          label: "Default branch",
          value: repo.default_branch || "main",
          hint: "The branch name as git knows it, such as main or develop.",
          onSave: async (branch) => {
            await api("POST", `/repos/${repo.id}/default-branch`, { default_branch: branch });
            toast(`${repo.name} default branch → ${branch}`, { ok: true });
            router();
          },
        }),
    },
    "Edit",
  );
  roLock(branchBtn, "repo");
  const kvRow = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
  const groundCard = el("section", { class: "card gr-card", "aria-label": "The ground" }, [
    panelHead("The ground", "where the work is done", null, { kit: "claret" }),
    el("dl", { class: "kv gr-kv" }, [
      ...kvRow(
        "Path",
        repo.local_path
          ? el("code", { class: "mono" }, repo.local_path)
          : el("span", { class: "dim" }, "Not set"),
      ),
      ...kvRow(
        "Default branch",
        el("span", { class: "gr-kv-act" }, [
          el("code", { class: "mono" }, repo.default_branch || "main"),
          branchBtn,
        ]),
      ),
      ...kvRow(
        "Remote",
        repo.remote_url
          ? el("code", { class: "mono" }, repo.remote_url)
          : el("span", { class: "dim" }, "None: local only"),
      ),
    ]),
    !isMapped ? renderMapRepoBox(repo, allNodes) : null,
    !hasWrite
      ? el("div", { class: "warn-box gr-warn" }, [
          ycard(22),
          el("p", {}, [
            el("strong", {}, "No write access. "),
            isMapped
              ? "This repo is on the map, but no link grants write access, so agents cannot deliver code to it."
              : "This repo plays on its own (single-repo mode). Put it on the map with write access to use it in factory mode.",
          ]),
        ])
      : null,
  ]);

  const checksCard = el("section", { class: "card gr-card", "aria-label": "Referee's checks" }, [
    panelHead("Referee's checks", "the Definition of Done", null, { kit: "sky" }),
    roLockAll(renderRepoCommandsEditor(repo), "repo"),
  ]);

  const scopeCard = el("section", { class: "card gr-card", "aria-label": "On the map" }, [
    panelHead("On the map", `${scopes.length} ground${scopes.length === 1 ? "" : "s"}`, null, {
      kit: "ink",
    }),
    el(
      "p",
      { class: "gr-note" },
      "Each ground on the Map this repo plays for, with its relation and the access agents inherit. Change access in place; change the relation by re-linking.",
    ),
    scopes.length
      ? el(
          "ul",
          { class: "clean gr-rows" },
          scopes.map((s) => renderRepoScopeRow(repo, s)),
        )
      : el("p", { class: "quiet" }, "Not on the map: this repo is its own single-repo scope."),
    el("h3", { class: "gr-sub" }, "Link to a ground"),
    renderAddAssociationForm(repo, allNodes, scopes),
  ]);

  const ticketCard = el(
    "section",
    { class: "card gr-card", "aria-label": "Results and fixtures" },
    [
      panelHead(
        "Results & fixtures",
        tickets && tickets.length
          ? `${tickets.length > 8 ? `8 of ${tickets.length}` : plural(tickets.length, "ticket")} delivering here, live first`
          : "",
        null,
        { kit: "ink" },
      ),
      tickets
        ? fixtureList(sortedT, { empty: "No ticket delivers to this repo yet." })
        : renderRepoTickets(repo, tickets, ticketErr),
    ],
  );

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", { class: "stack" }, [groundCard, checksCard, scopeCard]),
      el("div", { class: "stack" }, [ticketCard]),
    ]),
  );
  return wrap;
}

function renderRepoScopeRow(repo, s) {
  const accessSel = el(
    "select",
    { class: "access-select", "aria-label": `Default access for ${s.name}` },
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: s.default_access === a }, a)),
  );
  accessSel.addEventListener("change", () =>
    guard(async () => {
      await api("PATCH", `/scope/repos/${s.association_id}`, { default_access: accessSel.value });
      toast(`Access set to ${accessSel.value}`, { ok: true });
      router();
    }),
  );
  const relationSel = el(
    "select",
    { class: "access-select", "aria-label": `Relation to ${s.name}` },
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: s.relation === r }, r)),
  );
  relationSel.addEventListener("change", () =>
    guard(async () => {
      await api("DELETE", `/scope/repos/${s.association_id}`);
      await api("POST", "/scope/repos", {
        scope_node_id: s.id,
        repo_id: repo.id,
        relation: relationSel.value,
        default_access: s.default_access,
      });
      toast(`Relation set to ${relationSel.value}`, { ok: true });
      router();
    }),
  );
  // Relation, access and Unlink each change the mapping: a read token's are off.
  return roLockAll(
    el(
      "li",
      {},
      el("div", { class: "assoc-row assoc-row-edit" }, [
        el("div", { class: "assoc-edit-main" }, [
          el("a", { class: "assoc-name", href: `#/node/${s.id}` }, s.name),
          badge(typeLabel(s.type), `type-${s.type}`),
        ]),
        el("div", { class: "assoc-edit-controls" }, [
          el("label", { class: "assoc-edit-field" }, [
            el("span", { class: "assoc-edit-label" }, "relation"),
            relationSel,
          ]),
          el("label", { class: "assoc-edit-field" }, [
            el("span", { class: "assoc-edit-label" }, "access"),
            accessSel,
          ]),
          el(
            "button",
            {
              class: "btn danger small",
              type: "button",
              "aria-label": `Unlink from ${s.name}`,
              onclick: () =>
                confirmSheet({
                  title: `Unlink ${repo.name}`,
                  intro: `${repo.name} is no longer mapped into “${s.name}”. Existing tickets are unaffected.`,
                  confirm: "Unlink",
                  tone: "danger",
                  onConfirm: async () => {
                    await api("DELETE", `/scope/repos/${s.association_id}`);
                    toast("Association removed", { ok: true });
                    router();
                  },
                }),
            },
            "Unlink",
          ),
        ]),
      ]),
    ),
  );
}

function renderMapRepoBox(repo, allNodes) {
  if (!allNodes.length)
    return el("div", { class: "map-repo-box" }, [
      el("strong", {}, "Unmapped. "),
      "Create a scope node on the Map first, then map this repo into it.",
    ]);
  const nodeSel = el(
    "select",
    { "aria-label": "Scope node to map into" },
    allNodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  );
  const accessSel = el(
    "select",
    { "aria-label": "Default access" },
    SCOPE_REPO_ACCESS.filter((a) => a !== "none").map((a) =>
      el("option", { value: a, selected: a === "write" }, a),
    ),
  );
  const mapBtn = el(
    "button",
    {
      class: "btn primary small",
      type: "button",
      onclick: () =>
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeSel.value,
            repo_id: repo.id,
            relation: "owns",
            default_access: accessSel.value,
          });
          toast("Repo mapped into the Map", { ok: true });
          router();
        }),
    },
    "Map this repo",
  );
  return roLockAll(
    el("div", { class: "map-repo-box" }, [
      el("div", { class: "map-repo-lead" }, [
        el("strong", {}, "This repo is unmapped. "),
        "Map it into a scope node to coordinate it in factory mode. Existing tickets are not affected.",
      ]),
      el("div", { class: "map-repo-controls" }, [
        el("label", { class: "assoc-edit-field" }, [
          el("span", { class: "assoc-edit-label" }, "into node"),
          nodeSel,
        ]),
        el("label", { class: "assoc-edit-field" }, [
          el("span", { class: "assoc-edit-label" }, "access"),
          accessSel,
        ]),
        mapBtn,
      ]),
    ]),
  );
}

function renderRepoTickets(repo, tickets, err) {
  const box = el("div", { class: "repo-tickets" });
  if (!tickets) {
    box.appendChild(
      el(
        "p",
        { class: "quiet" },
        `Recent tickets unavailable${err && err.code ? ` (${err.code})` : ""}.`,
      ),
    );
    return box;
  }
  if (!tickets.length) {
    box.appendChild(el("p", { class: "quiet" }, "No tickets reference this repo yet."));
    return box;
  }
  const recent = [...tickets]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 8);
  box.appendChild(
    el(
      "ul",
      { class: "clean repo-ticket-list" },
      recent.map((t) =>
        el(
          "li",
          {},
          el("a", { class: "repo-ticket-row", href: `#/ticket/${t.id}` }, [
            el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
            el("span", { class: "repo-ticket-title" }, t.title),
            el("span", { class: "repo-ticket-side" }, [
              statusBadge(t.status, t.landing_state),
              el(
                "time",
                { class: "repo-ticket-time", datetime: t.updated_at },
                fmtTime(t.updated_at),
              ),
            ]),
          ]),
        ),
      ),
    ),
  );
  if (tickets.length > recent.length) {
    box.appendChild(
      el("p", { class: "repo-ticket-more" }, [
        `${tickets.length - recent.length} more on the `,
        el("a", { href: "#/work" }, "Work board"),
        ".",
      ]),
    );
  }
  return box;
}

function renderAddAssociationForm(repo, allNodes, existing) {
  const nodeSel = el("select", { required: "" }, [
    el("option", { value: "" }, allNodes.length ? "Select a scope node…" : "No scope nodes yet"),
    ...allNodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
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
        if (!nodeSel.value) {
          toast("Pick a scope node first");
          return;
        }
        const dup = existing.some((s) => s.id === nodeSel.value && s.relation === relation.value);
        if (dup) {
          toast(`Already linked to that node with relation “${relation.value}”.`);
          return;
        }
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeSel.value,
            repo_id: repo.id,
            relation: relation.value,
            default_access: access.value,
          });
          toast("Linked to scope node", { ok: true });
          router();
        });
      },
    },
    [
      field("Scope node", nodeSel),
      field("Relation", relation),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Add association"),
    ],
  );
  return roLockAll(form);
}

export { renderRepo };
