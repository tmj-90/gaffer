// THE AUTONOMY LADDER (backlog 58): per repository, a ladder of risk levels (low to
// critical) by the two gates (approve, merge). Each cell says its rung in a word and a
// mark (never colour alone), the evidence behind it as a rate row with its Wilson
// whisker and "k of n", and the distance to the next rung. A stepped-down cell says why
// and what lifts it (a person gives it back here); critical shows the ceiling.
// Self-contained: it reads GET /api/autonomy/ladder itself. Mounted on Settings >
// Autonomy (autonomyLadderPanel, re-exported by autonomy.js) and as one line on the
// Overview (autonomyStepDownLine).

import { api } from "../api.js";
import { button, callout, emptyState, meterRow, panelHead } from "../components.js";
import { clear, el } from "../dom.js";
import { glyph, icon } from "../icons.js";
import { router } from "../router.js";
import { runAsyncAction, toast } from "../toast.js";

const GATES = ["approve", "merge"];
const GATE_WORD = { approve: "Approve", merge: "Merge" };
const RISK_WORD = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
const MEASURE_WORD = { agreement: "Agreement", approved_unchanged: "Approved unchanged" };
const TRIGGER_WORD = {
  regression: "a regression",
  reopened: "a reopened change",
  tester_failures: "tester failures",
  cascade: "a lower risk stepped down",
};

/** The rung a cell shows: a word and a mark. A step-down and the ceiling read as their own. */
function rungOf(cell) {
  if (cell.ceiling)
    return { key: "ceiling", word: "Not allowed", mark: () => icon("lock", "al-mark", 16) };
  if (cell.step_down)
    return { key: "stepped", word: "Stepped down", mark: () => glyph("failed", 16) };
  if (cell.rung === "automatic")
    return { key: "automatic", word: "Automatic", mark: () => glyph("done", 16) };
  if (cell.rung === "suggested")
    return { key: "suggested", word: "Suggested", mark: () => glyph("ready", 16) };
  return { key: "person", word: "A person decides", mark: () => glyph("draft", 16) };
}

function pctOf(x) {
  return `${Math.round(Number(x) * 100)}%`;
}

/** Give autonomy back for one row: re-enable when the evidence is ready, else override. */
function liftForm(repo, cell) {
  const sd = cell.step_down;
  const ready = Boolean(sd.lift && sd.lift.reenable_ready);
  const id = `al-reason-${repo.repo_id}-${cell.risk_level}-${cell.gate}`;
  const reason = el("input", {
    id,
    class: "input al-reason",
    type: "text",
    maxlength: "300",
    placeholder: ready ? "Why (optional)" : "Why give it back now",
  });
  const go = button(ready ? "Re-enable" : "Override and give back", { size: "small" });
  go.addEventListener("click", () =>
    runAsyncAction(go, "Giving back…", async () => {
      const why = reason.value.trim();
      if (!ready && why.length < 3) {
        toast("An override needs a reason: say why autonomy is given back now.", { ok: false });
        reason.focus();
        return;
      }
      await api("POST", "/api/autonomy/lift", {
        repo_id: repo.repo_id,
        risk_level: cell.risk_level,
        gate: cell.gate,
        how: ready ? "reenable" : "override",
        ...(why ? { reason: why } : {}),
      });
      toast(
        `${GATE_WORD[cell.gate]} at ${cell.risk_level} risk in ${repo.repo_name}: autonomy given back.`,
        { ok: true },
      );
      router();
    }),
  );
  return el("div", { class: "al-lift" }, [
    el("label", { for: id, class: "al-lift-label" }, "Give it back (a person's act)"),
    el("div", { class: "al-lift-row" }, [reason, go]),
  ]);
}

/** One cell: rung, evidence, distance, and the step-down or ceiling callout. */
function ladderCell(repo, cell) {
  const r = rungOf(cell);
  const e = cell.evidence || {};
  const out = el("div", { class: `al-cell al-${r.key}`, "data-rung": r.key }, [
    el("span", { class: "al-gate-label" }, GATE_WORD[cell.gate]),
    el("p", { class: "al-rung" }, [r.mark(), el("span", { class: "al-rung-word" }, r.word)]),
  ]);
  if (cell.ceiling) {
    out.appendChild(
      callout({ tone: "info", body: "Not allowed: a person always decides critical changes." }),
    );
    return out;
  }
  out.appendChild(
    el("div", { class: "meter-list al-evidence" }, [
      meterRow({ name: MEASURE_WORD[e.measure] || "Evidence", k: e.k, n: e.n, whisker: true }),
    ]),
  );
  out.appendChild(
    el(
      "p",
      { class: "al-bar dim" },
      `Bar: ${pctOf(e.threshold)} of at least ${e.min_samples}${e.since ? `, counted since ${String(e.since).slice(0, 10)}` : ""}${cell.prior && cell.prior.used ? ", with other repos' record" : ""}`,
    ),
  );
  if (cell.distance && cell.distance.text) {
    out.appendChild(el("p", { class: "al-distance" }, cell.distance.text));
  }
  if (cell.step_down) {
    const sd = cell.step_down;
    out.appendChild(
      callout({
        tone: "bad",
        title: `Stepped down ${String(sd.at).slice(0, 10)} after ${TRIGGER_WORD[sd.trigger] || "bad evidence"}.`,
        body: `${sd.why} ${sd.lift ? sd.lift.text : ""}`.trim(),
      }),
    );
    // A cascaded row lifts only after the lower risk it follows (the server's rule too).
    out.appendChild(
      sd.cascade_from
        ? el(
            "p",
            { class: "al-lift-after dim" },
            `Give ${sd.cascade_from} risk back first: if ${sd.cascade_from} is not trusted, ${cell.risk_level} is not either.`,
          )
        : liftForm(repo, cell),
    );
  }
  return out;
}

/** One repository's ladder: a real table, risk rows by gate columns (stacks on a phone). */
function repoLadder(repo) {
  const table = el("table", { class: "al-table" }, [
    el("caption", { class: "sr-only" }, `Autonomy ladder for ${repo.repo_name}`),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, "Risk"),
        ...GATES.map((g) => el("th", { scope: "col" }, GATE_WORD[g])),
      ]),
    ]),
    el(
      "tbody",
      {},
      repo.rows.map((row) =>
        el("tr", { "data-risk": row.risk_level }, [
          el("th", { scope: "row", class: "al-risk" }, RISK_WORD[row.risk_level] || row.risk_level),
          ...GATES.map((g) => el("td", {}, ladderCell(repo, row.gates[g]))),
        ]),
      ),
    ),
  ]);
  return el("section", { class: "al-repo", "data-repo": repo.repo_name }, [
    panelHead(repo.repo_name, null, null, { level: 3 }),
    table,
  ]);
}

/** The whole ladder from the read model (pure: the tests call it with a fixture). */
function renderLadder(ladder) {
  const repos = ladder && Array.isArray(ladder.repos) ? ladder.repos : [];
  if (repos.length === 0) {
    return emptyState(
      "No repositories yet: the ladder appears once one is registered.",
      null,
      null,
      null,
      {
        inline: true,
      },
    );
  }
  const rules = ladder.rules || {};
  return el("div", { class: "al-body" }, [
    el(
      "p",
      { class: "section-note" },
      `A row climbs from "a person decides" to "suggested" when your own review record clears the bar, and becomes automatic only when you enable it. ` +
        `Autonomy steps down on its own after a regression of an automatic change, a reopened automatic landing, or ${rules.step_down_tester_fails || 2} tester failures on automatic approvals within ${rules.step_down_window_days || 30} days; a merge step-down covers every higher risk too.`,
    ),
    ...repos.map(repoLadder),
  ]);
}

/** Settings > Autonomy: the ladder panel. Loads itself; a failed read says so. */
function autonomyLadderPanel() {
  const body = el("div", { class: "al-loading dim" }, "Loading the ladder…");
  const panel = el("div", { class: "card panel autonomy-ladder", id: "autonomy-ladder" }, [
    panelHead("Autonomy ladder", null, null, { level: 2 }),
    body,
  ]);
  api("GET", "/api/autonomy/ladder")
    .then((ladder) => {
      clear(body);
      body.className = "";
      body.appendChild(renderLadder(ladder));
    })
    .catch(() => {
      clear(body);
      body.appendChild(callout({ tone: "bad", body: "The ladder could not be read." }));
    });
  return panel;
}

/** Overview: one line per repository where autonomy stepped down in the last 7 days. */
function stepDownLines(ladder) {
  const recent = ladder && Array.isArray(ladder.recent_step_downs) ? ladder.recent_step_downs : [];
  const byRepo = new Map();
  for (const s of recent) {
    if (s.trigger === "cascade") continue;
    if (!byRepo.has(s.repo_name)) byRepo.set(s.repo_name, s);
  }
  return [...byRepo.values()].map((s) =>
    el("p", { class: "al-overview-line" }, [
      glyph("failed", 14),
      el("span", {}, [
        el("b", {}, `Autonomy stepped down on ${s.repo_name}: `),
        s.why,
        " ",
        el("a", { href: "#/settings", class: "al-overview-link" }, "See the ladder"),
      ]),
    ]),
  );
}

/** The Overview's line: hidden until a step-down of the last 7 days is on record. */
function autonomyStepDownLine() {
  const box = el("div", { class: "al-overview", hidden: true, role: "status" });
  // The narrow read: the recent step-downs alone, not the whole ladder.
  api("GET", "/api/autonomy/ladder?recent=1")
    .then((ladder) => {
      const lines = stepDownLines(ladder);
      if (lines.length === 0) return;
      for (const l of lines) box.appendChild(l);
      box.hidden = false;
    })
    .catch(() => {});
  return box;
}

export { autonomyLadderPanel, autonomyStepDownLine, renderLadder, stepDownLines };
