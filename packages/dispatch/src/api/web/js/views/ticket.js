// View: Ticket detail.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { readOnly, roLock, roLockAll, scopeTitle } from "../access.js";
import { api } from "../api.js";
import { ensureAgents } from "../club.js";
import { panelHead } from "../components.js";
import { renderTicketDiff, safeHttpUrl } from "../diff.js";
import { clear, el, svgEl } from "../dom.js";
import { fmtTime, money, parseJsonSafe, plural } from "../format.js";
import { badge, glyph, icon, repoTag, ycard } from "../icons.js";
import { ticketSignature } from "../live.js";
import { OFF_PITCH, allTickets, ticketDetails } from "../matchday.js";
import { detailBackHash, errorPage, routeSignal, router, setDocTitle } from "../router.js";
import { reasonSheet, unblockSheet, wontDoSheet } from "../sheets.js";
import {
  pipelineDots,
  riskBadge,
  stageCaption,
  statusBadge,
  statusLabel,
  ticketActionKeys,
} from "../status.js";
import { guard, toast } from "../toast.js";
import { renderAddAcForm } from "./acceptance.js";
import { computePhases, isAcceptanceTicket } from "./epics.js";
import { backLink } from "./map.js";
import { CLAIM_ONLY_BLOCKERS, loadClaimability, renderRepoPanel } from "./repo-panel.js";
import {
  REJECT_REASON_PRESETS,
  deliveredBy,
  parseDodEvidence,
  pausedInfo,
  reopenedForReview,
  reviewRawWatch,
  sinceStatus,
} from "./review-comments.js";
import {
  deliveryCount,
  fullTimeCard,
  fullTimePlaque,
  memoryPrimedPanel,
  regressionCard,
  renderTestingCard,
  shippedFiles,
  ticketEvidenceCard,
  ticketMatchReport,
  ticketRunsPanel,
} from "./ticket-cards.js";
import { renderWork } from "./work.js";

// ===========================================================================
//  View: Ticket detail
// ===========================================================================

/**
 * Read a distilled test failure (vitest / jest / node:test / pytest shapes) into
 * the parts the page draws: file, test name, expected, received, where, counts.
 * Anything it cannot read stays null and the raw text is shown instead.
 */
/**
 * A captured failure with its worktree paths made repo-relative. The runner checks
 * each repo out at $GAFFER_DATA/worktrees/ticket-<N>/<repo key>/ (review and
 * clarify worktrees at worktrees/review-wt-<N>/, clarify-wt-<N>/), so a stack reads
 * "/…/data/worktrees/ticket-1/<uuid>/test/tasks.test.js:7:1"; the reviewer wants
 * "test/tasks.test.js:7:1". Paths outside a worktree are left alone.
 */
const WORKTREE_PREFIX_RE =
  /(?:file:\/\/)?(?:\/[^\s/:"'()<>]+)*\/worktrees\/(?:ticket-\d+\/[^\s/:"'()<>]+|(?:review|clarify)-wt-\d+)\//g;
function repoRelative(text) {
  return String(text || "").replace(WORKTREE_PREFIX_RE, "");
}

function parseFailure(text) {
  const s = repoRelative(text);
  const out = { file: null, name: null, expected: null, received: null, at: null, counts: null };
  const fail = s.match(/^\s*(?:FAIL|✗|×|FAILED)\s+(\S+?)\s+(?:>|›|::)\s+(.+)$/m);
  if (fail) {
    out.file = fail[1];
    out.name = fail[2].replace(/\s+>\s+/g, " › ").trim();
  }
  const exp = s.match(/^\s*-\s*Expected:?\s*(.+)$/m);
  const rec = s.match(/^\s*\+\s*Received:?\s*(.+)$/m);
  const unq = (v) => v && v.trim().replace(/^["'`](.*)["'`]$/, "$1");
  if (exp && rec) {
    out.expected = unq(exp[1]);
    out.received = unq(rec[1]);
  } else {
    const m = s.match(
      /expected\s+(.+?)\s+to (?:be|equal|deeply equal|strictly equal)\s+(.+?)(?:\s*\/\/|$)/im,
    );
    if (m) {
      out.received = unq(m[1]);
      out.expected = unq(m[2]);
    }
  }
  // The location line names file:line; the column is noise to a reviewer.
  const at = s.match(/(?:❯|at)\s+((?:[\w./-]+\/)?[\w.-]+\.\w+:\d+)(?::\d+)?/);
  if (at) out.at = at[1];
  const counts = s.match(/^\s*Tests\s+(.+?)(?:\s+\[attempt[^\]]*\])?\s*$/m);
  if (counts) out.counts = counts[1].replace(/\s{2,}/g, " ").trim();
  return out;
}

/** The referee's card at the head of a ticket that is out: red (blocked/failed) or yellow (needs you). */
function refCard(kind, status) {
  return svgEl(
    "svg",
    {
      viewBox: "0 0 120 150",
      width: 120,
      height: 150,
      class: `ref-card ref-${kind}`,
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      svgEl("rect", { x: 10, y: 8, width: 100, height: 134, rx: 6, class: "ref-card-shadow" }),
      svgEl("rect", { x: 4, y: 2, width: 100, height: 134, rx: 6, class: "ref-card-face" }),
      // The card carries the status glyph's shape: blocked is a square, failed a triangle.
      kind === "red" && status === "failed"
        ? svgEl("path", { d: "M54 50 L72 84 H36 Z", class: "ref-card-glyph" })
        : kind === "red"
          ? svgEl("rect", { x: 40, y: 55, width: 28, height: 28, rx: 2, class: "ref-card-glyph" })
          : null,
    ],
  );
}

/** The sentence under a ticket's title: where it stands, in plain words, from its data. */
function ticketLede(t, trail, events, doneAt, evidence = []) {
  const last = trail[trail.length - 1];
  const f = last ? parseFailure(last.distilled_failure) : null;
  const max = last && last.max_attempts ? last.max_attempts : null;
  switch (t.status) {
    case "blocked": {
      const why = last
        ? f && f.name
          ? [
              `The test “${f.name.split(" › ").pop()}” still fails after ${trail.length}${max ? ` of ${max}` : ""} delivery attempts, so the runner parked it.`,
            ]
          : [
              `It failed the ${last.gate} gate on ${trail.length}${max ? ` of ${max}` : ""} attempts, so the runner parked it.`,
            ]
        : ["The runner parked it."];
      return [el("b", { class: "is-red" }, "Blocked. "), ...why, " It needs you."];
    }
    case "failed":
      return [
        el("b", { class: "is-red" }, "Failed. "),
        (() => {
          if (last) return `It failed the ${last.gate} gate.`;
          // No rework trail: name the gate from the runner's Definition-of-Done report.
          const dod = parseDodEvidence(evidence);
          const bad = dod ? dod.gates.filter((g) => g.status === "FAIL") : [];
          if (!bad.length) return "It failed its gates.";
          const g = bad[0];
          return `It failed the ${g.gate} gate${g.repo ? ` in ${g.repo}` : ""}${g.note ? ` (${g.note})` : ""}.`;
        })(),
        " It needs you.",
      ];
    case "paused": {
      const p = pausedInfo(events);
      return [
        el("b", {}, "Paused. "),
        p.reason === "budget_cap"
          ? `It hit its budget cap${p.spend ? ` at ${p.spend}` : ""}.`
          : "It hit a cap mid-delivery.",
        " Continue it in place, or stop it.",
      ];
    }
    case "in_review":
      return [el("b", {}, "In review. "), "It waits for your sign-off."];
    case "ready_for_merge":
      // The server's landing_state says where the landing is; never claim a merge runs.
      return [
        el("b", {}, "Approved. "),
        t.landing_state && t.landing_state.detail
          ? t.landing_state.detail
          : "It waits in Ready for merge until a landing path lands it.",
      ];
    case "done":
      return [
        el("b", {}, "Done. "),
        `Merged${doneAt ? ` ${fmtTime(doneAt)}` : ""}, ${
          trail.length ? `after ${plural(trail.length, "rework")}.` : "first time, with no rework."
        }`,
      ];
    case "in_testing":
      return [
        el("b", {}, "In testing. "),
        "An independent tester is checking it against its test contract before it can merge.",
      ];
    case "claimed":
    case "in_progress": {
      const by = deliveredBy(events);
      return [
        el("b", {}, `${statusLabel(t.status, t.landing_state)}. `),
        by ? `${by.name} is on it.` : "An agent is on it.",
      ];
    }
    case "ready":
      return [el("b", {}, "Ready. "), "The next free agent can claim it."];
    case "draft":
    case "refining":
      return [
        el("b", {}, `${statusLabel(t.status, t.landing_state)}. `),
        "Mark it ready when its criteria are right.",
      ];
    case "cancelled": {
      // Say WHY it will not be built: the reason the closer gave (the latest move into
      // Won't do carries it), not only that it closed.
      const closed = events
        .filter((e) => e.event_type === "ticket.transitioned")
        .map((e) => parseJsonSafe(e.payload_json) || {})
        .filter((pl) => pl.to === "cancelled")
        .pop();
      const why = closed && typeof closed.reason === "string" ? closed.reason.trim() : "";
      return [
        el("b", {}, "Won't do. "),
        why
          ? [`It will not be built: `, el("q", { class: "lede-why" }, why), "."]
          : "It will not be built.",
      ];
    }
    default:
      return [el("b", {}, `${statusLabel(t.status, t.landing_state)}. `), "An agent is on it."];
  }
}

/** A policy pack said as house rules ("Solo · loose rules"), the raw key in the title. */
const POLICY_WORDS = {
  solo_loose: "Solo · loose rules",
  team_light: "Team · light rules",
  factory_strict: "Factory · strict rules",
  regulated: "Regulated rules",
};
function policyChip(pack) {
  const b = badge(POLICY_WORDS[pack] || String(pack).replace(/_/g, " "), "no-dot");
  b.title = `Policy pack: ${pack}`;
  return b;
}

/** The failing test as a scoreline: Expected v Received, and where it broke. */
function failingTestCard(trail) {
  const last = trail[trail.length - 1];
  if (!last || !last.distilled_failure) return null;
  const f = parseFailure(last.distilled_failure);
  const head = panelHead(
    last.gate === "tests" || f.name ? "The failing test" : `The failing gate: ${last.gate}`,
  );
  const body = [];
  if (f.file || f.name)
    body.push(
      el("p", { class: "ftest-name" }, [
        f.file ? el("code", { class: "mono" }, f.file) : null,
        f.file && f.name ? " › " : null,
        f.name || "",
      ]),
    );
  if (f.expected != null && f.received != null) {
    body.push(
      el(
        "div",
        {
          class: "scoreline",
          role: "group",
          "aria-label": `Expected ${f.expected}, received ${f.received}`,
        },
        [
          el("div", { class: "sl-side sl-exp" }, [
            el("span", { class: "sl-l" }, "Expected"),
            el("code", { class: "sl-v" }, f.expected),
          ]),
          el("span", { class: "sl-v-sep", "aria-hidden": "true" }, "v"),
          el("div", { class: "sl-side sl-rec" }, [
            el("span", { class: "sl-l" }, "Received"),
            el("code", { class: "sl-v" }, f.received),
          ]),
        ],
      ),
    );
  }
  const bits = [f.at ? ["at ", el("code", { class: "mono" }, f.at)] : null, f.counts].filter(
    Boolean,
  );
  if (bits.length)
    body.push(
      el(
        "p",
        { class: "ft-where" },
        bits.flatMap((b, i) => (i ? [" · ", b] : [b])),
      ),
    );
  if (f.expected == null)
    body.push(
      el(
        "pre",
        {
          class: "failure-detail",
          tabindex: "0",
          role: "region",
          "aria-label": "The failure, as captured",
        },
        repoRelative(last.distilled_failure),
      ),
    );
  return el("section", { class: "card panel failing-test" }, [head, ...body]);
}

/**
 * The runner's per-attempt AGENT-RUN evidence (tick.sh gaffer_record_agent_run): which
 * model served each delivery attempt and which Claude Code CLI ran it. Oldest first.
 * Only rows the runner itself recorded (actor type system) count: a delivery agent can
 * write a `log` row with any payload through record_ac_evidence, and its own claim
 * about which model ran is not provenance.
 */
function agentRuns(evidence) {
  const runs = [];
  for (const e of evidence || []) {
    if (e.evidence_type !== "log" || !e.payload_json) continue;
    if (e.recorded_by_actor_type !== "system") continue;
    const p = parseJsonSafe(e.payload_json);
    if (!p || p.kind !== "agent_run") continue;
    runs.push({ ...p, created_at: e.created_at });
  }
  return runs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
/**
 * The attempt a trail entry is the failure of. The runner files a failure under the
 * NEXT attempt's number (tick.sh `runner-rework --attempt $_next`), so trail attempt N
 * is the failure of attempt N-1. An entry numbered below 2 was not written that way and
 * keeps its own number; null when it has none.
 */
function failedAttempt(a) {
  const n = Number(a && a.attempt);
  if (!Number.isInteger(n)) return null;
  return n >= 2 ? n - 1 : n;
}
/**
 * The run behind a failure: the latest agent run recorded at or before the failure
 * whose attempt is the one that failed (trail attempt N → run N-1). Time order alone is
 * not enough: an attempt can fail before its agent is launched (agent-env-install), and
 * the run before that failure is then the PREVIOUS attempt's, not this one's. A failure
 * with no timestamp, or with no matching run before it, names no model rather than a
 * guessed one.
 */
function runForAttempt(runs, a) {
  if (!a || !a.created_at) return null;
  const at = String(a.created_at);
  const want = Number(a.attempt) >= 2 ? failedAttempt(a) : null;
  const before = runs.filter(
    (r) => r.created_at && String(r.created_at) <= at && (want === null || r.attempt === want),
  );
  return before.length ? before[before.length - 1] : null;
}
/**
 * When the current set of attempts began: the first run of the latest set, where a run
 * whose attempt number is not above the run before it starts a new set (an Unblock
 * resets the count and the runner numbers the next run 1). Null with one set only.
 */
function currentRoundStart(runs) {
  let start = null;
  let prev = null;
  for (const r of runs || []) {
    const n = Number(r.attempt);
    if (!Number.isInteger(n)) continue;
    if (prev !== null && n <= prev && r.created_at) start = String(r.created_at);
    prev = n;
  }
  return start;
}
/** "model X · CLI 1.2.3" — the model that served the run (else the one it asked for). */
function runLine(r) {
  const served = Array.isArray(r.models_served) && r.models_served.length ? r.models_served : null;
  const model = served ? served.join(", ") : r.model_requested || "default";
  return `Model ${model} · CLI ${r.claude_version || "unknown"}`;
}

/**
 * Attempts as a penalty shootout: one goal per attempt, the ball marked where the
 * delivery went wide, then the captured failure for each (collapsed: identical
 * failures are shown once above as the scoreline). Each attempt names the model and
 * the CLI version that ran it, from the agent-run evidence. Every run no failure is
 * paired with (the attempt that passed after a failed one, or the last go of a parked
 * ticket) follows the failures as its own row, so each run's model is on the page. A
 * ticket with runs but no failure gets the plain list of its attempts instead.
 */
function renderFailureHistory(trail, runs = []) {
  if ((!Array.isArray(trail) || trail.length === 0) && runs.length) return renderAgentRuns(runs);
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const max = trail[trail.length - 1].max_attempts;
  const attemptsLabel = trail.length === 1 ? "1 attempt" : `${trail.length} attempts`;
  const paired = new Set();
  for (const a of trail) {
    const r = runForAttempt(runs, a);
    if (r) paired.add(r);
  }
  // Oldest first (runs is sorted): the runs no failure accounts for.
  const unpaired = runs.filter((r) => !paired.has(r));
  // An Unblock gives a fresh set of attempts, and the runner numbers the next run 1
  // again: the header and the kicks count the CURRENT set, from the same agent-run rows
  // the run list labels its attempts by, and the earlier sets stay listed, marked.
  const since = currentRoundStart(runs);
  const current = (x) => !since || String(x.created_at || "") >= since;
  const used = trail.filter(current).length + unpaired.filter(current).length;
  const earlier = trail.length + unpaired.length - used;
  const goal = (i, taken = true) =>
    svgEl(
      "svg",
      {
        viewBox: "0 0 180 100",
        class: taken ? "shoot" : "shoot is-untaken",
        "aria-hidden": "true",
        focusable: "false",
      },
      [
        svgEl("rect", { x: 0, y: 0, width: 180, height: 100, class: "shoot-grass" }),
        svgEl("path", { d: "M20 100 V20 H160 V100", class: "shoot-post" }),
        ...Array.from({ length: 7 }, (_, k) =>
          svgEl("line", { x1: 20 + k * 20, y1: 20, x2: 20 + k * 20, y2: 100, class: "shoot-net" }),
        ),
        ...Array.from({ length: 4 }, (_, k) =>
          svgEl("line", { x1: 20, y1: 36 + k * 16, x2: 160, y2: 36 + k * 16, class: "shoot-net" }),
        ),
        taken
          ? // A miss: the ball off the frame, a cross beside it (position varies by attempt).
            svgEl(
              "g",
              { transform: `translate(${[150, 30, 160][i % 3]} ${[16, 14, 70][i % 3]})` },
              [
                svgEl("circle", { r: 11, class: "shoot-ball" }),
                svgEl("path", { d: "M-9 -9 L9 9 M9 -9 L-9 9", class: "shoot-x" }),
              ],
            )
          : // Not taken: the ball still on the spot.
            svgEl("circle", { cx: 90, cy: 86, r: 9, class: "shoot-ball is-spot" }),
      ],
    );
  return el("section", { class: "card failure-history" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, [
        "Attempts",
        el(
          "span",
          { class: "panel-aux" },
          (max
            ? `${Math.min(used, Number(max) || used)} of ${max} used`
            : used === 1
              ? "1 attempt"
              : `${used} attempts`) + (earlier ? `, ${earlier} before an Unblock` : ""),
        ),
      ]),
    ]),
    el(
      "p",
      { class: "dim failure-history-sub" },
      `Failure history (${attemptsLabel}), oldest first: what the runner recorded on each go.`,
    ),
    el(
      "ol",
      { class: "failure-trail" },
      // ONE children array: el() takes a single children argument, so rows passed as
      // further arguments were dropped (the "not taken" kicks never showed).
      [
        ...trail.map((a, i) => {
          const mx =
            typeof a.max_attempts === "number" && a.max_attempts > 0 ? `/${a.max_attempts}` : "";
          // Labelled with the attempt that FAILED (the trail files it one higher), so the
          // number matches its run's and the rows below it.
          const n = failedAttempt(a) ?? a.attempt;
          return el("li", { class: `failure-attempt${current(a) ? "" : " is-earlier"}` }, [
            goal(i),
            el("div", { class: "failure-attempt-head" }, [
              el("span", { class: "failure-attempt-num" }, `Attempt ${n}${mx}`),
              a.gate ? el("span", { class: "failure-gate" }, `${a.gate} failed`) : null,
              current(a) ? null : el("span", { class: "failure-round" }, "before the Unblock"),
              el("span", { class: "failure-attempt-time" }, fmtTime(a.created_at)),
            ]),
            (() => {
              const r = runForAttempt(runs, a);
              return r ? el("p", { class: "attempt-run mono" }, runLine(r)) : null;
            })(),
            el("details", { class: "failure-more" }, [
              el("summary", {}, "What it said"),
              // Untrusted captured tool output: a text node in a focusable, named <pre>.
              el(
                "pre",
                {
                  class: "failure-detail",
                  tabindex: "0",
                  role: "region",
                  "aria-label": `Attempt ${n} failure output`,
                },
                repoRelative(a.distilled_failure) || "(no detail captured)",
              ),
            ]),
          ]);
        }),
        // The runs no failure was recorded for, each with its model and CLI.
        ...unpaired.map((r) =>
          el("li", { class: `failure-run${current(r) ? "" : " is-earlier"}` }, [
            el("div", { class: "failure-attempt-head" }, [
              el(
                "span",
                { class: "failure-attempt-num" },
                r.attempt
                  ? `Attempt ${r.attempt}${r.max_attempts ? `/${r.max_attempts}` : ""}`
                  : "Run",
              ),
              r.rc ? el("span", { class: "failure-gate" }, `exit ${r.rc}`) : null,
              current(r) ? null : el("span", { class: "failure-round" }, "before the Unblock"),
              el("span", { class: "failure-attempt-time" }, fmtTime(r.created_at)),
            ]),
            el("p", { class: "attempt-run mono" }, runLine(r)),
            el("p", { class: "dim failure-run-note" }, "No failure recorded for this run."),
          ]),
        ),
        // The kicks still to come (or never taken, once the runner parked it).
        ...Array.from({ length: Math.max(0, (Number(max) || 0) - used) }, (_, k) =>
          el("li", { class: "failure-kick-none" }, [
            goal(used + k, false),
            el("div", { class: "failure-attempt-head" }, [
              el("span", { class: "failure-attempt-num" }, `Attempt ${used + k + 1}/${max}`),
              el("span", { class: "failure-attempt-time" }, "not taken"),
            ]),
          ]),
        ),
      ],
    ),
  ]);
}

/** Attempts with no failure on record: each run, its model and its CLI version. */
function renderAgentRuns(runs) {
  return el("section", { class: "card failure-history agent-runs" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, [
        "Attempts",
        el("span", { class: "panel-aux" }, runs.length === 1 ? "1 run" : `${runs.length} runs`),
      ]),
    ]),
    el(
      "p",
      { class: "dim failure-history-sub" },
      "Which model and which Claude Code CLI ran each attempt, oldest first.",
    ),
    el(
      "ol",
      { class: "agent-run-list" },
      runs.map((r) =>
        el("li", { class: "agent-run" }, [
          el(
            "span",
            { class: "failure-attempt-num" },
            r.attempt ? `Attempt ${r.attempt}${r.max_attempts ? `/${r.max_attempts}` : ""}` : "Run",
          ),
          el("span", { class: "attempt-run mono" }, runLine(r)),
          r.rc ? el("span", { class: "failure-gate" }, `exit ${r.rc}`) : null,
          el("span", { class: "failure-attempt-time" }, fmtTime(r.created_at)),
        ]),
      ),
    ),
  ]);
}

/** The ticket's epic as a cup run: rounds, this ticket highlighted, who waits on it. */
async function ticketEpicCard(t, scopes) {
  const epic = (scopes || []).find((s) => s.type === "epic");
  if (!epic) return null;
  const all =
    (
      await allTickets("", { signal: routeSignal() }).catch(() => ({
        tickets: [],
      }))
    ).tickets || [];
  const details = await ticketDetails(
    all.filter((x) => x.status !== "cancelled"),
    routeSignal(),
  );
  const members = all.filter((x) =>
    (details.get(x.id)?.scopes || []).some((s) => s.id === epic.id),
  );
  if (!members.length) return null;
  const deps = new Map(
    members.map((m) => [
      m.id,
      (details.get(m.id)?.dependencies || []).map((d) => d.depends_on_ticket_id),
    ]),
  );
  const byPhase = computePhases(members, deps);
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const waiting = members.filter(
    (m) => (deps.get(m.id) || []).includes(t.id) && m.status !== "done",
  );
  return el("section", { class: "card panel tk-epic" }, [
    panelHead(epic.name, null, { text: "Campaign", href: `#/epics/${epic.id}` }, { kit: "sky" }),
    el(
      "ol",
      { class: "tk-rounds" },
      phases.map((p, i) => {
        const ph = byPhase
          .get(p)
          .slice()
          .sort((a, b) => a.number - b.number);
        const final =
          i === phases.length - 1 &&
          phases.length > 1 &&
          ph.some((x) => /^Acceptance/i.test(x.title));
        return el("li", {}, [
          el("span", { class: "round-name" }, final ? "Final" : `Round ${i + 1}`),
          el(
            "ul",
            {},
            ph.map((x) =>
              el("li", { class: `tie st-${x.status}${x.id === t.id ? " is-here" : ""}` }, [
                el(
                  "a",
                  {
                    href: `#/ticket/${x.id}`,
                    "aria-current": x.id === t.id ? "page" : null,
                    "aria-label": `#${x.number} ${statusLabel(x.status, x.landing_state)}: ${x.title}`,
                  },
                  [
                    glyph(x.status, 16),
                    el("b", {}, `#${x.number}`),
                    el("span", { class: "tie-t" }, x.title),
                  ],
                ),
              ]),
            ),
          ),
        ]);
      }),
    ),
    waiting.length
      ? el("p", { class: OFF_PITCH.has(t.status) ? "tk-waits is-red" : "tk-waits" }, [
          OFF_PITCH.has(t.status) ? glyph("blocked", 14) : null,
          `${waiting.map((w) => "#" + w.number).join(", ")} ${waiting.length === 1 ? "waits" : "wait"} on #${t.number}.`,
        ])
      : null,
  ]);
}

/** Holds only a fresh review clears: the ticket page offers Back to review for them. */
const REVIEW_HOLDS = new Set(["moved_since_review", "unpinned_repo"]);

/**
 * "Your move" on an approved ticket, in its landing state's own words: never "the merge
 * runner has it" when nothing is landing it, and a hold's advice names an action the
 * page offers (Back to review, Send back to rework, Merge now, Mark merged).
 */
function approvedMoveWords(t, ref) {
  const ls = t.landing_state;
  const byHand = " Mark merged only if you merged the branch by hand.";
  if (!ls) return `Merge now lands it.${byHand}`;
  if (ls.kind === "held") {
    if (ls.hold === "moved_since_review")
      return `Held: the branch moved since the review approved it, so nothing lands it. Back to review sends ${ref} to Review to sign off the new commits; Send back to rework returns it to Refining.${byHand}`;
    if (ls.hold === "unpinned_repo")
      return `Held: the approval does not cover every repository, so it can never land as approved. Back to review sends ${ref} to Review to approve every repository together.${byHand}`;
    if (ls.hold === "merge_gate_red")
      return `Held: the merge gate failed on the current default branch, so nothing lands it until you look. Merge now runs the merge gate again (after a fix on the default branch); Send back to rework returns it to Refining.${byHand}`;
    if (ls.hold === "ci_red")
      return `Held: required CI failed for the commit that would land. Merge now tries again once CI passes; Send back to rework returns it to Refining.${byHand}`;
    return `${ls.label}. ${ls.detail}${byHand}`;
  }
  if (ls.kind === "partly_landed") return `Partly landed. ${ls.detail}`;
  if (ls.kind === "landing")
    return "The merge runner is landing it now; this page updates when it lands.";
  if (ls.kind === "lands_next_tick") return `${ls.detail} Merge now lands it at once.${byHand}`;
  return `Nothing lands it until you press Merge now.${byHand}`;
}

async function renderTicket(id) {
  if (!id) return renderWork();
  let view;
  try {
    view = await api("GET", `/tickets/${id}`);
  } catch (e) {
    // A missing ticket is not worth a retry: say so, and point back to the board.
    if (e && (e.status === 404 || e.code === "NOT_FOUND" || /not found/i.test(e.message || ""))) {
      return errorPage({
        code: "404",
        caption: "no such ticket",
        title: "No such ticket",
        lede: "There is no ticket at this address. It may have been a mistyped link. Every ticket is on the Work board.",
        actions: [el("a", { class: "btn primary", href: "#/work" }, "Open the Work board")],
      });
    }
    throw e;
  }
  await ensureAgents();
  const t = view.ticket;
  setDocTitle("ticket", `#${t.number} ${t.title}`, id);
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  const acList = view.acceptance_criteria || [];
  const blockers = view.blocking_decisions || [];
  const events = view.events || [];

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    backLink(detailBackHash, detailBackHash === "#/review" ? "Back to Review" : "Back to Work"),
  );

  const policyBox = el("div");

  // The action bar is driven OFF the single TICKET_ACTION_KEYS map (same map the
  // review surface uses), so "Mark ready" can never resurface where it shouldn't
  // (in_review / ready_for_merge / done). Each key maps to its concrete button.
  const actionButtons = {
    unblock: () =>
      el(
        "button",
        {
          class: "btn primary big",
          type: "button",
          onclick: () => {
            const ev = events.filter((e) => e.event_type === "ticket.blocked").pop();
            const reason = ev ? parseJsonSafe(ev.payload_json)?.reason || null : null;
            unblockSheet(t, { reason });
          },
        },
        t.status === "failed" ? "Send back…" : "Unblock…",
      ),
    mark_ready: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              try {
                const r = await api("POST", `/tickets/${t.id}/ready`);
                clear(policyBox);
                policyBox.appendChild(
                  el(
                    "div",
                    { class: "policy-result ok" },
                    `Policy passed — ticket is now ${statusLabel(r.ticket.status)}.`,
                  ),
                );
                toast("Ticket marked ready", { ok: true });
                router();
              } catch (e) {
                clear(policyBox);
                const box = el("div", { class: "policy-result fail" }, [
                  `Mark-ready failed: ${e.message}`,
                ]);
                // A policy refusal names its failed checks: say WHICH, not just "denied".
                const failed = e.details?.policy?.failures;
                if (Array.isArray(failed) && failed.length)
                  box.appendChild(
                    el(
                      "ul",
                      { class: "policy-failures" },
                      failed.map((f) =>
                        el("li", {}, [
                          f.message || f.code,
                          f.code ? el("span", { class: "toast-code" }, ` ${f.code}`) : null,
                        ]),
                      ),
                    ),
                  );
                if (e.code) box.appendChild(el("div", { class: "toast-code" }, e.code));
                policyBox.appendChild(box);
                // The toast says why too: the reason, not only "Policy … denied ready".
                const why = Array.isArray(failed)
                  ? failed.map((f) => f && (f.message || f.code)).filter(Boolean)
                  : [];
                if (why.length) {
                  toast(`Not marked ready: ${why.join(" ")}`, { code: e.code });
                  return;
                }
                throw e;
              }
            }),
        },
        "Mark ready",
      ),
    // A hold only a fresh review clears (the branch moved since the approval, or the
    // approval missed a repository): back to Review, through the reopen-for-review route.
    back_to_review: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title: "Send this approved ticket back to Review to sign off its current commits",
          onclick: () =>
            reasonSheet({
              title: `Back to review: ${ref}`,
              ticket: t,
              intro: `${ref} is held: ${(t.landing_state && t.landing_state.detail) || "its approval no longer covers what would land."} This moves it back to In review, the old approval stops counting, and you approve the current commits on the Review page.`,
              label: "Why back to review?",
              presets: ["The branch moved since review", "The approval missed a repository"],
              hint: "Required. It is kept on the ticket.",
              confirm: "Back to review",
              onConfirm: async (reason) => {
                await api("POST", `/tickets/${t.id}/reopen-for-review`, {
                  reason,
                  // The hold is the cause: the event says the branch moved (or the
                  // approval missed a repository), not that a conflict was resolved.
                  cause: (t.landing_state && t.landing_state.hold) || "other",
                  resolution:
                    "Sent back to review from the ticket page: review the current commits and approve again.",
                });
                toast(`${ref} is back in review.`, { ok: true });
                router();
              },
            }),
        },
        "Back to review",
      ),
    // Send an approved-and-merging ticket back for rework (-> refining); resets ACs.
    rework: () =>
      el(
        "button",
        {
          class: "btn",
          type: "button",
          title: "Send this ticket back for rework",
          onclick: () =>
            reasonSheet({
              title: `Send ${ref} back`,
              ticket: t,
              intro:
                t.status === "ready_for_merge"
                  ? `${ref} is approved but has not merged. This pulls it back to Refining with your reason, and its acceptance criteria reset to not met.`
                  : `${ref} goes back to Refining with your reason, and its acceptance criteria reset to not met.`,
              label: "What should change?",
              presets: REJECT_REASON_PRESETS,
              confirm: "Send back",
              onConfirm: async (reason) => {
                await api("POST", `/tickets/${t.id}/review/reject`, { to: "refining", reason });
                toast(`${ref} sent back to Refining.`, { ok: true });
                router();
              },
            }),
        },
        "Send back to rework",
      ),
    // Merge an approved ticket whose branch has not landed (the runner held the merge
    // gate, lite mode, or a merge attempt hit a conflict). Fires the merge runner —
    // the same one the Approve path uses — instead of marking done without code.
    tester_pass: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title:
            "Record a tester PASS for this in_testing ticket (→ in_review for your approval, or → ready_for_merge when an approval sent it to the tester). Use when you verified the acceptance criteria yourself or the tester lane is held.",
          onclick: () =>
            reasonSheet({
              title: `Tester pass ${ref}`,
              ticket: t,
              intro: `Records an independent tester PASS for ${ref}. It goes back to Review, where you approve the commit it was tested on (or to Ready for merge, when an approval sent it to the tester), and what you checked is kept as test evidence.`,
              label: "What did you check?",
              presets: [
                "Checked every acceptance criterion by hand",
                "Ran the black-box checks against a running build",
              ],
              hint: "Required. It is kept as the test evidence.",
              confirm: "Record PASS",
              onConfirm: async (summary) => {
                const r = await api("POST", `/tickets/${t.id}/tester`, {
                  verdict: "pass",
                  summary,
                });
                toast(
                  r && r.ticket && r.ticket.status === "in_review"
                    ? `Tester PASS recorded: ${ref} is back in Review for your approval.`
                    : `Tester PASS recorded: ${ref} is ready to merge.`,
                  { ok: true },
                );
                router();
              },
            }),
        },
        "Record tester PASS",
      ),
    tester_fail: () =>
      el(
        "button",
        {
          class: "btn",
          type: "button",
          title:
            "Record a tester FAIL for this in_testing ticket (→ refining; the failing observation becomes the rework feedback)",
          onclick: () =>
            reasonSheet({
              title: `Tester fail ${ref}`,
              ticket: t,
              intro: `Records an independent tester FAIL for ${ref}. It goes back to Refining, and what you saw becomes the rework feedback.`,
              label: "What failed?",
              presets: [
                "An acceptance criterion does not hold",
                "Breaks a flow that worked before",
                "Errors on empty or unusual input",
              ],
              hint: "Required. The next attempt reads it.",
              confirm: "Record FAIL",
              tone: "danger",
              onConfirm: async (summary) => {
                await api("POST", `/tickets/${t.id}/tester`, { verdict: "fail", summary });
                toast(`Tester FAIL recorded: ${ref} is back in Refining.`, { ok: true });
                router();
              },
            }),
        },
        "Record tester FAIL",
      ),
    merge_now: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title: "Merge the approved delivery branch now (runs the merge runner)",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/merge`);
              // A held landing stays held: say so, not "Merge started".
              const ls = t.landing_state;
              if (ls && ls.kind === "held") {
                const why = String(ls.label || "held").replace(/^Held · /, "");
                toast(
                  `${ref} is held (${why}): Merge now asked the merge runner to check again, and nothing lands while the hold stands.${REVIEW_HOLDS.has(ls.hold) ? " Back to review is the way on." : ""}`,
                );
              } else toast("Merge started — the board updates when it lands", { ok: true });
              router();
            }),
        },
        "Merge now",
      ),
    // Admin override: mark the ticket actually merged (ready_for_merge -> done).
    mark_merged: () =>
      el(
        "button",
        {
          class: "btn ok",
          type: "button",
          title: "Mark this ticket merged (admin override)",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/mark-merged`);
              toast("Marked merged — ticket done", { ok: true });
              router();
            }),
        },
        "Mark merged",
      ),
    wont_do: () =>
      el(
        "button",
        {
          class: "btn danger",
          type: "button",
          title: "Mark this ticket won't do (won't be built)",
          onclick: () => wontDoSheet(t),
        },
        "Won't do",
      ),
    reopen: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title: "Reopen this won't-do ticket into refining",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/reopen`, { to: "refining" });
              toast("Reopened to refining", { ok: true });
              router();
            }),
        },
        "Reopen → refining",
      ),
    // PAUSE-ON-CAP: re-enter delivery in the existing worktree. The factory loop
    // picks up resume-requested paused tickets and continues them in place.
    pause_continue: () =>
      el(
        "button",
        {
          class: "btn ok",
          type: "button",
          title: "Continue this paused delivery — the factory resumes it in its existing worktree",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/continue`, {});
              toast("Continue requested — the factory will resume this ticket", { ok: true });
              router();
            }),
        },
        "Continue",
      ),
    // PAUSE-ON-CAP: abandon the paused delivery (cancel; the next tick's sweep, or
    // Poll's, removes its worktree).
    pause_stop: () =>
      el(
        "button",
        {
          class: "btn danger",
          type: "button",
          title:
            "Stop this paused delivery: the ticket is cancelled and its worktree is removed on the next tick",
          onclick: () =>
            reasonSheet({
              title: `Stop ${ref}`,
              ticket: t,
              intro: `Abandons the paused delivery of ${ref}: the ticket is cancelled (Won't do) and its resume point is dropped, so it cannot carry on. Its worktree is removed on the next tick. Continue resumes it where it stopped instead.`,
              label: "Why stop it?",
              required: false,
              confirm: "Stop",
              tone: "danger",
              onConfirm: async (reason) => {
                await api("POST", `/tickets/${t.id}/stop`, reason ? { reason } : {});
                toast(
                  `Stopped ${ref}: it is cancelled; its worktree is removed on the next tick.`,
                  {
                    ok: true,
                  },
                );
                router();
              },
            }),
        },
        "Stop",
      ),
  };

  // No "merging…" pill: next to Merge now it read as a disabled button, and the merge
  // runner may be held. The status (its landing_state) and the lede say where it is.
  let markReadyBtn = null;
  const actionKeys = ticketActionKeys(t.status);
  const reviewHold =
    t.status === "ready_for_merge" && t.landing_state && REVIEW_HOLDS.has(t.landing_state.hold);
  const keys = reviewHold ? ["back_to_review", ...actionKeys] : actionKeys;
  const headActions = [
    ...keys.map((key) => {
      if (!actionButtons[key]) return null;
      const b = roLock(actionButtons[key](), "ticket");
      if (key === "mark_ready") markReadyBtn = b;
      return b;
    }),
  ].filter(Boolean);

  // PAUSE-ON-CAP banner: when a delivery is paused on a turn/budget cap, surface WHY
  // (reason + spend-so-far, read from the latest ticket.paused event) above the
  // Continue / Stop actions so the human can decide at a glance.
  const pausedBanner =
    t.status === "paused"
      ? (() => {
          const p = pausedInfo(events);
          const reasonLabel =
            p.reason === "budget_cap"
              ? "budget cap reached"
              : p.reason === "timeout"
                ? "hit the wall-clock timeout"
                : "hit the turn cap";
          const bits = [
            p.spend ? `spend so far ${p.spend}` : null,
            p.turns != null ? `${p.turns} turns` : null,
          ].filter(Boolean);
          return el("div", { class: "reopen-banner paused-banner" }, [
            icon("alert"),
            el("div", {}, [
              el("strong", {}, "Delivery paused — "),
              `${reasonLabel} mid-delivery. The worktree + branch are kept alive` +
                (bits.length ? ` (${bits.join(", ")})` : "") +
                ". Continue to resume in place, or Stop to abandon it.",
            ]),
          ]);
        })()
      : null;

  const trail = view.rework_trail || [];
  const repoW =
    (view.repositories || []).find((r) => r.access === "write") || view.repositories?.[0];
  const epicScope = (view.scopes || []).find((s) => s.type === "epic");
  const out = t.status === "blocked" || t.status === "failed";
  // Yellow: it waits on you (a sign-off, a merge, a capped delivery).
  const needsYou = ["in_review", "ready_for_merge", "paused"].includes(t.status);
  const doneAt = t.status === "done" ? sinceStatus(events, "done") || t.updated_at : null;
  const mark = out
    ? refCard("red", t.status)
    : needsYou
      ? refCard("yellow")
      : t.status === "done"
        ? fullTimePlaque(doneAt)
        : null;
  const head = el(
    "header",
    {
      class: `card tk-head tk-${t.status}${out ? " is-out" : ""}${mark ? " has-mark" : ""}`,
    },
    [
      mark,
      el("div", { class: "tk-head-main" }, [
        el("p", { class: "tk-meta" }, [
          statusBadge(t.status, t.landing_state),
          repoW ? repoTag(repoW.name, 20) : null,
          riskBadge(t.risk_level, { long: true }),
          // The acceptance ticket is its campaign's Final: say so where it is named.
          epicScope && isAcceptanceTicket(t) ? el("span", { class: "tk-final" }, "Final") : null,
          epicScope
            ? el("a", { class: "tk-epic-link", href: `#/epics/${epicScope.id}` }, epicScope.name)
            : null,
          t.policy_pack ? policyChip(t.policy_pack) : null,
          badge(`priority ${t.priority}`, "no-dot"),
          // TRACK-3a: the per-ticket delivery-budget ceiling, when set.
          t.delivery_budget_usd != null
            ? badge(`budget ${money(Number(t.delivery_budget_usd))}`, "no-dot")
            : null,
        ]),
        el("h1", { class: "detail-title" }, [
          el("span", { class: "tk-no" }, t.number != null ? `#${t.number}` : ""),
          t.number != null ? " " : "",
          t.title,
        ]),
        el("p", { class: "tk-lede" }, ticketLede(t, trail, events, doneAt, view.evidence || [])),
        el("div", { class: "tk-dots" }, [
          pipelineDots(t.status),
          el("span", { class: "tk-stage", "aria-hidden": "true" }, stageCaption(t.status)),
        ]),
      ]),
    ],
  );

  // Claimability only means something before a claim: never "Ready to claim" on a
  // blocked, done or in-flight ticket (the endpoint answers for the dependency gate).
  const claimable = ["ready", "draft", "refining"].includes(t.status);
  const claimBox = el("div", { class: "claim-box", dataset: claimable ? undefined : { off: "1" } });
  // The claimability read runs the same ready gate Mark ready would: when it will
  // refuse, Mark ready says so up front (disabled, the reasons in its title) instead
  // of waiting for the click. A dependency or a decision holds the claim, not the ready.
  claimBox._onClaim = (data) => {
    const btn = markReadyBtn;
    if (!btn || readOnly()) return;
    const gate = ((data && data.blockers) || []).filter(
      (b) => b && typeof b === "object" && !CLAIM_ONLY_BLOCKERS.has(b.code),
    );
    const refuses = data && data.ready === false && gate.length > 0;
    btn.disabled = refuses;
    if (refuses) {
      btn.setAttribute("aria-disabled", "true");
      btn.title = `Mark ready would be refused: ${gate.map((b) => b.message || b.code).join(" ")}`;
    } else {
      btn.removeAttribute("aria-disabled");
      btn.removeAttribute("title");
    }
  };
  if (claimable) loadClaimability(t.id, claimBox);

  // Your move: what the gaffer can do with this ticket now, in words, then the buttons.
  const moveWords = {
    blocked: `Unblock sends #${t.number} back to Ready so an agent can try again, or to Refining so you can rewrite it first. To brief the next attempt, sharpen an acceptance criterion.`,
    failed: `Send #${t.number} back to Ready for another go, or to Refining to rewrite it first.`,
    paused:
      "Continue resumes the delivery in its worktree; Stop cancels it, and its worktree is removed on the next tick.",
    in_review: "The sign-off is on the Review page: the diff, the flags and Approve.",
    ready_for_merge: approvedMoveWords(t, ref),
    in_testing: "The tester owns the verdict. Record it by hand only if you tested it yourself.",
    draft: "Mark it ready when its acceptance criteria say what done means.",
    refining: "Mark it ready when its acceptance criteria say what done means.",
    ready:
      "It waits in the fixtures for the next free agent. Nothing to do unless the plan changed.",
    cancelled: "Reopen it to bring it back to Refining.",
  };
  const moveActions = [
    t.status === "in_review"
      ? el("a", { class: "btn primary big", href: `#/review/${t.id}` }, "Review")
      : null,
    ...headActions,
  ].filter(Boolean);
  // One primary per view: the first filled action in Your move is THE move, in the
  // big display face like Unblock… and Review; any later filled one (Mark merged next
  // to Merge now, a second ok) reads as an ordinary button beside it.
  let movePrimary = false;
  for (const b of moveActions) {
    const filled = b.classList.contains("primary") || b.classList.contains("ok");
    if (!filled) continue;
    if (!movePrimary) {
      b.classList.remove("ok");
      b.classList.add("primary", "big");
      movePrimary = true;
    } else {
      b.classList.remove("primary", "ok", "big");
    }
  }
  const yourMove =
    t.status === "done"
      ? fullTimeCard(t, { trail, events, acList, doneAt })
      : moveActions.length || moveWords[t.status]
        ? el("section", { class: "card panel tk-move", "aria-label": "Your move" }, [
            panelHead("Your move", null, null, {
              kit: out || needsYou ? "claret" : "ink",
            }),
            moveWords[t.status] ? el("p", { class: "tk-move-t" }, moveWords[t.status]) : null,
            pausedBanner,
            el("div", { class: "btn-row" }, [
              ...moveActions,
              el("a", { class: "btn", href: `#/work?status=${t.status}` }, "See it on the board"),
            ]),
            policyBox,
            claimBox,
          ])
        : claimable
          ? el("div", { class: "tk-claim" }, [policyBox, claimBox])
          : null;

  const acCard = el("section", { class: "card panel tk-ac", "aria-label": "Acceptance criteria" }, [
    panelHead(
      "Acceptance criteria",
      `${acList.filter((a) => a.status === "satisfied").length} of ${acList.length} satisfied`,
    ),
    acList.length
      ? el(
          "ul",
          { class: "clean tk-ac-list" },
          acList.map((ac) =>
            el(
              "li",
              { class: `ac-${ac.status}` },
              el("div", { class: "ac-item" }, [
                glyph(
                  ac.status === "satisfied" ? "done" : ac.status === "failed" ? "failed" : "draft",
                  16,
                ),
                el("div", { class: "ac-text" }, [
                  el("div", {}, ac.text),
                  el(
                    "div",
                    { class: "ac-meta" },
                    [
                      ac.check_command
                        ? `check: ${ac.check_command}`
                        : ac.verification_method
                          ? `verify: ${ac.verification_method}`
                          : "no verification method",
                      ac.evidence_required ? " · evidence required" : "",
                      ac.check_command && ac.verified_by === "runner:check"
                        ? " · runner-verified"
                        : "",
                    ].join(""),
                  ),
                ]),
                el("span", { class: "ac-state" }, String(ac.status || "").replace(/_/g, " ")),
              ]),
            ),
          ),
        )
      : el("p", { class: "dim" }, "No acceptance criteria yet. Add the first below."),
    // A shipped or abandoned ticket's criteria are its record, not a to-do list.
    t.status === "done" || t.status === "cancelled" || readOnly()
      ? null
      : el("details", { class: "tk-add-ac", open: acList.length ? null : "" }, [
          el("summary", {}, "Add a criterion"),
          renderAddAcForm(t.id),
        ]),
  ]);

  // The boundary: which repos this ticket may write, read or test. Read-only once merged.
  const sideRepos = renderRepoPanel(t.id, claimBox, {
    readOnly: t.status === "done" || readOnly(),
    ticket: t,
  });

  // The diff: the delivery once it is in review (or shipped), and the work in
  // progress of a parked or capped delivery when it left a branch. Files fold
  // here (the file list is the way in); the Review page reads them open.
  const delivered =
    t.status === "in_review" ||
    t.status === "ready_for_merge" ||
    t.status === "done" ||
    reopenedForReview(events);
  const wip =
    !delivered &&
    Boolean(t.branch_name) &&
    ["blocked", "failed", "paused", "in_testing", "refining"].includes(t.status);
  const diffCard =
    delivered || wip
      ? el("section", { class: "tk-diff", "aria-label": "Diff" }, [
          el("h2", { class: "tk-h2" }, [
            t.status === "done" ? "What shipped" : wip ? "Work in progress" : "The delivery",
            el(
              "span",
              { class: "panel-aux" },
              t.status === "done" ? "merged" : wip ? "on its branch, not merged" : "on its branch",
            ),
          ]),
          reopenedForReview(events)
            ? el("div", { class: "reopen-banner" }, [
                icon("alert"),
                "Merge conflict resolved on the branch — re-review the resolved diff before re-approving.",
              ])
            : null,
          (t.status === "done" && shippedFiles(view.evidence || [])) ||
            reviewRawWatch(renderTicketDiff(t.id, null, { collapsed: true }), t, events),
        ])
      : null;

  const sideBlockers = blockers.length
    ? el("section", { class: "card panel tk-blockers", "aria-label": "Blocking decisions" }, [
        panelHead("Blocking decisions", String(blockers.length), null, { kit: "claret" }),
        el(
          "ul",
          { class: "clean tk-blocker-list" },
          blockers.map((d) =>
            el("li", {}, [
              ycard(18),
              el("div", {}, [
                el("strong", {}, d.title),
                el("div", { class: "ac-meta" }, `${d.severity} · ${d.status}`),
              ]),
            ]),
          ),
        ),
        el("a", { class: "panel-link", href: "#/overview" }, "Answer them on the team sheet"),
      ])
    : null;

  const sideFields = el("section", { class: "card panel tk-record", "aria-label": "The record" }, [
    panelHead("The record"),
    el("dl", { class: "kv" }, [
      el("dt", {}, "Branch"),
      el("dd", {}, t.branch_name ? el("code", { class: "mono" }, t.branch_name) : "—"),
      el("dt", {}, "PR"),
      el(
        "dd",
        {},
        t.pr_url
          ? el(
              "a",
              { href: safeHttpUrl(t.pr_url) || "#", target: "_blank", rel: "noopener" },
              "open",
            )
          : "—",
      ),
      el("dt", {}, "Deliveries"),
      // Same count as Full time's: each failed go on the rework trail, plus the
      // delivery that got through once it is past the pitch (attempt_count only
      // counts claims, so a parked ticket read "0" beside "3 attempts").
      el("dd", {}, String(Math.max(deliveryCount(t, trail), t.attempt_count || 0))),
      el("dt", {}, "Source"),
      el("dd", {}, t.source || "—"),
      el("dt", {}, "Created"),
      el("dd", {}, [fmtTime(t.created_at), t.created_by ? ` by ${t.created_by}` : ""]),
      el("dt", {}, "Updated"),
      el("dd", {}, fmtTime(t.updated_at)),
    ]),
  ]);

  // The brief: what the ticket asks for, and what it waits on.
  const deps = view.dependencies || [];
  const brief = el("section", { class: "card panel tk-brief", "aria-label": "The brief" }, [
    panelHead("The brief"),
    t.description
      ? el("p", { class: "desc" }, t.description)
      : el("p", { class: "desc dim" }, "No description."),
    el("h3", { class: "tk-h3" }, "Depends on"),
    deps.length
      ? el(
          "ul",
          { class: "clean tk-deps" },
          deps.map((d) =>
            el("li", { class: `st-${d.status}` }, [
              glyph(d.status, 16),
              // A ticket outside a scoped token's scope comes without its title (the
              // server leaves it out), and its page would be refused, so no link.
              d.outside_scope
                ? el("span", { title: scopeTitle() }, [
                    el("b", {}, `#${d.number}`),
                    " ",
                    el("span", { class: "dim" }, "outside this token's scope"),
                  ])
                : el("a", { href: `#/ticket/${d.depends_on_ticket_id}` }, [
                    el("b", {}, `#${d.number}`),
                    " ",
                    d.title,
                  ]),
              el("span", { class: "ac-state" }, statusLabel(d.status)),
            ]),
          ),
        )
      : el("p", { class: "dim" }, "Nothing. It can start on its own."),
  ]);

  const timeline = ticketMatchReport(events, view.repositories || []);

  // BBT-001: the independent black-box testing card — the testability toggle, the
  // test_contract (surfaces / deps / env / run / harness), and the tester's verdict
  // evidence. Rendered on every ticket so a PO can mark it testable + fill the
  // contract ahead of time; the contract surfaces/render the same way in_testing.
  const testingCard = roLockAll(renderTestingCard(t, view.evidence || []), "ticket");

  // FAILURE-DIAGNOSIS: the "why did #N fail" history — the full ordered rework
  // trail (attempt 1 → 2 → …) with the distilled failing test + assertion for each.
  const failureHistory = renderFailureHistory(trail, agentRuns(view.evidence));
  const failingTest =
    OFF_PITCH.has(t.status) || t.status === "refining" ? failingTestCard(trail) : null;
  const epicCard = el("div", { class: "tk-epic-slot" });
  ticketEpicCard(t, view.scopes)
    .then((c) => c && epicCard.replaceChildren(c))
    .catch(() => {});

  // PO-r2 #2: per-delivery memory attribution — what memory was primed into the agent
  // for this delivery, paired with the outcome (shipped clean vs needed rework).
  const memoryPrimed = memoryPrimedPanel(t, view.evidence || [], view.rework_trail || []);

  // The runner's logs for this ticket: live while it is on the pitch, else the record.
  const runs = ticketRunsPanel(t, events);

  // The evidence trail (reviewer-agent notes, the DoD checklist, AC check output…)
  // by who recorded it, so a ticket that left Review keeps it in view.
  const evidenceCard = ticketEvidenceCard(view.evidence || [], acList, view.repositories || []);

  const live = ["claimed", "in_progress"].includes(t.status);
  const main =
    t.status === "in_testing"
      ? [
          yourMove,
          testingCard,
          runs,
          failingTest,
          failureHistory,
          diffCard,
          evidenceCard,
          sideRepos,
          memoryPrimed,
        ]
      : live
        ? [runs, yourMove, failureHistory, evidenceCard, sideRepos, testingCard, memoryPrimed]
        : [
            yourMove,
            failingTest,
            failureHistory,
            diffCard,
            evidenceCard,
            runs,
            sideRepos,
            memoryPrimed,
            testingCard,
          ];

  // The live stream re-reads this page when the ticket itself changed (its status, a
  // landing, a criterion), and leaves it alone otherwise (see VIEW_SIGNATURES.ticket).
  wrap.dataset.sig = ticketSignature(view);
  wrap.appendChild(head);
  wrap.appendChild(
    el("div", { class: "detail-grid tk-grid" }, [
      el("div", { class: "tk-main" }, main),
      el("div", { class: "tk-side" }, [
        epicCard,
        sideBlockers,
        brief,
        acCard,
        regressionCard(t, view.regression),
        timeline,
        sideFields,
      ]),
    ]),
  );
  return wrap;
}

export { repoRelative, refCard, ticketLede, renderTicket };
