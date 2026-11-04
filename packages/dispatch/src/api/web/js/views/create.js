// View: Create ticket.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { readOnly, roLock, roLockAll } from "../access.js";
import { api } from "../api.js";
import { panelHead, viewHead } from "../components.js";
import { clear, el, field } from "../dom.js";
import { plural } from "../format.js";
import { badge } from "../icons.js";
import { jumpTo, navigate, routeSignal } from "../router.js";
import { appState } from "../state.js";
import { accessBadge } from "../status.js";
import { guard, toast } from "../toast.js";
import { TICKET_REPO_ACCESS } from "./repo-panel.js";
import { RISK_LEVELS } from "./work.js";
import { mountPlanBuildInline, typeLabel } from "../../app.js";

const POLICY_PACKS = ["solo_loose", "team_light", "factory_strict", "regulated"];

async function renderCreate(param) {
  const [nodesRes, reposRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal: routeSignal() }),
    api("GET", "/repositories", undefined, { signal: routeSignal() }),
  ]);
  const nodes = nodesRes.nodes || [];
  const allRepos = reposRes.repositories || [];

  const title = el("input", {
    type: "text",
    required: "",
    placeholder: "Short, action-oriented title",
  });
  const desc = el("textarea", { placeholder: "Context, user value, constraints…" });
  const policy = el(
    "select",
    {},
    POLICY_PACKS.map((p, i) => el("option", { value: p, selected: i === 0 }, p)),
  );
  const risk = el("select", {}, [
    el("option", { value: "" }, "default (low)"),
    ...RISK_LEVELS.map((r) => el("option", { value: r }, r)),
  ]);

  const validationMsg = el("p", { class: "form-error", role: "alert", hidden: "" });
  // Create waits for a write repo: aria-disabled (not disabled) keeps it focusable,
  // and the line under it says what is missing before anyone presses it.
  const createHintId = `create-hint-${++appState.fieldSeq}`;
  const createHint = el("p", { class: "act-hint create-hint", id: createHintId });
  const createBtn = el(
    "button",
    { class: "btn", type: "submit", "aria-describedby": createHintId },
    "Create ticket",
  );
  roLock(createBtn);
  const syncCreate = ({ hasWrite }) => {
    createBtn.setAttribute("aria-disabled", String(!hasWrite));
    createHint.hidden = hasWrite;
    createHint.textContent = hasWrite
      ? ""
      : "Attach a write repo first: Create needs somewhere to deliver.";
    if (hasWrite) validationMsg.hidden = true;
  };

  // Feature A: the shared repo + scope selector. Suggestions re-populate when the
  // title/description/scope change (debounced), so the picker reflects the draft.
  const selector = renderRepoScopeSelector({
    nodes,
    allRepos,
    getDraft: () => ({ title: title.value.trim(), description: desc.value.trim() }),
    onChange: (state) => syncCreate(state),
  });
  const debouncedSuggest = debounce(() => selector.refreshSuggestions(), 500);
  title.addEventListener("input", debouncedSuggest);
  desc.addEventListener("input", debouncedSuggest);

  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        const t = title.value.trim();
        if (!t) return;
        const sel = selector.getSelection();
        // Require at least one write repo — without it the ticket has nowhere to
        // deliver and is un-claimable. Surface the gate inline rather than letting
        // the create through.
        if (!selector.hasWriteRepo()) {
          validationMsg.textContent =
            "Attach at least one repo with write access — the factory needs somewhere to deliver.";
          validationMsg.hidden = false;
          selector.node.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        validationMsg.hidden = true;
        const body = { title: t, policy_pack: policy.value };
        if (desc.value.trim()) body.description = desc.value.trim();
        if (risk.value) body.risk_level = risk.value;
        if (sel.repoIds.length) body.repoIds = sel.repoIds;
        if (sel.scopeNodeIds.length) body.scopeNodeIds = sel.scopeNodeIds;
        guard(async () => {
          const created = await api("POST", "/tickets", body);
          const ticket = created.ticket;
          toast(`Created ticket #${ticket.number ?? ""}`, { ok: true });
          navigate(`#/ticket/${ticket.id}`);
        });
      },
    },
    [
      field("Title", title),
      field("Description", desc),
      el("div", { class: "form-grid cols-2" }, [
        field("Policy pack", policy),
        field("Risk level", risk),
      ]),
      selector.node,
      validationMsg,
      el("div", { class: "btn-row" }, [createBtn]),
      createHint,
    ],
  );

  // The page: Plan a build (the team talk, the same panel as the sheet) leads;
  // one ticket on its own (a friendly, outside any campaign) sits beside it.
  const epicsN = nodes.filter((n) => n.type === "epic").length;
  const wrap = el("div", { class: "view view-create" });
  wrap.appendChild(
    viewHead(
      "Plan a build",
      `${plural(allRepos.length, "repo")} to build on · ${plural(epicsN, "campaign")} this season`,
      el("a", { class: "btn", href: "#one-ticket" }, "Or add one ticket"),
    ),
  );
  const planHost = el("div", { class: "cr-plan" });
  const ticketPage = el(
    "section",
    { class: "card prog cr-ticket", id: "one-ticket", "aria-labelledby": "one-ticket-h" },
    [
      (() => {
        const h = panelHead("One ticket", "a friendly: outside any campaign", null, { kit: "sky" });
        h.querySelector(".panel-title").id = "one-ticket-h";
        return h;
      })(),
      el("div", { class: "cr-ticket-body" }, form),
    ],
  );
  wrap.appendChild(el("div", { class: "cr-grid" }, [planHost, ticketPage]));
  wrap._dispose = mountPlanBuildInline(planHost);
  // After the router's scroll-to-top, not before it.
  if (param === "ticket") wrap._mounted = () => setTimeout(() => jumpTo("one-ticket"), 0);
  // Initial suggestion pass once the form is in the DOM (empty draft → likely
  // empty, but a pre-selected scope or single repo can still surface a candidate).
  // A read token files no ticket, so it asks for no suggestions (a POST it may not send).
  roLockAll(form);
  if (!readOnly()) selector.refreshSuggestions();
  return wrap;
}

/**
 * Shared repo + scope selector (Features A & B). Lets the operator attach one or
 * more repos — each with a write/read/test access level — plus optional scope
 * node(s). Pre-populates from the FG-005 suggestion engine and lets the user
 * accept, edit or drop each suggestion.
 *
 * Returns:
 *   node                — the section element to mount
 *   getSelection()      — { repoIds: [{repo_id, access}], scopeNodeIds: [] }
 *   hasWriteRepo()      — true iff ≥1 attached repo has write access
 *   refreshSuggestions()— re-query suggestions from the current draft + scopes
 *
 * `onChange({ hasWrite })` runs after every change to the attached repos (and once
 * on the first render), so a form can hold its submit until there is a write repo.
 */
function renderRepoScopeSelector({ nodes, allRepos, getDraft, onChange }) {
  // repo id → access ("write"|"read"|"test"). Insertion order is render order.
  const attached = new Map();
  const scopeNodeIds = new Set();
  const repoById = new Map(allRepos.map((r) => [r.id, r]));
  const repoByName = new Map(allRepos.map((r) => [r.name, r]));

  const scopeList = el("div", { class: "selector-chips" });
  const repoList = el("div", { class: "selector-repos" });
  const suggestBox = el("div", { class: "selector-suggestions" });
  const writeHint = el("p", { class: "selector-hint dim" });

  // --- scope node picker ---------------------------------------------------
  const scopeSel = el("select", {}, [
    el("option", { value: "" }, nodes.length ? "Add a scope node…" : "No scope nodes yet"),
    ...nodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  scopeSel.addEventListener("change", () => {
    if (!scopeSel.value) return;
    scopeNodeIds.add(scopeSel.value);
    scopeSel.value = "";
    renderScopes();
    refreshSuggestions();
  });

  function renderScopes() {
    clear(scopeList);
    for (const id of scopeNodeIds) {
      const node = nodes.find((n) => n.id === id);
      const name = node ? node.name : id;
      scopeList.appendChild(
        el("span", { class: "chip" }, [
          el("span", {}, name),
          el(
            "button",
            {
              class: "chip-x",
              type: "button",
              "aria-label": `Remove ${name}`,
              onclick: () => {
                scopeNodeIds.delete(id);
                renderScopes();
                refreshSuggestions();
              },
            },
            "✕",
          ),
        ]),
      );
    }
    if (!scopeNodeIds.size)
      scopeList.appendChild(el("span", { class: "dim" }, "No scope linked (optional)."));
  }

  // --- manual repo picker --------------------------------------------------
  const repoSel = el("select", {}, [
    el("option", { value: "" }, "Add a repo…"),
    ...allRepos.map((r) => el("option", { value: r.id }, r.name)),
  ]);
  const accessSel = el(
    "select",
    {},
    TICKET_REPO_ACCESS.map((a, i) => el("option", { value: a, selected: i === 0 }, a)),
  );
  const addRepoBtn = el(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: () => {
        if (!repoSel.value) return;
        attached.set(repoSel.value, accessSel.value);
        repoSel.value = "";
        renderRepos();
      },
    },
    "Add",
  );

  function setAccess(repoId, access) {
    attached.set(repoId, access);
    renderRepos();
  }

  function renderRepos() {
    clear(repoList);
    for (const [repoId, access] of attached) {
      const repo = repoById.get(repoId) || repoByName.get(repoId);
      const name = repo ? repo.name : repoId;
      const accessControl = el(
        "div",
        { class: "segmented small" },
        TICKET_REPO_ACCESS.map((a) =>
          el(
            "button",
            {
              class: access === a ? "active" : "",
              type: "button",
              onclick: () => setAccess(repoId, a),
            },
            a,
          ),
        ),
      );
      repoList.appendChild(
        el("div", { class: "selector-repo-row" }, [
          el("span", { class: "assoc-name plain" }, name),
          el("div", { class: "selector-repo-controls" }, [
            accessControl,
            el(
              "button",
              {
                class: "chip-x",
                type: "button",
                "aria-label": `Remove ${name}`,
                onclick: () => {
                  attached.delete(repoId);
                  renderRepos();
                },
              },
              "✕",
            ),
          ]),
        ]),
      );
    }
    if (!attached.size) repoList.appendChild(el("p", { class: "dim" }, "No repos attached yet."));
    renderWriteHint();
  }

  function renderWriteHint() {
    const hasWrite = [...attached.values()].includes("write");
    writeHint.className = `selector-hint ${hasWrite ? "ok" : "warn"}`;
    writeHint.textContent = hasWrite
      ? "✓ This ticket has a write target — it can be delivered."
      : "Needs at least one write repo, so the factory has somewhere to deliver.";
    if (onChange) onChange({ hasWrite });
  }

  // --- suggestion population ------------------------------------------------
  async function refreshSuggestions() {
    if (readOnly()) return; // POST /scope/repo-suggestions is a write route to the server
    const draft = getDraft ? getDraft() : {};
    const reqBody = {
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(scopeNodeIds.size ? { scopeNodeIds: [...scopeNodeIds] } : {}),
      ...(attached.size ? { repoIds: [...attached.keys()] } : {}),
    };
    clear(suggestBox);
    try {
      const res = await api("POST", "/scope/repo-suggestions", reqBody);
      const suggestions = (res.suggestions || []).filter((s) => !attached.has(s.repoId));
      if (!suggestions.length) return;
      suggestBox.appendChild(
        el(
          "p",
          { class: "selector-sub dim" },
          "Suggested repos — accept to attach with the suggested access:",
        ),
      );
      for (const s of suggestions) {
        const acc = s.suggestedAccess || "read";
        suggestBox.appendChild(
          el("div", { class: "selector-suggestion" }, [
            el("div", { class: "suggestion-main" }, [
              el("span", { class: "assoc-name plain" }, s.repoName || s.repoId),
              accessBadge(acc),
              s.lowConfidence ? badge("low confidence", "no-dot") : null,
            ]),
            el(
              "button",
              {
                class: "btn small primary",
                type: "button",
                onclick: () => {
                  attached.set(s.repoId, acc);
                  renderRepos();
                  refreshSuggestions();
                },
              },
              "Accept",
            ),
          ]),
        );
      }
    } catch (e) {
      if (e.code === "UNAUTHORIZED") return;
      suggestBox.appendChild(
        el("p", { class: "dim" }, "Suggestions unavailable — attach repos manually."),
      );
    }
  }

  const section = el(
    "section",
    { class: "where-section selector-section", "aria-labelledby": "selector-heading" },
    [
      el("h2", { id: "selector-heading", class: "where-heading" }, "Repos & scope"),
      el(
        "p",
        { class: "where-intro dim" },
        "Attach the repos this ticket may write, read or test, and optionally the scope node it lives under.",
      ),
      field("Scope node", scopeSel),
      scopeList,
      el("div", { class: "selector-add-repo" }, [
        field("Repository", repoSel, { class: "grow" }),
        field("Access", accessSel),
        addRepoBtn,
      ]),
      repoList,
      writeHint,
      suggestBox,
    ],
  );

  renderScopes();
  renderRepos();

  return {
    node: section,
    getSelection: () => ({
      repoIds: [...attached.entries()].map(([repo_id, access]) => ({ repo_id, access })),
      scopeNodeIds: [...scopeNodeIds],
    }),
    hasWriteRepo: () => [...attached.values()].includes("write"),
    refreshSuggestions,
  };
}

/** Trailing-edge debounce — coalesces rapid input events into one call. */
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export { renderCreate };
