// Settings: autonomy policies and recommendations, access (principals), idle loops.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { actorName } from "../club.js";
import { emptyState, panelHead } from "../components.js";
import { clear, el, field } from "../dom.js";
import { icon } from "../icons.js";
import { router } from "../router.js";
import { runAsyncAction, toast } from "../toast.js";
import { autonomyGateLabel, isPolicyActive, submitAutonomyPolicy } from "./formation.js";
import { resolveTargetRepos, targetPicker } from "../../app.js";

function autonomyRecommendationsPanel(recs, policies, { inert = false } = {}) {
  if (!Array.isArray(recs) || recs.length === 0) return null;
  return el("div", { class: "card panel autonomy-recs" }, [
    panelHead("Autonomy suggestions", "from your review track record", null, { kit: "sky" }),
    el(
      "p",
      { class: "section-note" },
      "Advisory only — nothing changes until you explicitly enable it.",
    ),
    el(
      "ul",
      { class: "ar-list" },
      recs.map((r) => autonomyRecItem(r, policies, { inert })),
    ),
  ]);
}

/** One recommendation row with its inline evidence + explicit enable/confirm flow. */
function autonomyRecItem(r, policies, { inert = false } = {}) {
  const confPct = Math.round((Number(r.confidence) || 0) * 100);
  const reasons = Array.isArray(r.reasons) ? r.reasons : [];
  const active = isPolicyActive(policies, r.repoId, r.riskLevel, r.gate);

  // The action zone toggles between [Enable] and an inline confirm panel so the
  // operator must take a deliberate second step, with the evidence still on screen.
  const action = el("div", { class: "ar-action" });
  const renderEnable = () => {
    action.textContent = "";
    const enableBtn = el("button", { class: "btn small", type: "button" }, [
      icon("check"),
      el("span", {}, `Enable ${autonomyGateLabel(r.gate).toLowerCase()}`),
    ]);
    enableBtn.addEventListener("click", renderConfirm);
    action.appendChild(enableBtn);
  };
  const renderConfirm = () => {
    action.textContent = "";
    const confirmBtn = el("button", { class: "btn small primary", type: "button" }, [
      icon("check"),
      el("span", {}, "Confirm — I've reviewed the evidence"),
    ]);
    const cancelBtn = el("button", { class: "btn small ghost", type: "button" }, "Cancel");
    cancelBtn.addEventListener("click", renderEnable);
    confirmBtn.addEventListener("click", () =>
      submitAutonomyPolicy(
        confirmBtn,
        "Enabling…",
        {
          repo_id: r.repoId,
          risk_level: r.riskLevel,
          gate: r.gate,
          mode: "auto",
          confirm: true,
        },
        `Enabled ${autonomyGateLabel(r.gate).toLowerCase()} for risk=${r.riskLevel} in ${r.repoName || "repo"}.`,
      ),
    );
    action.appendChild(
      el("div", { class: "ar-confirm" }, [
        el(
          "p",
          { class: "ar-confirm-note" },
          `This grants ${autonomyGateLabel(r.gate).toLowerCase()} for risk=${r.riskLevel} in ${r.repoName || "this repo"}. Reversible any time.`,
        ),
        el("div", { class: "btn-row" }, [confirmBtn, cancelBtn]),
      ]),
    );
  };
  if (active && inert) {
    action.appendChild(
      el(
        "span",
        {
          class: "ar-enabled-chip inert",
          title: "Review mode is human: no reviewer agent runs, so this grant never acts.",
        },
        [icon("alert"), "Enabled · inert"],
      ),
    );
  } else if (active) {
    action.appendChild(el("span", { class: "ar-enabled-chip" }, [icon("check"), "Enabled"]));
  } else {
    renderEnable();
  }

  return el("li", { class: "ar-item" }, [
    el("div", { class: "ar-item-head" }, [
      el("span", { class: `ar-gate ar-gate-${r.gate}` }, autonomyGateLabel(r.gate)),
      el("span", { class: "ar-risk" }, `risk=${r.riskLevel}`),
      el("span", { class: "ar-repo" }, r.repoName || ""),
      el("span", { class: "ar-conf dim tabnum", title: "confidence" }, `${confPct}%`),
    ]),
    el("p", { class: "ar-headline" }, r.headline || ""),
    reasons.length
      ? el(
          "ul",
          { class: "ar-reasons dim" },
          reasons.map((reason) => el("li", {}, reason)),
        )
      : null,
    action,
  ]);
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): the active-policies panel — every enabled
 * (mode=auto) autonomy policy with a one-click, reversible OFF. Returns null when
 * nothing is enabled, so the panel only appears once the operator has opted in.
 */
function autonomyPoliciesPanel(policies, { inert = false } = {}) {
  const active = (Array.isArray(policies) ? policies : []).filter((p) => p.mode === "auto");
  if (active.length === 0) return null;
  return el("div", { class: `card panel autonomy-policies${inert ? " is-inert" : ""}` }, [
    panelHead(inert ? "Active autonomy (inert)" : "Active autonomy", null, null, { kit: "sky" }),
    el(
      "p",
      { class: "section-note" },
      inert
        ? "These grants are never consulted while Review mode is human — no reviewer agent runs. Switch Review mode to agent or both for them to act, or turn them off."
        : "The factory acts without you at these chokepoints. Turn any off to re-gate it immediately.",
    ),
    el(
      "ul",
      { class: "ar-list" },
      active.map((p) => {
        const offBtn = el(
          "button",
          { class: "btn small ghost", type: "button" },
          el("span", {}, "Turn off"),
        );
        offBtn.addEventListener("click", () =>
          submitAutonomyPolicy(
            offBtn,
            "Turning off…",
            { repo_id: p.repo_id, risk_level: p.risk_level, gate: p.gate, mode: "off" },
            `Turned off ${autonomyGateLabel(p.gate).toLowerCase()} for risk=${p.risk_level} in ${p.repo_name || "repo"}.`,
          ),
        );
        return el("li", { class: "ar-item ap-item" }, [
          el("div", { class: "ar-item-head" }, [
            el("span", { class: `ar-gate ar-gate-${p.gate}` }, autonomyGateLabel(p.gate)),
            el("span", { class: "ar-risk" }, `risk=${p.risk_level}`),
            el("span", { class: "ar-repo" }, p.repo_name || ""),
            inert
              ? el(
                  "span",
                  {
                    class: "ap-mode inert",
                    title:
                      "Review mode is human: no reviewer agent runs, so this grant never acts.",
                  },
                  "auto · inert",
                )
              : el("span", { class: "ap-mode" }, "auto"),
          ]),
          p.enabled_by
            ? el(
                "p",
                { class: "ar-reasons dim" },
                `enabled by ${p.enabled_by}${p.enabled_at ? ` · ${p.enabled_at.slice(0, 10)}` : ""}`,
              )
            : null,
          el("div", { class: "ar-action" }, [offBtn]),
        ]);
      }),
    ),
  ]);
}

/**
 * Access panel (Settings): how this session authenticated, the named API
 * credentials (principals) and, for a full-capability session, the mint and
 * revoke actions. A minted token is shown ONCE in a read-only field; only its
 * hash exists server-side, so it cannot be shown again.
 */
/** A principal's scope in words ("" for an unscoped one). */
function principalScopeWords(scope) {
  if (!scope) return "";
  const parts = [];
  if (scope.repos) parts.push(`repos ${scope.repos.map((r) => r.name || r.id).join(", ")}`);
  if (scope.tickets)
    parts.push(`tickets ${scope.tickets.map((t) => "#" + (t.number ?? t.id)).join(", ")}`);
  return parts.join(" and ");
}

function accessPanel(whoami, principals) {
  const cap = whoami && whoami.capability ? whoami.capability : "full";
  // Principals are minted and revoked with the shared operator token only (the server
  // refuses a principal token), so a principal's session lists them and changes none.
  const canManage = cap === "full" && !(whoami && whoami.principal);
  const actorId = whoami && whoami.actor ? whoami.actor.id || whoami.actor.type : "—";
  const via =
    whoami && whoami.principal
      ? `principal “${whoami.principal.name}”`
      : whoami
        ? "the shared token"
        : "unknown";
  const card = el("div", { class: "card panel access-panel" }, [
    panelHead("Access", "the keys to the ground", null, { kit: "ink" }),
    el(
      "p",
      { class: "section-note" },
      "Named credentials for the API. Every write a principal makes is attributed to its actor in the event log.",
    ),
    el("p", { class: "access-whoami", "data-testid": "access-whoami" }, [
      "Signed in as ",
      el("strong", {}, actorId),
      ` (${cap}) via ${via}${whoami && whoami.scope ? `, scoped to ${principalScopeWords(whoami.scope)}` : ""}.`,
    ]),
  ]);

  const list = el("ul", { class: "ar-list access-list", "aria-label": "API principals" });
  if (principals.length === 0) {
    list.appendChild(
      el("li", { class: "ar-item dim" }, "No principals yet — every caller uses the shared token."),
    );
  }
  for (const p of principals) {
    const revoked = Boolean(p.revoked_at);
    const item = el("li", { class: `ar-item access-item${revoked ? " is-revoked" : ""}` }, [
      el("div", { class: "ar-item-head" }, [
        el("span", { class: "access-name" }, p.name),
        el("span", { class: "ap-mode" }, p.capability),
        el("span", { class: "ar-repo" }, actorName(p.actor_type, p.actor_id)),
        p.scope
          ? el("span", { class: "access-scope" }, `scoped: ${principalScopeWords(p.scope)}`)
          : null,
        revoked ? el("span", { class: "access-status" }, "revoked") : null,
      ]),
      el(
        "p",
        { class: "ar-reasons dim" },
        `created ${String(p.created_at || "").slice(0, 10)}${p.created_by ? ` by ${p.created_by}` : ""}` +
          (p.last_used_at
            ? ` · last used ${String(p.last_used_at).slice(0, 16).replace("T", " ")}`
            : " · never used") +
          (revoked ? ` · revoked ${String(p.revoked_at).slice(0, 10)}` : ""),
      ),
    ]);
    if (canManage && !revoked) {
      // Two-step revoke: the first click arms, the second confirms (no modal).
      const btn = el(
        "button",
        { class: "btn small ghost", type: "button" },
        el("span", {}, "Revoke"),
      );
      let armed = false;
      btn.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          clear(btn);
          btn.appendChild(el("span", {}, "Confirm revoke"));
          btn.classList.add("danger");
          setTimeout(() => {
            if (!armed) return;
            armed = false;
            clear(btn);
            btn.appendChild(el("span", {}, "Revoke"));
            btn.classList.remove("danger");
          }, 6000);
          return;
        }
        runAsyncAction(btn, "Revoking…", async () => {
          await api("DELETE", `/api/principals/${encodeURIComponent(p.id)}`);
          toast(`Revoked “${p.name}”.`, { ok: true });
          router();
        });
      });
      item.appendChild(el("div", { class: "ar-action" }, [btn]));
    }
    list.appendChild(item);
  }
  card.appendChild(list);

  if (canManage) {
    const nameInput = el("input", {
      type: "text",
      name: "principal-name",
      placeholder: "e.g. alice or ci-reviewer",
      required: "required",
      maxlength: "64",
      // The HTML pattern attribute compiles with the `v` flag: `-` in a class must be escaped.
      pattern: "[A-Za-z0-9][A-Za-z0-9._@\\-]{0,63}",
      autocomplete: "off",
    });
    const capSelect = el("select", { name: "principal-capability" }, [
      el("option", { value: "full" }, "full — read and write"),
      el("option", { value: "read" }, "read — GET routes only"),
    ]);
    const actorInput = el("input", {
      type: "text",
      name: "principal-actor-id",
      placeholder: "defaults to the name",
      maxlength: "200",
      autocomplete: "off",
    });
    const typeSelect = el("select", { name: "principal-actor-type" }, [
      el("option", { value: "human" }, "human"),
      el("option", { value: "admin" }, "admin — may change repositories and settings"),
    ]);
    // PRINCIPAL SCOPES: optional. A scoped credential reaches only tickets on these
    // repos (every write repo inside) and these tickets; everything else is refused.
    const reposInput = el("input", {
      type: "text",
      name: "principal-repos",
      placeholder: "every repo (or: app, svc)",
      maxlength: "2000",
      autocomplete: "off",
    });
    const ticketsInput = el("input", {
      type: "text",
      name: "principal-tickets",
      placeholder: "every ticket (or: 12, 14)",
      maxlength: "2000",
      autocomplete: "off",
    });
    const submit = el("button", { class: "btn small", type: "submit" }, [
      icon("plus"),
      el("span", {}, "Create credential"),
    ]);
    const tokenOut = el("div", { class: "access-token-out", hidden: true });
    const form = el("form", { class: "access-form" }, [
      el("h3", {}, "New credential"),
      el("div", { class: "access-form-row" }, [
        field("Name", nameInput),
        field("Capability", capSelect),
        field("Acts as", typeSelect),
        field("Actor id", actorInput),
      ]),
      el("div", { class: "access-form-row" }, [
        field("Repo scope", reposInput),
        field("Ticket scope", ticketsInput),
      ]),
      el(
        "p",
        { class: "section-note dim" },
        "Leave both scopes empty for a credential that reaches everything. With a scope it sees and changes only tickets whose write repos are all in its repo scope, and the tickets you name.",
      ),
      el("div", { class: "btn-row" }, [submit]),
      tokenOut,
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      runAsyncAction(submit, "Creating…", async () => {
        const body = { name, capability: capSelect.value };
        if (typeSelect.value === "admin") body.actor_type = "admin";
        if (actorInput.value.trim()) body.actor_id = actorInput.value.trim();
        const words = (v) =>
          v
            .split(/[\s,]+/)
            .map((x) => x.trim().replace(/^#/, ""))
            .filter(Boolean);
        const repos = words(reposInput.value);
        const tickets = words(ticketsInput.value).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
        if (repos.length) body.repos = repos;
        if (tickets.length) body.tickets = tickets;
        const res = await api("POST", "/api/principals", body);
        const tok = el("input", {
          type: "text",
          readonly: "readonly",
          class: "access-token",
          "data-testid": "access-token",
          value: res.token,
          "aria-label": "New token (shown once)",
        });
        tok.addEventListener("focus", () => tok.select());
        clear(tokenOut);
        tokenOut.hidden = false;
        tokenOut.append(
          el("p", { class: "access-token-note" }, [
            el("strong", {}, `Token for “${res.principal.name}” — shown once. `),
            "Copy it now; only its hash is stored.",
          ]),
          tok,
        );
        toast(`Created “${res.principal.name}”. The token is shown once below.`, { ok: true });
        nameInput.value = "";
        actorInput.value = "";
        reposInput.value = "";
        ticketsInput.value = "";
        // Refresh the list without dropping the one-time token from view.
        const fresh = await api("GET", "/api/principals").catch(() => null);
        if (fresh && Array.isArray(fresh.principals)) {
          const rebuilt = accessPanel(whoami, fresh.principals);
          const freshList = rebuilt.querySelector(".access-list");
          if (freshList) list.replaceWith(freshList);
        }
      });
    });
    card.appendChild(form);
  } else {
    card.appendChild(
      el(
        "p",
        { class: "section-note dim" },
        "This session is read-scoped: it can see principals but not mint or revoke them.",
      ),
    );
  }
  return card;
}

/** The known idle scan loops, in display order, with copy for the panel. */
const IDLE_LOOP_LABELS = {
  idle_security_hotspot: "Security hotspots",
  idle_coverage: "Coverage",
  idle_test_quality: "Test quality",
  idle_type_quality: "Type quality",
  idle_tech_debt: "Tech debt",
  idle_documentation: "Documentation",
  idle_dependencies: "Dependencies",
  idle_feature_backlog: "Feature backlog",
};

/**
 * Idle-loops control panel. For each scan loop: an enable toggle + a multi-select
 * target picker (repos + scopes). On save, node selections are resolved to repo
 * NAMES so the crew loop backend stays repo-name-based, and the whole set is PUT
 * to /api/idle-loops. An empty selection means "all repos" (schema semantics).
 */
/** The lanes "Use recommended set" turns on (mirrors the API's RECOMMENDED_LANE_KEYS). */
const IDLE_RECOMMENDED_LANES = [
  "idle_security_hotspot",
  "idle_coverage",
  "idle_tech_debt",
  "idle_documentation",
];

function renderIdleLoopsPanel(view, repos, nodes, envSettings = []) {
  const card = el("div", { class: "card settings-group idle-loops-group" });
  card.appendChild(el("h2", {}, "Scan lanes"));
  card.appendChild(
    el(
      "p",
      { class: "section-note dim" },
      "When the queue is empty the factory can spend the tick on maintenance: one scan lane per idle tick, " +
        "chosen by priority and rotation, drafting a ticket per finding with a behaviour-preserving acceptance " +
        "criterion the runner checks with the repo's own test command. Empty scope = all repos.",
    ),
  );
  card.appendChild(
    el("div", { class: "settings-note idle-loops-note" }, [
      icon("clock", "settings-note-ico"),
      el("span", {}, "Stored in crew.yaml; changes apply on the next tick — no live restart."),
    ]),
  );

  if (!view.configured) {
    card.appendChild(
      emptyState(
        "Crew config not found",
        "No crew.yaml is configured for this factory yet, so the scan loops can't be edited here.",
        "alert",
      ),
    );
    return card;
  }

  const makeSwitch = (label, checked, testid) => {
    const input = el("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": label,
      "data-testid": testid,
    });
    input.checked = checked === true;
    const wrap = el("label", { class: "switch" }, [
      input,
      el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
    ]);
    return { input, wrap };
  };

  // ── Maintenance lane master switch ────────────────────────────────────────
  const maint = makeSwitch(
    "Maintenance when idle",
    view.maintenance && view.maintenance.enabled,
    "maintenance-toggle",
  );
  const recommendBtn = el(
    "button",
    { class: "btn", type: "button", "data-testid": "idle-recommended" },
    [icon("spark"), el("span", {}, "Use recommended set")],
  );
  card.appendChild(
    el("div", { class: "idle-loop-row idle-lane-master" }, [
      el("div", { class: "idle-loop-head" }, [
        el("div", { class: "idle-loop-label" }, [
          el("span", {}, "Maintenance when idle"),
          el("code", { class: "mono setting-key" }, "loops.maintenance.enabled"),
        ]),
        maint.wrap,
      ]),
      el(
        "p",
        { class: "dim" },
        "The master switch. Off: an idle factory polls and stops. On: each idle tick runs the one enabled lane " +
          "below that is most due (security first, then tests, types, tech debt, docs, dependencies). " +
          "GAFFER_MAINTENANCE=0 in the runner's env is the emergency kill switch.",
      ),
      el("div", { class: "btn-row" }, [recommendBtn]),
    ]),
  );

  // ── Per-loop editors ──────────────────────────────────────────────────────
  const editors = new Map();
  const rows = el("div", { class: "idle-loops-rows" });

  for (const loop of view.loops || []) {
    const label = IDLE_LOOP_LABELS[loop.key] || loop.label || loop.key;
    const initial = (loop.repos || []).map((name) => ({ kind: "repo", id: name, name }));
    const picker = targetPicker({
      repos,
      nodes,
      value: initial,
      multiple: true,
      onChange: () => {},
    });
    const sw = makeSwitch(`Enable ${label}`, loop.enabled === true, `idle-loop-${loop.key}`);
    sw.input.addEventListener("change", () => refreshStatus());

    // The dependency lane's read-only audit command (crew.yaml
    // loops.idle_dependencies.audit_command): without one the lane only flags
    // floating ranges, so "dependency upgrades" never happen.
    let auditInput = null;
    if (loop.key === "idle_dependencies") {
      auditInput = el("input", {
        type: "text",
        name: "idle-dependencies-audit-command",
        placeholder: "e.g. pnpm outdated --json  (empty = floating ranges only)",
        maxlength: "500",
        "data-testid": "idle-dependencies-audit",
        "aria-label": "Dependency audit command",
      });
      auditInput.value = loop.auditCommand || "";
      auditInput.addEventListener("input", () => refreshStatus());
    }

    editors.set(loop.key, {
      key: loop.key,
      lane: loop.maintenanceLane === true,
      toggle: sw.input,
      enabled: () => sw.input.checked,
      targets: () => (typeof picker.getTargets === "function" ? picker.getTargets() : []),
      auditCommand: () => (auditInput ? auditInput.value.trim() : null),
    });

    const head = el("div", { class: "idle-loop-head" }, [
      el("div", { class: "idle-loop-label" }, [
        el("span", {}, label),
        el("code", { class: "mono setting-key" }, loop.key),
        loop.maintenanceLane ? el("span", { class: "dim" }, "· maintenance lane") : null,
      ]),
      sw.wrap,
    ]);

    rows.appendChild(
      el("div", { class: "idle-loop-row" }, [
        head,
        el("div", { class: "idle-loop-targets field" }, [
          el("label", {}, "Scope to repos / scopes"),
          picker,
        ]),
        auditInput
          ? el("div", { class: "field" }, [
              el("label", {}, "Audit / outdated command (read-only, runs in each repo checkout)"),
              auditInput,
              el(
                "p",
                { class: "dim" },
                "Its output is parsed for outdated and vulnerable packages; the lane never installs. " +
                  "It runs on the host, so under GAFFER_STRICT_REQUIRE it is refused unless " +
                  "GAFFER_IDLE_HOST_EXEC=1.",
              ),
            ])
          : null,
      ]),
    );
  }
  card.appendChild(rows);

  // ── Self-improve: promote the lane's own drafts to ready ──────────────────
  const si = view.selfImprove || { enabled: false, repos: [], maxRisk: "low", maxReadyPerRun: 1 };
  const siSwitch = makeSwitch("Promote drafts to ready", si.enabled, "self-improve-toggle");
  const siPicker = targetPicker({
    repos,
    nodes,
    value: (si.repos || []).map((name) => ({ kind: "repo", id: name, name })),
    multiple: true,
    onChange: () => {},
  });
  const riskSel = el(
    "select",
    { name: "self-improve-max-risk", "aria-label": "Maximum repo risk to auto-promote" },
    ["low", "medium", "high", "critical"].map((r) =>
      el("option", { value: r, selected: r === si.maxRisk ? "" : undefined }, r),
    ),
  );
  const capInput = el("input", {
    type: "number",
    name: "self-improve-max-ready",
    min: "1",
    max: "20",
    step: "1",
    "aria-label": "Maximum promotions per idle tick",
  });
  capInput.value = String(si.maxReadyPerRun || 1);
  siSwitch.input.addEventListener("change", () => refreshStatus());

  card.appendChild(
    el("div", { class: "idle-loop-row idle-self-improve" }, [
      el("div", { class: "idle-loop-head" }, [
        el("div", { class: "idle-loop-label" }, [
          el("span", {}, "Promote drafts to ready"),
          el("code", { class: "mono setting-key" }, "loops.self_improve"),
        ]),
        siSwitch.wrap,
      ]),
      el(
        "p",
        { class: "dim" },
        "Closes the loop: an idle tick may mark its own drafts ready so the delivery loop claims and fixes " +
          "them without a human in the promote step. Strict opt-in — only the repos named here, only at or " +
          "below the risk ceiling, and at most this many per tick. Every promoted ticket carries the " +
          "behaviour-preserving criterion, machine-checked by the repo's test command.",
      ),
      el("div", { class: "idle-loop-targets field" }, [
        el("label", {}, "Repos allowed to self-improve (empty = none)"),
        siPicker,
      ]),
      el("div", { class: "form-grid" }, [
        el("div", { class: "field" }, [el("label", {}, "Max repo risk"), riskSel]),
        el("div", { class: "field" }, [el("label", {}, "Max promotions per tick"), capInput]),
      ]),
    ]),
  );

  // ── Live status: what the next idle tick will actually do ─────────────────
  const statusText = el("span", {});
  const statusIcon = el("span", { class: "settings-note-ico" });
  const status = el("div", { class: "settings-note", "data-testid": "idle-status" }, [
    statusIcon,
    statusText,
  ]);
  card.appendChild(status);

  // The effective runner env the panel cannot see from crew.yaml alone: the
  // GAFFER_MAINTENANCE override, the idle MODE override and the legacy every-loop
  // scan. `effective` is what the factory will use (env → settings.json → preset).
  const envOf = (key) => {
    const row = (envSettings || []).find((s) => s && s.key === key);
    const v = row ? (row.effective !== undefined ? row.effective : row.value) : "";
    return String(v === undefined || v === null ? "" : v).trim();
  };
  const flagOn = (v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
  const reposWithCoverage = (repos || []).filter((r) => r && r.coverage_command).map((r) => r.name);

  function refreshStatus() {
    const lanes = [...editors.values()].filter((e) => e.lane && e.enabled());
    const lanesOn = lanes.length;
    const envMaint = envOf("GAFFER_MAINTENANCE");
    const panelOn = maint.input.checked;
    // GAFFER_MAINTENANCE wins over the panel switch: 0 kills the lane, 1 forces it.
    const maintOn = envMaint === "0" ? false : envMaint === "1" ? true : panelOn;
    const legacyScan = flagOn(envOf("IDLE_DRAFT_WHEN_IDLE"));
    const idleMode = envOf("GAFFER_IDLE_MODE") || view.mode || "create_draft_tickets";
    const siOn = siSwitch.input.checked;
    const backlog = editors.get("idle_feature_backlog");
    const backlogOn = backlog ? backlog.enabled() : false;
    const filing =
      idleMode === "observe_only"
        ? "findings are observed only — nothing is filed (GAFFER_IDLE_MODE=observe_only)"
        : idleMode === "create_ready_tickets"
          ? "findings are filed READY, past the human gate (GAFFER_IDLE_MODE=create_ready_tickets)"
          : siOn
            ? `findings are filed as drafts and may be promoted to ready for the opted-in repos (risk ≤ ${riskSel.value}, ≤ ${capInput.value || 1} per tick)`
            : "findings are filed as drafts for you to promote";
    const notes = [];
    let tone = "ok";
    let text;
    // What the legacy every-loop scan (tick.sh's `fg idle`) runs in one pass.
    const legacyPass =
      lanesOn === 0
        ? "runs no scan lane (none is enabled), only ingest and the memory loops"
        : `runs ALL ${lanesOn} enabled lane${lanesOn === 1 ? "" : "s"} in one pass (plus ingest and the memory loops)`;
    if (envMaint === "0" && !legacyScan) {
      text =
        "GAFFER_MAINTENANCE=0 in the runner's settings is the kill switch: idle ticks skip maintenance " +
        "entirely, whatever this panel says.";
      tone = "warn";
    } else if (!maintOn && lanesOn === 0 && !legacyScan && backlogOn) {
      // The feature backlog has its own switch and runs BEFORE the maintenance lane
      // (tick.sh's `fg feature-backlog`), so it runs with maintenance off too.
      text = `Maintenance is off, so each idle tick runs only the feature backlog; ${filing}.`;
      if (idleMode === "create_ready_tickets") tone = "warn";
    } else if (!maintOn && lanesOn === 0 && !legacyScan) {
      text =
        "Idle ticks poll and stop. Turn on maintenance and at least one lane to work the backlog while idle.";
      tone = "dim";
    } else if (!maintOn && legacyScan) {
      // GAFFER_MAINTENANCE=0 only skips the maintenance lane: tick.sh still falls
      // through to the legacy scan when IDLE_DRAFT_WHEN_IDLE=1.
      text =
        (envMaint === "0"
          ? "GAFFER_MAINTENANCE=0 skips the maintenance lane, but IDLE_DRAFT_WHEN_IDLE=1 (legacy) is on: each idle tick "
          : "IDLE_DRAFT_WHEN_IDLE=1 (legacy): with maintenance off, each idle tick ") +
        `${legacyPass}; ${filing}.`;
      tone = "warn";
    } else if (maintOn && lanesOn === 0 && backlogOn) {
      text =
        "No scan lane is enabled, so each idle tick runs only the feature backlog (plus ingest and the lore-gap loop when on)" +
        (envMaint === "1" ? " (forced on by GAFFER_MAINTENANCE=1)" : "") +
        `; ${filing}.`;
      if (idleMode === "create_ready_tickets") tone = "warn";
    } else if (maintOn && lanesOn === 0 && !backlogOn) {
      text =
        (envMaint === "1"
          ? "GAFFER_MAINTENANCE=1 forces the lane on, but "
          : "Maintenance is on but ") +
        "no lane is enabled — idle ticks will do nothing (no_work). Enable a lane or use the recommended set.";
      tone = "warn";
    } else if (!maintOn) {
      text = `${lanesOn} lane${lanesOn === 1 ? "" : "s"} enabled but maintenance is off — they will not run until you turn it on.`;
      tone = "warn";
    } else {
      text =
        `Each idle tick runs ONE of the ${lanesOn} enabled lane${lanesOn === 1 ? "" : "s"}, rotating by priority` +
        (envMaint === "1" ? " (forced on by GAFFER_MAINTENANCE=1)" : "") +
        `; ${filing}.`;
      if (idleMode === "create_ready_tickets") tone = "warn";
    }
    if (maintOn || legacyScan) {
      const cov = editors.get("idle_coverage");
      if (cov && cov.enabled()) {
        const scope = cov.targets().map((t) => t.name);
        const covered = scope.length
          ? scope.filter((n) => reposWithCoverage.includes(n))
          : reposWithCoverage;
        if (covered.length === 0) {
          notes.push(
            "The coverage lane needs a repo with a coverage command (repo settings → coverage); it will answer no_repos until one is set.",
          );
          tone = tone === "ok" ? "warn" : tone;
        }
      }
      const dep = editors.get("idle_dependencies");
      if (dep && dep.enabled() && !dep.auditCommand()) {
        notes.push(
          "Without an audit command the dependency lane only flags floating ranges (*, latest, >), never outdated or vulnerable packages.",
        );
      }
    }
    if (backlogOn) {
      notes.push(
        "The feature backlog plans one `backlog` feature from memory per idle tick, before the maintenance lane and whatever its switch says (one model call, counted against the day cap); add features with `lg feature add`.",
      );
    }
    statusText.textContent = notes.length ? `${text} ${notes.join(" ")}` : text;
    status.dataset.tone = tone;
    statusIcon.innerHTML = "";
    statusIcon.appendChild(icon(tone === "warn" ? "alert" : tone === "ok" ? "check" : "clock"));
  }
  maint.input.addEventListener("change", refreshStatus);
  riskSel.addEventListener("change", refreshStatus);
  capInput.addEventListener("input", refreshStatus);
  recommendBtn.addEventListener("click", () => {
    maint.input.checked = true;
    for (const ed of editors.values()) {
      if (IDLE_RECOMMENDED_LANES.includes(ed.key)) ed.toggle.checked = true;
    }
    refreshStatus();
    toast("Recommended lanes selected — save to apply.", { ok: true });
  });
  refreshStatus();

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveBtn = el("button", { class: "btn primary", type: "button" }, [
    icon("check"),
    el("span", {}, "Save idle loops"),
  ]);
  card.appendChild(el("div", { class: "btn-row settings-actions" }, [saveBtn]));

  saveBtn.addEventListener("click", () => {
    runAsyncAction(saveBtn, "Saving…", async () => {
      // Resolve every selection to repo NAMES (nodes expand to their repos),
      // de-duplicating so a repo named twice (directly + via a scope) collapses.
      const namesOf = async (targets) => {
        const names = new Set();
        for (const target of targets) {
          const resolved = await resolveTargetRepos(target);
          for (const name of resolved) names.add(name);
        }
        return [...names];
      };
      const loops = [];
      for (const ed of editors.values()) {
        const row = { key: ed.key, enabled: ed.enabled(), repos: await namesOf(ed.targets()) };
        if (ed.key === "idle_dependencies") row.audit_command = ed.auditCommand() || null;
        loops.push(row);
      }
      const cap = Math.min(20, Math.max(1, Math.trunc(Number(capInput.value) || 1)));
      await api("PUT", "/api/idle-loops", {
        loops,
        maintenance: { enabled: maint.input.checked },
        self_improve: {
          enabled: siSwitch.input.checked,
          repos: await namesOf(
            typeof siPicker.getTargets === "function" ? siPicker.getTargets() : [],
          ),
          max_risk: riskSel.value,
          max_ready_per_run: cap,
        },
      });
      toast(
        `Saved idle loops (${loops.length} loops, maintenance ${maint.input.checked ? "on" : "off"}).`,
        {
          ok: true,
        },
      );
      router();
    });
  });

  return card;
}

export { autonomyRecommendationsPanel, autonomyPoliciesPanel, accessPanel, renderIdleLoopsPanel };
