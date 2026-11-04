// View: Specs (coverage and traceability).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock } from "../access.js";
import { api } from "../api.js";
import { emptyState, panelHead, viewHead } from "../components.js";
import { el } from "../dom.js";
import { fmtRelative, plural } from "../format.js";
import { badge, glyph, icon, repoTag } from "../icons.js";
import { TERMINAL, allTickets } from "../matchday.js";
import { navigate, routeSignal, router } from "../router.js";
import { statusLabel } from "../status.js";
import { runAsyncAction, toast } from "../toast.js";
import { backLink } from "./map.js";
import { openPlanBuild } from "./plan.js";
import { progPage } from "./programme.js";
import { openSpecBuild } from "./spec-build.js";

// --- Specs (Spec-Driven Development, Phase 3: coverage & traceability) -------

const SPEC_STATUS_LABEL = { draft: "Draft", frozen: "Frozen", superseded: "Superseded" };
const CLAUSE_KIND_LABEL = {
  requirement: "Requirement",
  "non-goal": "Non-goal",
  decision: "Decision",
};
const LORE_STATUS_LABEL = {
  active: "reaching agents",
  draft: "unratified",
  absent: "not seeded",
  unknown: "",
};

/** Count clauses on a spec row without throwing on a malformed clauses_json. */
function specClauseCount(spec) {
  try {
    const parsed = JSON.parse(spec.clauses_json || "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Specs view. Two surfaces on one route: a list of specs (#/specs) and, for a
 * given spec (#/specs/:id), the coverage TRACE — each clause → its covering ACs
 * (satisfied vs open), the coverage gaps (orphan clauses) called out, per-clause
 * bounce counts, and the seeded-lore ratification status. Modelled on renderEpics.
 */
async function renderSpecs(param) {
  const specId = param ? decodeURIComponent(param) : "";
  return specId ? renderSpecDetail(specId) : renderSpecList();
}

/** A spec's status: its mark + its word (a lock when frozen: the clauses cannot change). */
function specStatusMark(status) {
  const word = SPEC_STATUS_LABEL[status] || status || "—";
  const mark =
    status === "frozen"
      ? icon("lock", "spec-lock", 16)
      : glyph(status === "superseded" ? "cancelled" : "draft", 16);
  return el("span", { class: `spec-card-status status-${status}` }, [mark, el("span", {}, word)]);
}

/** How many of a clause's covering criteria are met, of how many. */
function clauseMet(c) {
  const acs = Array.isArray(c.covering_acs) ? c.covering_acs : [];
  return { met: acs.filter((ac) => ac.satisfied).length, of: acs.length };
}

/**
 * One clause's coverage state (the data-state hook). The server's `satisfied`
 * flag is true when ANY covering criterion is met, so the state is read from the
 * criteria themselves: satisfied only when every one is met, partly met when
 * some are, open when none are. A clause is proven only when all of it is.
 */
function clauseState(c) {
  if (c.orphan) return "orphan";
  const { met, of } = clauseMet(c);
  if (!of) return c.satisfied ? "satisfied" : "open";
  return met === of ? "satisfied" : met > 0 ? "partial" : "open";
}

/** Clause kinds that record intent rather than behaviour: no criterion is not a gap. */
const INTENT_KINDS = new Set(["non-goal", "decision"]);

/**
 * A spec not built yet: a draft, or a frozen spec with no campaign playing it and
 * no criterion naming any clause (the state between "Freeze spec" and "Plan a
 * build from it"). Its clauses read "not covered yet" everywhere (the squares,
 * the board line, the lede and the list), never as gaps: nothing has failed.
 */
function specUnbuilt(status, clauses, scopeNodeId) {
  if (status === "draft") return true;
  return !scopeNodeId && !(clauses || []).some((c) => c.covered);
}

/**
 * A gap is a clause that should be proven and is not: a requirement of a spec
 * whose build is under way with no criterion covering it. A spec not built yet
 * (specUnbuilt) has no gaps by design, and a non-goal or a decision with no
 * criterion is not a failure; those read quietly, never red.
 */
function clauseIsGap(c, status, unbuilt = false) {
  return !!c.orphan && !unbuilt && status !== "draft" && !INTENT_KINDS.has(c.kind);
}

/** How many of a coverage payload's clauses are gaps (see clauseIsGap). */
function specGapCount(coverage, status) {
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses) {
    const unbuilt = specUnbuilt(status, clauses, coverage.scope_node_id);
    return clauses.filter((c) => clauseIsGap(c, status, unbuilt)).length;
  }
  const r = specCoverageRollup(coverage);
  return r && status !== "draft" && (r.covered || coverage.scope_node_id) ? r.orphans : 0;
}

/**
 * The form guide: one square per clause, in the order written — filled when
 * every criterion is met, outlined with a filled corner when some are, outlined
 * when covered but none is met yet, red when it is a gap, dashed when it has no
 * criterion and is not a gap (a spec not built yet, a non-goal, a decision).
 * Decorative next to the sentence that states the same counts.
 */
function specFormGuide(clauses, status, scopeNodeId) {
  const unbuilt = specUnbuilt(status, clauses, scopeNodeId);
  return el(
    "span",
    { class: "spec-form", "aria-hidden": "true" },
    clauses.map((c, i) => {
      const state = clauseState(c);
      const cls =
        state === "orphan" ? (clauseIsGap(c, status, unbuilt) ? "orphan" : "none") : state;
      return el(
        "i",
        {
          class: `fg fg-${cls}`,
          title: `Clause ${i + 1} (${CLAUSE_KIND_LABEL[c.kind] || c.kind}): ${c.text}`,
        },
        String(i + 1),
      );
    }),
  );
}

/**
 * "6 of 8 covered · 1 satisfied · 2 partly met · 1 gap" — the counts the form
 * guide draws. Satisfied means every criterion on the clause is met.
 */
function specCoverageWords(r, gaps) {
  if (!r) return "Coverage unavailable";
  if (!r.total) return "No clauses yet";
  if (!r.covered)
    return gaps
      ? `Nothing covered: ${plural(gaps, "gap")}`
      : `Not covered yet: no criterion names ${r.total === 1 ? "it" : "them"}`;
  return [
    `${r.covered} of ${r.total} covered`,
    r.satisfied != null ? `${r.satisfied} satisfied` : null,
    r.partial ? `${r.partial} partly met` : null,
    gaps ? plural(gaps, "gap") : "no gaps",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function renderSpecList() {
  const signal = routeSignal();
  const res = await api("GET", "/specs", undefined, { signal });
  const specs = res.specs || [];

  const wrap = el("div", { class: "view view-specs", dataset: { view: "specs" } });
  const author = roLock(
    el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
      icon("spark"),
      el("span", {}, "Author a spec"),
    ]),
  );
  const by = (st) => specs.filter((s) => s.status === st).length;
  wrap.appendChild(
    viewHead(
      "The playbook",
      specs.length
        ? [
            plural(specs.length, "spec"),
            by("frozen") ? `${by("frozen")} frozen` : null,
            by("draft") ? `${by("draft")} draft` : null,
            by("superseded") ? `${by("superseded")} superseded` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "No specs written yet.",
      author,
    ),
  );

  if (specs.length === 0) {
    // What is on the pitch without a written play: the campaigns and live tickets,
    // so the empty page still says something true about this club.
    const [nodesRes, ticketsRes] = await Promise.all([
      api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
      allTickets("", { signal }).catch(() => ({ tickets: [] })),
    ]);
    const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
    const live = (ticketsRes.tickets || []).filter((t) => !TERMINAL.has(t.status));
    wrap.appendChild(
      el("section", { class: "card playbook-empty" }, [
        panelHead("No specs yet", null, null, { kit: "ink" }),
        el(
          "div",
          { class: "pb-steps", role: "list" },
          [
            ["1", "The brief", "Say what to build in a paragraph."],
            ["2", "The clauses", "Gaffer drafts testable clauses; you edit them."],
            ["3", "Frozen", "Each clause is traced to the acceptance criteria that prove it."],
          ].map(([n, h, t]) =>
            el("div", { class: "pb-step", role: "listitem" }, [
              el("span", { class: "pb-n", "aria-hidden": "true" }, n),
              el("h3", {}, h),
              el("p", {}, t),
            ]),
          ),
        ),
        el(
          "p",
          { class: "pb-now" },
          epics.length || live.length
            ? [
                `Playing without a written spec right now: ${plural(epics.length, "campaign")}${epics.length ? ` (${epics.map((e) => e.name).join(", ")})` : ""} and ${plural(live.length, "live ticket")}. `,
                el("a", { href: "#/epics" }, "See the season"),
                ".",
              ]
            : "Nothing is on the pitch yet: a spec is a good first play.",
        ),
        el("div", { class: "btn-row" }, [
          roLock(
            el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
              icon("spark"),
              el("span", {}, "Write the first play"),
            ]),
          ),
        ]),
      ]),
    );
    return wrap;
  }

  // Coverage per spec (best-effort: a failed read shows "Coverage unavailable" on
  // that row, never a broken page) and the campaign names the specs are played in.
  const [coverages, nodesRes] = await Promise.all([
    Promise.all(
      specs.map((s) =>
        api("GET", `/specs/${encodeURIComponent(s.id)}/coverage`, undefined, { signal })
          .then((r) => (r && r.coverage) || null)
          .catch(() => null),
      ),
    ),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const covById = new Map(specs.map((s, i) => [s.id, coverages[i]]));
  const nodeName = new Map(((nodesRes && nodesRes.nodes) || []).map((n) => [n.id, n.name]));

  // The newest spec (by when it was written, the order the server lists them in)
  // is marked: it is the one most likely in play.
  const stamp = (x) => Date.parse(x.created_at || x.updated_at || 0) || 0;
  const newestId = specs.slice().sort((a, b) => stamp(b) - stamp(a))[0]?.id;

  const list = el("div", { class: "spec-list", role: "list" });
  for (const spec of specs)
    list.appendChild(
      el(
        "div",
        { role: "listitem" },
        renderSpecCard(spec, {
          coverage: covById.get(spec.id),
          isPrimary: spec.id === newestId,
          campaign: spec.scope_node_id ? nodeName.get(spec.scope_node_id) : null,
        }),
      ),
    );
  wrap.appendChild(
    el("section", { class: "card prog spec-plays", "aria-labelledby": "spec-plays-h" }, [
      (() => {
        const h = panelHead("The plays", `${plural(specs.length, "spec")}, as written`, null, {
          kit: "claret",
        });
        h.querySelector(".panel-title").id = "spec-plays-h";
        return h;
      })(),
      list,
      el("p", { class: "spec-key" }, [
        ...[
          ["satisfied", "1", "satisfied: every criterion met"],
          ["partial", "2", "partly met: some criteria met"],
          ["open", "3", "covered, none met yet"],
          ["orphan", "4", "a gap: a requirement nothing covers while it is built"],
          [
            "none",
            "5",
            "no criterion yet, not a gap (a spec not built yet, a non-goal, a decision)",
          ],
        ].map(([cls, n, words]) =>
          el("span", { class: "spec-key-item" }, [
            el("span", { class: "spec-form", "aria-hidden": "true" }, [
              el("i", { class: `fg fg-${cls}` }, n),
            ]),
            el("span", {}, words),
          ]),
        ),
        el("span", {}, "Each square is a clause, in the order written."),
      ]),
    ]),
  );
  return wrap;
}

/**
 * A rollup {total,covered,satisfied,partial,orphans} from a coverage payload,
 * defensively read. Satisfied and partly met are counted from the clauses when
 * they are there (clauseState): the server's own `satisfied` counts a clause
 * with any criterion met, which is not the same as proven.
 */
function specCoverageRollup(coverage) {
  const src =
    coverage && coverage.rollup && typeof coverage.rollup === "object" ? coverage.rollup : null;
  if (!src) return null;
  const total = Number(src.total) || 0;
  const covered = Number(src.covered) || 0;
  const orphans = Array.isArray(src.orphans) ? src.orphans.length : Number(src.orphans) || 0;
  const clauses = Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses && clauses.length) {
    const states = clauses.map(clauseState);
    const n = (st) => states.filter((x) => x === st).length;
    return { total, covered, satisfied: n("satisfied"), partial: n("partial"), orphans };
  }
  const satisfied = src.satisfied != null ? Number(src.satisfied) || 0 : null;
  return { total, covered, satisfied, partial: 0, orphans };
}

/** One spec = one line of the playbook, linking to its clause-by-clause trace. */
function renderSpecCard(spec, { coverage, isPrimary = false, campaign = null } = {}) {
  const count = specClauseCount(spec);
  const rollup = specCoverageRollup(coverage);
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : [];
  const statusLabel = SPEC_STATUS_LABEL[spec.status] || spec.status;
  const gaps = coverage ? specGapCount(coverage, spec.status) : 0;
  const words = specCoverageWords(rollup, gaps);
  return el(
    "a",
    {
      class: `spec-card${isPrimary ? " spec-card--primary" : ""}${gaps ? " has-gaps" : ""}`,
      href: `#/specs/${encodeURIComponent(spec.id)}`,
      dataset: { specId: spec.id, status: spec.status },
      "aria-label": `${spec.title}: ${statusLabel}, ${plural(count, "clause")}, ${words}${campaign ? `, played in ${campaign}` : ""}`,
    },
    [
      el("span", { class: "spec-card-lead" }, [
        specStatusMark(spec.status),
        isPrimary ? el("span", { class: "spec-card-new" }, "newest") : null,
      ]),
      el("span", { class: "spec-card-body" }, [
        el("span", { class: "spec-card-title" }, spec.title),
        spec.brief ? el("span", { class: "spec-card-brief" }, spec.brief) : null,
        el("span", { class: "spec-card-meta" }, [
          el("span", {}, plural(count, "clause")),
          spec.target_repo ? repoTag(spec.target_repo, 16) : null,
          campaign ? el("span", {}, `Campaign: ${campaign}`) : null,
          spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
        ]),
      ]),
      el("span", { class: "spec-card-cov" }, [
        clauses.length ? specFormGuide(clauses, spec.status, coverage.scope_node_id) : null,
        el("span", { class: `spec-card-words${gaps ? " is-red" : ""}` }, words),
      ]),
    ],
  );
}

async function renderSpecDetail(specId) {
  const signal = routeSignal();
  const [res, specRes, nodesRes] = await Promise.all([
    api("GET", `/specs/${encodeURIComponent(specId)}/coverage`, undefined, { signal }),
    api("GET", `/specs/${encodeURIComponent(specId)}`, undefined, { signal }).catch(() => null),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const cov = res && res.coverage;
  // GET /specs/:id answers { spec }; tolerate a list-shaped answer too.
  const spec =
    (specRes && specRes.spec) ||
    ((specRes && specRes.specs) || []).find((s) => s.id === specId) ||
    null;

  const wrap = el("div", { class: "view view-spec", dataset: { view: "specs" } });
  const back = backLink("#/specs", "Back to the playbook");
  wrap.appendChild(back);

  // Defensive: a missing / empty / malformed coverage payload must render a
  // clean empty state, not blank the whole spec view.
  if (!cov || typeof cov !== "object") {
    wrap.appendChild(viewHead((spec && spec.title) || "Spec", "Coverage"));
    wrap.appendChild(
      emptyState(
        "Coverage unavailable",
        "This spec's coverage report could not be loaded. It may have been removed, or the report is still being built.",
        null,
        el("a", { class: "btn", href: "#/specs" }, "Back to the playbook"),
      ),
    );
    return wrap;
  }

  const clauses = Array.isArray(cov.clauses) ? cov.clauses : [];
  const r = specCoverageRollup(cov.rollup ? cov : { ...cov, rollup: {} });
  r.satisfied = r.satisfied || 0;
  const status = cov.status || (spec && spec.status) || "";
  const targetRepo = (spec && spec.target_repo) || cov.target_repo || null;
  const campaign = cov.scope_node_id
    ? ((nodesRes && nodesRes.nodes) || []).find((n) => n.id === cov.scope_node_id)
    : null;
  const brief = (spec && spec.brief) || cov.brief || null;

  // The lede: where the spec stands, from its coverage. A gap is a requirement
  // nothing proves while it is built (clauseIsGap); a spec not built yet (a draft,
  // or frozen with no campaign and nothing covering it) reads as one calm "not
  // covered yet" in the squares, the board, the lede and the list, never as red.
  const unbuilt = specUnbuilt(status, clauses, cov.scope_node_id);
  const gapClauses = clauses.filter((c) => clauseIsGap(c, status, unbuilt));
  const gapsN = gapClauses.length;
  const quietN = clauses.filter((c) => c.orphan && !clauseIsGap(c, status, unbuilt)).length;
  const uncovered = unbuilt && r.total > 0 && r.covered === 0;
  // "1 already satisfied and 2 partly met": satisfied means every criterion is met.
  const metWords =
    r.satisfied && r.partial
      ? `, ${r.satisfied} already satisfied and ${r.partial} partly met`
      : r.satisfied
        ? `, ${r.satisfied} already satisfied`
        : r.partial
          ? `, none fully proven yet: ${r.partial} partly met`
          : "";
  const quietOf = (k) => clauses.filter((c) => c.orphan && c.kind === k).length;
  const quietWords = [
    quietOf("non-goal") ? plural(quietOf("non-goal"), "non-goal") : null,
    quietOf("decision") ? plural(quietOf("decision"), "decision") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const total = plural(r.total, "clause");
  let lede;
  if (!r.total)
    lede = [el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `), "It has no clauses yet."];
  else if (uncovered)
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      // Not built yet: said the same way here, on the board, and in the list.
      status === "draft"
        ? `Not covered yet, and no gaps: freeze it to lock its ${total} and seed them as lore for the agents; the criteria that prove them come with the build you plan from it.`
        : status === "frozen"
          ? `Not covered yet, and no gaps until it is built: plan a build from it, and each ticket's criteria will name the ${r.total === 1 ? "clause it proves" : "clauses they prove"}.`
          : `None of its ${total} is covered.`,
    ];
  else
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      `${r.covered} of its ${total} ${r.covered === 1 ? "is" : "are"} covered by acceptance criteria${metWords}.`,
      gapsN
        ? [
            " ",
            el(
              "span",
              { class: "is-red" },
              `${gapsN === 1 ? "1 requirement has" : `${gapsN} requirements have`} no criterion, so nothing proves ${gapsN === 1 ? "it" : "them"} yet.`,
            ),
          ]
        : "",
      quietN
        ? status === "draft"
          ? ` ${quietN} ${quietN === 1 ? "is" : "are"} not covered yet.`
          : ` ${quietWords} ${quietN === 1 ? "has" : "have"} none, which is not counted as a gap.`
        : !gapsN
          ? " Every clause has a criterion."
          : "",
      status === "draft"
        ? " Freeze it to lock the clauses and seed them as lore for the agents."
        : "",
    ];

  const actions = [];
  if (cov.scope_node_id) {
    actions.push(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => navigate(`#/epics/${encodeURIComponent(cov.scope_node_id)}`),
        },
        [icon("epics"), el("span", {}, "Open campaign")],
      ),
    );
  }
  if (status === "draft") {
    actions.unshift(
      roLock(
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: (e) =>
              runAsyncAction(e.currentTarget, "Freezing…", async () => {
                await api("POST", `/specs/${encodeURIComponent(specId)}/freeze`);
                toast("Spec frozen: its clauses are locked and seeded as lore.", { ok: true });
                router();
              }),
          },
          [icon("lock", "", 18), el("span", {}, "Freeze spec")],
        ),
      ),
    );
  } else if (status === "frozen" && !cov.scope_node_id && clauses.length) {
    // A frozen spec with no campaign yet: build one from it, clause provenance and all.
    actions.unshift(
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            openPlanBuild({
              spec: clauses
                .filter((c) => c.clause_id && c.kind && c.text)
                .map((c) => ({
                  clause_id: c.clause_id,
                  kind: c.kind,
                  text: c.text,
                  ...(c.rationale ? { rationale: c.rationale } : {}),
                })),
              brief: brief || cov.title || "Build from the frozen spec.",
              ...(targetRepo ? { repo: targetRepo } : {}),
            }),
        },
        [icon("spark"), el("span", {}, "Plan a build from it")],
      ),
    );
    roLock(actions[0]);
  }

  wrap.appendChild(
    el("header", { class: "spec-head" }, [
      el("p", { class: "spec-meta" }, [
        specStatusMark(status),
        targetRepo ? repoTag(targetRepo, 20) : el("span", {}, "Every repo"),
        campaign
          ? el(
              "a",
              { href: `#/epics/${encodeURIComponent(campaign.id)}` },
              `Campaign: ${campaign.name}`,
            )
          : null,
        el("span", {}, plural(r.total, "clause")),
        spec && spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
      ]),
      el("h1", { class: "detail-title" }, cov.title || (spec && spec.title) || "Spec"),
      el("p", { class: "spec-lede" }, lede),
      brief ? el("p", { class: "spec-brief" }, [el("b", {}, "The brief: "), `“${brief}”`]) : null,
      actions.length ? el("div", { class: "btn-row" }, actions) : null,
    ]),
  );

  const indexOf = new Map(clauses.map((c, i) => [c.clause_id, i + 1]));
  // Coverage gaps: requirements nothing proves, called out first. Only when some
  // clauses are covered: a spec nothing covers yet says so once, on the board.
  if (gapsN > 0 && !uncovered) {
    wrap.appendChild(
      el(
        "section",
        {
          class: "card coverage-gaps",
          dataset: { count: String(gapsN) },
          "aria-label": "Coverage gaps",
        },
        [
          panelHead(
            `${gapsN} coverage gap${gapsN === 1 ? "" : "s"}`,
            `${gapsN === 1 ? "a requirement" : "requirements"} with no acceptance criterion covering ${gapsN === 1 ? "it" : "them"}`,
            null,
            { kit: "red" },
          ),
          el(
            "ul",
            { class: "coverage-gaps-list" },
            gapClauses.map((c) =>
              el("li", { dataset: { clauseId: c.clause_id } }, [
                el(
                  "a",
                  {
                    class: "sc-no",
                    href: `#clause-${indexOf.get(c.clause_id) || ""}`,
                    "aria-label": `Clause ${indexOf.get(c.clause_id) || ""}, in the trace below`,
                  },
                  String(indexOf.get(c.clause_id) || ""),
                ),
                el("span", { class: "cg-text" }, c.text),
              ]),
            ),
          ),
          el(
            "p",
            { class: "cg-hint" },
            "Cover a gap with an acceptance criterion that names the clause, on the ticket that delivers it.",
          ),
        ],
      ),
    );
  }

  // Lore and bounces are said once for the spec when every clause shares them,
  // and per clause only where they differ.
  const loreSet = new Set(clauses.map((c) => c.lore_status || "unknown"));
  const loreOnce = loreSet.size === 1 ? [...loreSet][0] : null;
  const anyBounce = clauses.some((c) => c.bounce_count > 0);
  const notes = [];
  const uncoveredNote = !uncovered
    ? null
    : el("p", { class: "spec-board-note spec-uncovered" }, [
        glyph("draft", 16),
        el(
          "span",
          {},
          `Not covered yet: none of the ${total} has an acceptance criterion naming it. That is not a gap until a build is under way.`,
        ),
      ]);
  if (loreOnce && loreOnce !== "unknown")
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        loreOnce === "active"
          ? "Lore: every clause is seeded and reaching the agents."
          : loreOnce === "draft"
            ? [
                "Lore: every clause is seeded as draft lore, unratified, so it is not reaching the agents yet. ",
                el("a", { href: "#/memory" }, "Ratify it in Memory"),
                ".",
              ]
            : `Lore: no clause is seeded yet.${status === "draft" ? " Freezing the spec seeds them." : ""}`,
      ),
    );
  if (anyBounce)
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        "Bounced: how many times work on the tickets covering a clause was sent back.",
      ),
    );

  // The trace: one row per clause → its covering ACs → satisfied / open.
  const opts = { status, uncovered, unbuilt, loreOnce };
  const trace = el(
    "ol",
    { class: "spec-trace" },
    clauses.map((c, i) => el("li", { id: `clause-${i + 1}` }, renderClauseTrace(c, i + 1, opts))),
  );
  wrap.appendChild(
    progPage(
      "spec-clauses",
      "ink",
      "The clauses",
      `${plural(clauses.length, "clause")}, in the order written`,
      [
        specFormGuide(clauses, status, cov.scope_node_id),
        uncoveredNote,
        trace,
        notes.length ? el("div", { class: "spec-board-notes" }, notes) : null,
      ],
    ),
  );

  if (cov.gate_enabled) {
    wrap.appendChild(
      el(
        "p",
        { class: "section-note" },
        "The spec-coverage gate is on (advisory): a clause with no met criterion is flagged at the Definition of Done.",
      ),
    );
  }
  return wrap;
}

/**
 * One clause's trace row: its number, kind and text, its state, and the criteria
 * that prove it. A gap is red; a clause with no criterion that is not a gap is
 * quiet; when nothing in the spec is covered yet the board says so once and the
 * rows carry no state of their own.
 */
function renderClauseTrace(
  clause,
  n,
  { status, uncovered = false, unbuilt = false, loreOnce = null } = {},
) {
  const state = clauseState(clause);
  const isGap = clauseIsGap(clause, status, unbuilt);
  const acs = Array.isArray(clause.covering_acs) ? clause.covering_acs : [];
  const { met } = clauseMet(clause);
  const block = el("div", {
    class: `spec-clause${isGap ? " is-gap" : ""}`,
    dataset: {
      clauseId: clause.clause_id,
      state,
      covered: String(clause.covered),
      orphan: String(clause.orphan),
      // Proven: every covering criterion met (the server's flag means "any").
      satisfied: String(state === "satisfied"),
      met: String(met),
    },
  });
  const ofMet = acs.length > 1 ? ` · ${met} of ${acs.length} met` : "";
  const stateMark =
    state === "orphan"
      ? uncovered
        ? null
        : isGap
          ? el("span", { class: "sc-state is-red" }, [
              glyph("failed", 16),
              el("span", {}, "Gap: nothing proves it"),
            ])
          : el("span", { class: "sc-state is-quiet" }, [
              glyph("draft", 16),
              el("span", {}, status === "draft" ? "Not covered yet" : "No criterion"),
            ])
      : state === "satisfied"
        ? el("span", { class: "sc-state is-ok" }, [
            glyph("done", 16),
            el("span", {}, acs.length > 1 ? `Satisfied · all ${acs.length} met` : "Satisfied"),
          ])
        : state === "partial"
          ? el("span", { class: "sc-state is-part" }, [
              glyph("in_progress", 16),
              el("span", {}, `Partly met · ${met} of ${acs.length}`),
            ])
          : el("span", { class: "sc-state" }, [glyph("ready", 16), el("span", {}, `Open${ofMet}`)]);

  const tags = el("div", { class: "spec-clause-tags" }, [stateMark]);
  if (clause.bounce_count > 0) {
    const b = badge(`bounced ${clause.bounce_count}×`, "clause-bounce");
    b.title = `Work covering this clause was sent back ${plural(clause.bounce_count, "time")}`;
    tags.appendChild(b);
  }
  if (!loreOnce && clause.lore_status && clause.lore_status !== "unknown") {
    const label = LORE_STATUS_LABEL[clause.lore_status] || clause.lore_status;
    tags.appendChild(
      badge(
        `lore: ${clause.lore_status}${label ? ` (${label})` : ""}`,
        `lore-${clause.lore_status === "active" ? "active" : "draft"}`,
      ),
    );
  }

  const main = el("div", { class: "spec-clause-main" }, [
    el("div", { class: "spec-clause-head" }, [
      badge(CLAUSE_KIND_LABEL[clause.kind] || clause.kind, `clause-kind kind-${clause.kind}`),
      el("span", { class: "spec-clause-text" }, clause.text),
    ]),
    clause.rationale ? el("p", { class: "spec-clause-rationale" }, clause.rationale) : null,
  ]);
  if (acs.length) {
    main.appendChild(
      el(
        "ul",
        { class: "spec-clause-acs" },
        acs.map((ac) =>
          el("li", { class: "spec-ac", dataset: { satisfied: String(ac.satisfied) } }, [
            glyph(ac.satisfied ? "done" : "ready", 14, ac.satisfied ? "satisfied" : ac.ac_status),
            el("span", { class: "spec-ac-text" }, ac.ac_text),
            // The ticket and its status are one unit: they never wrap apart.
            el("span", { class: "spec-ac-tk" }, [
              el(
                "a",
                {
                  class: "spec-ac-ticket",
                  href: `#/ticket/${encodeURIComponent(ac.ticket_id)}`,
                  title: ac.ticket_title || "",
                },
                ac.ticket_number != null ? `#${ac.ticket_number}` : ac.ticket_title,
              ),
              ac.ticket_status
                ? el("span", { class: "spec-ac-st" }, statusLabel(ac.ticket_status))
                : null,
            ]),
          ]),
        ),
      ),
    );
  }
  block.appendChild(el("span", { class: "sc-no", "aria-hidden": "true" }, String(n)));
  block.appendChild(main);
  block.appendChild(tags);
  return block;
}

export { SPEC_STATUS_LABEL, renderSpecs, specGapCount, specCoverageRollup };
