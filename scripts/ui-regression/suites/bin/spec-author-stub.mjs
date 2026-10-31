#!/usr/bin/env node
// Canned stand-in for runner/bin/spec-author.mjs (GAFFER_SPEC_AUTHOR_BIN, set by
// run-suites.sh): the same stdin/stdout contract, no model call. First turn (no
// answer yet, no forcePlan) → one clarifying question; then a spec of three
// clauses: two requirements and a non-goal. Calls are appended to
// $GAFFER_DATA/spec-author-calls.jsonl.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const req = JSON.parse(readFileSync(0, "utf8") || "{}");
try {
  if (process.env.GAFFER_DATA)
    appendFileSync(
      path.join(process.env.GAFFER_DATA, "spec-author-calls.jsonl"),
      JSON.stringify(req) + "\n",
    );
} catch {
  /* best-effort */
}
// The panel sends the brief as the first user turn; an ANSWER is a user turn after
// the assistant asked its question.
const history = Array.isArray(req.history) ? req.history : [];
const asked = history.findIndex((h) => h && h.role === "assistant" && Array.isArray(h.questions));
const answered = asked >= 0 && history.slice(asked + 1).some((h) => h && h.role === "user");
const out = (o) => {
  process.stdout.write(JSON.stringify(o) + "\n");
  process.exit(0);
};
if (!answered && req.forcePlan !== true)
  out({ phase: "clarify", questions: ["Who archives tasks: the user or a timer?"] });
out({
  phase: "spec",
  spec: {
    clauses: [
      {
        clause_id: "c1",
        kind: "requirement",
        text: "archive(list) separates completed tasks from open ones",
        rationale: "the list stays short",
      },
      {
        clause_id: "c2",
        kind: "requirement",
        text: "countArchived(list) reports how many tasks were archived",
      },
      { clause_id: "c3", kind: "non-goal", text: "No automatic archiving on a timer" },
    ],
  },
});
