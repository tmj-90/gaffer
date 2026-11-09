#!/usr/bin/env node
// runner/lib/review-head.mjs: what dispatch already knows about ONE delivered commit,
// read from a ticket view (`wg ticket show <n>` JSON on stdin) for the agent review
// pass (lib/review.sh). Read-only, no I/O beyond stdin/stdout, never throws on bad input.
//
//   reviewed <sha>     prints the agent reviewer's verdict (approve | changes) already
//                      recorded for that exact commit (its `ticket.lane_verdict`, lane
//                      agent-review, commit <sha>), or nothing. ONE AGENT REVIEW PER
//                      DELIVERED COMMIT: the pass does not pay for a second review of a
//                      head dispatch holds a verdict for. A held lane verdict is not a
//                      verdict (the reviewer did not run, or its run was discarded), and
//                      a security second opinion that was held on that head makes the
//                      review incomplete, so both leave the head reviewable again.
//   back <sha>         prints the agent reviewer's verdict (approve | changes) for that exact
//                      commit when the ticket came BACK into review on it after that verdict
//                      from anywhere but the tester (a rework that submitted no new commit,
//                      a reopen), or nothing. The commit is not reviewed again, so the pass
//                      acts on the recorded verdict or says on the ticket that it waits for
//                      a person, instead of leaving the ticket in review with nobody told.
//   tester-note <sha>  prints one line for the reviewer's packet: the independent
//                      tester's outcome for that exact commit (PASS or FAIL, where its
//                      tests are kept, its own summary), or the latest hold reason when
//                      its last run could not decide. Nothing when the tester has said
//                      nothing about the commit. The summary is the tester agent's own
//                      text: the caller quarantines the line before it reaches a prompt.
//
// Usage: wg ticket show <n> | node review-head.mjs reviewed|back|tester-note <sha>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const parse = (raw) => {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const asSha = (v) =>
  typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v.trim()) ? v.trim().toLowerCase() : "";
// A commit id names one commit: an abbreviated id matches the full one either way round.
const sameSha = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
const events = (view) => (Array.isArray(view?.events) ? view.events : []);

/** The agent reviewer's recorded verdict for `sha` (approve | changes), or "". */
export function reviewedVerdict(view, sha) {
  const want = asSha(sha);
  if (!want) return "";
  let verdict = "";
  for (const e of events(view)) {
    if (!e || e.event_type !== "ticket.lane_verdict") continue;
    const p = parse(e.payload_json);
    if (!sameSha(asSha(p.commit), want)) continue;
    if (p.lane === "agent-review") {
      verdict = p.verdict === "approve" || p.verdict === "changes" ? p.verdict : "";
    } else if (p.lane === "security-review" && p.verdict === "held") {
      // The second opinion on this head did not decide: the review of it is incomplete.
      verdict = "";
    }
  }
  return verdict;
}

/**
 * The recorded verdict for `sha` when the ticket re-entered review after it (a submit or a
 * reopen; the tester's PASS bringing it back is not a re-entry), or "" (see the header).
 */
export function backInReview(view, sha) {
  const want = asSha(sha);
  if (!want) return "";
  let verdict = "";
  let back = false;
  for (const e of events(view)) {
    if (!e) continue;
    if (e.event_type === "ticket.lane_verdict") {
      const p = parse(e.payload_json);
      if (!sameSha(asSha(p.commit), want)) continue;
      if (p.lane === "agent-review") {
        verdict = p.verdict === "approve" || p.verdict === "changes" ? p.verdict : "";
        back = false;
      } else if (p.lane === "security-review" && p.verdict === "held") {
        verdict = "";
      }
    } else if (e.event_type === "ticket.transitioned" && verdict) {
      const p = parse(e.payload_json);
      if (p.to === "in_review" && p.from !== "in_testing") back = true;
    }
  }
  return back ? verdict : "";
}

/** One line on the tester's outcome for `sha`, or "" (see the header). */
export function testerNote(view, sha) {
  const want = asSha(sha);
  if (!want) return "";
  const evidence = Array.isArray(view?.evidence) ? view.evidence : [];
  const number = view?.ticket?.number;
  let last = null;
  for (const e of events(view)) {
    if (e && (e.event_type === "ticket.tester_passed" || e.event_type === "ticket.tester_failed")) {
      last = e;
    }
  }
  const clip = (s, n) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  // A hold newer than the latest verdict: the tester's last run could not decide.
  const hold = evidence
    .filter((r) => r && /^tester held: /.test(String(r.summary ?? "")))
    .filter((r) => !last || String(r.created_at ?? "") > String(last.created_at ?? ""))
    .at(-1);
  if (hold) {
    return `the tester's latest run could not decide (held): ${clip(String(hold.summary).replace(/^tester held: /, ""), 400)}`;
  }
  if (!last) return "";
  const p = parse(last.payload_json);
  const row = evidence.find((r) => r && r.id === p.evidence_id);
  const binding = parse(row?.payload_json);
  const tested = asSha(p.tested_head) || asSha(binding.tested_commit);
  if (!sameSha(tested, want)) return "";
  const pass = last.event_type === "ticket.tester_passed";
  const parts = [`${pass ? "PASS" : "FAIL"} on this exact commit (${want.slice(0, 12)})`];
  const testsCommit = asSha(binding.tests_commit);
  const files = Array.isArray(binding.tests)
    ? [
        ...new Set(
          binding.tests.map((t) => (t && typeof t.file === "string" ? t.file : "")).filter(Boolean),
        ),
      ]
    : [];
  if (testsCommit) {
    parts.push(
      `its black-box tests are kept on gaffer-tests/ticket-${number ?? "?"} (commit ${testsCommit.slice(0, 12)}${files.length ? `; ${clip(files.slice(0, 8).join(", "), 300)}` : ""})`,
    );
  } else if (binding.tests_commit === "none") {
    parts.push("it kept no test files");
  }
  if (row?.summary) parts.push(`its summary: ${clip(row.summary, 500)}`);
  return parts.join("; ");
}

function main(argv) {
  const [cmd, sha] = argv;
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // no stdin: an empty view, so nothing is known about the commit
  }
  const view = parse(raw);
  if (cmd === "reviewed") process.stdout.write(reviewedVerdict(view, sha));
  else if (cmd === "back") process.stdout.write(backInReview(view, sha));
  else if (cmd === "tester-note") process.stdout.write(testerNote(view, sha));
  else {
    process.stderr.write(
      "usage: review-head.mjs reviewed|back|tester-note <sha> < ticket-view.json\n",
    );
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
