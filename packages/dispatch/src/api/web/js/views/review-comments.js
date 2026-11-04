// Review comments (A1), Fix these (A2), since your review (A3), the DoD and AC checklists.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentWho, readOnly, roLock } from "../access.js";
import { api } from "../api.js";
import { agentNames, squad } from "../club.js";
import { safeHttpUrl, splitDiffFiles } from "../diff.js";
import { el } from "../dom.js";
import { fmtTime, plural } from "../format.js";
import { clockTime } from "../freshness.js";
import { badge, glyph, ycard } from "../icons.js";
import { appState } from "../state.js";
import { toast } from "../toast.js";

// ===========================================================================
//  Review comments (A1), Fix these (A2), since your review (A3)
// ===========================================================================

/** Where a comment points, in words: repo:path:line, the file, or the whole change. */
function commentWhere(c) {
  if (!c.path) return "the whole change";
  const at = `${c.repo ? `${c.repo}:` : ""}${c.path}`;
  if (c.line == null) return `${at} (the file)`;
  return `${at}:${c.line}${c.side === "old" ? " (old side)" : ""}`;
}

/** The git-derived anchor tag of a comment written on an earlier revision. */
const ANCHOR_TAGS = {
  changed: ["anchor changed in this revision", "warn"],
  untouched: ["anchor untouched", "no-dot"],
  current: ["written on this revision", "no-dot"],
  unknown: ["anchor not checkable here", "no-dot"],
};

/**
 * One comment: severity, where it points, the body (a text node), its state, the git
 * anchor tag when it was written on an earlier revision, the delivery agent's replies
 * (labelled as what the agent says: a claim, never a resolution) and the reviewer's
 * Resolve / Reopen / Withdraw.
 */
function reviewCommentItem(c, { attempt = 0, onAct } = {}) {
  const earlier = typeof c.round === "number" && c.round < attempt;
  const tag = earlier && c.anchor_state ? ANCHOR_TAGS[c.anchor_state] : null;
  const act = (action, label, kind = "") =>
    roLock(
      el(
        "button",
        {
          class: `btn small ${kind}`.trim(),
          type: "button",
          dataset: { commentAct: action },
          onclick: () => onAct && onAct(c, action),
        },
        label,
      ),
      "ticket",
    );
  const actions =
    c.status === "open"
      ? [act("resolve", "Resolve"), act("withdraw", "Withdraw")]
      : [act("reopen", "Reopen")];
  return el(
    "li",
    {
      class: `rc-item is-${c.status} sev-${c.severity}`,
      dataset: { commentId: c.id },
    },
    [
      el("p", { class: "rc-head" }, [
        badge(
          c.severity === "must_fix" ? "Must fix" : "Consider",
          c.severity === "must_fix" ? "warn" : "no-dot",
        ),
        " ",
        el("code", { class: "mono rc-id" }, c.short_id || String(c.id).slice(0, 8)),
        " ",
        el("span", { class: "rc-where" }, commentWhere(c)),
        c.status !== "open" ? [" ", badge(c.status, "no-dot")] : null,
        tag
          ? [
              " ",
              el(
                "span",
                {
                  class: `badge rc-anchor ${tag[1]}`,
                  title:
                    "From git: the lines this comment points at, compared between the revision it was written on and this one.",
                },
                tag[0],
              ),
            ]
          : null,
      ]),
      el("p", { class: "rc-body" }, c.body),
      (c.agent_replies || []).map((r) =>
        el("p", { class: "rc-reply" }, [
          el("b", {}, "The agent says: "),
          r.summary,
          el("small", { class: "dim" }, " (its claim; only you resolve the comment)"),
        ]),
      ),
      el("p", { class: "rc-meta dim" }, [
        c.author_id ? `${c.author_id} · ` : "",
        earlier ? `written on attempt ${c.round + 1}` : "this attempt",
        c.sent_round != null ? " · sent back with Fix these" : "",
      ]),
      el("div", { class: "btn-row rc-actions" }, actions),
    ],
  );
}

/**
 * The inline comment form: a body, Must fix / Consider, Comment and Cancel. A typed draft
 * is a text field the refresh never throws away (viewHasTypedText).
 */
function reviewCommentComposer({ where, onSave, onCancel }) {
  const ta = el("textarea", {
    class: "rc-input",
    rows: "3",
    "aria-label": `Comment on ${where}`,
    placeholder: "What should change?",
  });
  const name = `rc-sev-${++appState.fieldSeq}`;
  const radio = (value, label, checked) =>
    el("label", { class: "rc-sev" }, [
      el("input", { type: "radio", name, value, checked: checked ? "" : null }),
      ` ${label}`,
    ]);
  let busy = false;
  const form = el(
    "form",
    {
      class: "rc-composer",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy) return;
        const body = ta.value.trim();
        if (!body) {
          ta.focus();
          return;
        }
        const sev = form.querySelector(`input[name="${name}"]:checked`);
        busy = true;
        try {
          await onSave(body, sev ? sev.value : "must_fix");
          form.remove();
        } catch (err) {
          toast((err && err.message) || "The comment was not saved.", { code: err && err.code });
        } finally {
          busy = false;
        }
      },
    },
    [
      el("p", { class: "rc-composer-h" }, ["Comment on ", el("b", {}, where)]),
      ta,
      el("div", { class: "rc-composer-row" }, [
        radio("must_fix", "Must fix", true),
        radio("consider", "Consider", false),
        el("span", { class: "grow" }),
        el("button", { class: "btn small primary", type: "submit" }, "Comment"),
        el(
          "button",
          {
            class: "btn small",
            type: "button",
            onclick: () => {
              form.remove();
              if (onCancel) onCancel();
            },
          },
          "Cancel",
        ),
      ]),
    ],
  );
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ta.value.trim() === "") {
      e.stopPropagation();
      form.remove();
      if (onCancel) onCancel();
    }
  });
  form._focus = () => ta.focus();
  return form;
}

/** The commentable row a diff line is (new side unless it only has an old number). */
function diffRowAnchor(row) {
  const pre = row && row.closest && row.closest(".diff-pre[data-path]");
  if (!pre) return null;
  const since = pre.dataset.since === "1";
  if (row.dataset.ln) return { pre, line: Number(row.dataset.ln), side: "new" };
  if (row.dataset.ol && !since) return { pre, line: Number(row.dataset.ol), side: "old" };
  return null;
}

/**
 * Put a comment button on every commentable line of the per-file diffs in `box`, and a
 * "Comment on this file" button above each file. One empty button per line (its label is
 * for a screen reader, its glyph is CSS), so a copied line is still only the line.
 */
function decorateCommentable(box, onLine, onFile) {
  if (!box) return;
  for (const pre of box.querySelectorAll(".diff-pre[data-path]")) {
    if (pre.dataset.cmt === "1") continue;
    pre.dataset.cmt = "1";
    for (const row of pre.querySelectorAll(".diff-line")) {
      const a = diffRowAnchor(row);
      if (!a) continue;
      const b = el("button", {
        class: "diff-cmt",
        type: "button",
        tabindex: "-1",
        "aria-label": `Comment on line ${a.line}${a.side === "old" ? " (old side)" : ""} of ${pre.dataset.path}`,
        onclick: (e) => {
          e.stopPropagation();
          onLine(row);
        },
      });
      roLock(b, "ticket");
      row.prepend(b);
    }
    if (onFile && pre.dataset.since !== "1") {
      const bar = el("div", { class: "rc-filebar" }, [
        roLock(
          el(
            "button",
            { class: "btn small", type: "button", onclick: () => onFile(pre, bar) },
            "Comment on this file",
          ),
          "ticket",
        ),
      ]);
      pre.before(bar);
    }
  }
}

/** True when the ticket's events show a merge-conflict-resolved reopen pending re-review. */
function reopenedForReview(events) {
  return (events || []).some((ev) => ev.event_type === "ticket.reopened_for_review");
}

// PAUSE-ON-CAP: pull the latest pause reason/spend/turns/branch off the events so the
// detail view's paused banner can explain WHY the delivery paused. Returns an empty
// shape when there is no pause event (defensive — the banner only renders for
// status === 'paused' anyway).
function pausedInfo(events) {
  const out = { reason: "cap_hit", spend: null, turns: null, branch: null };
  const paused = (events || []).filter((ev) => ev.event_type === "ticket.paused");
  const last = paused[paused.length - 1];
  if (!last) return out;
  let payload;
  try {
    payload = JSON.parse(last.payload_json || "{}");
  } catch {
    // Malformed payload — fall back to the defaults already in `out`.
    return out;
  }
  if (payload.reason) out.reason = payload.reason;
  if (payload.spend != null) out.spend = payload.spend;
  if (payload.turns != null) out.turns = payload.turns;
  if (payload.branch_name != null) out.branch = payload.branch_name;
  return out;
}

/**
 * Definition-of-Done checklist (I3). The runner records the enforced DoD verdict
 * as a `test_output` evidence row whose summary opens with `DoD: PASS|FAIL` and a
 * machine-parseable JSON line: {"dod","gates":[{gate,repo,status,rc,note}…]}.
 * Render the latest such row as a compact ✓/✗ checklist so the reviewer sees a
 * pre-verified board — and, for a failing gate, the captured `note`. A FAIL row
 * here means the delivery was AUTO-REJECTED before review; it lingers only as
 * history, but surfacing it keeps the gate honest. All text goes through text
 * nodes (el coerces strings) — never innerHTML — so it stays XSS-safe.
 */
function parseDodEvidence(evidence) {
  // The runner records the DoD row as the system actor; an agent-recorded row that
  // merely looks like one is the agent's word, never a gate verdict.
  const rows = (evidence || []).filter(
    (ev) =>
      ev.evidence_type === "test_output" &&
      ev.recorded_by_agent !== true &&
      typeof ev.summary === "string" &&
      ev.summary.startsWith("DoD: "),
  );
  if (rows.length === 0) return null;
  // Newest wins: the last attached DoD row reflects the current verdict.
  const summary = rows[rows.length - 1].summary;
  const jsonLine = summary.split("\n")[1] || "";
  try {
    const parsed = JSON.parse(jsonLine);
    if (!parsed || !Array.isArray(parsed.gates)) return null;
    return parsed;
  } catch {
    // A malformed/legacy row must never break the Review view — just skip it.
    return null;
  }
}

function dodChecklist(evidence) {
  const dod = parseDodEvidence(evidence);
  if (!dod) return null;
  const overall = dod.dod === "PASS" ? "PASS" : "FAIL";
  const items = dod.gates.map((g) => {
    const status =
      g.status === "PASS"
        ? "pass"
        : g.status === "FAIL"
          ? "fail"
          : g.status === "FLAG"
            ? "flag"
            : "skip";
    const mark = { pass: "✓", fail: "✗", flag: "!", skip: "–" }[status];
    const children = [
      el("span", { class: `dod-mark dod-${status}`, "aria-hidden": "true" }, mark),
      el("span", { class: "dod-gate" }, String(g.gate || "gate")),
      el("span", { class: "dod-repo ac-meta" }, String(g.repo || "")),
      el(
        "span",
        { class: `dod-word dod-w-${status}` },
        { pass: "passed", fail: "failed", flag: "flagged", skip: "skipped" }[status],
      ),
    ];
    // A tests gate that passed only on its rerun at concurrency 1 (lib/dod.sh): a yellow
    // card for the reviewer, and the note names both runs.
    if (g.flaky === true) {
      children.push(el("span", { class: "dod-flaky" }, "Flaky suspected"));
      if (g.note)
        children.push(el("span", { class: "dod-note dod-note-flaky ac-meta" }, String(g.note)));
      if (g.source) children.push(el("span", { class: "dod-src ac-meta" }, String(g.source)));
      return el("li", { class: `dod-item dod-i-${status} is-flaky` }, children);
    }
    // A passing gate names the command it ran; a failing one surfaces its captured note,
    // and the integrity row (gate integrity) says what it found in words.
    if ((status === "fail" || status === "flag" || g.gate === "integrity") && g.note) {
      children.push(el("span", { class: `dod-note dod-note-${status} ac-meta` }, String(g.note)));
    } else if (g.note) {
      children.push(el("code", { class: "dod-cmd mono" }, String(g.note)));
    }
    // Where the command's behaviour was read from (the base commit, for a script).
    if (g.source && g.gate !== "integrity")
      children.push(el("span", { class: "dod-src ac-meta" }, String(g.source)));
    return el("li", { class: `dod-item dod-i-${status}` }, children);
  });
  return el("div", { class: `review-dod dod-${overall === "PASS" ? "ok" : "bad"}` }, [
    el("div", { class: "ac-meta dod-cap" }, [
      "Definition of Done ",
      badge(overall === "PASS" ? "all gates green" : "gate failed", "no-dot"),
      dod.gates.some((g) => g.flaky === true) ? badge("flaky suspected", "no-dot") : null,
    ]),
    el("ul", { class: "clean dod-list" }, items),
  ]);
}

/** Acceptance criteria as a checklist: glyph · the criterion · its state. */
function acChecklist(acList) {
  return el(
    "ul",
    { class: "ac-list" },
    acList.map((a) =>
      el("li", { class: `ac-row ac-${a.status}` }, [
        glyph(a.status === "satisfied" ? "done" : a.status === "failed" ? "failed" : "draft", 16),
        el("span", { class: "ac-row-t" }, a.text),
        el("span", { class: "ac-state" }, String(a.status || "").replace(/_/g, " ")),
      ]),
    ),
  );
}

/** The evidence label a reviewer reads ("test output", "diff summary"). */
function evidenceKind(type) {
  return String(type || "note").replace(/_/g, " ");
}

/**
 * The evidence, oldest first, as a minute list: when · who (named, with the
 * agent-reported chip) · what kind · the first line of what it says. Longer
 * captures (a DoD report, a diff stat) fold their remaining lines.
 */
function reviewEvidenceList(evidence, acList, { repos, asks, onRawOpen } = {}) {
  if (!evidence || evidence.length === 0) return null;
  const acText = new Map((acList || []).map((a) => [a.id, a.text]));
  const rows = evidence
    .slice()
    .sort((x, y) => String(x.created_at || "").localeCompare(String(y.created_at || "")))
    .map((ev) => {
      const link = safeHttpUrl(ev.uri);
      const acLabel = ev.ac_id && acText.has(ev.ac_id) ? acText.get(ev.ac_id) : null;
      // Provenance — who recorded this evidence and when, plus an explicit flag
      // when it was SELF-REPORTED by a delivery agent so the reviewer weighs it with
      // due skepticism. `recorded_by_agent` is set server-side ONLY when the recording
      // actor is a KNOWN registered agent (a reliable positive signal); it is never
      // inferred from an absence, and no "trusted" label is fabricated. `created_by`
      // renders through el() as a text node, so it can never inject markup.
      const raw = ev.created_by ? String(ev.created_by) : "—";
      const who =
        squad.byId.get(raw)?.display_name_effective ||
        agentNames.get(raw) ||
        (raw === "system" ? "the runner" : raw);
      const provBadge =
        ev.recorded_by_agent === true ? badge("agent-reported", "no-dot prov-agent") : null;
      const asking = asks && asks.has(ev.id);
      const lines = String(ev.summary || "").split("\n");
      // A blocked-write note and absolute paths read as repo-relative paths.
      const say = (l) =>
        l
          .replace(/(\/[^\s\][,]+)/g, (m) => (m.split("/").length > 4 ? repoPath(m, repos) : m))
          .replace(
            /^FG-007 boundary violation\(s\) blocked by the safety hook during delivery:$/,
            "FG-007: the safety hook blocked a write outside the write roots",
          );
      const first = say(lines[0] || "");
      const rest = lines
        .slice(1)
        .filter((l) => l.trim())
        .map(say);
      return el("li", { class: asking ? "review-evi evi-asks" : "review-evi" }, [
        el(
          "time",
          {
            class: "evi-time tabnum",
            datetime: ev.created_at || "",
            title: ev.created_at ? fmtTime(ev.created_at) : null,
          },
          ev.created_at ? clockTime(Date.parse(ev.created_at)) : "—",
        ),
        el("div", { class: "evi-main" }, [
          el("div", { class: "ac-meta evi-prov" }, [
            el("span", { class: "evi-who" }, who),
            badge(evidenceKind(ev.evidence_type), "no-dot evi-kind"),
            provBadge,
            asking ? badge("asks for a human", "no-dot evi-ask") : null,
          ]),
          el("p", { class: "evi-summary" }, first),
          rest.length
            ? el(
                "details",
                {
                  class: "evi-more",
                  ontoggle: onRawOpen
                    ? (e) => {
                        if (e.currentTarget.open) onRawOpen();
                      }
                    : null,
                },
                [
                  el("summary", {}, `${plural(rest.length, "more line")}`),
                  el(
                    "pre",
                    {
                      class: "evi-pre",
                      tabindex: "0",
                      role: "region",
                      "aria-label": `${evidenceKind(ev.evidence_type)}, in full`,
                    },
                    rest.join("\n"),
                  ),
                ],
              )
            : null,
          acLabel ? el("p", { class: "ac-meta evi-ac" }, `for AC: ${acLabel}`) : null,
          link
            ? el(
                "a",
                {
                  class: "evi-link",
                  href: link,
                  target: "_blank",
                  rel: "noopener",
                  onclick: onRawOpen ? () => onRawOpen() : null,
                },
                "open",
              )
            : null,
        ]),
      ]);
    });
  return el("div", { class: "review-evidence" }, [el("ol", { class: "clean evi-list" }, rows)]);
}

// Preset quick-reject reasons. Tapping a chip fills the reason so an operator
// can reject one-handed on a phone without summoning a keyboard; the free-text
// field stays as a fallback for anything the chips don't cover.
const REJECT_REASON_PRESETS = [
  "Doesn't meet the spec",
  "Tests missing or failing",
  "Wrong approach",
  "Scope creep",
  "Needs cleanup first",
];
const WONT_DO_PRESETS = [
  "No longer needed",
  "Covered by another ticket",
  "Not worth the risk",
  "Out of scope for this campaign",
];

/**
 * Single source of truth for "is a blocking modal open right now?".
 *
 * The review gate's global j/k/a/r shortcuts (and any future global key
 * shortcut) MUST bail when this is true. Without it, a keystroke aimed at an
 * open dialog leaks through to the review queue underneath — the reject-reason
 * dialog is appended to `document.body` (NOT the app/view container the review
 * MutationObserver watches), so the gate's key handler never detaches while a
 * reject is in progress. Pressing `a` after tapping a reason chip would then
 * approve+merge `cards[cursor]` — potentially a DIFFERENT ticket than the one
 * being rejected. That is a reject-to-approve path through the exact human gate
 * this product exists to protect.
 *
 * Keyed on each modal's real open-signal so it can't leak or go stale:
 *   - reject dialog + move-menu are removed from the DOM on close → presence == open;
 *   - command palette + detail sheet persist and toggle an `.open` class.
 * Any modal added later should follow one of those two conventions (or be added
 * to this selector) so global shortcuts stay suppressed underneath it.
 */
function isModalOpen() {
  // Single source of truth for "a modal owns the keyboard" — must list EVERY modal scrim,
  // or the review hotkeys (a = approve+merge) leak through the ones it omits. `.pb-scrim`
  // covers both the Plan-a-build and Author-a-spec panels (they share the class).
  return Boolean(
    document.querySelector(
      ".reject-scrim, .movemenu-scrim, .palette-scrim.open, .sheet-scrim.open, .pb-scrim.open",
    ),
  );
}

/** Who delivered a ticket: the agent on its latest claim ({ id, name, no } or null). */
function deliveredBy(events) {
  const c = (events || []).filter((e) => e.event_type === "claim.created" && e.actor_id).pop();
  if (!c || !(squad.byId.has(c.actor_id) || agentNames.has(c.actor_id))) return null;
  return agentWho(c.actor_id);
}
/**
 * Who reviewed it: the ticket's assigned reviewer when that is a registered agent,
 * else the last reviewer-role agent that acted on it ({ id, name, no } or null).
 */
function reviewedBy(ticket, events) {
  const rid = ticket && ticket.reviewer;
  if (rid && squad.byId.has(rid)) return agentWho(rid);
  const REVIEW_ROLES = new Set(["reviewer", "security_reviewer"]);
  const e = (events || [])
    .filter((x) => x.actor_type === "agent" && x.actor_id)
    .filter((x) => REVIEW_ROLES.has(squad.byId.get(x.actor_id)?.role))
    .pop();
  return e ? agentWho(e.actor_id) : null;
}
/**
 * REVIEW TELEMETRY (Release A metrics): tell the server, once per ticket and review
 * round, that a person opened the ticket in Review (`what` empty) or opened a raw view
 * of it (`what`: run_log | evidence | full_diff). Health splits time in review into
 * queue wait and decision time with it. Best-effort and silent: a refusal (a read token
 * is refused before any request) or a network error loses one measurement, nothing else.
 */
const reviewOpensSent = new Set();
/**
 * On a ticket page, unfolding a file of a ticket in review's folded diff opens the full
 * diff outside the Review view: note it (full_diff). Returns `box` for inline use.
 */
function reviewRawWatch(box, t, events) {
  if (box && t && t.status === "in_review" && box.addEventListener)
    box.addEventListener(
      "toggle",
      (e) => {
        if (e.target && e.target.open && e.target.classList?.contains("diff-file-block"))
          noteReviewOpen(t.id, sinceStatus(events, "in_review"), "full_diff");
      },
      true,
    );
  return box;
}
function noteReviewOpen(ticketId, round, what = "") {
  if (!ticketId || !round || readOnly()) return;
  const key = `${ticketId}@${round}${what ? `#${what}` : ""}`;
  if (reviewOpensSent.has(key)) return;
  reviewOpensSent.add(key);
  const path = what
    ? `/tickets/${ticketId}/review-raw-opened`
    : `/tickets/${ticketId}/review-opened`;
  api("POST", path, what ? { what, round_entered_at: round } : { round_entered_at: round }).catch(
    () => {},
  );
}
/** When the ticket last moved into its current status (the wait starts there). */
function sinceStatus(events, status) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "ticket.transitioned") continue;
    try {
      if (JSON.parse(e.payload_json || "{}").to === status) return e.created_at;
    } catch {
      /* skip a malformed payload */
    }
  }
  return null;
}
/** The safety hook's blocked writes, from the FG-007 evidence note. */
function blockedWrites(evidence) {
  const out = [];
  for (const ev of evidence || []) {
    const s = String(ev.summary || "");
    if (!/^FG-007/.test(s)) continue;
    for (const line of s.split("\n").slice(1)) {
      // The hook writes "<why (…)>: <target> [write-roots: a, b]" or
      // "<why (…)>: <target> — "<cmd>"". The target is the first path after the
      // reason; the roots in brackets are where the ticket may write (the old
      // greedy match took the last root for the target).
      const m = line.match(/^BLOCKED[^:]*:\s*(.*?\)):\s*(\/[^\s\]]+)(.*)$/);
      if (m) {
        const roots = (m[3].match(/\[write-roots:\s*([^\]]*)\]/) || [])[1];
        out.push({
          why: m[1].trim(),
          path: m[2],
          roots: roots ? roots.split(/,\s*/).filter(Boolean) : [],
        });
      } else if (line.trim()) out.push({ why: line.trim(), path: null, roots: [] });
    }
  }
  return out;
}
/** A long absolute path, shortened to its last three parts. */
function shortPath(p) {
  const parts = String(p || "")
    .split("/")
    .filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : String(p || "");
}
/**
 * Files the diff changes that the delivering agent's smallest-change note does not
 * name. Gaffer has no out-of-scope field: this compares the note (manual_note
 * evidence "Smallest-change note: …") with the diff's own paths, and says so.
 * No note → no derivation (an empty answer, never a guess).
 */
function outsideStatedChange(evidence, repos) {
  const note = (evidence || [])
    .filter((e) => /^Smallest-change note:/i.test(String(e.summary || "")))
    .pop();
  if (!note) return [];
  const said = (String(note.summary).match(/[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.\w{1,6}/g) || []).map(
    (x) => x.replace(/\.+$/, ""),
  );
  if (!said.length) return [];
  const out = [];
  for (const rd of repos || []) {
    for (const f of splitDiffFiles(rd.diff)) {
      const p = f.path;
      if (!said.some((x) => x === p || p.endsWith("/" + x) || x.endsWith("/" + p)))
        out.push({ path: p, noteId: note.id });
    }
  }
  return out;
}
/** Card the diff's files that sit outside the stated change (file list + file block). */
function markOutsideFiles(box, outside) {
  if (!box || !outside.length) return;
  const set = new Set(outside.map((o) => o.path));
  for (const jump of box.querySelectorAll(".diff-filejump")) {
    const p = jump.querySelector(".diff-filejump-path")?.textContent;
    if (!set.has(p) || jump.classList.contains("has-risk")) continue;
    jump.classList.add("has-risk");
    const flag = jump.querySelector(".dfj-flag");
    if (flag && !flag.firstChild) flag.appendChild(ycard(14, "diff-file-risk"));
    jump.setAttribute(
      "aria-label",
      `${jump.getAttribute("aria-label")}, flagged (outside the stated change)`,
    );
    const block = box.querySelector(`[id="${jump.dataset.fileTarget}"]`);
    if (block && !block.classList.contains("is-flagged")) {
      block.classList.add("is-flagged");
      block
        .querySelector(".diff-file-summary")
        ?.after(
          el("p", { class: "diff-file-flag" }, [
            ycard(14),
            "Not in the agent's smallest-change note (derived; see the flag on the left).",
          ]),
        );
    }
  }
}
/** An absolute path inside a known repo, said as "repo/rel/path" (else shortened). */
function repoPath(p, repos) {
  const s = String(p || "");
  for (const r of repos || []) {
    const root = String(r.local_path || "").replace(/\/+$/, "");
    if (!root || !r.name) continue;
    if (s === root) return r.name;
    if (s.startsWith(root + "/")) return `${r.name}/${s.slice(root.length + 1)}`;
  }
  return shortPath(s);
}

export {
  commentWhere,
  reviewCommentItem,
  reviewCommentComposer,
  diffRowAnchor,
  decorateCommentable,
  reopenedForReview,
  pausedInfo,
  parseDodEvidence,
  dodChecklist,
  acChecklist,
  evidenceKind,
  reviewEvidenceList,
  REJECT_REASON_PRESETS,
  WONT_DO_PRESETS,
  isModalOpen,
  deliveredBy,
  reviewedBy,
  reviewRawWatch,
  noteReviewOpen,
  sinceStatus,
  blockedWrites,
  outsideStatedChange,
  markOutsideFiles,
  repoPath,
};
