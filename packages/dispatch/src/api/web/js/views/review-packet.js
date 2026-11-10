// The review packet: gate integrity, human asks, verdicts, impact, backing, the verdict strip.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock } from "../access.js";
import { api } from "../api.js";
import { actorName } from "../club.js";
import { splitDiffFiles } from "../diff.js";
import { clear, el } from "../dom.js";
import { fmtTime, money, moneyW, plural } from "../format.js";
import { icon, ycard } from "../icons.js";
import { router } from "../router.js";
import { viewRunLog } from "../runs.js";
import { closeSheet } from "../sheet.js";
import { actionSheet } from "../sheets.js";
import { riskBadge } from "../status.js";
import { guard, toast } from "../toast.js";
import { testerByline } from "./acceptance.js";
import { redCard } from "./epics.js";
import { parseDodEvidence } from "./review-comments.js";

// --- Gate integrity: the delivery changed the tests that decide it is done -----

/** The server's `test-modified` risk annotations across a diff's live repos. */
function testModifiedAnns(repos) {
  return (repos || [])
    .filter((r) => !r.unavailable)
    .flatMap((r) => (r.riskAnnotations || []).map((a) => ({ ...a, repo: r.repo })))
    .filter((a) => a.kind === "test-modified");
}

/** The runner's integrity row from the newest DoD evidence, when it FLAGged. */
function integrityFlagOf(evidence) {
  const dod = parseDodEvidence(evidence);
  if (!dod) return null;
  return dod.gates.find((g) => g.gate === "integrity" && g.status === "FLAG") || null;
}

/**
 * Allow (or withdraw) test changes on a ticket — a human's call, recorded as an event.
 * With it set, the runner's integrity row reads PASS with a note and the server no
 * longer holds an auto-approve for the test changes on their own.
 */
function allowTestChangesSheet(t, allow) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  const reason = el("textarea", {
    class: "input",
    rows: "2",
    maxlength: "500",
    "aria-label": "Why this ticket may change its tests",
    placeholder: "Why this ticket may change its tests (kept on the event)",
  });
  actionSheet(
    allow ? `Allow test changes on ${ref}` : `Withdraw the test-changes allowance on ${ref}`,
    {
      intro: allow
        ? "Only when the ticket asked for these test changes. The gate's integrity row will read PASS with a note on its next run, and the test changes alone no longer hold an agent's approve (they still count as medium risk, so a ticket declared low stays held). You still sign the change off here."
        : "Test changes on this ticket are flagged again, and an agent approve is held until a person looks.",
      body: allow ? reason : null,
      focus: allow ? reason : undefined,
      actions: [
        el(
          "button",
          {
            class: allow ? "btn primary" : "btn danger",
            type: "button",
            onclick: () =>
              guard(async () => {
                const why = allow ? reason.value.trim() : "";
                await api("POST", `/tickets/${t.id}/allow-test-changes`, {
                  allow_test_changes: allow,
                  ...(why ? { reason: why } : {}),
                });
                closeSheet();
                toast(
                  allow ? `Test changes allowed on ${ref}.` : `Allowance withdrawn on ${ref}.`,
                  {
                    ok: true,
                  },
                );
                router();
              }),
          },
          allow ? "Allow test changes" : "Withdraw allowance",
        ),
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      ],
    },
  );
}

/**
 * The Review banner for a delivery that changed its own tests: what changed (one line
 * per finding, from the server's `test-modified` annotation), what that means for the
 * auto-approve, and the human's allow / withdraw control. Empty when nothing changed.
 */
function integrityBanner(t, anns) {
  if (!anns.length) return null;
  const allowed = anns.every((a) => a.allowed);
  // One line per finding; the repo leads only when more than one repo changed tests.
  const many = new Set(anns.map((a) => a.repo)).size > 1;
  const items = anns.flatMap((a) =>
    (a.items && a.items.length ? a.items : [a.detail]).map((line) =>
      many ? `${a.repo}: ${line}` : line,
    ),
  );
  const shown = items.slice(0, 8);
  return el(
    "div",
    {
      class: `warn-box integrity-banner${allowed ? " is-allowed" : ""}`,
      role: allowed ? "status" : "alert",
      "aria-label": allowed
        ? "Test changes are allowed on this ticket."
        : "This delivery changed the tests that gate it.",
    },
    [
      icon("alert"),
      el("div", { class: "integrity-body" }, [
        el(
          "p",
          { class: "integrity-h" },
          allowed
            ? "Test changes are allowed on this ticket."
            : "This delivery changed the tests that decide it is done.",
        ),
        el(
          "ul",
          { class: "integrity-items" },
          [
            ...shown.map((line) => el("li", {}, line)),
            items.length > shown.length
              ? el("li", { class: "dim" }, `and ${items.length - shown.length} more`)
              : null,
          ].filter(Boolean),
        ),
        el(
          "p",
          { class: "integrity-note" },
          allowed
            ? "A person allowed it, so the gate reads PASS with a note from its next run. Check the changes are the ones the ticket asked for."
            : "A green gate proves less when its own tests changed. Auto-approve is held until a person looks.",
        ),
        // A read token sees the control switched off (the server refuses it anyway).
        roLock(
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: () => allowTestChangesSheet(t, !allowed),
            },
            allowed ? "Withdraw allowance…" : "Allow test changes…",
          ),
          "ticket",
        ),
      ]),
    ],
  );
}

/** One flag: a yellow card, a caps title, what it means, who raised it. */
function reviewFlag(title, body, source) {
  return el("li", { class: "flag" }, [
    ycard(22, "flag-card"),
    el("div", { class: "flag-body" }, [
      el("h3", { class: "flag-title" }, title),
      el("p", { class: "flag-text" }, body),
      source ? el("p", { class: "flag-src" }, source) : null,
    ]),
  ]);
}

/**
 * The evidence rows (and events) that ASK FOR A HUMAN before sign-off: the runner's
 * needs_human_review requests, a reviewer agent's CHANGES, a tester's FAIL or hold, a
 * merge-gate hold, a DoD FLAG gate, an observed-risk escalation, anything held "for a
 * human". The flags, the summary line and the warnings beside the button all read this
 * one list, built from the same rows the Evidence list renders, so the sign-off can never
 * say "Nothing flagged" over a request for a human further down the page.
 * Returns [{ id, title, detail, source, topic? }]; `id` is the evidence row's id (null for
 * events). `topic: "tests"` marks the GATE INTEGRITY asks (the runner's integrity FLAG, an
 * auto-approve held because the tests changed): one finding, which the diff's
 * `test-modified` flag and the test-changes banner say instead once the diff has loaded.
 */
const HUMAN_ASK_RULES = [
  [/^needs_human_review\b[:\s]*/i, "Runner asks for a human review", "Raised by the runner"],
  [
    /^Reviewer agent \(advisory\): changes requested\s*[—-]?\s*/i,
    "Reviewer asked for changes",
    "Raised by the reviewer agent",
  ],
  [/^tester held:\s*/i, "Tester held it for a human", "Raised by the tester lane"],
  [/^MERGE GATE FAILED:\s*/i, "Merge gate held it", "Raised by the merge gate"],
  [/^agent review could not run:\s*/i, "Agent review could not run", "Raised by the runner"],
  [/^PARKED\b[^:]*:\s*/i, "Parked for a human", "Raised by the runner"],
];
/**
 * ONE ROUND: where the ticket's CURRENT delivery attempt begins in its event log (the
 * latest claim, or a human taking it straight from Ready) and where it last entered
 * review, as event-log positions (-1: none on record). A request for a human recorded
 * before the attempt began was about an earlier attempt's code: that round's verdicts are
 * in the rework history, not asks of this sign-off. Each evidence row is placed by its
 * own `evidence.recorded` event, so the order is the log's, never a clock comparison
 * across tables (a row with no such event falls back to its timestamp).
 */
function roundMarks(events) {
  const list = events || [];
  const payload = (e) => {
    try {
      return JSON.parse(e.payload_json || "{}") || {};
    } catch {
      return {};
    }
  };
  let attempt = -1;
  let review = -1;
  const recordedAt = new Map();
  list.forEach((e, i) => {
    if (e.event_type === "evidence.recorded") {
      const id = payload(e).evidence_id;
      if (id) recordedAt.set(String(id), i);
      return;
    }
    if (e.event_type !== "ticket.transitioned") return;
    const p = payload(e);
    if (p.to === "claimed" || (p.to === "in_progress" && p.from !== "claimed")) attempt = i;
    if (p.to === "in_review") review = i;
  });
  /** Was evidence row `ev` recorded before the mark at log position `at`? */
  const before = (ev, at) => {
    if (at < 0) return false;
    const pos = recordedAt.get(String(ev.id));
    if (pos !== undefined) return pos < at;
    return Boolean(ev.created_at && ev.created_at < list[at].created_at);
  };
  return { attempt, review, before };
}
function humanAsks(evidence, events, dod) {
  const out = [];
  // ONE ROUND: only this attempt's requests ask anything of this sign-off. A reviewer
  // agent's advisory CHANGES is a verdict on what it reviewed, so it counts only since
  // the ticket last entered review (the Work card's rule, boardService.advisoryReview).
  const round = roundMarks(events);
  for (const ev of evidence || []) {
    const s = String(ev.summary || "");
    const first = s.split("\n")[0];
    const rule = HUMAN_ASK_RULES.find(([re]) => re.test(first));
    if (round.before(ev, round.attempt)) continue;
    if (rule && rule[1] === "Reviewer asked for changes" && round.before(ev, round.review))
      continue;
    let payload;
    try {
      payload = ev.payload_json ? JSON.parse(ev.payload_json) : null;
    } catch {
      payload = null;
    }
    if (rule) {
      const detail = first.replace(rule[0], "").trim() || first;
      out.push({ id: ev.id, title: rule[1], detail, source: rule[2] });
    } else if (payload && payload.verdict === "fail") {
      out.push({
        id: ev.id,
        title: "Tester asked for changes",
        detail: first,
        source: "Raised by the tester",
      });
    } else if (/\b(needs a human|held (?:[\w ]+ )?for a human)\b/i.test(first)) {
      out.push({
        id: ev.id,
        title: "Held for a human",
        detail: first,
        source: "Raised by the runner",
      });
    }
  }
  let integrityFlag = false;
  for (const g of (dod && dod.gates) || []) {
    if (String(g.status || "").toUpperCase() !== "FLAG") continue;
    const integrity = g.gate === "integrity";
    integrityFlag = integrityFlag || integrity;
    out.push({
      id: null,
      title: `Gate flagged: ${g.gate || "gate"}`,
      detail: g.note ? String(g.note) : "The Definition of Done flagged this gate for a human.",
      source: "Raised by the runner's gates",
      ...(integrity ? { topic: "tests" } : {}),
    });
  }
  (events || []).forEach((e, i) => {
    if (e.event_type !== "ticket.autoship_escalated") return;
    if (i < round.attempt) return;
    let p;
    try {
      p = JSON.parse(e.payload_json || "{}") || {};
    } catch {
      p = {};
    }
    // GATE INTEGRITY: an escalation for the tests changing is that finding, not a risk level
    // above the declared one; said once (the runner's integrity FLAG, when present, says it).
    if (Array.isArray(p.holds) && p.holds.length) {
      if (!integrityFlag)
        out.push({
          id: null,
          title: "Auto-approve held: tests changed",
          detail: `${p.holds.join("; ")}. An agent's or auto approval is held until a person looks; a human approval is not.`,
          source: "Raised by the gate-integrity check",
          topic: "tests",
        });
      return;
    }
    out.push({
      id: null,
      title: "Observed risk above declared",
      detail: `The real diff reads as ${p.observed || "unknown"} risk, above the declared ${p.declared || "risk"}${
        Array.isArray(p.reasons) && p.reasons.length ? `: ${p.reasons.join("; ")}` : ""
      }. Auto-approve was held for a human.`,
      source: "Raised by the observed-risk check",
    });
  });
  return out;
}

/**
 * The review packet's gate report in the DoD row's shape: the verdict strip's own rows
 * (the server's read of the runner's DoD record), so the flags, the summary and the
 * requests for a human never say something about the gates the strip contradicts.
 */
function packetDod(p) {
  const g = p && p.gates;
  if (!g) return null;
  return {
    dod: g.overall,
    gates: (g.rows || []).map((r) => ({
      gate: r.gate,
      repo: r.repo,
      status: r.status,
      note: r.note || r.command || "",
    })),
  };
}

/**
 * What an approval did when the server sent no `approve_outcome` (an older server): read
 * the new status and the merge result. Never says a merge is running unless one started.
 */
function approvedFallback(to, merge) {
  if (to === "in_testing")
    return { done_label: "Sent to tester", sentence: "It goes to the tester next." };
  if (merge && merge.triggered)
    return { done_label: "Landing now", sentence: "The merge runner is landing it now." };
  if (merge && merge.skipped === "auto_merge_off")
    return {
      done_label: "Waits for Merge now",
      sentence:
        "It waits in Ready for merge: Auto-merge on approval is off, so press Merge now to land it.",
    };
  return {
    done_label: "Ready for merge",
    sentence: "It waits in Ready for merge until the runner's merge lane or Merge now lands it.",
  };
}

// ── The review packet: the runner's facts, above the agent's words ──────────
// One GET /tickets/:id/dossier?include=packet per change, kept against the
// ticket's id@updated_at: a refresh that re-renders the page for another
// ticket's sake (the queue moved) reuses it, and a changed ticket reads it again.
const packetCache = new Map();
async function reviewPacketFor(t, signal) {
  const sig = `${t.id}@${t.updated_at || ""}`;
  const hit = packetCache.get(t.id);
  if (hit && hit.sig === sig) return hit.packet;
  const d = await api("GET", `/tickets/${t.id}/dossier?include=packet`, undefined, { signal });
  const packet = (d && d.review_packet) || null;
  if (packet) packetCache.set(t.id, { sig, packet });
  return packet;
}
/** Forget packets for tickets that left the queue (the cache never outgrows it). */
function prunePacketCache(tickets) {
  const live = new Set(tickets.map((t) => t.id));
  for (const id of packetCache.keys()) if (!live.has(id)) packetCache.delete(id);
}

const VD_WORD = { PASS: "passed", FAIL: "failed", FLAG: "flagged", SKIPPED: "skipped" };
/** One cell of the verdict strip: a caps label, the verdict, then its detail. */
function verdictCell(key, label, value, aria, body, tone = "") {
  return el(
    "div",
    {
      class: `vd-cell vd-${key}${tone ? ` vd-${tone}` : ""}`,
      role: "group",
      "aria-label": aria,
    },
    [
      el("p", { class: "vd-k" }, label),
      el("p", { class: "vd-v" }, value),
      el("div", { class: "vd-body" }, body),
    ],
  );
}
/** Who sent a delivery back, said plainly. */
function reworkWho(r) {
  if (r.by === "gate") return r.gate ? `the ${r.gate} gate` : "a gate";
  return r.by === "tester" ? "the tester" : "the review";
}
/** What a criterion's evidence is, said on its row (and in its label). */
function acEvidenceWords(a) {
  const c = a.check;
  if (a.evidence_kind === "runner" && c)
    return c.passed
      ? `The runner ran the check: exit ${c.exit_code ?? 0}`
      : `The runner ran the check and it failed: exit ${c.exit_code ?? "unknown"}`;
  if (a.evidence_kind === "human" && c)
    return `A person recorded the check result: exit ${c.exit_code ?? "unknown"}`;
  if (a.evidence_kind === "agent") return "No machine evidence: only the agent's word";
  return "No machine evidence: nothing recorded";
}

const JUDGE_DIM_LABEL = {
  ac_coverage: "Acceptance criteria",
  correctness: "Correctness",
  minimalism: "Smallest change",
  test_adequacy: "Tests",
  security: "Security",
};
const JUDGE_WORD = { pass: "Pass", borderline: "Borderline", fail: "Fail" };
/**
 * BLINDING: the judge's cell starts collapsed behind "Show the judge's view", with no
 * verdict, score or tone, so a reviewer who decides without opening it decides blind and
 * judge agreement can compare the grade with that decision. Opening it calls `onReveal`,
 * which records the reveal on the ticket and resolves to the grade (or rejects): the cell
 * draws the grade only from that answer, and says so plainly when it fails.
 * A view already opened this round (`revealedAt`) is drawn open.
 */
function judgeCell({ onReveal = null } = {}) {
  const btn = el(
    "button",
    { class: "btn small vd-judge-show", type: "button", "aria-expanded": "false" },
    "Show the judge's view",
  );
  // A failed reveal says so here, in the cell, and leaves the button to try again.
  const err = el("p", { class: "vd-sub vd-judge-err", role: "alert" });
  err.hidden = true;
  const cell = verdictCell(
    "judge",
    "Judge",
    btn,
    "Quality judge, advisory: hidden until you open it",
    [
      el(
        "p",
        { class: "vd-sub" },
        "Hidden until you open it, so your decision can be compared with the grade blind. Opening it before you decide is recorded.",
      ),
      err,
    ],
  );
  // review14/2: the packet holds no grade. The click asks the server to record the reveal
  // and return the grade in one request; the grade is drawn only from a 2xx answer, so a
  // reviewer never sees it while the reveal is unrecorded (and counted blind).
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Opening…";
    err.hidden = true;
    let jd;
    try {
      if (typeof onReveal !== "function") throw new Error("this page cannot open it");
      jd = await onReveal();
    } catch (e) {
      const why = String((e && e.message) || "the request failed").replace(/[.\s]+$/, "");
      err.textContent = `The judge's view could not be opened, so the grade stays hidden: ${why}.`;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Try again";
      return;
    }
    cell.replaceWith(
      jd
        ? judgeCellOpen(jd)
        : verdictCell(
            "judge",
            "Judge",
            "No grade",
            "Quality judge, advisory: no grade recorded",
            el("p", { class: "vd-sub" }, "The judge recorded no grade for this delivery."),
          ),
    );
  });
  return cell;
}

/**
 * The judge's cell, open: its verdict and score, then every dimension it scored 3 or
 * lower with its reason (lowest first), its one-line summary and the model.
 */
function judgeCellOpen(jd) {
  const score = Number(jd.score);
  const shown = Number.isFinite(score) ? score.toFixed(1) : "?";
  const weak = Object.entries(jd.dims || {})
    .filter(([, v]) => typeof v === "number" && v <= 3)
    .sort((a, b) => a[1] - b[1]);
  const why = jd.rationale || {};
  return verdictCell(
    "judge",
    "Judge",
    `${JUDGE_WORD[jd.overall] || jd.overall} ${shown}/5`,
    `Quality judge, advisory: ${jd.overall}, ${shown} of 5${
      weak.length ? `, ${plural(weak.length, "weak dimension")}` : ""
    }`,
    [
      weak.length
        ? el(
            "ul",
            { class: "clean vd-judge-dims" },
            weak.map(([d, v]) =>
              el("li", { class: "vd-judge-dim" }, [
                el("b", {}, `${JUDGE_DIM_LABEL[d] || d} ${v}/5`),
                why[d] ? [": ", el("span", { class: "vd-why" }, why[d])] : null,
              ]),
            ),
          )
        : el("p", { class: "vd-sub" }, "No dimension scored 3 or lower."),
      jd.summary ? el("p", { class: "vd-say" }, jd.summary) : null,
      el("p", { class: "vd-sub" }, [
        "A model's grade of the diff, not a check: nothing gates on it",
        jd.judge_model ? ` · ${jd.judge_model}` : "",
        jd.at ? ` · ${fmtTime(jd.at)}` : "",
      ]),
    ],
    jd.overall === "fail" ? "bad" : jd.overall === "borderline" ? "warn" : "",
  );
}

/**
 * The verdict strip under the title: gates, the independent tester, cost and
 * turns, attempts and rework, risk and its reasons, the reviewed-commit pin.
 * Each a recorded fact (see services/reviewPacketService.ts). `setRisk(anns)`
 * adds the diff's own risk annotations once the diff has loaded.
 */
/**
 * REVIEW FACTS (intent): what was asked, the ticket's description as the human wrote it,
 * above the runner's facts. Text only: a description is untrusted text.
 */
const INTENT_FOLD_CHARS = 600;
function intentBlock(intent) {
  const body = el(
    "p",
    { class: "rv-intent-t" },
    intent ||
      "The ticket has no description: the title and the acceptance criteria are all that was asked.",
  );
  const kids = [el("h2", { class: "rv-intent-h" }, "What was asked"), body];
  if (intent && intent.length > INTENT_FOLD_CHARS) {
    body.classList.add("is-folded");
    const more = el(
      "button",
      {
        type: "button",
        class: "btn-link rv-intent-more",
        "aria-expanded": "false",
        onclick: () => {
          const open = body.classList.toggle("is-folded") === false;
          more.setAttribute("aria-expanded", String(open));
          more.textContent = open ? "Show less" : "Show all of it";
        },
      },
      "Show all of it",
    );
    kids.push(more);
  }
  return el("section", { class: "rv-intent", "aria-label": "What was asked" }, kids);
}

/** The Behavioural surface's order: what callers see first, what was generated last. */
const IMPACT_ORDER = [
  "export_removed",
  "export_changed",
  "export_added",
  "symbol_callers",
  "route",
  "migration",
  "ddl",
  "config",
  "env_added",
  "env_removed",
  "dependency_added",
  "dependency_removed",
  "dependency_bumped",
  "untested_module",
  "downstream_repo",
  "generated",
];

/** "a, b or c". */
function orList(items) {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Open a file block of the Review diff (and its line, when the diff shows it). */
function goToDiffFile(targetId, line) {
  const block = document.getElementById(targetId);
  if (!block) return;
  block.open = true;
  const row = line != null ? block.querySelector(`.diff-line[data-ln="${Number(line)}"]`) : null;
  (row || block).scrollIntoView({ behavior: "smooth", block: row ? "center" : "start" });
  if (row) {
    row.classList.add("is-target");
    setTimeout(() => row.classList.remove("is-target"), 2400);
  }
}

/**
 * CHANGE IMPACT: the "Behavioural surface" panel above the diff, from each repo's
 * server-computed `impact` (GET /diff?include=impact). Every line says how it was found
 * and links to its file in the diff below; what the scan finds nothing of is said once,
 * and what it does not cover is said as not analysed. Advisory: nothing gates on it.
 * Null when no repo carries impact facts (an older server, or no diff).
 */
function impactPanel(repos) {
  const withImpact = (repos || []).map((rd, i) => ({ rd, i })).filter((x) => x.rd.impact);
  if (!withImpact.length) return null;
  const multi = withImpact.length > 1;
  const blocks = withImpact.map(({ rd, i }) => {
    const files = splitDiffFiles(rd.diff);
    const fileIdx = (p) => files.findIndex((f) => f.path === p);
    const facts = [...(rd.impact.facts || [])].sort(
      (a, b) => IMPACT_ORDER.indexOf(a.kind) - IMPACT_ORDER.indexOf(b.kind),
    );
    const goTo = (path, line) => {
      const idx = path ? fileIdx(path) : -1;
      const target = idx >= 0 ? `diff-file-${i}-${idx}` : null;
      return target
        ? el(
            "button",
            {
              type: "button",
              class: "btn-link rv-impact-go",
              dataset: { fileTarget: target },
              "aria-label": `Show ${path} in the diff`,
              onclick: () => goToDiffFile(target, line),
            },
            el("code", { class: "mono" }, `${path}${line != null ? `:${line}` : ""}`),
          )
        : el("code", { class: "mono" }, `${path}${line != null ? `:${line}` : ""}`);
    };
    // CALLERS (code index): the importers and tests a symbol_callers fact lists, each with
    // what is known about it. A file in this diff links to it; the rest are named.
    const refList = (refs) =>
      refs && refs.length
        ? el(
            "ul",
            { class: "clean rv-impact-refs" },
            refs.map((r) =>
              el("li", { class: `rv-impact-ref rv-ref-${r.role}` }, [
                el("small", { class: "dim" }, r.role === "test" ? "test " : "caller "),
                goTo(r.path, r.in_change ? null : r.line),
                r.through ? el("small", { class: "dim" }, ` through ${r.through}`) : null,
                r.in_change ? el("small", { class: "rv-ref-note" }, " changed here") : null,
                r.role === "caller" && r.tested === false
                  ? el("small", { class: "rv-ref-note rv-ref-untested" }, " no test imports it")
                  : null,
              ]),
            ),
          )
        : null;
    const list = el(
      "ul",
      { class: "clean rv-impact-list" },
      facts.map((f) => {
        const idx = f.path ? fileIdx(f.path) : -1;
        const target = idx >= 0 ? `diff-file-${i}-${idx}` : null;
        return el("li", { class: `rv-impact-fact rv-k-${f.kind}` }, [
          el("span", { class: "rv-impact-t" }, f.text),
          " ",
          el("small", { class: "rv-impact-method" }, f.method),
          target
            ? [
                " ",
                el(
                  "button",
                  {
                    type: "button",
                    class: "btn-link rv-impact-go",
                    dataset: { fileTarget: target },
                    "aria-label": `Show ${f.path} in the diff`,
                    onclick: () => goToDiffFile(target, f.line),
                  },
                  el("code", { class: "mono" }, `${f.path}${f.line != null ? `:${f.line}` : ""}`),
                ),
              ]
            : null,
          f.kind === "symbol_callers" ? refList(f.refs) : null,
        ]);
      }),
    );
    const none = rd.impact.none || [];
    const callers = rd.impact.callers;
    return el("div", { class: "rv-impact-repo" }, [
      multi
        ? el("h4", { class: "rv-impact-repo-h" }, el("code", { class: "mono" }, rd.repo))
        : null,
      facts.length
        ? list
        : el("p", { class: "dim" }, "The scan found nothing to list in this diff."),
      none.length ? el("p", { class: "rv-impact-none" }, `No ${orList(none)} change found.`) : null,
      callers && callers.status === "none_changed" && callers.reason
        ? el("p", { class: "rv-impact-none rv-impact-callers-none" }, `Callers: ${callers.reason}`)
        : null,
      ...(rd.impact.not_analysed || []).map((n) => el("p", { class: "rv-impact-na dim" }, n)),
    ]);
  });
  return el("section", { class: "card panel rv-impact", "aria-label": "Behavioural surface" }, [
    el("h3", { class: "rv-h3" }, "Behavioural surface"),
    el(
      "p",
      { class: "rv-impact-sub dim" },
      "Read from the diff and the tree at the head commit, each line with how it was found. Advisory: nothing gates on it.",
    ),
    ...blocks,
  ]);
}

/** The Behavioural surface's rows for "What is not backed" (changed modules with no test). */
function impactBacking(repos) {
  const n = (repos || []).reduce(
    (k, rd) =>
      k + ((rd.impact && rd.impact.facts) || []).filter((f) => f.kind === "untested_module").length,
    0,
  );
  if (!n) return [];
  // Of those, the ones the code index finds no test for on the base branch either.
  const bare = (repos || []).reduce(
    (k, rd) =>
      k +
      ((rd.impact && rd.impact.facts) || []).filter(
        (f) => f.kind === "untested_module" && f.index_tests === 0,
      ).length,
    0,
  );
  return [
    {
      fact:
        n === 1
          ? "1 changed module has no test in this change that imports it"
          : `${n} changed modules have no test in this change that imports them`,
      holds: false,
      source: "the Behavioural surface (by import text)",
      cell: "impact",
    },
    ...(bare
      ? [
          {
            fact:
              bare === 1
                ? "1 of them has no test on the base branch that imports it or is named for it either"
                : `${bare} of them have no test on the base branch that imports them or is named for them either`,
            holds: false,
            source: "the Behavioural surface (by import text, code index)",
            cell: "impact",
          },
        ]
      : []),
  ];
}

/** A commit id, short, in mono; or a plain word when there is none. */
function shaOr(sha, none) {
  return sha ? el("code", { class: "mono" }, String(sha).slice(0, 12)) : none;
}
/** Two commit ids name one commit (equal, or one a ≥7-hex prefix of the other). */
function sameSha(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The strip's Candidate cell: per write repo, the commit the gates ran on, the commit the
 * diff shows, the tester's commit and the pin, and whether they are one commit (the
 * server's `same`). Once the diff loads, `_setShown(repos)` checks the commit on screen
 * too. Its run-log links open the delivery and tester logs.
 */
function candidateCell(p, onRunLog) {
  const cands = p.candidate || [];
  const allSame = cands.every((c) => c.same);
  // Only the runner's own record says the gates ran on a commit: an agent's or a person's
  // record of the head is not shown to be one candidate, but it does not differ either.
  const notRunner = (c) => c.gated_by === "agent" || c.gated_by === "human";
  const unknown = cands.some((c) => !c.diff_head || !c.gated_sha || notRunner(c));
  // A rework entered review a moment before the runner recorded its gated commit (or that
  // record failed): the row still holds an earlier attempt's commit.
  const earlier = !unknown && cands.some((c) => c.gated_earlier);
  const multi = cands.length > 1;
  const sub = el("p", { class: "vd-sub vd-cand-sub" });
  const rows = el(
    "ul",
    { class: "clean vd-cand-list" },
    cands.map((c) =>
      el("li", { class: "vd-cand" }, [
        multi ? el("b", { class: "vd-cand-repo" }, c.repo) : null,
        el("span", { class: "vd-cand-row" }, [
          "Gates ran on ",
          shaOr(c.gated_sha, "no recorded commit"),
          c.gated_by === "agent"
            ? " (the agent's record)"
            : c.gated_by === "human"
              ? " (a person's record)"
              : c.gated_earlier
                ? " (an earlier attempt's record)"
                : "",
        ]),
        el("span", { class: "vd-cand-row vd-cand-shown" }, [
          "The diff shows ",
          shaOr(c.diff_head, c.head_unavailable ? `nothing (${c.head_unavailable})` : "nothing"),
        ]),
        el("span", { class: "vd-cand-row" }, [
          "Tested commit ",
          shaOr(c.tester_tested, p.tester_expected ? "none yet" : "none (no tester)"),
        ]),
        c.pin ? el("span", { class: "vd-cand-row" }, ["Pinned ", shaOr(c.pin, "")]) : null,
      ]),
    ),
  );
  const words = (state) =>
    state === "same"
      ? "The gates ran on the commit the diff shows, and any tested or pinned commit is that commit."
      : state === "moved"
        ? "The branch moved after these facts were read: the diff on screen is a newer commit."
        : unknown
          ? "Not every commit is known from the runner's record, so this is not shown to be one candidate."
          : earlier
            ? "The runner records the commit its gates ran on just after the ticket enters review, and this attempt's record is not in: the commit on record is an earlier attempt's. Reload in a moment."
            : "These are not one commit: a green gate or tester verdict is about another commit.";
  const value = (state) =>
    state === "same"
      ? "One commit"
      : state === "moved"
        ? "Moved"
        : unknown
          ? "Unknown"
          : earlier
            ? "Not recorded"
            : "Differs";
  let state = allSame ? "same" : "differs";
  sub.textContent = words(state);
  const links = (p.run_links || []).map((r) =>
    el(
      "button",
      {
        type: "button",
        class: "btn-link vd-runlink",
        dataset: { runId: r.run_id, role: r.role },
        title: `The dashboard run that was running then (${r.method}), started ${fmtTime(r.started_at)}`,
        onclick: () => {
          // A raw view: the review-time measure counts it (ticket.review_raw_opened).
          if (typeof onRunLog === "function") onRunLog();
          viewRunLog(
            { id: r.run_id, kind: r.kind },
            `${r.role === "tester" ? "Tester" : "Delivery"} run log`,
          );
        },
      },
      r.role === "tester" ? "View tester run log" : "View delivery run log",
    ),
  );
  // The runs table carries no ticket: say on screen how the link was found.
  const foundBy = links.length ? el("small", { class: "vd-runlink-by" }, " (found by time)") : null;
  const runLine = el("p", { class: "vd-sub vd-runlinks" }, [
    links.length
      ? ""
      : "No run log is recorded for this delivery (its runner was not started from the dashboard).",
    ...links.flatMap((a, i) => (i ? [" · ", a] : [a])),
    foundBy,
  ]);
  const cell = verdictCell(
    "candidate",
    "Candidate",
    value(state),
    `Candidate: ${value(state).toLowerCase()}`,
    [rows, sub, runLine],
    state === "same" ? "ok" : unknown || earlier ? "warn" : "bad",
  );
  cell._setShown = (repos) => {
    const moved = (repos || []).some((r) => {
      const c = cands.find((x) => x.repo_id === r.repoId);
      return c && r.headSha && c.diff_head && !sameSha(r.headSha, c.diff_head);
    });
    if (!moved) return;
    state = "moved";
    cell.querySelector(".vd-v").textContent = value(state);
    cell.setAttribute("aria-label", `Candidate: ${value(state).toLowerCase()}`);
    cell.classList.remove("vd-ok", "vd-bad");
    cell.classList.add("vd-warn");
    sub.textContent = words(state);
  };
  return cell;
}

/** The strip's CI cell: the latest recorded CI result for the candidate commit. */
function ciCell(ci) {
  if (!ci)
    return verdictCell(
      "ci",
      "CI",
      "None",
      "CI: no result recorded",
      el("p", { class: "vd-sub" }, "No CI result is recorded for this ticket."),
    );
  const v = { pass: "Green", fail: "Red", pending: "Running" }[ci.state] || "No result";
  const tone = { pass: "ok", fail: "bad" }[ci.state] || "warn";
  return verdictCell(
    "ci",
    "CI",
    v,
    `CI: ${v.toLowerCase()}${ci.commit ? ` for ${ci.commit.slice(0, 12)}` : ""}`,
    [
      el("p", { class: "vd-sub" }, [
        ci.state ? "Recorded for " : "Nothing recorded for ",
        shaOr(ci.commit, "the candidate commit (its head cannot be read)"),
        ci.at ? ` · ${fmtTime(ci.at)}` : "",
      ]),
      ci.detail ? el("p", { class: "vd-say" }, ci.detail) : null,
      !ci.state && ci.latest
        ? el("p", { class: "vd-sub" }, [
            `The latest result recorded is ${ci.latest.state} for `,
            shaOr(ci.latest.commit, ""),
            ".",
          ])
        : null,
      el("p", { class: "vd-sub" }, "Approval waits for a passing result for this commit."),
    ],
    tone,
  );
}

/** Where a backing row's fact is shown: its strip cell, the criteria table or the evidence. */
const BACKING_TARGET = {
  candidate: ".vd-cell.vd-candidate",
  gates: ".vd-cell.vd-gates",
  integrity: ".vd-cell.vd-gates",
  tester: ".vd-cell.vd-tester",
  ci: ".vd-cell.vd-ci",
  criteria: ".rv-ac-table, .rv-checks",
  evidence: ".rv-evid",
  impact: ".rv-impact",
};

/**
 * INSPECTABLE CONFIDENCE: "What backs this / What is not backed", the server's backing rows
 * (each a fact, whether it holds, and where it comes from) as two lists. No score, no
 * headline and no ask: the flags list stays the one list of things to check. Each row
 * links to where the fact is shown. `_setImpact(repos)` adds the Behavioural surface's
 * rows once the diff loads.
 */
function backingPanel(rows) {
  const holds = el("ul", { class: "clean rv-backing-list rv-backs" });
  const not = el("ul", { class: "clean rv-backing-list rv-unbacked" });
  const rowEl = (b) =>
    el("li", { class: `rv-backing-row ${b.holds ? "is-held" : "is-unheld"}` }, [
      el(
        "span",
        { class: `dod-mark dod-${b.holds ? "pass" : "skip"}`, "aria-hidden": "true" },
        b.holds ? "✓" : "–",
      ),
      el("span", { class: "rv-backing-fact" }, b.fact),
      el("small", { class: "rv-backing-src" }, b.source),
      BACKING_TARGET[b.cell]
        ? el(
            "button",
            {
              type: "button",
              class: "btn-link rv-backing-go",
              "aria-label": `Show where: ${b.fact}`,
              onclick: (e) => {
                const root = e.currentTarget.closest(".view-review") || document;
                const to = root.querySelector(BACKING_TARGET[b.cell]);
                if (to) to.scrollIntoView({ behavior: "smooth", block: "center" });
              },
            },
            "show",
          )
        : null,
    ]);
  const paint = (list) => {
    clear(holds);
    clear(not);
    for (const b of list) (b.holds ? holds : not).appendChild(rowEl(b));
    if (!holds.children.length)
      holds.appendChild(
        el("li", { class: "rv-backing-none dim" }, "No recorded fact backs it yet."),
      );
    if (!not.children.length)
      not.appendChild(el("li", { class: "rv-backing-none dim" }, "Every fact read here holds."));
  };
  let base = rows || [];
  paint(base);
  const panel = el("section", { class: "card panel rv-backing", "aria-label": "What backs this" }, [
    el("h2", { class: "rv-h2" }, "What backs this"),
    holds,
    el("h3", { class: "rv-h3" }, "What is not backed"),
    not,
  ]);
  panel._setImpact = (extra) => paint([...base, ...(extra || [])]);
  return panel;
}

function verdictStrip(p, hooks = {}) {
  const cells = [];

  // Gates: the runner's DoD rows, each with its command; the test count it saw.
  const g = p.gates;
  const gateBody = [];
  // A multi-repo delivery ran each gate once per repo: name the repo on every row, or
  // "tests passed" twice says nothing about which repo is which.
  const gateRepos = g
    ? new Set(g.rows.map((r) => r.repo).filter((x) => x && x !== "-"))
    : new Set();
  const multiRepo = gateRepos.size > 1;
  if (g) {
    gateBody.push(
      el(
        "ul",
        { class: "clean vd-gate-list" },
        g.rows.map((r) => {
          // GATE INTEGRITY: a FLAG is the yellow "!" of the gates checklist, never a skip.
          const st =
            r.status === "PASS"
              ? "pass"
              : r.status === "FAIL"
                ? "fail"
                : r.status === "FLAG"
                  ? "flag"
                  : "skip";
          return el("li", { class: `vd-gate vd-g-${st}` }, [
            el(
              "span",
              { class: `dod-mark dod-${st}`, "aria-hidden": "true" },
              { pass: "✓", fail: "✗", flag: "!", skip: "–" }[st],
            ),
            el("b", {}, r.gate),
            multiRepo && r.repo && r.repo !== "-"
              ? el("span", { class: "vd-gate-repo" }, r.repo)
              : null,
            el("span", { class: `vd-word vd-w-${st}` }, VD_WORD[r.status] || r.status),
            r.command
              ? el("code", { class: "vd-cmd mono" }, r.command)
              : r.note
                ? el("span", { class: "vd-note" }, r.note)
                : null,
          ]);
        }),
      ),
    );
    gateBody.push(
      el(
        "p",
        { class: "vd-sub" },
        g.tally
          ? `The runner saw ${plural(g.tally.passed, "test")} pass${
              g.tally.failed ? `, ${g.tally.failed} fail` : ""
            }${g.tally.skipped ? `, ${g.tally.skipped} skipped` : ""} (${g.tally.framework}).`
          : "The runner's test output carries no test count.",
      ),
    );
  } else gateBody.push(el("p", { class: "vd-sub" }, "The runner has recorded no gate report."));
  for (const d of p.disagreements || [])
    gateBody.push(el("p", { class: "vd-flag" }, [ycard(16), d.message]));
  // The integrity row checks the gates; it is not one of them (it never "ran" the work).
  const gateList = g ? g.rows.filter((r) => r.gate !== "integrity") : [];
  const ran = gateList.filter((r) => r.status !== "SKIPPED").length;
  cells.push(
    verdictCell(
      "gates",
      "Gates",
      g ? (g.overall === "PASS" ? "Passed" : "Failed") : "No report",
      g
        ? `Gates: ${g.overall === "PASS" ? "passed" : "failed"}, ${ran} of ${gateList.length} ran`
        : "Gates: no report recorded",
      gateBody,
      g ? (g.overall === "PASS" ? "ok" : "bad") : "warn",
    ),
  );

  // The independent tester: its verdict and what it tested, or when it comes.
  const ts = p.tester;
  // A PASS on a commit the branch has moved past is not a PASS of this commit (lane-hook
  // R3): the same comparison as the server's backing row, on any write repo's head, and
  // only when a head was read (otherwise the strip cannot tell).
  const cands = Array.isArray(p.candidate) ? p.candidate : [];
  const passMoved =
    ts &&
    ts.verdict === "pass" &&
    ts.tested_commit &&
    cands.some((c) => c.diff_head) &&
    !cands.some((c) => sameSha(ts.tested_commit, c.diff_head));
  // LANE-SETTING CONSISTENCY: the runner last routed under a lane that does not gate this
  // ticket, so "it tests before you review" is not what will happen (the flag says why).
  const runnerLane = p.tester_lane && p.tester_lane.runner;
  const runnerSkips = !!(runnerLane && p.tester_expected && !runnerLane.gates);
  cells.push(
    passMoved
      ? verdictCell(
          "tester",
          "Tester",
          "Not this commit",
          `Independent tester: passed ${ts.tested_commit.slice(0, 12)}, not tested on this commit`,
          [
            el("p", { class: "vd-sub" }, [
              "Passed ",
              el("code", { class: "mono" }, ts.tested_commit.slice(0, 12)),
              testerByline(ts),
              ` · ${fmtTime(ts.at)}`,
            ]),
            el(
              "p",
              { class: "vd-say" },
              "Not tested on this commit: the branch has moved past the commit the tester passed, and approval waits for a PASS on the new one.",
            ),
          ],
          "warn",
        )
      : ts && ts.waiver
        ? // A PERSON'S WAIVER (package H1): said as a waiver, with who, what and on which
          // commit, never as the tester's PASS.
          verdictCell(
            "tester",
            "Tester",
            "Waived",
            ts.waiver.label,
            [
              el("p", { class: "vd-sub" }, [`${fmtTime(ts.at)}`]),
              el("p", { class: "vd-say tester-waiver" }, ts.waiver.label),
            ],
            "warn",
          )
        : ts
          ? verdictCell(
              "tester",
              "Tester",
              ts.verdict === "pass" ? "Passed" : "Failed",
              `Independent tester: ${ts.verdict === "pass" ? "passed" : "failed"}${
                ts.tested_commit ? `, tested commit ${ts.tested_commit.slice(0, 12)}` : ""
              }`,
              [
                el("p", { class: "vd-sub" }, [
                  ts.tested_commit
                    ? ["Tested ", el("code", { class: "mono" }, ts.tested_commit.slice(0, 12))]
                    : "No commit recorded",
                  testerByline(ts),
                  ` · ${fmtTime(ts.at)}`,
                ]),
                el("p", { class: "vd-say" }, ts.summary),
              ],
              ts.verdict === "pass" ? "ok" : "bad",
            )
          : verdictCell(
              "tester",
              "Tester",
              p.tester_expected ? "Not yet" : "None",
              p.tester_expected
                ? "Independent tester: has not passed this commit yet"
                : "Independent tester: not used for this ticket",
              el(
                "p",
                { class: "vd-sub" },
                runnerSkips
                  ? `Approval waits for the independent tester's PASS, but the runner last routed with GAFFER_TESTING ${runnerLane.mode}, which does not send this ticket to the tester. See Flags.`
                  : p.tester_expected
                    ? "The independent tester tests a delivery before you review it, and approval waits for its PASS on the commit you sign."
                    : p.tester_lane &&
                        p.tester_lane.mode === "auto" &&
                        p.tester_lane.missing_test_command.length
                      ? `This ticket does not go through the independent tester: no test command is registered for ${p.tester_lane.missing_test_command.join(", ")}.`
                      : "This ticket does not go through the independent tester.",
              ),
            ),
  );

  // SAME CANDIDATE and REQUIRED CI (an older server's packet has neither).
  let candCell = null;
  if (Array.isArray(p.candidate) && p.candidate.length) {
    candCell = candidateCell(p, hooks.onRunLog);
    cells.push(candCell);
  }
  if ("ci" in p) cells.push(ciCell(p.ci));

  // Cost and turns so far, from the usage ledger (an estimate is said as one).
  const c = p.cost;
  const unknown = c.ledger_status === "unreadable";
  const untracked = c.ledger_status === "unconfigured" || c.ledger_status === "no_ticket";
  cells.push(
    verdictCell(
      "cost",
      "Cost",
      unknown ? "Unknown" : untracked ? "Not tracked" : money(c.cost_usd),
      unknown
        ? "Cost: unknown, the usage ledger could not be read"
        : untracked
          ? "Cost: not tracked, no usage ledger"
          : `Cost so far: ${money(c.cost_usd)} over ${plural(c.num_turns, "turn")}`,
      el("p", { class: "vd-sub" }, [
        unknown
          ? "The usage ledger could not be read."
          : untracked
            ? "No usage ledger is configured."
            : plural(c.num_turns, "turn"),
        !unknown && c.estimated_usd > 0 ? ` · ${money(c.estimated_usd)} of it estimated` : "",
        c.unknown_calls ? ` · ${plural(c.unknown_calls, "call")} unmeasured` : "",
        c.budget_usd != null ? ` · budget ${moneyW(c.budget_usd)}` : "",
      ]),
      unknown ? "warn" : "",
    ),
  );

  // Attempts and the rework history (latest three).
  const at = p.attempts;
  const rework = at.rework || [];
  cells.push(
    verdictCell(
      "attempts",
      "Attempt",
      `${at.attempt_count + 1} of ${at.max_attempts}`,
      `Attempt ${at.attempt_count + 1} of ${at.max_attempts}, sent back ${plural(rework.length, "time")}`,
      rework.length
        ? [
            el(
              "ol",
              { class: "clean vd-rework" },
              rework
                .slice(-3)
                .map((r) =>
                  el("li", {}, [
                    el("span", { class: "vd-when tabnum" }, fmtTime(r.at)),
                    ` Sent back by ${reworkWho(r)}: `,
                    el("span", { class: "vd-why" }, r.reason),
                  ]),
                ),
            ),
            rework.length > 3
              ? el("p", { class: "vd-sub" }, `${plural(rework.length - 3, "earlier send-back")}`)
              : null,
          ]
        : el("p", { class: "vd-sub" }, "First time through: nothing has sent it back."),
      rework.length ? "warn" : "",
    ),
  );

  // Risk: the declared level, the recorded reasons, then the diff's own flags.
  const riskList = el("ul", { class: "clean vd-reasons" });
  const riskSub = el("p", { class: "vd-sub" }, "Reading the diff's risk check…");
  const riskCell = verdictCell(
    "risk",
    "Risk",
    riskBadge(p.risk.level, { long: true }),
    `Risk: ${p.risk.level}`,
    [riskList, riskSub],
  );
  const paintRisk = (anns) => {
    clear(riskList);
    const reasons = [...p.risk.reasons, ...(anns || []).map((a) => a.detail)];
    for (const r of reasons) riskList.appendChild(el("li", {}, r));
    if (anns) riskSub.textContent = reasons.length ? "" : "The diff's risk check raised nothing.";
    riskSub.hidden = !riskSub.textContent;
    riskCell.setAttribute(
      "aria-label",
      `Risk: ${p.risk.level}${reasons.length ? `, ${plural(reasons.length, "reason")}` : ""}`,
    );
  };
  paintRisk(null);
  cells.push(riskCell);

  // The reviewed-commit pin, when one is recorded: landing merges only that commit.
  if (p.pin)
    cells.push(
      verdictCell(
        "pin",
        "Pinned",
        el("code", { class: "mono" }, p.pin.sha.slice(0, 12)),
        `Reviewed commit pinned: ${p.pin.sha.slice(0, 12)}`,
        el("p", { class: "vd-sub" }, [
          /^agent review/.test(p.pin.summary) ? "By the agent review" : "By a review",
          ` · ${fmtTime(p.pin.at)}. Only this commit can land.`,
        ]),
      ),
    );

  // EVAL JUDGE (the runner's opt-in judge): the quality judge's grade, when one was recorded for
  // this delivery. A model's opinion of the diff, not a runner fact: said as one, and no
  // gate reads it. Its weak dimensions carry the judge's own reasons.
  // BLINDING (review14/2): while the ticket is in review and nobody opened the judge's
  // view this round, the packet carries no grade (`judge_hidden`); the collapsed cell gets
  // it from the reveal request, which records the reveal first.
  const jd = p.judge;
  if (jd) cells.push(judgeCellOpen(jd));
  else if (p.judge_hidden) cells.push(judgeCell({ onReveal: hooks.onJudgeReveal }));

  const strip = el(
    "section",
    { class: "rv-verdict", "aria-label": "The runner's verdict" },
    el("div", { class: "vd-cells" }, cells),
  );
  strip._setRisk = paintRisk;
  strip._setShown = (repos) => candCell?._setShown(repos);
  return strip;
}

/**
 * The acceptance criteria as the runner sees them: each with its check command
 * and the runner's recorded exit code, or "no machine evidence" on a yellow card
 * when only the agent's word (or nothing) backs it.
 */
function acTable(rows) {
  return el("table", { class: "rv-ac-table" }, [
    el("caption", { class: "sr-only" }, "Acceptance criteria and the evidence behind each"),
    el(
      "thead",
      {},
      el("tr", {}, [
        el("th", { scope: "col" }, "Criterion"),
        el("th", { scope: "col" }, "Check"),
        el("th", { scope: "col" }, "Evidence"),
      ]),
    ),
    el(
      "tbody",
      {},
      rows.map((a) => {
        const kind = a.evidence_kind;
        const failed = a.check && !a.check.passed;
        const tone = kind === "runner" || kind === "human" ? (failed ? "bad" : "ok") : "none";
        const words = acEvidenceWords(a);
        return el(
          "tr",
          {
            class: `ac-ev ac-ev-${kind} ac-ev-${tone}`,
            "aria-label": `${a.text}: ${String(a.status).replace(/_/g, " ")}. ${words}.`,
          },
          [
            el("td", { class: "ac-ev-t" }, [
              el("span", {}, a.text),
              el("span", { class: "ac-state" }, String(a.status || "").replace(/_/g, " ")),
            ]),
            el(
              "td",
              { class: "ac-ev-cmd" },
              a.check_command
                ? el("code", { class: "mono" }, a.check_command)
                : el("span", { class: "dim" }, "No check command"),
            ),
            el(
              "td",
              { class: "ac-ev-what" },
              el("div", { class: "ac-ev-in" }, [
                tone === "ok"
                  ? el("span", { class: "dod-mark dod-pass", "aria-hidden": "true" }, "✓")
                  : tone === "bad"
                    ? redCard(16)
                    : ycard(16),
                el("span", { class: "ac-ev-word" }, [
                  kind === "runner" || kind === "human"
                    ? el("span", {}, [
                        el("b", {}, kind === "runner" ? "Runner" : "Person"),
                        ` · exit ${a.check.exit_code ?? "unknown"}`,
                      ])
                    : el("b", {}, "No machine evidence"),
                  el(
                    "small",
                    { class: "ac-ev-by" },
                    kind === "agent"
                      ? `The agent's word${a.verified_by ? ` (verified by ${actorName("agent", a.verified_by)})` : ""}`
                      : kind === "none"
                        ? "Nothing recorded"
                        : a.verified_by
                          ? `verified by ${a.verified_by}`
                          : fmtTime(a.check.at),
                  ),
                ]),
              ]),
            ),
          ],
        );
      }),
    ),
  ]);
}

export {
  testModifiedAnns,
  integrityFlagOf,
  integrityBanner,
  reviewFlag,
  humanAsks,
  packetDod,
  approvedFallback,
  reviewPacketFor,
  prunePacketCache,
  intentBlock,
  impactPanel,
  impactBacking,
  sameSha,
  backingPanel,
  verdictStrip,
  acTable,
};
