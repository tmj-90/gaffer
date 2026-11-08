// View: Settings (UI-editable factory config, env-override semantics).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLockAll } from "../access.js";
import { api } from "../api.js";
import { emptyState, viewHead } from "../components.js";
import { clear, el, field } from "../dom.js";
import { plural } from "../format.js";
import { icon } from "../icons.js";
import { routeSignal, router } from "../router.js";
import { runAsyncAction, toast } from "../toast.js";
import {
  accessPanel,
  autonomyPoliciesPanel,
  autonomyRecommendationsPanel,
  renderIdleLoopsPanel,
} from "./autonomy.js";
import {
  autonomyPoliciesInert,
  inertPoliciesNote,
  isOnValue,
  teamInstructions,
  testingLaneOff,
} from "./formation.js";

// ===========================================================================
//  View: Create ticket
// ===========================================================================

// --- Settings (UI-editable factory config, env-override semantics) ----------
//
// GET /api/settings reports every known setting (file value + envLocked + group);
// the panel groups them into sections of toggles / number / text inputs.
// env-locked settings (set in the process env, which always wins over the file)
// render read-only with a "set by env" badge. Save POSTs the changed,
// non-locked values back and reflects the server's fresh state.

const SETTINGS_GROUPS = [
  {
    id: "autonomy",
    label: "Autonomy",
    note: "How much the factory may do without a human in the loop.",
  },
  {
    id: "delivery",
    label: "Delivery",
    note: "What happens once a ticket is approved — merge, push, PR, CI.",
  },
  {
    id: "execution",
    label: "Execution",
    note: "How the loop schedules and paces work — concurrency, cadence, ceilings.",
  },
  {
    id: "idle-loops",
    label: "Idle overrides",
    note: "Run-wide overrides for what the squad does between tickets. The per-lane switches live in Idle loops, further down.",
  },
  {
    id: "budget",
    label: "Budget & caps",
    note: "Hard limits on a run — ticks, timeouts, turns, retries, spend.",
  },
  {
    id: "planning-debate",
    label: "Planning debate",
    note: "Multi-model plan critique before decomposing.",
  },
  {
    id: "quality",
    label: "Quality gates",
    note: "The runner's definition-of-done guards on every delivery.",
  },
  {
    id: "sandbox",
    label: "Sandbox",
    note: "OS-level execution confinement: every agent runs inside it unless GAFFER_STRICT_REQUIRE=0 is set in the environment.",
  },
  {
    id: "notifications",
    label: "Notifications",
    note: "Opt-in pings when the factory needs a human.",
  },
];

async function renderSettings() {
  // Load the env-override settings plus the crew idle-loop config + the repos and
  // scope nodes the idle-loop target picker needs. Best-effort on the extras: a
  // failure there must not blank the whole Settings page.
  const signal = routeSignal();
  const get = (p) => api("GET", p, undefined, { signal });
  const [
    { settings, isolation },
    idleLoopsRes,
    reposRes,
    nodesRes,
    autonomyRecRes,
    autonomyPolRes,
    whoamiRes,
    principalsRes,
  ] = await Promise.all([
    get("/api/settings"),
    get("/api/idle-loops").catch(() => null),
    get("/repositories").catch(() => ({ repositories: [], unread: true })),
    get("/scope/nodes").catch(() => ({ nodes: [] })),
    // GRADUATED-AUTONOMY (Spec 2): advisory recommendations — best-effort, must never
    // blank the page if the endpoint is unavailable.
    get("/api/autonomy/recommendations").catch(() => null),
    // GRADUATED-AUTONOMY (Spec 2, Phase 3): the currently-enabled policies.
    get("/api/autonomy/policies").catch(() => null),
    // PER-PRINCIPAL CREDENTIALS: who this session is + the named credentials.
    get("/api/whoami").catch(() => null),
    get("/api/principals").catch(() => null),
  ]);
  const all = Array.isArray(settings) ? settings : [];
  const modeRow = all.find((x) => x.key === "GAFFER_MODE");
  settingsModeName = (modeRow && (modeRow.effective || modeRow.value)) || "supervised";
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

  const wrap = el("div", { class: "view settings-view" });
  const groupsUsed = SETTINGS_GROUPS.filter((g) => all.some((s) => s.group === g.id));
  const fromFile = all.filter((s) => s.source === "file").length;
  const locked = all.filter((s) => s.envLocked).length;

  // Standing note: edits land in settings.json; the runner reads it on its NEXT
  // tick, so nothing restarts live.
  const note = el("p", { class: "settings-note" }, [
    icon("clock", "settings-note-ico", 16),
    el("span", {}, "Changes apply on the next tick — no live restart."),
  ]);
  wrap.appendChild(
    viewHead(
      "The boot room",
      all.length
        ? `${plural(all.length, "setting")} in ${plural(groupsUsed.length, "group")} · ${fromFile} set in settings.json · ${locked} set by the environment`
        : null,
    ),
  );

  // Empty/abnormal state: the allow-list is static server-side, so an empty list
  // means the API answered oddly. Surface it rather than render a blank page.
  if (all.length === 0) {
    wrap.appendChild(note);
    wrap.appendChild(
      emptyState("No settings available", "The config API returned no known settings."),
    );
    return wrap;
  }

  // Two columns: a sticky index (search, sections, unsaved count) and the room.
  const main = el("div", { class: "boot-main" });
  const index = el("nav", { class: "boot-index", "aria-label": "Boot room sections" });
  const layout = el("div", { class: "boot-room" }, [index, main]);
  wrap.appendChild(layout);
  main.appendChild(note);

  // edit registry: key → { def, read() } for non-locked inputs, so Save collects
  // only the values the operator can actually change.
  const editors = new Map();
  // novalidate: Save checks every field itself and says which one is wrong (the
  // browser's own bubble blocked Save for every field and named none of them).
  const form = el("form", { class: "settings-form", id: "settings-form", novalidate: "" });

  for (const grp of SETTINGS_GROUPS) {
    const inGroup = all.filter((s) => s.group === grp.id);
    if (inGroup.length === 0) continue;
    // Each group folds (the room ran 12,000px): the first opens, the index jumps.
    const changed = inGroup.filter((x) => x.source === "file").length;
    const card = el("details", {
      class: "card settings-group",
      id: `grp-${grp.id}`,
      open: grp.id === SETTINGS_GROUPS[0].id ? "" : null,
    });
    card.appendChild(
      el("summary", { class: "panel-head" }, [
        el("h2", { class: "panel-title" }, grp.label),
        el(
          "span",
          { class: "panel-aux" },
          `${plural(inGroup.length, "setting")}${changed ? ` · ${changed} set in settings.json` : ""}`,
        ),
        el("span", { class: "grp-dirty", hidden: true }),
      ]),
    );
    card.appendChild(el("p", { class: "section-note" }, grp.note));
    if (grp.id === "sandbox") card.appendChild(isolationLine(isolation));
    const rows = el("div", { class: "settings-rows" });
    for (const s of inGroup) rows.appendChild(renderSettingRow(s, editors));
    card.appendChild(rows);
    form.appendChild(card);
  }
  const noMatch = el("p", { class: "boot-nomatch", hidden: true });
  form.appendChild(noMatch);

  // The headline: the team's instructions (GAFFER_MODE as a five-detent dial) and
  // the formation it plays (who takes each gate on a delivery's way to main).
  const instructions = teamInstructions(all, editors, autonomyPolicies);
  main.appendChild(instructions.node);

  // GRADUATED-AUTONOMY (Spec 2, Phase 3): the currently-enabled policies, each with a
  // one-click reversible OFF, above the suggestions so the active posture comes first.
  // B17: those policies are consulted ONLY by the agent review pass. Under
  // REVIEW_MODE=human (supervised, the default) no reviewer agent runs, so an enabled
  // grant showed "Enabled" here and never acted. Say so wherever a grant is shown.
  const inertCount = autonomyPoliciesInert(autonomyPolicies, all);
  if (inertCount > 0) main.appendChild(inertPoliciesNote(inertCount));
  const polPanel = autonomyPoliciesPanel(autonomyPolicies, { inert: inertCount > 0 });
  if (polPanel) {
    polPanel.id = "autonomy-policies";
    main.appendChild(polPanel);
  }
  // GRADUATED-AUTONOMY (Spec 2, Phase 3): advisory recommendations backed by the review
  // track record — each is an ENABLE action (evidence + explicit confirm → POST).
  const recPanel = autonomyRecommendationsPanel(autonomyRecs, autonomyPolicies, {
    inert: inertCount > 0,
  });
  if (recPanel) {
    recPanel.id = "autonomy-recs";
    main.appendChild(recPanel);
  }

  main.appendChild(form);

  // Crew idle-loop scan loops — enable + repo/scope scoping. These live in
  // crew.yaml (not settings.json), so they save through their own endpoint.
  if (idleLoops) {
    const loops = renderIdleLoopsPanel(idleLoops, repos, nodes, all);
    const fold = el("details", { class: "boot-fold", id: "idle-loops" }, [
      el("summary", {}, [
        el("span", { class: "boot-fold-t" }, "Idle loops"),
        el(
          "span",
          { class: "panel-aux" },
          "what the squad does when no ticket is ready · crew.yaml",
        ),
      ]),
      loops,
    ]);
    main.appendChild(fold);
  }

  // PER-PRINCIPAL CREDENTIALS: who is signed in, the named credentials, mint/revoke.
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
  // Which switches differ from what was loaded (the same test Save uses).
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
    // Nothing to save, nothing to press: the primary waits for a change.
    saveBtn.disabled = n === 0;
    saveBar.classList.toggle("is-clean", n === 0);
    idxDirty.textContent = n ? String(n) : "none";
    idxDirty.className = n ? "nav-count urgent" : "boot-n";
    const dirty = new Set(keys);
    for (const [key, ed] of editors)
      if (ed.row) ed.row.classList.toggle("is-dirty", dirty.has(key));
    for (const g of form.querySelectorAll(".settings-group")) {
      const c = g.querySelectorAll(".setting-row.is-dirty").length;
      const tag = g.querySelector(".grp-dirty");
      tag.hidden = !c;
      tag.textContent = c ? `${c} unsaved` : "";
      const link = index.querySelector(`a[href="#${g.id}"] .boot-n`);
      if (link) link.classList.toggle("is-dirty", c > 0);
    }
    instructions.sync();
  };
  form.addEventListener("input", paintDirty);
  form.addEventListener("change", paintDirty);
  instructions.onPick = paintDirty;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // Collect only editable (non-locked) values the user actually CHANGED. Sending
    // every editor used to persist an explicit "0" for each untouched switch, which
    // then out-ranked the GAFFER_MODE presets in the runner (a save silently turned
    // autonomy off). The server is the final gate: it re-checks env-lock and drops
    // unknown keys, so this is just the payload.
    const payload = {};
    for (const [key, ed] of editors) {
      const v = ed.read();
      if (ed.initial === undefined || v !== ed.initial) payload[key] = v;
    }
    // A value the server would refuse is shown on its own row, and Save says which
    // field holds it back; nothing is posted until it is fixed (or put back).
    const bad = [];
    const markBad = (key, problem) => {
      const ed = editors.get(key);
      const label = labelOf.get(key) || key;
      bad.push(`${label} ${problem}`);
      if (!ed) return;
      if (ed.input) ed.input.setAttribute("aria-invalid", "true");
      if (ed.row) {
        const ctl = ed.row.querySelector(".setting-control") || ed.row;
        ctl.appendChild(
          el("p", { class: "form-error setting-error", role: "alert" }, `${label} ${problem}.`),
        );
        const grp = ed.row.closest("details");
        if (grp) grp.open = true;
      }
    };
    const focusFirstBad = () => {
      const first = [...editors.values()].find(
        (ed) => ed.input && ed.input.getAttribute("aria-invalid") === "true",
      );
      if (first) first.input.focus();
    };
    for (const [key, ed] of editors) {
      if (ed.row) for (const old of ed.row.querySelectorAll(".setting-error")) old.remove();
      if (ed.input) ed.input.removeAttribute("aria-invalid");
      const problem = key in payload && ed.check ? ed.check() : null;
      if (problem) markBad(key, problem);
    }
    if (bad.length) {
      toast(`Not saved: ${bad.join("; ")}.`, {});
      focusFirstBad();
      return;
    }
    // A submit is the intent (the primary only rests disabled while clean).
    saveBtn.disabled = false;
    runAsyncAction(saveBtn, "Saving…", async () => {
      let res;
      try {
        res = await api("POST", "/api/settings", { settings: payload });
      } catch (err) {
        // A value only the server can judge (a webhook address, a choice it no longer
        // lists): the 422 names each field, so mark them on their rows like the rest.
        const invalid = err && err.details && err.details.invalid;
        if (Array.isArray(invalid) && invalid.length) {
          for (const p of invalid) if (p && p.key) markBad(p.key, p.problem || "is not valid");
          focusFirstBad();
        }
        throw err;
      }
      const written = (res.written || []).length;
      const rejected = (res.rejected || []).length;
      const invalid = (res.invalid || []).length;
      const skips = [
        rejected ? `${rejected} skipped (set by env)` : null,
        invalid ? `${invalid} rejected (invalid value)` : null,
      ].filter(Boolean);
      toast(
        skips.length
          ? `Saved ${written} setting${written === 1 ? "" : "s"} — ${skips.join(", ")}.`
          : `Saved ${written} setting${written === 1 ? "" : "s"}.`,
        { ok: !invalid },
      );
      // Re-render from the server's fresh state so values + locks reflect reality.
      router();
    });
  });

  // The index: find a setting by name, key or help; jump to any section.
  const findCount = el("span", { class: "boot-find-n", role: "status" });
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
      for (const g of form.querySelectorAll(".settings-group")) {
        g.hidden = !!q && !g.querySelector(".setting-row:not([hidden])");
        if (q && !g.hidden) g.open = true;
      }
      findCount.textContent = q ? `${plural(shown, "match", "matches")}` : "";
      noMatch.hidden = !q || shown > 0;
      // While finding, the rows are the page: the panels above step aside.
      main.classList.toggle("is-finding", !!q);
      noMatch.textContent = q && !shown ? `No setting matches “${e.target.value.trim()}”.` : "";
    },
  });
  const link = (id, label, n) =>
    el("a", { href: `#${id}` }, [
      el("span", {}, label),
      n != null ? el("span", { class: "boot-n" }, String(n)) : null,
    ]);
  // The section links. On a phone they fold behind one line (the find box stays
  // open), so the room starts with the team instructions, not a wall of links.
  const phone =
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const sections = el("details", { class: "boot-sections", open: phone ? null : "" }, [
    el("summary", {}, [
      "Jump to a section",
      el(
        "span",
        { class: "boot-n" },
        String(groupsUsed.length + 2 + [polPanel, recPanel, idleLoops].filter(Boolean).length),
      ),
    ]),
    el("ul", { class: "boot-links" }, [
      el("li", {}, link("instructions", "Team instructions")),
      polPanel ? el("li", {}, link(polPanel.id, "Active autonomy")) : null,
      recPanel ? el("li", {}, link(recPanel.id, "Suggested autonomy")) : null,
      ...groupsUsed.map((g) =>
        el("li", {}, link(`grp-${g.id}`, g.label, all.filter((x) => x.group === g.id).length)),
      ),
      idleLoops ? el("li", {}, link("idle-loops", "Idle loops")) : null,
      el("li", {}, link("access", "Access")),
    ]),
  ]);
  sections.addEventListener("click", (e) => {
    // Picking a section on a phone folds the list away again.
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
 * One setting row: a label + help on the left, a control on the right. Locked
 * settings render their value read-only with a "set by env" badge; editable ones
 * get a toggle (boolean), number input (int) or text input (csv/string), and
 * register a reader into `editors` so Save can collect the value.
 */
/** A setting's help: the first sentence, the rest folded behind "More" (pages ran 12,000px). */
/**
 * The agent isolation posture as one read-only line in the Sandbox group (GET
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
      "Opted out: GAFFER_STRICT_REQUIRE=0 is set in the environment, so agents run without an OS sandbox.";
  else if (iso.available) text += "Required: every agent runs inside it.";
  else text += "Required: live runs refuse to launch agents until it is fixed.";
  if (!iso.available && iso.fix) text += ` Fix: ${iso.fix}.`;
  return el(
    "p",
    { class: "section-note settings-isolation", "data-state": state, role: "status" },
    text,
  );
}

function settingHelp(text) {
  const t = String(text);
  const m = t.match(/^(.{40,180}?[.!?])\s+(.+)$/s);
  if (!m) return el("p", { class: "setting-help dim" }, t);
  return el("div", { class: "setting-help dim" }, [
    el("p", {}, m[1]),
    el("details", { class: "setting-more" }, [el("summary", {}, "More"), el("p", {}, m[2])]),
  ]);
}
function renderSettingRow(s, editors) {
  const mode = settingsModeName;
  const src =
    s.source === "file"
      ? "set in settings.json"
      : s.source === "mode"
        ? `from the ${mode || "supervised"} mode`
        : s.source === "env"
          ? null
          : "default";
  const meta = el("div", { class: "setting-meta" }, [
    el("div", { class: "setting-label" }, [
      el("span", {}, s.label || s.key),
      s.envLocked
        ? el("span", { class: "badge env-locked no-dot" }, [
            icon("lock", "lock-ico", 12),
            "set by env",
          ])
        : null,
    ]),
    el("div", { class: "setting-id" }, [
      el("code", { class: "mono setting-key" }, s.key),
      src ? el("span", { class: `setting-src src-${s.source}` }, src) : null,
      el("span", { class: "setting-unsaved" }, "unsaved"),
    ]),
    s.help ? settingHelp(s.help) : null,
  ]);

  const control = el("div", { class: "setting-control" }, renderSettingInput(s, editors));

  const row = el(
    "div",
    {
      class: `setting-row${s.envLocked ? " is-locked" : ""}`,
      id: `set-${s.key}`,
      dataset: { find: `${s.label || ""} ${s.key} ${s.help || ""}`.toLowerCase() },
    },
    [meta, control],
  );
  const ed = editors.get(s.key);
  if (ed) ed.row = row;
  return row;
}

/** The mode the settings on screen were read under (for "from the graduated mode"). */
let settingsModeName = "";

/** Sentinel an untouched secret editor reads as (never sent: it equals `initial`). */
const SECRET_UNCHANGED = "\u0000unchanged";

/**
 * A SECRET-BEARING setting (a webhook URL is posting authority): the server never sends
 * its value, only whether it is set and its host. Show that, masked, with Replace (a new
 * value is typed in, never the old one shown) and Remove. Untouched, the editor reads as
 * the sentinel and nothing is sent.
 */
function renderSecretSettingInput(s, editors) {
  const state = s.configured ? `Set${s.host ? ` · ${s.host}` : ""}` : "Not set";
  const masked = el(
    "span",
    {
      class: `setting-secret mono${s.configured ? " is-set" : ""}`,
      "aria-label": s.configured
        ? `${s.label} is set${s.host ? ` for ${s.host}` : ""}; the value is hidden.`
        : `${s.label} is not set.`,
    },
    [s.configured ? "•••••••• " : "", state],
  );
  if (s.envLocked) return el("div", { class: "setting-secret-row" }, [masked]);
  let mode = "keep"; // keep | replace | remove
  const input = el("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Paste the new URL",
    "aria-label": `New value for ${s.label}`,
    hidden: "",
  });
  const replace = el("button", { type: "button", class: "btn small ghost" }, "Replace");
  const remove = s.configured
    ? el("button", { type: "button", class: "btn small ghost" }, "Remove")
    : null;
  replace.addEventListener("click", () => {
    mode = "replace";
    input.hidden = false;
    input.focus();
  });
  if (remove)
    remove.addEventListener("click", () => {
      mode = mode === "remove" ? "keep" : "remove";
      remove.textContent = mode === "remove" ? "Keep" : "Remove";
      masked.classList.toggle("is-removing", mode === "remove");
      remove.dispatchEvent(new Event("change", { bubbles: true }));
    });
  editors.set(s.key, {
    read: () =>
      mode === "remove"
        ? ""
        : mode === "replace" && input.value.trim() !== ""
          ? input.value.trim()
          : SECRET_UNCHANGED,
    initial: SECRET_UNCHANGED,
    input,
  });
  return el("div", { class: "setting-secret-row" }, [masked, replace, remove, input]);
}

/**
 * Why `value` cannot be saved for setting `s`, or null when it can: the same rules
 * POST /api/settings applies (api/settings.ts settingValueProblem), so Save can say
 * which field is wrong instead of posting a value the server refuses. Empty clears.
 */
function settingValueProblem(s, value) {
  if (value === "") return null;
  if (s.type === "int") {
    const min = s.min || 0;
    if (!/^\d+$/.test(value) || Number(value) < min)
      return min > 0 ? `must be a whole number of ${min} or more` : "must be a whole number";
  }
  if (s.type === "number" && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    return "must be a number of 0 or more, such as 5 or 2.50";
  return null;
}

/** Build the right-hand control for a setting (or a read-only value when locked). */
function renderSettingInput(s, editors) {
  if (s.secret) return renderSecretSettingInput(s, editors);
  if (s.envLocked) {
    // Read-only: show the env-driven value if known, else a muted placeholder.
    // The actual env value isn't exposed by the API (it could be a secret), so we
    // only confirm it's locked; the file value (if any) is shown for context.
    const shown = s.value !== "" ? s.value : "—";
    return el("input", {
      type: "text",
      class: "setting-locked-input",
      value: shown,
      readonly: "",
      disabled: "",
      "aria-label": `${s.label} (read-only, set by env)`,
    });
  }

  if (s.type === "boolean") {
    // Show the value the factory will USE (env → file → GAFFER_MODE preset), not
    // only what settings.json stores; an autonomous mode's presets read as on.
    const eff = s.effective !== undefined ? s.effective : s.value;
    const checked = eff === "1" || eff === "true" || eff === "yes" || eff === "on";
    // The tester lane's default is neither on nor off: unset (or "auto") runs the tester
    // where a test command is registered. The switch says Auto until it is moved; moving
    // it writes an explicit on or off (testingLaneOff below reads the same values).
    const auto =
      s.key === "GAFFER_TESTING" && !checked && !testingLaneOff(eff) && !isOnValue(s.value);
    let touched = false;
    const input = el("input", { type: "checkbox", role: "switch", "aria-label": s.label });
    input.checked = checked;
    // `initial` lets Save send only what the user changed: an untouched switch
    // that merely reflects a mode preset must not be written as an explicit "0".
    editors.set(s.key, {
      read: () => (input.checked ? "1" : auto && !touched ? "" : "0"),
      initial: checked ? "1" : auto ? "" : "0",
    });
    const wordFor = () => (input.checked ? "On" : auto && !touched ? "Auto" : "Off");
    const word = el("span", { class: "switch-word", "aria-hidden": "true" }, wordFor());
    input.addEventListener("change", () => {
      touched = true;
      word.textContent = wordFor();
    });
    return el("label", { class: "switch switch-worded" }, [
      input,
      el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
      word,
    ]);
  }

  if (s.type === "int") {
    const input = el("input", {
      type: "number",
      inputmode: "numeric",
      step: "1",
      min: String(s.min || 0),
      value: s.value,
      placeholder: s.effective && s.effective !== s.value ? s.effective : "default",
      "aria-label": s.label,
    });
    editors.set(s.key, {
      read: () => input.value.trim(),
      initial: s.value,
      input,
      // A number box reads "" for text it cannot parse ("1e", "--"): that is not a clear.
      check: () =>
        input.validity && input.validity.badInput
          ? settingValueProblem(s, "x")
          : settingValueProblem(s, input.value.trim()),
    });
    return input;
  }

  // A dollar figure: a text box (so what was typed is what is checked, never a
  // browser-sanitised "") with the decimal keypad, checked like the server checks it.
  if (s.type === "number") {
    const input = el("input", {
      type: "text",
      inputmode: "decimal",
      value: s.value,
      placeholder: s.effective && s.effective !== s.value ? s.effective : "default",
      "aria-label": s.label,
    });
    editors.set(s.key, {
      read: () => input.value.trim(),
      initial: s.value,
      input,
      check: () => settingValueProblem(s, input.value.trim()),
    });
    return input;
  }

  // Enum string → a dropdown of the allowed choices. A leading empty option
  // clears the override back to the built-in default.
  if (Array.isArray(s.choices) && s.choices.length > 0) {
    const select = el("select", { class: "setting-select", "aria-label": s.label });
    const optDefault = el("option", { value: "" }, "— default —");
    if (s.value === "") optDefault.selected = true;
    select.appendChild(optDefault);
    for (const choice of s.choices) {
      const opt = el("option", { value: choice }, choice);
      if (s.value === choice) opt.selected = true;
      select.appendChild(opt);
    }
    editors.set(s.key, { read: () => select.value, initial: s.value });
    return select;
  }

  // csv / free string → a plain text input.
  const input = el("input", {
    type: "text",
    value: s.value,
    // The same "default" placeholder every blank control shows (a sample list
    // read like a real value); a list says how to write it.
    placeholder:
      s.effective && s.effective !== s.value
        ? s.effective
        : s.type === "csv"
          ? "default · comma-separated"
          : "default",
    "aria-label": s.label,
  });
  // `initial` makes a text edit count as unsaved (and an untouched one stay out of
  // the payload), the same as every other control.
  editors.set(s.key, { read: () => input.value.trim(), initial: s.value });
  return input;
}

export { renderSettings, formationLaneRepos };
