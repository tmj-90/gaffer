// Settings: the formation, modes, gates, go / no-go and team instructions.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { panelHead } from "../components.js";
import { clear, el, svgEl } from "../dom.js";
import { moneyW, plural } from "../format.js";
import { agentShirt, glyph, icon, ycard } from "../icons.js";
import { router } from "../router.js";
import { runAsyncAction, toast } from "../toast.js";
import { formationLaneRepos } from "./settings.js";

/**
 * The autonomy posture each GAFFER_MODE implies: a MIRROR of MODE_PRESETS in
 * src/api/settings.ts (itself a mirror of runner/factory.config.sh). A value in
 * settings.json or the environment wins over the mode, as on the server.
 */
const MODE_PRESETS = {
  supervised: {
    REVIEW_MODE: "human",
    DISPATCH_ALLOW_AGENT_APPROVE: "0",
    MERGE_ON_AGENT_REVIEW: "0",
    AUTO_MERGE: "0",
    GAFFER_AUTO_PUSH: "0",
    MEMORY_AUTO_APPROVE: "0",
  },
  lite: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "1",
    MERGE_ON_AGENT_REVIEW: "0",
    AUTO_MERGE: "0",
    GAFFER_AUTO_PUSH: "0",
    MEMORY_AUTO_APPROVE: "0",
  },
  graduated: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "0",
    MERGE_ON_AGENT_REVIEW: "0",
    AUTO_MERGE: "0",
    GAFFER_AUTO_PUSH: "0",
    MEMORY_AUTO_APPROVE: "0",
  },
  autonomous: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "1",
    MERGE_ON_AGENT_REVIEW: "1",
    AUTO_MERGE: "1",
    GAFFER_AUTO_PUSH: "1",
    MEMORY_AUTO_APPROVE: "1",
  },
  strict: {
    REVIEW_MODE: "agent",
    DISPATCH_ALLOW_AGENT_APPROVE: "1",
    MERGE_ON_AGENT_REVIEW: "1",
    AUTO_MERGE: "1",
    GAFFER_AUTO_PUSH: "1",
    MEMORY_AUTO_APPROVE: "1",
  },
};
/** The dial's detents, least to most autonomy (the server's own order). */
const MODE_DETENTS = [
  { mode: "supervised", name: "Supervised", line: "You sign off every merge." },
  { mode: "lite", name: "Lite", line: "Agents approve the trivial ones; you still merge." },
  {
    mode: "graduated",
    name: "Graduated",
    line: "Each repo ships what it has earned; the rest waits for you.",
  },
  { mode: "autonomous", name: "Autonomous", line: "Agents approve, merge and push." },
  { mode: "strict", name: "Strict", line: "Autonomous, inside an OS sandbox." },
];

const isOnValue = (v) => v === true || v === "true" || v === "1" || v === "on" || v === "yes";
/**
 * The tester lane's setting (GAFFER_TESTING): unset, empty or "auto" is the adaptive
 * default (on for a repo with a registered test command, off elsewhere), any other value
 * not on is off.
 */
const testingLaneOff = (v) => {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s !== "" && s !== "auto" && !isOnValue(s);
};
/** Under `v`, does the independent tester run nowhere: off, or `auto` with no test command anywhere? */
const testingPlaysNowhere = (v) =>
  testingLaneOff(v) ||
  (!isOnValue(v) && formationLaneRepos !== null && formationLaneRepos.withTest === 0);

/**
 * The value each key would take under `mode`, given what is saved and what the
 * operator has changed on this page but not saved: env → pending edit → file →
 * the mode's preset → default. Returns { value, from } per key.
 */
function postureFor(all, editors, mode) {
  const presets = MODE_PRESETS[mode] || MODE_PRESETS.supervised;
  const out = {};
  for (const s of all) {
    const ed = editors.get(s.key);
    const pending = ed && ed.initial !== undefined && ed.read() !== ed.initial;
    if (s.envLocked) out[s.key] = { value: s.effective ?? s.value ?? "", from: "env" };
    else if (pending && s.key !== "GAFFER_MODE") out[s.key] = { value: ed.read(), from: "edit" };
    else if (s.value !== "" && s.value != null) out[s.key] = { value: s.value, from: "file" };
    else if (presets[s.key] !== undefined) out[s.key] = { value: presets[s.key], from: "mode" };
    else out[s.key] = { value: "", from: "default" };
  }
  return out;
}

/**
 * The gates a delivery passes on its way to main, left to right like the tactics
 * board: who plays each one under a posture. "squad" = an agent does it, "you" =
 * the gaffer makes the call, "both" = the squad reviews and you still sign,
 * "none" = nobody plays it (no independent tester).
 */
const FORMATION_GATES = [
  {
    id: "testing",
    label: "Testing",
    key: "GAFFER_TESTING",
    who: (p) => (testingPlaysNowhere(p.GAFFER_TESTING?.value) ? "none" : "squad"),
  },
  {
    id: "review",
    label: "Review",
    key: "REVIEW_MODE",
    who: (p) => {
      const v = String(p.REVIEW_MODE?.value || "human");
      return v === "agent" ? "squad" : v === "both" ? "both" : "you";
    },
  },
  {
    id: "approve",
    label: "Approve",
    key: "DISPATCH_ALLOW_AGENT_APPROVE",
    who: (p) => (isOnValue(p.DISPATCH_ALLOW_AGENT_APPROVE?.value) ? "squad" : "you"),
  },
  {
    id: "merge",
    label: "Merge",
    key: "AUTO_MERGE",
    who: (p) =>
      isOnValue(p.AUTO_MERGE?.value) || isOnValue(p.MERGE_ON_AGENT_REVIEW?.value) ? "squad" : "you",
  },
  {
    id: "push",
    label: "Push",
    key: "GAFFER_AUTO_PUSH",
    who: (p) => (isOnValue(p.GAFFER_AUTO_PUSH?.value) ? "squad" : "you"),
  },
  {
    id: "lore",
    label: "Lore",
    key: "MEMORY_AUTO_APPROVE",
    who: (p) => (isOnValue(p.MEMORY_AUTO_APPROVE?.value) ? "squad" : "you"),
  },
];
const WHO_WORDS = {
  squad: "the squad",
  you: "you",
  both: "squad, then you",
  none: "not played",
};
/** The autonomy-policy gate behind a formation position (per-repo × risk grants). */
const FORMATION_POLICY_GATE = { approve: "approve", merge: "merge", lore: "memory" };
/** Enabled auto grants for a formation position (0 when it has none or no policy gate). */
function formationGrants(policies, gateId, posture) {
  const gate = FORMATION_POLICY_GATE[gateId];
  if (!gate || !Array.isArray(policies)) return 0;
  // Grants are read only by the agent review pass: with review human they are inert.
  if (posture && String(posture.REVIEW_MODE?.value || "human") === "human") return 0;
  return policies.filter((p) => p && p.gate === gate && p.mode === "auto").length;
}

/**
 * Go/No-Go before raising the dial: checks read from the posture the new mode
 * would run with. They advise; Save still applies the mode.
 */
function goNoGo(posture, mode, policies) {
  const v = (k) => (posture[k] ? posture[k].value : "");
  const checks = [
    {
      key: "GAFFER_TESTING",
      ok: !testingPlaysNowhere(v("GAFFER_TESTING")),
      go: isOnValue(v("GAFFER_TESTING"))
        ? "An independent tester checks every delivery."
        : "An independent tester checks each delivery in a repo with a registered test command.",
      nogo: testingLaneOff(v("GAFFER_TESTING"))
        ? "No independent tester: the squad marks its own work."
        : "No repository has a registered test command, so by default the independent tester runs nowhere: the squad marks its own work.",
    },
    {
      key: "GAFFER_DAILY_BUDGET_USD",
      ok: Number(v("GAFFER_DAILY_BUDGET_USD")) > 0,
      go: `A daily budget caps the wage bill (${moneyW(Number(v("GAFFER_DAILY_BUDGET_USD")))} a day).`,
      nogo: "No daily budget: nothing caps the wage bill.",
    },
    {
      key: "GAFFER_REQUIRE_CI",
      ok: isOnValue(v("GAFFER_REQUIRE_CI")),
      go: "CI must be green before review.",
      nogo: "CI is not required before review.",
    },
  ];
  if (mode === "lite" || mode === "strict") {
    const p = v("SANDBOX_PROVIDER");
    checks.push({
      key: "SANDBOX_PROVIDER",
      ok: p === "docker" || p === "sandbox-exec",
      go: `The squad runs inside an OS sandbox (${p}).`,
      nogo: `No OS sandbox is chosen: ${mode} needs one.`,
    });
  }
  if (mode === "graduated") {
    const n = (policies || []).filter((x) => x.mode === "auto").length;
    checks.push({
      key: null,
      href: "#autonomy-recs",
      ok: n > 0,
      go: `${plural(n, "repo grant")} let the squad ship what it has earned.`,
      nogo: "No repo has earned a grant yet, so graduated holds every ticket for you.",
    });
  }
  return checks;
}

/**
 * Team instructions: GAFFER_MODE as a five-detent dial, the formation it plays
 * (a pitch where each gate is a position: a claret shirt where the squad plays
 * it, a yellow card where the gaffer makes the call), what moving the dial would
 * change, and the Go/No-Go checks before raising it. The dial drives the
 * GAFFER_MODE select in the form, so it saves (and counts as unsaved) with the rest.
 */
function teamInstructions(all, editors, policies) {
  const modeSetting = all.find((s) => s.key === "GAFFER_MODE");
  const modeEd = editors.get("GAFFER_MODE");
  const modeSelect = modeEd && modeEd.row ? modeEd.row.querySelector("select") : null;
  const savedMode = String((modeSetting && (modeSetting.effective || modeSetting.value)) || "");
  const current = MODE_PRESETS[savedMode] ? savedMode : "supervised";
  const lockedMode = !!(modeSetting && modeSetting.envLocked);
  const rank = (m) => MODE_DETENTS.findIndex((d) => d.mode === m);
  const picked = () => {
    const v = modeSelect ? modeSelect.value : savedMode;
    return MODE_PRESETS[v] ? v : "supervised";
  };

  const head = el("div", { class: "ti-head" });
  const dial = el("fieldset", { class: "dial", disabled: lockedMode ? "" : null }, [
    el("legend", { class: "sr-only" }, "Autonomy mode"),
  ]);
  const radios = [];
  for (const d of MODE_DETENTS) {
    const input = el("input", {
      type: "radio",
      name: "mode-dial",
      value: d.mode,
      class: "dial-input",
    });
    input.checked = d.mode === current;
    input.addEventListener("change", () => {
      if (!input.checked || !modeSelect) return;
      // Choosing the saved mode again restores the stored value (no false "unsaved").
      modeSelect.value = d.mode === current ? modeEd.initial : d.mode;
      modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof api_.onPick === "function") api_.onPick();
    });
    radios.push(input);
    dial.appendChild(
      el("label", { class: "dial-stop", dataset: { mode: d.mode } }, [
        input,
        el("span", { class: "dial-notch", "aria-hidden": "true" }),
        el("span", { class: "dial-name" }, d.name),
        el("span", { class: "dial-line" }, d.line),
        d.mode === current ? el("span", { class: "dial-now" }, "Now") : null,
      ]),
    );
  }
  const board = el("div", { class: "formation-board" });
  const changes = el("div", { class: "ti-changes", "aria-live": "polite" });
  const node = el(
    "section",
    { class: "card boot-page instructions", id: "instructions", "aria-label": "Team instructions" },
    [
      panelHead("Team instructions", null, null, { kit: "claret" }),
      head,
      dial,
      board,
      changes,
      el("p", { class: "ti-foot" }, [
        lockedMode
          ? "The mode is set by the environment, so the dial is locked here. "
          : "The dial is the Autonomy mode setting below and saves with the rest of the room. ",
        "A switch you set yourself always beats the mode. ",
        el("a", { href: "#set-GAFFER_MODE" }, "Autonomy mode"),
      ]),
    ],
  );

  const drawFormation = (now, next) => {
    clear(board);
    const W = 1000;
    const H = 220;
    board.appendChild(
      svgEl(
        "svg",
        {
          viewBox: `0 0 ${W} ${H}`,
          class: "formation-pitch",
          preserveAspectRatio: "none",
          "aria-hidden": "true",
          focusable: "false",
        },
        [
          svgEl("rect", { x: 0, y: 0, width: W, height: H, class: "fp-grass" }),
          ...Array.from({ length: 6 }, (_, i) =>
            svgEl("rect", { x: (i * W) / 6, y: 0, width: W / 12, height: H, class: "fp-mow" }),
          ),
          svgEl("rect", { x: 10, y: 10, width: W - 20, height: H - 20, class: "fp-line" }),
          svgEl("line", { x1: W / 2, y1: 10, x2: W / 2, y2: H - 10, class: "fp-line" }),
          svgEl("circle", { cx: W / 2, cy: H / 2, r: 46, class: "fp-line" }),
          svgEl("rect", { x: 10, y: H / 2 - 56, width: 70, height: 112, class: "fp-line" }),
          svgEl("rect", { x: W - 80, y: H / 2 - 56, width: 70, height: 112, class: "fp-line" }),
        ],
      ),
    );
    const step = 80 / (FORMATION_GATES.length - 1);
    board.appendChild(
      el(
        "ol",
        { class: "formation-pos", "aria-label": "Who plays each gate" },
        FORMATION_GATES.map((g, i) => {
          const a = g.who(now);
          const b = g.who(next);
          const moving = a !== b;
          // A position the gaffer holds can still be played by the squad where a
          // per-repo grant says so (risk=low on one repo, say): show the grants,
          // since "you" alone would misstate who acts.
          const grants = b === "you" ? formationGrants(policies, g.id, next) : 0;
          const words = (who) =>
            who === "you" && grants
              ? `you · ${plural(grants, "grant")} to the squad`
              : WHO_WORDS[who];
          const mark = (who) =>
            who === "squad"
              ? agentShirt("squad", 44)
              : who === "both"
                ? el("span", { class: "fp-pair" }, [agentShirt("squad", 40), ycard(32, "fp-card")])
                : who === "you" && grants
                  ? el("span", { class: "fp-pair is-grant" }, [
                      ycard(32, "fp-card"),
                      agentShirt("squad", 34),
                    ])
                  : who === "you"
                    ? ycard(36, "fp-card")
                    : el("span", { class: "fp-empty", "aria-hidden": "true" });
          return el("li", { style: { "--x": `${10 + step * i}%` } }, [
            el(
              "a",
              {
                class: `fp-spot who-${b}${grants ? " has-grants" : ""}${moving ? " is-moving" : ""}`,
                href: grants ? "#autonomy-policies" : `#set-${g.key}`,
                "aria-label": `${g.label}: ${words(b)}${moving ? ` after save (now ${WHO_WORDS[a]})` : ""}`,
              },
              [
                mark(b),
                el("span", { class: "fp-label" }, g.label),
                el("span", { class: "fp-who" }, moving ? `→ ${words(b)}` : words(b)),
              ],
            ),
          ]);
        }),
      ),
    );
  };

  const api_ = {
    node,
    onPick: null,
    sync() {
      const next = picked();
      for (const r of radios) r.checked = r.value === next;
      for (const lab of dial.querySelectorAll(".dial-stop"))
        lab.classList.toggle("is-picked", lab.dataset.mode === next);
      const now = postureFor(all, new Map(), current);
      const after = postureFor(all, editors, next);
      const squadCount = (p) => FORMATION_GATES.filter((g) => g.who(p) === "squad").length;
      clear(head);
      const d = MODE_DETENTS[rank(next)];
      head.append(
        el("p", { class: "ti-lede" }, [
          el("strong", {}, next === current ? `${d.name}.` : `${d.name}, once you save.`),
          ` The squad plays ${squadCount(after)} of ${FORMATION_GATES.length} positions on its own; `,
          `you make the call on ${FORMATION_GATES.filter((g) => ["you", "both"].includes(g.who(after))).length}`,
          (() => {
            const granted = FORMATION_GATES.filter(
              (g) => g.who(after) === "you" && formationGrants(policies, g.id, after),
            );
            if (!granted.length) return ".";
            const n = granted.reduce((t, g) => t + formationGrants(policies, g.id, after), 0);
            return `, though ${plural(n, "per-repo grant")} hand${n === 1 ? "s" : ""} ${granted
              .map((g) => g.label.toLowerCase())
              .join(" and ")} to the squad on the repos and risks they name.`;
          })(),
        ]),
      );
      drawFormation(now, after);
      clear(changes);
      if (next === current) return;
      // What moving the dial changes, key by key, and what it cannot change.
      const rows = Object.keys(MODE_PRESETS.supervised).map((k) => {
        const s = all.find((x) => x.key === k);
        const a = now[k];
        const b = after[k];
        const same = String(a.value) === String(b.value);
        const show = (v) =>
          s && s.type === "boolean" ? (isOnValue(v.value) ? "On" : "Off") : v.value || "default";
        return el("tr", { class: same ? "is-same" : "is-change" }, [
          el("th", { scope: "row" }, el("a", { href: `#set-${k}` }, (s && s.label) || k)),
          el("td", {}, show(a)),
          el("td", {}, [
            show(b),
            b.from === "file" || b.from === "env" || b.from === "edit"
              ? el(
                  "span",
                  { class: "ti-kept" },
                  b.from === "env"
                    ? " · set by the environment"
                    : b.from === "edit"
                      ? " · your unsaved edit"
                      : " · kept from settings.json",
                )
              : null,
          ]),
        ]);
      });
      changes.appendChild(
        el("table", { class: "ti-table" }, [
          el("caption", {}, `Moving from ${MODE_DETENTS[rank(current)].name} to ${d.name}`),
          el("thead", {}, [
            el("tr", {}, [
              el("th", { scope: "col" }, "Switch"),
              el("th", { scope: "col" }, "Now"),
              el("th", { scope: "col" }, "After save"),
            ]),
          ]),
          el("tbody", {}, rows),
        ]),
      );
      if (rank(next) > rank(current)) {
        const checks = goNoGo(after, next, policies);
        const go = checks.filter((c) => c.ok).length;
        changes.appendChild(
          el("div", { class: "gng" }, [
            el("h3", { class: "gng-title" }, [
              "Go / No-Go",
              el("span", { class: "gng-n" }, `${go} of ${checks.length} go`),
            ]),
            el(
              "ul",
              { class: "gng-list" },
              checks.map((c) =>
                el("li", { class: c.ok ? "is-go" : "is-nogo" }, [
                  glyph(c.ok ? "done" : "failed", 18),
                  el("span", { class: "gng-word" }, c.ok ? "Go" : "No-go"),
                  el("span", { class: "gng-text" }, [
                    c.ok ? c.go : c.nogo,
                    " ",
                    el("a", { href: c.href || `#set-${c.key}` }, c.ok ? "See it" : "Fix it"),
                  ]),
                ]),
              ),
            ),
            el(
              "p",
              { class: "gng-note" },
              "These checks advise; Save still applies the mode. Read them before you raise it.",
            ),
          ]),
        );
      }
    },
  };
  return api_;
}

/** Human label for an autonomy gate. */
function autonomyGateLabel(g) {
  if (g === "merge") return "Auto-merge";
  if (g === "memory") return "Auto-memory";
  return "Auto-approve";
}

/** Is (repo × risk × gate) already enabled as auto? Used to hide a redundant Enable. */
function isPolicyActive(policies, repoId, riskLevel, gate) {
  return (
    Array.isArray(policies) &&
    policies.some(
      (p) =>
        p.repo_id === repoId && p.risk_level === riskLevel && p.gate === gate && p.mode === "auto",
    )
  );
}

/**
 * POST an autonomy policy change and re-render the Settings view from the server's
 * fresh state (so the active-policies list + suggestions reflect reality). Security:
 * the server re-checks the explicit confirm on enable; this is just the transport.
 */
function submitAutonomyPolicy(btn, busyLabel, body, okMsg) {
  runAsyncAction(btn, busyLabel, async () => {
    await api("POST", "/api/autonomy/policy", body);
    toast(okMsg, { ok: true });
    router();
  });
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): advisory recommendations panel — now with an
 * ENABLE action per item.
 *
 * Each suggestion surfaces "you've approved N of M low-risk deliveries in api-repo
 * unchanged — consider auto-merge for risk=low" backed by the real review track
 * record. Clicking Enable reveals the evidence (already shown) + an EXPLICIT CONFIRM
 * step (the LOCKED trust-boundary posture), then POSTs the policy with confirm:true.
 * An item already enabled as auto shows an "Enabled" chip instead of the action.
 * Returns null when there's nothing to recommend, so the panel simply doesn't appear.
 */
/** The REVIEW_MODE the tick will use, from the settings views ('human' when unset). */
function effectiveReviewMode(all) {
  const s = (Array.isArray(all) ? all : []).find((x) => x.key === "REVIEW_MODE");
  const v = s ? String(s.effective !== undefined ? s.effective : s.value || "").trim() : "";
  return v || "human";
}

/**
 * B17: how many active (mode=auto) per-repo grants can never act — the runner consults
 * them only inside the agent review pass (REVIEW_MODE=agent|both); under `human` no
 * reviewer runs, so the grants are inert. 0 when there are none or they are live.
 */
function autonomyPoliciesInert(policies, all) {
  const active = (Array.isArray(policies) ? policies : []).filter((p) => p.mode === "auto");
  if (active.length === 0) return 0;
  return effectiveReviewMode(all) === "human" ? active.length : 0;
}

/** The Settings banner for inert grants (see autonomyPoliciesInert). */
function inertPoliciesNote(n) {
  return el("div", { class: "warn-box autonomy-inert-note", role: "status" }, [
    icon("alert", "settings-note-ico"),
    el("span", {}, [
      el("strong", {}, `${n} autonomy grant${n === 1 ? " is" : "s are"} inert. `),
      "Review mode is human, so no reviewer agent runs and the per-repo policies are never " +
        "consulted. Set Review mode to agent or both (or Autonomy mode to graduated) for them " +
        "to act, or turn them off below.",
    ]),
  ]);
}

export {
  isOnValue,
  testingLaneOff,
  teamInstructions,
  autonomyGateLabel,
  isPolicyActive,
  submitAutonomyPolicy,
  autonomyPoliciesInert,
  inertPoliciesNote,
};
