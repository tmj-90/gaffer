// View: Settings, the fourteen settings a factory has (everything else follows from them).
// The module map is in app.js.

import { roLockAll } from "../access.js";
import { api } from "../api.js";
import { button, callout, dataTable, emptyState, viewHead } from "../components.js";
import { clear, el, field } from "../dom.js";
import { moneyW, plural } from "../format.js";
import { icon } from "../icons.js";
import { table } from "../lookup.js";
import { routeSignal, router } from "../router.js";
import { runAsyncAction, toast } from "../toast.js";
import {
  accessPanel,
  autonomyLadderPanel,
  autonomyPoliciesPanel,
  autonomyRecommendationsPanel,
  renderIdleLoopsPanel,
} from "./autonomy.js";
import {
  autonomyPoliciesInert,
  inertPoliciesNote,
  teamInstructions,
  whatThisSets,
} from "./formation.js";
import { principalSignaturesCallout } from "./principal-signatures.js";

// --- Settings -----------------------------------------------------------------
//
// GET /api/settings reports the fourteen settings (value, where it came from, whether
// the environment locks it), what the runner derives from them (`derived`), the old
// settings.json keys (`migration`), derived values the environment overrides
// (`overrides`) and what the removal act would do (`cleanup`). The names, kinds,
// choices, defaults and descriptions come from the runner's schema through the API;
// this page only lays them out. Save POSTs the changed values and re-renders.

/** The page's sections, in the order of the design's table (GAFFER_MODE is the dial). */
const SETTINGS_GROUPS = [
  { id: "budget", label: "Budget", note: "The two dollar caps. A live run needs one of them." },
  {
    id: "work",
    label: "Models and effort",
    note: "Which models play, how much work one ticket may take, how many at once, and what happens when nothing is ready.",
  },
  {
    id: "safety",
    label: "Safety",
    note: "The OS sandbox, the gates every delivery passes, and the independent tester.",
  },
  { id: "delivery", label: "Delivery", note: "How approved work lands." },
  { id: "notify", label: "Notify", note: "Where to tell a person when the factory needs one." },
  {
    id: "location",
    label: "Where it runs",
    note: "Shown here; how to change each is under it.",
  },
];

/** One line per choice: what picking it changes (the figures are under What this sets). */
const CHOICE_LINES = table({
  GAFFER_EFFORT: table({
    small: "Shorter agent calls, fewer turns and delivery attempts.",
    standard: "The built-in limits.",
    large: "Longer agent calls, more turns and attempts.",
  }),
  GAFFER_SANDBOX: table({
    auto: "sandbox-exec on macOS, docker elsewhere.",
    docker: "Read, write and network isolation (needs Docker).",
    "sandbox-exec": "macOS only: write containment.",
  }),
  GAFFER_GATES: table({
    standard: "Tests, lint and typecheck must pass.",
    strict: "Also a smallest-change note, tighter size flags and no flaky rerun.",
  }),
  GAFFER_LANDING: table({
    local: "Merged into the default branch on this machine.",
    pr: "A pull request per delivery; review waits for green checks.",
  }),
  GAFFER_TESTING: table({
    auto: "On where a repository has a test command.",
    on: "Every testable ticket is tested before review.",
    off: "Only an epic's acceptance ticket is tested.",
  }),
  GAFFER_IDLE: table({
    auto: "The Idle loops panel decides.",
    off: "Nothing runs between tickets.",
    maintenance: "The maintenance lanes.",
    backlog: "Plan the next feature from the backlog.",
    all: "Everything, also clarifying and drafting tickets.",
  }),
});
const CHOICE_WORDS = table({
  "sandbox-exec": "sandbox-exec",
});

/** Where a value came from, as a word (never colour alone). */
const ORIGIN_WORDS = table({
  default: "default",
  dashboard: "set here",
  environment: "set by the environment",
});

const ADVANCED_DOC = "https://github.com/tmj-90/gaffer/blob/main/docs/CONFIG-ADVANCED.md";

async function renderSettings() {
  // The settings plus the crew idle-loop config, the repos and scope nodes its target
  // picker needs, the autonomy panels and the spend so far. Best-effort on the extras:
  // a failure there must not blank the whole Settings page.
  const signal = routeSignal();
  const get = (p) => api("GET", p, undefined, { signal });
  const [
    report,
    idleLoopsRes,
    reposRes,
    nodesRes,
    autonomyRecRes,
    autonomyPolRes,
    whoamiRes,
    principalsRes,
    costRes,
  ] = await Promise.all([
    get("/api/settings"),
    get("/api/idle-loops").catch(() => null),
    get("/repositories").catch(() => ({ repositories: [], unread: true })),
    get("/scope/nodes").catch(() => ({ nodes: [] })),
    get("/api/autonomy/recommendations").catch(() => null),
    get("/api/autonomy/policies").catch(() => null),
    get("/api/whoami").catch(() => null),
    get("/api/principals").catch(() => null),
    get("/api/cost").catch(() => null),
  ]);
  const all = Array.isArray(report.settings) ? report.settings : [];
  const derived = Array.isArray(report.derived) ? report.derived : [];
  const migration = Array.isArray(report.migration) ? report.migration : [];
  const overrides = Array.isArray(report.overrides) ? report.overrides : [];
  const cleanup = report.cleanup || { drop: [], rewrite: [] };
  const isolation = report.isolation;
  const idleLoops = idleLoopsRes && idleLoopsRes.idle_loops ? idleLoopsRes.idle_loops : null;
  const repos = reposRes.repositories || [];
  // The formation and Go/No-Go read whether any repository has a test command (the `auto`
  // tester lane runs only there); unknown when the list could not be read.
  formationLaneRepos =
    reposRes.unread || !Array.isArray(reposRes.repositories)
      ? null
      : {
          total: repos.length,
          withTest: repos.filter((r) => String(r.test_command || "").trim()).length,
        };
  const nodes = nodesRes.nodes || [];
  const autonomyRecs =
    autonomyRecRes && Array.isArray(autonomyRecRes.recommendations)
      ? autonomyRecRes.recommendations
      : [];
  const autonomyPolicies =
    autonomyPolRes && Array.isArray(autonomyPolRes.policies) ? autonomyPolRes.policies : [];
  // The derived values as read-only rows, for the panels that read one by name (the
  // idle loops panel, the inert-grants note): the value a run uses, never editable.
  const derivedViews = derived.map((d) => ({
    key: d.name,
    value: "",
    effective: d.value == null ? "" : String(d.value),
    envLocked: d.source === "environment",
    setting: d.setting,
  }));
  const views = [...all, ...derivedViews];

  const wrap = el("div", { class: "view settings-view" });
  const here = all.filter((s) => s.origin === "dashboard").length;
  const locked = all.filter((s) => s.envLocked).length;

  const note = el("p", { class: "settings-note" }, [
    icon("clock", "settings-note-ico", 16),
    el("span", {}, "Changes apply on the next tick; no live restart."),
  ]);
  wrap.appendChild(
    viewHead(
      "The boot room",
      all.length
        ? `${plural(all.length, "setting")} · ${here} set here · ${locked} set by the environment`
        : null,
    ),
  );

  if (all.length === 0) {
    wrap.appendChild(note);
    wrap.appendChild(emptyState("No settings available", "The settings API returned no settings."));
    return wrap;
  }

  const main = el("div", { class: "boot-main" });
  const index = el("nav", { class: "boot-index", "aria-label": "Boot room sections" });
  wrap.appendChild(el("div", { class: "boot-room" }, [index, main]));
  main.appendChild(note);

  // The runner refuses to load this settings.json: say so first, in its own words.
  if (report.configError) {
    main.appendChild(
      callout({
        tone: "bad",
        cls: "settings-config-error",
        role: "alert",
        title: "The runner refuses this settings.json, so no run starts.",
        body: `${report.configError}. Fix the setting below (or use the removal act in the callout under this one, which also rewrites a stored value the runner refuses).`,
      }),
    );
  }
  const migrationNode = migrationCallout(migration, cleanup);
  if (migrationNode) main.appendChild(migrationNode);

  const editors = new Map();
  const form = el("form", { class: "settings-form", id: "settings-form", novalidate: "" });

  // The headline: the Autonomy mode (GAFFER_MODE) as the five-detent dial.
  const instructions = teamInstructions(all, editors, autonomyPolicies, derived, isolation);
  main.appendChild(instructions.node);

  main.appendChild(autonomyLadderPanel()); // THE AUTONOMY LADDER (js/views/autonomy-ladder.js)
  const inertCount = autonomyPoliciesInert(autonomyPolicies, views);
  if (inertCount > 0) main.appendChild(inertPoliciesNote(inertCount));
  const polPanel = autonomyPoliciesPanel(autonomyPolicies, { inert: inertCount > 0 });
  if (polPanel) {
    polPanel.id = "autonomy-policies";
    main.appendChild(polPanel);
  }
  const recPanel = autonomyRecommendationsPanel(autonomyRecs, autonomyPolicies, {
    inert: inertCount > 0,
  });
  if (recPanel) {
    recPanel.id = "autonomy-recs";
    main.appendChild(recPanel);
  }

  const groupsUsed = SETTINGS_GROUPS.filter((g) => all.some((s) => s.group === g.id));
  for (const grp of groupsUsed) {
    const inGroup = all.filter((s) => s.group === grp.id);
    const card = el("section", {
      class: "card settings-group",
      id: `grp-${grp.id}`,
      "aria-labelledby": `grp-${grp.id}-t`,
    });
    card.appendChild(
      el("div", { class: "panel-head" }, [
        el("h2", { class: "panel-title", id: `grp-${grp.id}-t` }, grp.label),
        el("span", { class: "grp-dirty", hidden: true }),
      ]),
    );
    card.appendChild(el("p", { class: "section-note" }, grp.note));
    if (grp.id === "safety") card.appendChild(isolationLine(isolation));
    const rows = el("div", { class: "settings-rows" });
    for (const s of inGroup) rows.appendChild(renderSettingRow(s, editors, derived, costRes));
    card.appendChild(rows);
    form.appendChild(card);
  }
  main.appendChild(form);

  // Derived values a real environment variable sets: read-only, at the bottom of the room.
  if (overrides.length) main.appendChild(overridesPanel(overrides));

  if (idleLoops) {
    const loops = renderIdleLoopsPanel(idleLoops, repos, nodes, views);
    main.appendChild(
      el("details", { class: "boot-fold", id: "idle-loops" }, [
        el("summary", {}, [
          el("span", { class: "boot-fold-t" }, "Idle loops"),
          el(
            "span",
            { class: "panel-aux" },
            "what the squad does when no ticket is ready · crew.yaml",
          ),
        ]),
        loops,
      ]),
    );
  }

  main.appendChild(principalSignaturesCallout(whoamiRes)); // SEALED PRINCIPALS: unsigned sign-ins
  const acc = accessPanel(
    whoamiRes,
    principalsRes && Array.isArray(principalsRes.principals) ? principalsRes.principals : [],
  );
  acc.id = "access";
  main.appendChild(acc);

  // The sticky save bar: the unsaved count (named), Discard, and the one primary.
  const saveBtn = el(
    "button",
    { class: "btn primary", type: "submit", form: "settings-form", disabled: "" },
    [icon("check"), el("span", {}, "Save changes")],
  );
  const discardBtn = el(
    "button",
    { class: "btn quiet", type: "button", disabled: "", onclick: () => router() },
    "Discard",
  );
  const dirtyNote = el("span", { class: "boot-dirty", role: "status" }, "No unsaved changes.");
  const saveBar = el(
    "div",
    { class: "boot-save settings-actions is-clean", role: "group", "aria-label": "Save settings" },
    [dirtyNote, discardBtn, saveBtn],
  );
  main.appendChild(saveBar);
  const idxDirty = el("span", { class: "boot-n" }, "none");
  const labelOf = new Map(all.map((s) => [s.key, s.label || s.key]));
  const dirtyKeys = () => {
    const out = [];
    for (const [key, ed] of editors) {
      if (ed.initial !== undefined && ed.read() !== ed.initial) out.push(key);
    }
    return out;
  };
  const paintDirty = () => {
    const keys = dirtyKeys();
    const n = keys.length;
    clear(dirtyNote);
    if (n) {
      const names = keys.slice(0, 2).map((k) => labelOf.get(k));
      dirtyNote.append(
        el("strong", {}, [
          `${n} unsaved`,
          el("span", { class: "bd-word" }, n === 1 ? " change" : " changes"),
        ]),
        el(
          "span",
          { class: "bd-names" },
          `: ${names.join(", ")}${n > 2 ? ` and ${n - 2} more` : ""}.`,
        ),
      );
    } else dirtyNote.textContent = "No unsaved changes.";
    dirtyNote.classList.toggle("is-dirty", n > 0);
    discardBtn.disabled = n === 0;
    saveBtn.disabled = n === 0;
    saveBar.classList.toggle("is-clean", n === 0);
    idxDirty.textContent = n ? String(n) : "none";
    // Unsaved is not a needs-you count: the ink outline badge, never the yellow card.
    idxDirty.className = n ? "unsaved-tag" : "boot-n";
    const dirty = new Set(keys);
    for (const [key, ed] of editors)
      if (ed.row) ed.row.classList.toggle("is-dirty", dirty.has(key));
    for (const g of form.querySelectorAll(".settings-group")) {
      const c = g.querySelectorAll(".setting-row.is-dirty").length;
      const tag = g.querySelector(".grp-dirty");
      tag.hidden = !c;
      tag.textContent = c ? `${c} unsaved` : "";
    }
    instructions.sync();
  };
  main.addEventListener("input", paintDirty);
  main.addEventListener("change", paintDirty);
  instructions.onPick = paintDirty;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // Only what the person changed. The server is the final gate: it validates every
    // value as the runner does, refuses any key that is not a setting and re-checks
    // env-lock, so this is just the payload.
    const settings = {};
    let notify;
    for (const [key, ed] of editors) {
      if (ed.initial === undefined || ed.read() === ed.initial) continue;
      if (ed.notify) notify = ed.notify();
      else settings[key] = ed.read();
    }
    for (const ed of editors.values()) {
      if (ed.row) for (const old of ed.row.querySelectorAll(".setting-error")) old.remove();
      if (ed.input) ed.input.removeAttribute("aria-invalid");
    }
    const markBad = (key, problem) => {
      const ed = editors.get(key);
      const label = labelOf.get(key) || key;
      if (!ed) return;
      if (ed.input) ed.input.setAttribute("aria-invalid", "true");
      if (ed.row) {
        const ctl = ed.row.querySelector(".setting-control") || ed.row;
        ctl.appendChild(
          el("p", { class: "form-error setting-error", role: "alert" }, `${label} ${problem}.`),
        );
      }
    };
    saveBtn.disabled = false;
    runAsyncAction(saveBtn, "Saving…", async () => {
      let res;
      try {
        res = await api("POST", "/api/settings", notify ? { settings, notify } : { settings });
      } catch (err) {
        // The 422 names each refused value (in the runner's words): mark its row.
        const invalid = err && err.details && err.details.invalid;
        if (Array.isArray(invalid) && invalid.length) {
          for (const p of invalid) if (p && p.key) markBad(p.key, p.problem || "is not valid");
          const first = [...editors.values()].find(
            (ed) => ed.input && ed.input.getAttribute("aria-invalid") === "true",
          );
          if (first) first.input.focus();
        }
        throw err;
      }
      const written = (res.written || []).length;
      const rejected = (res.rejected || []).length;
      toast(
        rejected
          ? `Saved ${plural(written, "setting")}; ${rejected} skipped (set by the environment).`
          : `Saved ${plural(written, "setting")}.`,
        { ok: true },
      );
      router();
    });
  });

  // The index: find a setting by name, key or description; jump to any section.
  const findCount = el("span", { class: "boot-find-n", role: "status" });
  const noMatch = el("p", { class: "boot-nomatch", hidden: true });
  form.appendChild(noMatch);
  const find = el("input", {
    type: "search",
    class: "boot-find",
    placeholder: "Find a setting…",
    "aria-label": "Find a setting",
    oninput: (e) => {
      const q = e.target.value.trim().toLowerCase();
      let shown = 0;
      for (const row of form.querySelectorAll(".setting-row")) {
        const hit = !q || (row.dataset.find || "").includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      }
      for (const g of form.querySelectorAll(".settings-group"))
        g.hidden = !!q && !g.querySelector(".setting-row:not([hidden])");
      findCount.textContent = q ? `${plural(shown, "match", "matches")}` : "";
      noMatch.hidden = !q || shown > 0;
      main.classList.toggle("is-finding", !!q);
      noMatch.textContent = q && !shown ? `No setting matches “${e.target.value.trim()}”.` : "";
    },
  });
  const link = (id, label, n) =>
    el("a", { href: `#${id}` }, [
      el("span", {}, label),
      n != null ? el("span", { class: "boot-n" }, String(n)) : null,
    ]);
  const phone =
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const extra = [migrationNode, polPanel, recPanel, idleLoops, overrides.length ? 1 : null];
  const sections = el("details", { class: "boot-sections", open: phone ? null : "" }, [
    el("summary", {}, [
      "Jump to a section",
      el("span", { class: "boot-n" }, String(groupsUsed.length + 2 + extra.filter(Boolean).length)),
    ]),
    el("ul", { class: "boot-links" }, [
      migrationNode ? el("li", {}, link("settings-migration", "Old settings")) : null,
      el("li", {}, link("instructions", "Autonomy mode")),
      polPanel ? el("li", {}, link(polPanel.id, "Active autonomy")) : null,
      recPanel ? el("li", {}, link(recPanel.id, "Suggested autonomy")) : null,
      ...groupsUsed.map((g) =>
        el("li", {}, link(`grp-${g.id}`, g.label, all.filter((x) => x.group === g.id).length)),
      ),
      overrides.length
        ? el("li", {}, link("settings-overrides", "Overridden", overrides.length))
        : null,
      idleLoops ? el("li", {}, link("idle-loops", "Idle loops")) : null,
      el("li", {}, link("access", "Access")),
    ]),
  ]);
  sections.addEventListener("click", (e) => {
    if (e.target.closest("a") && phone) sections.open = false;
  });
  index.append(
    field("Find a setting", find, { class: "boot-find-f" }),
    findCount,
    sections,
    el("p", { class: "boot-unsaved" }, ["Unsaved changes: ", idxDirty]),
  );
  instructions.sync();
  // A read token sees the room, not its switches: every editor and button in it is
  // off (the index's search still works). The strip under the header says why.
  roLockAll(main, "repo");
  return wrap;
}

/**
 * The registered repositories as the Settings view last read them: how many, and how many
 * have a registered test command. Null when unread. Under `auto` the tester runs only where
 * a repository has one (lane-hook R5).
 */
let formationLaneRepos = null;

/**
 * The migration callout: settings.json still holds keys that are no longer settings (or
 * a stored value the runner refuses). One callout lists each old key, the setting that
 * decides it now and, where the old value differs, which reading is in force (the
 * stricter one). Its one action removes them: a person's act behind a confirm step that
 * shows exactly what goes. Nothing is removed without it.
 */
function migrationCallout(migration, cleanup) {
  const drop = Array.isArray(cleanup.drop) ? cleanup.drop : [];
  const rewrite = Array.isArray(cleanup.rewrite) ? cleanup.rewrite : [];
  if (!migration.length && !drop.length && !rewrite.length) return null;
  const n = migration.length;
  const settingsNamed = [...new Set(migration.map((m) => m.setting).filter(Boolean))];
  const box = el("section", {
    class: "card settings-migration",
    id: "settings-migration",
    "aria-labelledby": "settings-migration-t",
  });
  box.appendChild(
    callout({
      tone: "needs",
      title: n
        ? `${plural(n, "old setting")} in settings.json ${n === 1 ? "is" : "are"} now decided by ${settingsNamed.length ? settingsNamed.join(", ") : "nothing"}: review.`
        : "settings.json holds a stored value the runner reads differently: review.",
      body: "While the old keys stay in settings.json, an old key that is stricter keeps beating the setting you pick (an old GAFFER_TICK_TIMEOUT=1800 beats Effort large), an old notify URL keeps receiving events after you change Notify, and every runner process prints one warning per old key. Nothing is removed until you choose to.",
    }),
  );
  box.firstChild.id = "settings-migration-t";
  if (n) {
    box.appendChild(
      dataTable({
        caption: "Old keys and the setting that decides each now",
        stackOnPhone: true,
        columns: [
          { key: "key", label: "Old key", format: (v) => el("code", { class: "mono" }, v) },
          {
            key: "setting",
            label: "Decided by",
            format: (v) => (v ? el("code", { class: "mono" }, v) : "nothing"),
            missing: "never a setting",
          },
          { key: "old", label: "Old value", missing: "empty" },
          {
            key: "inForce",
            label: "In force",
            format: (v, row) =>
              el("span", { class: `mig-${row.decision}` }, [
                row.differs ? el("strong", {}, "Differs: ") : null,
                v,
              ]),
          },
        ],
        rows: migration,
      }),
    );
  }
  const confirm = el("div", { class: "mig-confirm", hidden: true, role: "group" });
  const start = button("Remove the old keys from settings.json", { cls: "mig-start" });
  start.addEventListener("click", () => {
    confirm.hidden = false;
    start.hidden = true;
    const first = confirm.querySelector("button");
    if (first) first.focus();
  });
  const removeBtn = button(`Remove ${plural(drop.length, "key")} now`, {
    kind: "danger",
    cls: "mig-remove",
  });
  const cancelBtn = button("Cancel", { kind: "ghost" });
  cancelBtn.addEventListener("click", () => {
    confirm.hidden = true;
    start.hidden = false;
  });
  removeBtn.addEventListener("click", () =>
    runAsyncAction(removeBtn, "Removing…", async () => {
      await api("POST", "/api/settings/remove-old-keys", {
        drop: drop.map((d) => d.key),
        rewrite: rewrite.map((r) => r.key),
      });
      toast(`Removed ${plural(drop.length, "old key")} from settings.json.`, { ok: true });
      router();
    }),
  );
  // Element.append writes a null as the text "null": only real nodes go in.
  const parts = [
    el("p", { class: "mig-confirm-lede" }, [
      el("strong", {}, "This rewrites settings.json keeping only the fourteen settings. "),
      "It removes:",
    ]),
    el(
      "ul",
      { class: "mig-drop" },
      drop.map((d) =>
        el("li", {}, [
          el("code", { class: "mono" }, d.key),
          d.value !== "" ? ` = ${d.value}` : " (empty)",
        ]),
      ),
    ),
    rewrite.length
      ? el("p", {}, "And rewrites these stored values so the runner accepts them:")
      : null,
    rewrite.length
      ? el(
          "ul",
          { class: "mig-rewrite" },
          rewrite.map((r) =>
            el("li", {}, [
              el("code", { class: "mono" }, r.key),
              ` “${r.from}” becomes ${r.to === "" ? "cleared (the default)" : `“${r.to}”`}`,
            ]),
          ),
        )
      : null,
    el("div", { class: "mig-actions" }, [removeBtn, cancelBtn]),
  ];
  confirm.append(...parts.filter(Boolean));
  box.append(el("div", { class: "mig-act" }, [start]), confirm);
  return box;
}

/** Derived values a real environment variable sets (read-only, values masked). */
function overridesPanel(overrides) {
  return el(
    "section",
    {
      class: "card settings-overrides",
      id: "settings-overrides",
      "aria-labelledby": "settings-overrides-t",
    },
    [
      el("div", { class: "panel-head" }, [
        el(
          "h2",
          { class: "panel-title", id: "settings-overrides-t" },
          "Overridden from the environment",
        ),
      ]),
      el("p", { class: "section-note" }, [
        "A real environment variable sets these derived values, so the setting that would decide each does not. Unset the variable before starting the runner to hand it back. Every derived value: ",
        el(
          "a",
          { href: ADVANCED_DOC, rel: "noopener", target: "_blank" },
          "Detailed configuration",
        ),
        " (docs/CONFIG-ADVANCED.md).",
      ]),
      dataTable({
        caption: "Derived values the environment sets",
        stackOnPhone: true,
        columns: [
          { key: "name", label: "Variable", format: (v) => el("code", { class: "mono" }, v) },
          { key: "value", label: "Value", missing: "unset" },
          {
            key: "setting",
            label: "Otherwise decided by",
            format: (v) => el("code", { class: "mono" }, v),
          },
        ],
        rows: overrides,
      }),
    ],
  );
}

/**
 * The agent isolation posture as one read-only line in the Safety group (GET
 * /api/settings `isolation`, from runner/gaffer sandbox-status): the provider, whether
 * this host can supply it, whether it is required or opted out, and the fix when it is
 * missing. data-state is available, missing, opted-out or unknown.
 */
function isolationLine(iso) {
  if (!iso || typeof iso !== "object" || !iso.provider || iso.provider === "unknown") {
    const why = iso && iso.error ? ` (${iso.error})` : "";
    return el(
      "p",
      { class: "section-note settings-isolation", "data-state": "unknown", role: "status" },
      `Isolation: not known${why}. Run gaffer sandbox-status in a terminal to see it.`,
    );
  }
  const avail = iso.available ? "available" : `missing${iso.missing ? ` (${iso.missing})` : ""}`;
  const state = iso.optedOut ? "opted-out" : iso.available ? "available" : "missing";
  let text = `Isolation: ${iso.provider}, ${avail}. `;
  if (iso.optedOut)
    text +=
      "Opted out: GAFFER_STRICT_REQUIRE=0 is set in the environment, so agents run without an OS sandbox (only the environment can do that).";
  else if (iso.available) text += "Required: every agent runs inside it.";
  else text += "Required: live runs refuse to launch agents until it is fixed.";
  if (!iso.available && iso.fix) text += ` Fix: ${iso.fix}.`;
  return el(
    "p",
    { class: "section-note settings-isolation", "data-state": state, role: "status" },
    text,
  );
}

/** A setting's description: the first sentence, the rest folded behind "More". */
function settingHelp(text) {
  const t = String(text);
  const m = t.match(/^(.{40,180}?[.!?:])\s+(.+)$/s);
  if (!m) return el("p", { class: "setting-help dim" }, t);
  return el("div", { class: "setting-help dim" }, [
    el("p", {}, m[1]),
    el("details", { class: "setting-more" }, [el("summary", {}, "More"), el("p", {}, m[2])]),
  ]);
}

/**
 * One setting row: its label, name, where its value came from (a word), the
 * description, the control, and "What this sets" (the derived values with their
 * figures). An env-locked setting shows its value read-only with the lock and why.
 */
function renderSettingRow(s, editors, derived, costRes) {
  const origin = ORIGIN_WORDS[s.origin] || s.origin;
  const meta = el("div", { class: "setting-meta" }, [
    el("div", { class: "setting-label" }, [
      el("span", {}, s.label || s.key),
      s.envLocked
        ? el("span", { class: "badge env-locked no-dot" }, [
            icon("lock", "lock-ico", 12),
            "set by the environment",
          ])
        : null,
    ]),
    el("div", { class: "setting-id" }, [
      el("code", { class: "mono setting-key" }, s.key),
      s.envLocked ? null : el("span", { class: `setting-src src-${s.origin}` }, origin),
      el("span", { class: "setting-unsaved" }, "unsaved"),
    ]),
    s.description ? settingHelp(s.description) : null,
  ]);
  const control = el("div", { class: "setting-control" }, renderSettingInput(s, editors, costRes));
  const row = el(
    "div",
    {
      class: `setting-row${s.envLocked ? " is-locked" : ""}`,
      id: `set-${s.key}`,
      dataset: {
        key: s.key,
        find: `${s.label || ""} ${s.key} ${s.description || ""}`.toLowerCase(),
      },
    },
    [meta, control, whatThisSets(s, derived)],
  );
  const ed = editors.get(s.key);
  if (ed) ed.row = row;
  return row;
}

/** The read-only value of a setting the dashboard does not edit (env-locked, or data). */
function readOnlyValue(s, how) {
  return el("div", { class: "setting-readonly" }, [
    el(
      "output",
      { class: "mono setting-locked-value", "aria-label": `${s.label}: ${s.effective || "unset"}` },
      s.effective !== "" ? s.effective : "(unset)",
    ),
    how ? el("p", { class: "setting-how dim" }, how) : null,
  ]);
}

/** A segmented choice: one radio per value, each with its one line. */
function segmented(s, editors, values, words, lines, current) {
  const name = `seg-${s.key}`;
  const group = el("fieldset", { class: "seg-choice", "aria-label": s.label }, [
    el("legend", { class: "sr-only" }, s.label),
  ]);
  const radios = [];
  for (const v of values) {
    const input = el("input", { type: "radio", name, value: v, class: "seg-input" });
    input.checked = v === current;
    radios.push(input);
    group.appendChild(
      el("label", { class: "seg-opt", dataset: { value: v } }, [
        input,
        el("span", { class: "seg-word" }, (words && words[v]) || v),
        lines && lines[v] ? el("span", { class: "seg-line dim" }, lines[v]) : null,
        v === current ? el("span", { class: "seg-now" }, "Now") : null,
      ]),
    );
  }
  const picked = () => {
    const r = radios.find((x) => x.checked);
    return r ? r.value : current;
  };
  // Picking the value in force again restores what is stored (no false "unsaved").
  editors.set(s.key, {
    read: () => (picked() === current ? s.value : picked()),
    initial: s.value,
    input: radios[0],
  });
  return group;
}

/** The value a testing setting reads as (stored 1/0/true/... read as on/off). */
function testingWord(v) {
  const t = String(v || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return "on";
  if (["0", "false", "no", "off"].includes(t)) return "off";
  return "auto";
}

/** Build the control for a setting (or a read-only value when the dashboard cannot edit it). */
function renderSettingInput(s, editors, costRes) {
  if (s.key === "GAFFER_DATA")
    return readOnlyValue(
      s,
      "Only the environment moves it (settings.json lives inside it): export GAFFER_DATA=/path before gaffer dashboard and gaffer run.",
    );
  if (s.secret) return renderNotifyInput(s, editors);
  if (s.envLocked)
    return readOnlyValue(
      s,
      `The environment sets ${s.key}, which always wins over settings.json; unset it before starting the dashboard to edit it here.`,
    );
  const lines = CHOICE_LINES[s.key];
  if (s.kind === "choice" || s.kind === "gates")
    return segmented(s, editors, s.values, CHOICE_WORDS, lines, s.effective || s.default);
  if (s.kind === "testing")
    return segmented(s, editors, ["auto", "on", "off"], null, lines, testingWord(s.effective));
  if (s.kind === "models") return renderModelsInput(s, editors);
  if (s.kind === "usd") {
    const input = el("input", {
      type: "text",
      inputmode: "decimal",
      value: s.value,
      placeholder: "no cap",
      "aria-label": s.label,
    });
    editors.set(s.key, { read: () => input.value.trim(), initial: s.value, input });
    const spent =
      costRes && s.key === "GAFFER_DAILY_BUDGET_USD" && typeof costRes.today_usd === "number"
        ? `Spent today (UTC): ${moneyW(costRes.today_usd)}.`
        : costRes && s.key === "GAFFER_BUDGET_USD" && typeof costRes.total_usd === "number"
          ? `Spent so far: ${moneyW(costRes.total_usd)}.`
          : "Spend so far: not known (the usage ledger could not be read).";
    return el("div", { class: "setting-usd" }, [
      el("span", { class: "usd-prefix", "aria-hidden": "true" }, "$"),
      input,
      el("p", { class: "setting-spent dim" }, spent),
    ]);
  }
  if (s.kind === "count" || s.kind === "port") {
    const max = s.kind === "count" ? "64" : "65535";
    const input = el("input", {
      type: "number",
      inputmode: "numeric",
      step: "1",
      min: "1",
      max,
      value: s.value,
      placeholder: s.effective || s.default,
      "aria-label": s.label,
    });
    editors.set(s.key, { read: () => input.value.trim(), initial: s.value, input });
    return el("div", {}, [
      input,
      s.kind === "port"
        ? el(
            "p",
            { class: "setting-how dim" },
            "Takes effect when the dashboard restarts: gaffer dashboard --restart.",
          )
        : el("p", { class: "setting-how dim" }, "1 to 64."),
    ]);
  }
  const input = el("input", { type: "text", value: s.value, "aria-label": s.label });
  editors.set(s.key, { read: () => input.value.trim(), initial: s.value, input });
  return input;
}

/** Models: a named preset, or three slots (strong, standard, cheap). */
function renderModelsInput(s, editors) {
  const current = s.effective || s.default;
  const isPreset = s.values.includes(current);
  const slots = isPreset ? ["", "", ""] : current.split(",");
  const select = el("select", { class: "setting-select", "aria-label": `${s.label}: preset` }, [
    ...s.values.map((v) => {
      const o = el("option", { value: v }, v);
      if (isPreset && v === current) o.selected = true;
      return o;
    }),
    (() => {
      const o = el("option", { value: "custom" }, "three models of my own");
      if (!isPreset) o.selected = true;
      return o;
    })(),
  ]);
  const names = ["strong", "standard", "cheap"];
  const inputs = names.map((n, i) =>
    el("input", {
      type: "text",
      value: slots[i] || "",
      placeholder: `${n} model id`,
      "aria-label": `${s.label}: ${n}`,
      spellcheck: "false",
    }),
  );
  const custom = el(
    "div",
    { class: "models-slots", hidden: isPreset ? "" : null },
    names.map((n, i) => field(n, inputs[i])),
  );
  select.addEventListener("change", () => {
    custom.hidden = select.value !== "custom";
  });
  const read = () => {
    const v =
      select.value === "custom" ? inputs.map((x) => x.value.trim()).join(",") : select.value;
    return v === current ? s.value : v;
  };
  editors.set(s.key, { read, initial: s.value, input: select });
  return el("div", { class: "setting-models" }, [select, custom]);
}

/**
 * Notify: desktop on or off, and the webhook and Slack URLs. A saved URL is a credential:
 * the server never sends it, only its host, so it shows masked with Replace and Remove,
 * and Save sends what to change (the server keeps the stored URLs). Check delivery with
 * `gaffer wg notify test` in a terminal.
 */
function renderNotifyInput(s, editors) {
  const channels = Array.isArray(s.channels) ? s.channels : [];
  const has = (k) => channels.find((c) => c.kind === k);
  if (s.envLocked)
    return readOnlyValue(
      s,
      "The environment sets GAFFER_NOTIFY, which always wins over settings.json.",
    );
  const desktop = el("input", { type: "checkbox", role: "switch", "aria-label": "Desktop banner" });
  desktop.checked = !!has("desktop");
  const desktopWord = el(
    "span",
    { class: "switch-word", "aria-hidden": "true" },
    desktop.checked ? "On" : "Off",
  );
  desktop.addEventListener("change", () => {
    desktopWord.textContent = desktop.checked ? "On" : "Off";
  });
  const urlRow = (kind, label, placeholder) => {
    const c = has(kind);
    let mode = "keep"; // keep | replace | remove
    const state = el(
      "span",
      {
        class: `setting-secret mono${c ? " is-set" : ""}`,
        "aria-label": c
          ? `${label} is set${c.host ? ` for ${c.host}` : ""}; the address is hidden.`
          : `${label} is not set.`,
      },
      c ? `•••••••• Set${c.host ? ` · ${c.host}` : ""}` : "Not set",
    );
    const input = el("input", {
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder,
      "aria-label": `New ${label}`,
      hidden: "",
    });
    const replace = button(c ? "Replace" : "Add", { kind: "ghost", size: "small" });
    const remove = c ? button("Remove", { kind: "ghost", size: "small" }) : null;
    replace.addEventListener("click", () => {
      mode = "replace";
      input.hidden = false;
      input.focus();
    });
    if (remove)
      remove.addEventListener("click", () => {
        mode = mode === "remove" ? "keep" : "remove";
        remove.textContent = mode === "remove" ? "Keep" : "Remove";
        state.classList.toggle("is-removing", mode === "remove");
        remove.dispatchEvent(new Event("change", { bubbles: true }));
      });
    return {
      node: el("div", { class: "setting-secret-row", dataset: { channel: kind } }, [
        el("span", { class: "secret-label" }, label),
        state,
        replace,
        remove,
        input,
      ]),
      change: () =>
        mode === "remove"
          ? null
          : mode === "replace" && input.value.trim() !== ""
            ? input.value.trim()
            : undefined,
      input,
    };
  };
  const hook = urlRow("webhook", "Webhook URL", "https://…");
  const slack = urlRow("slack", "Slack URL", "https://hooks.slack.com/…");
  const word = (c) => (c === undefined ? "~keep" : c === null ? "~remove" : c);
  const sig = () => JSON.stringify([desktop.checked, word(hook.change()), word(slack.change())]);
  const initial = sig();
  editors.set(s.key, {
    read: sig,
    initial,
    input: hook.input,
    notify: () => {
      const out = {};
      if (desktop.checked !== !!has("desktop")) out.desktop = desktop.checked;
      const w = hook.change();
      const k = slack.change();
      if (w !== undefined) out.webhook = w;
      if (k !== undefined) out.slack = k;
      return out;
    },
  });
  return el("div", { class: "setting-notify" }, [
    el("label", { class: "switch switch-worded" }, [
      desktop,
      el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
      desktopWord,
      el("span", { class: "switch-label" }, "Desktop banner"),
    ]),
    hook.node,
    slack.node,
    el(
      "p",
      { class: "setting-how dim" },
      "Saved addresses are never shown again (anyone holding one can post as the factory). Check delivery with gaffer wg notify test.",
    ),
  ]);
}

export { renderSettings, formationLaneRepos };
