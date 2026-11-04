// UI-005: the ticket's repo suggestion and confirmation panel, and claimability.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { panelHead } from "../components.js";
import { clear, el, field } from "../dom.js";
import { badge, kitShirt } from "../icons.js";
import { closeSheet } from "../sheet.js";
import { actionSheet, reasonSheet } from "../sheets.js";
import { accessBadge, repoLink } from "../status.js";
import { guard, toast } from "../toast.js";

// --- UI-005: repo suggestion + confirmation panel ---------------------------

const TICKET_REPO_ACCESS = ["write", "read", "test"];
const REPO_GROUPS = [
  { key: "writeRepos", title: "Write", note: "agents may deliver code here", tone: "write" },
  { key: "readOnlyRepos", title: "Read-only", note: "context only — no writes", tone: "read" },
  { key: "testRepos", title: "Test", note: "test execution only", tone: "test" },
  {
    key: "suggestedRepos",
    title: "Suggested",
    note: "not a boundary until confirmed",
    tone: "suggested",
  },
  { key: "rejectedRepos", title: "Rejected", note: "retained for audit", tone: "rejected" },
];

/**
 * The boundary editor: the grounds this ticket may play on — which repos it may
 * write, read or test. Suggestions are not a boundary until confirmed. Once the
 * ticket is merged the boundary is its record and reads only (no controls).
 */
// The ticket each boundary editor belongs to, so its sheets can name it.
const boundaryTickets = new Map();
function boundaryRef(ticketId) {
  const t = boundaryTickets.get(ticketId);
  return t && t.number != null ? `#${t.number}` : "this ticket";
}
function renderRepoPanel(ticketId, claimBox, { readOnly = false, ticket = null } = {}) {
  if (ticket) boundaryTickets.set(ticketId, ticket);
  const body = el("div", { class: "repo-panel-body" }, el("p", { class: "dim" }, "Loading repos…"));
  // Read-only for two reasons: the ticket merged, or this token cannot change anything.
  const merged = !ticket || ticket.status === "done";
  const card = el(
    "section",
    {
      class: `card panel repo-panel${readOnly ? " is-readonly" : ""}`,
      "aria-label": "The boundary",
    },
    [
      panelHead(
        "The boundary",
        readOnly ? (merged ? "read-only: merged" : "read-only access") : "where agents may play",
      ),
      el(
        "p",
        { class: "section-note dim" },
        readOnly && merged
          ? "Merged. The boundary stays as the record of where this ticket played; it can no longer change."
          : readOnly
            ? "Where this ticket may write, read or test. This token can look, not change it."
            : "Confirm which repos this ticket may write, read or test before it can go ready. Suggestions are not a boundary until you confirm them.",
      ),
      body,
    ],
  );
  const reload = () =>
    guard(async () => {
      await refreshRepoPanel(ticketId, body, claimBox, reload, readOnly);
      if (claimBox) loadClaimability(ticketId, claimBox);
    });
  reload();
  return card;
}

async function refreshRepoPanel(ticketId, body, claimBox, reload, readOnly = false) {
  const work = (await api("GET", `/tickets/${ticketId}/work-repos`)).work_repos || {};
  let suggestions = null;
  let suggestionsError = false;
  try {
    const res = await api("GET", `/tickets/${ticketId}/repo-suggestions`);
    suggestions = res.suggestions || res.repos || [];
  } catch (e) {
    suggestionsError = true;
    if (e.code && !["404", "NOT_FOUND"].includes(String(e.code))) throw e;
  }
  const suggMeta = new Map();
  for (const s of suggestions || []) {
    const rid = s.repoId || s.repo_id || s.id;
    if (rid) suggMeta.set(rid, s);
  }

  clear(body);

  const write = work.writeRepos || [];
  const monoRepo = write.find(
    (r) => r.source === "mono_fallback" || r.relation === "implicit_single_repo",
  );
  if (monoRepo) {
    body.appendChild(
      el("div", { class: "mono-banner" }, [
        el("strong", {}, "Single-repo mode (mono-fallback). "),
        "This ticket targets one unmapped repo, ",
        el("code", { class: "mono" }, monoRepo.name || monoRepo.id),
        ", confirmed as the sole write target.",
      ]),
    );
  }

  let anyRepo = false;
  for (const group of REPO_GROUPS) {
    const links = work[group.key] || [];
    if (!links.length) continue;
    anyRepo = true;
    body.appendChild(
      renderRepoGroup(ticketId, group, links, suggMeta, reload, readOnly, write.length),
    );
  }
  const denied = work.deniedRepos || [];
  if (denied.length) {
    anyRepo = true;
    body.appendChild(
      renderRepoGroup(
        ticketId,
        { key: "deniedRepos", title: "Denied", note: "explicitly no access", tone: "rejected" },
        denied,
        suggMeta,
        reload,
        readOnly,
      ),
    );
  }

  const linkedIds = new Set();
  for (const group of [...REPO_GROUPS, { key: "deniedRepos" }]) {
    for (const r of work[group.key] || []) linkedIds.add(r.id);
  }
  const freshSuggestions = (suggestions || []).filter(
    (s) => !linkedIds.has(s.repoId || s.repo_id || s.id),
  );
  if (freshSuggestions.length && !readOnly) {
    anyRepo = true;
    body.appendChild(renderSuggestionGroup(ticketId, freshSuggestions, reload));
  }

  if (!anyRepo) {
    body.appendChild(
      el(
        "p",
        { class: "dim" },
        readOnly
          ? "No repos were recorded on this ticket."
          : "No repos on this ticket yet. Link a scope or repo on the create flow, or add one below.",
      ),
    );
  }
  if (suggestionsError && !readOnly) {
    body.appendChild(
      el(
        "p",
        { class: "dim suggestions-off" },
        "Repo suggestions unavailable — confirm the boundary manually.",
      ),
    );
  }
  if (!readOnly)
    body.appendChild(
      renderAddRepoForm(ticketId, reload, { linked: linkedIds, hasWrite: write.length > 0 }),
    );
}

function renderRepoGroup(
  ticketId,
  group,
  links,
  suggMeta,
  reload,
  readOnly = false,
  writeCount = 0,
) {
  const isRejected = group.tone === "rejected";
  const isSuggested = group.tone === "suggested";
  const rows = links.map((r) => {
    const meta = suggMeta.get(r.id);
    const reasons = parseReasons(r.reasons_json) ?? (meta ? meta.reasons : null);
    const confidence = r.confidence ?? (meta ? meta.confidence : null);
    const controls = [];
    if (readOnly) {
      controls.push(accessBadge(r.access || "none"));
    } else if (!isRejected) {
      controls.push(renderAccessControl(ticketId, r, reload, writeCount));
      controls.push(
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            onclick: () => rejectRepo(ticketId, r, reload),
          },
          "Reject",
        ),
      );
    } else {
      controls.push(
        el(
          "button",
          {
            class: "btn small",
            type: "button",
            onclick: () => setRepoAccess(ticketId, r.id, "write", "confirmed", reload, r.name),
          },
          "Restore → write",
        ),
      );
    }
    return el(
      "li",
      {},
      el("div", { class: "repo-row" }, [
        el("div", { class: "repo-row-main" }, [
          el("div", { class: "repo-row-head" }, [
            kitShirt(r.name || r.id, 22),
            repoLink(r, { className: "assoc-name" }),
            isSuggested
              ? badge("suggested", "relation-suggested")
              : badge("confirmed", "relation-confirmed"),
            confidence != null ? confidenceMeter(confidence) : null,
          ]),
          reasons && reasons.length
            ? el(
                "ul",
                { class: "reason-list" },
                reasons.map((why) => el("li", {}, why)),
              )
            : null,
        ]),
        el("div", { class: "repo-row-controls" }, controls),
      ]),
    );
  });
  return el("div", { class: `repo-group repo-group-${group.tone}` }, [
    el("div", { class: "repo-group-head" }, [
      el("span", { class: "repo-group-title" }, [
        group.title,
        el("span", { class: "repo-group-n" }, String(links.length)),
      ]),
      el("span", { class: "repo-group-note dim" }, group.note),
    ]),
    el("ul", { class: "clean" }, rows),
  ]);
}

function renderSuggestionGroup(ticketId, suggestions, reload) {
  const rows = suggestions.map((s) => {
    const rid = s.repoId || s.repo_id || s.id;
    const name = s.repoName || s.name || rid;
    const access = s.suggestedAccess || s.access || "read";
    const lowConfidence = s.lowConfidence === true;
    return el(
      "li",
      {},
      el("div", { class: "repo-row" }, [
        el("div", { class: "repo-row-main" }, [
          el("div", { class: "repo-row-head" }, [
            kitShirt(name, 22),
            el("span", { class: "assoc-name plain" }, name),
            badge("suggested", "relation-suggested"),
            accessBadge(access),
            s.monoFallback ? badge("mono-fallback", "multi-home") : null,
            s.confidence != null ? confidenceMeter(s.confidence) : null,
            lowConfidence ? badge("low confidence", "risk-medium") : null,
          ]),
          Array.isArray(s.reasons) && s.reasons.length
            ? el(
                "ul",
                { class: "reason-list" },
                s.reasons.map((why) => el("li", {}, why)),
              )
            : null,
        ]),
        el("div", { class: "repo-row-controls" }, [
          el(
            "button",
            {
              class: "btn ok small",
              type: "button",
              onclick: () =>
                setRepoAccess(
                  ticketId,
                  rid,
                  access === "none" ? "read" : access,
                  "confirmed",
                  reload,
                ),
            },
            "Confirm",
          ),
          el(
            "button",
            {
              class: "btn danger small",
              type: "button",
              onclick: () => rejectRepo(ticketId, { id: rid, name }, reload),
            },
            "Reject",
          ),
        ]),
      ]),
    );
  });
  return el("div", { class: "repo-group repo-group-suggested" }, [
    el("div", { class: "repo-group-head" }, [
      el("span", { class: "repo-group-title" }, [
        "Suggested",
        el("span", { class: "repo-group-n" }, String(suggestions.length)),
      ]),
      el("span", { class: "repo-group-note dim" }, "confirm to make a boundary"),
    ]),
    el("ul", { class: "clean" }, rows),
  ]);
}

function renderAccessControl(ticketId, repo, reload, writeCount = 0) {
  const name = repo.name || repo.id;
  const sel = el(
    "select",
    { class: "access-select", "aria-label": `Access for ${name}` },
    TICKET_REPO_ACCESS.map((a) => el("option", { value: a, selected: repo.access === a }, a)),
  );
  sel.addEventListener("change", () => {
    const to = sel.value;
    // Taking away the ticket's only write repo leaves nowhere to deliver code: ask first.
    if (repo.access === "write" && to !== "write" && writeCount <= 1) {
      sel.value = repo.access; // nothing changes unless the sheet confirms it
      const ref = boundaryRef(ticketId);
      const keep = el(
        "button",
        { class: "btn", type: "button", onclick: () => closeSheet() },
        "Keep write",
      );
      actionSheet(`Take ${name} off write?`, {
        focus: keep, // the safe choice has focus: Enter keeps the boundary as it is
        intro: `${name} is the only repo ${ref} may write. Set it to ${to} and no agent can deliver code for ${ref} until you give it a write repo again.`,
        actions: [
          keep,
          el(
            "button",
            {
              class: "btn danger",
              type: "button",
              onclick: () => {
                closeSheet();
                setRepoAccess(ticketId, repo.id, to, "confirmed", reload, name);
              },
            },
            `Set to ${to}`,
          ),
        ],
      });
      return;
    }
    setRepoAccess(ticketId, repo.id, to, "confirmed", reload, name);
  });
  return sel;
}

function confidenceMeter(value) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tone = pct >= 70 ? "high" : pct >= 40 ? "mid" : "low";
  return el("span", { class: `confidence conf-${tone}`, title: `Confidence ${pct}%` }, [
    el("span", { class: "conf-bar" }, el("span", { class: "conf-fill", style: `width:${pct}%` })),
    el("span", { class: "conf-pct tabnum" }, `${pct}%`),
  ]);
}

function setRepoAccess(ticketId, repoId, access, relation, reload, name) {
  guard(async () => {
    await api("PUT", `/tickets/${ticketId}/repo-access`, { repo_id: repoId, access, relation });
    toast(`${name || "Repo"}: ${access} on ${boundaryRef(ticketId)}.`, { ok: true });
    reload();
  });
}

function rejectRepo(ticketId, repo, reload) {
  const name = repo.name || repo.id;
  const ref = boundaryRef(ticketId);
  reasonSheet({
    title: `Reject ${name}`,
    ticket: boundaryTickets.get(ticketId) || null,
    intro: `${name} comes off the boundary of ${ref}: agents on this ticket may not write, read or test it. Restore it to write later if you change your mind.`,
    label: `Why is ${name} out of bounds?`,
    presets: [
      "This change does not touch it",
      "Wrong repo suggested",
      "Another ticket owns this work",
    ],
    hint: "Required. It is kept with the boundary.",
    confirm: "Reject repo",
    tone: "danger",
    onConfirm: async (reason) => {
      await api("PUT", `/tickets/${ticketId}/repo-access`, {
        repo_id: repo.id,
        access: "none",
        relation: "rejected",
        reasons: [reason],
      });
      toast(`${name} is off the boundary of ${ref}.`, { ok: true });
      reload();
    },
  });
}

/**
 * Add a repo to the boundary. It offers only repos NOT already on it (written, read,
 * tested or rejected): changing a listed repo's access is its own row's control, so
 * this form can never quietly turn a confirmed write into a read. With no write repo
 * yet, write is the default; otherwise read.
 */
function renderAddRepoForm(ticketId, reload, { linked = new Set(), hasWrite = false } = {}) {
  const repoSel = el("select", { required: "" }, [el("option", { value: "" }, "Loading repos…")]);
  const access = el(
    "select",
    {},
    TICKET_REPO_ACCESS.map((a) =>
      el("option", { value: a, selected: a === (hasWrite ? "read" : "write") }, a),
    ),
  );
  const submit = el("button", { class: "btn", type: "submit" }, "Add repo");
  const form = el(
    "form",
    {
      class: "inline-form add-repo-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!repoSel.value) {
          toast("Pick a repo first");
          return;
        }
        if (linked.has(repoSel.value)) return; // listed above: change it there
        const name = repoSel.selectedOptions?.[0]?.textContent || null;
        setRepoAccess(ticketId, repoSel.value, access.value, "confirmed", reload, name);
        repoSel.value = "";
      },
    },
    [field("Repo", repoSel), field("Access", access), submit],
  );
  guard(async () => {
    const repos = (await api("GET", "/repositories")).repositories || [];
    const free = repos.filter((r) => !linked.has(r.id));
    clear(repoSel);
    if (!free.length) {
      form.replaceChildren(
        el(
          "p",
          { class: "dim add-repo-none" },
          repos.length
            ? "Every repo the factory knows is already on this boundary. Change one above."
            : "The factory has no repos yet.",
        ),
      );
      return;
    }
    repoSel.appendChild(el("option", { value: "" }, "Add a repo…"));
    free.forEach((r) => repoSel.appendChild(el("option", { value: r.id }, r.name)));
  });
  return form;
}

/** Claimability blockers that hold a claim but not Mark ready (the ready gate passes them). */
const CLAIM_ONLY_BLOCKERS = new Set(["DEPENDENCY_BLOCKED", "DECISION_BLOCKED"]);
function loadClaimability(ticketId, box) {
  if (box.dataset.off) return; // only a ticket that can still be claimed asks
  clear(box);
  box.appendChild(el("span", { class: "dim" }, "Checking claimability…"));
  (async () => {
    let data;
    try {
      data = await api("GET", `/tickets/${ticketId}/claimability`);
    } catch (e) {
      clear(box);
      if (!e.code || ["404", "NOT_FOUND"].includes(String(e.code))) {
        box.appendChild(el("span", { class: "dim claim-off" }, "Claimability status unavailable."));
        return;
      }
      box.appendChild(
        el("span", { class: "dim claim-off" }, `Claimability check failed: ${e.message}`),
      );
      return;
    }
    clear(box);
    if (typeof box._onClaim === "function") box._onClaim(data);
    const ready = data.ready === true;
    const blockers = data.blockers || [];
    box.appendChild(
      el("div", { class: `claim-status ${ready ? "ready" : "blocked"}` }, [
        el("span", { class: "claim-dot" }),
        el("strong", {}, ready ? "Ready to claim" : "Not ready to claim"),
      ]),
    );
    if (!ready && blockers.length) {
      box.appendChild(
        el(
          "ul",
          { class: "claim-blockers" },
          blockers.map((b) => {
            // Unmet dependencies mean the ticket waits its turn, not that it is
            // blocked: say "waits on", without the red-card mark.
            if (b && b.code === "DEPENDENCY_BLOCKED") {
              const m = /^Blocked by (.+?) \(must be done first\)\.?$/.exec(b.message || "");
              return el(
                "li",
                { class: "is-wait" },
                m ? `Waits on ${m[1]}: they must be done first.` : b.message,
              );
            }
            return el(
              "li",
              {},
              typeof b === "string"
                ? b
                : b.message || b.reason || b.label || "Blocked by an unmet condition",
            );
          }),
        ),
      );
    } else if (!ready) {
      box.appendChild(el("p", { class: "dim" }, "Blocked, but no specific blockers reported."));
    }
  })();
}

function parseReasons(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : null;
  } catch {
    return null;
  }
}

export { TICKET_REPO_ACCESS, renderRepoPanel, CLAIM_ONLY_BLOCKERS, loadClaimability };
