#!/usr/bin/env node
// Canned stand-in for runner/bin/decompose.mjs (GAFFER_DECOMPOSE_BIN, set by
// run-suites.sh): the same stdin/stdout contract, no model call. Reads
// { brief, history?, context?, forcePlan?, spec? } and answers ONE JSON object:
//   • first turn (no answers yet, no forcePlan, no spec) → two clarifying questions;
//   • otherwise a plan: three tickets, ticket 2 dependsOn ticket 1. A brownfield
//     request (context.repo) stamps that repo on every ticket; a spec-driven one
//     threads each requirement clause onto an AC as clauseRef. A brief that says
//     "greenfield" gets a bootstrap ticket first (the others depend on it).
// Every call is appended to $GAFFER_DATA/decompose-calls.jsonl for the suites.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const req = JSON.parse(readFileSync(0, "utf8") || "{}");
try {
  if (process.env.GAFFER_DATA)
    appendFileSync(
      path.join(process.env.GAFFER_DATA, "decompose-calls.jsonl"),
      JSON.stringify(req) + "\n",
    );
} catch {
  /* best-effort */
}
const history = Array.isArray(req.history) ? req.history : [];
// The panel sends the brief as the first user turn; an ANSWER is a user turn after
// the assistant asked its questions.
const asked = history.findIndex((h) => h && h.role === "assistant" && Array.isArray(h.questions));
const answered = asked >= 0 && history.slice(asked + 1).some((h) => h && h.role === "user");
const spec = Array.isArray(req.spec) ? req.spec : [];
const repo = String((req.context && req.context.repo) || req.repo || "").trim();
const out = (o) => {
  process.stdout.write(JSON.stringify(o) + "\n");
  process.exit(0);
};
if (!answered && req.forcePlan !== true && spec.length === 0)
  out({
    phase: "clarify",
    questions: ["Should completed tasks be archived or deleted?", "Does the list need sorting?"],
  });

const reqClauses = spec.filter((c) => c.kind === "requirement");
const ac = (text, i) => (reqClauses[i] ? { text, clauseRef: reqClauses[i].clause_id } : text);
const stamp = (t) => (repo ? { ...t, repo } : t);
const greenfield = /greenfield/i.test(String(req.brief || "")) && !repo;
const tickets = [
  stamp({
    title: "Add an archive helper for completed tasks",
    description: "archive(list) moves done tasks aside.",
    acceptanceCriteria: [ac("archive(list) returns the open tasks and the archived ones", 0)],
    dependsOn: [],
  }),
  stamp({
    title: "Show archived tasks count",
    description: "countArchived(list) for the header.",
    acceptanceCriteria: [ac("countArchived counts the archived tasks", 1)],
    dependsOn: [0],
  }),
  stamp({
    title: "Document the archive helpers",
    description: "README section.",
    acceptanceCriteria: ["the README names archive and countArchived"],
    dependsOn: [],
  }),
];
if (greenfield) {
  for (const t of tickets) t.dependsOn = [0, ...t.dependsOn.map((d) => d + 1)];
  tickets.unshift({
    title: "Bootstrap the task app",
    description: "a package.json and a passing test",
    acceptanceCriteria: ["the repo has a package.json whose test script passes"],
    bootstrap: true,
    dependsOn: [],
  });
}
out({
  phase: "plan",
  plan: {
    epic: {
      name: `Archive completed tasks${repo ? ` (${repo})` : ""}`,
      description: `Planned from: ${String(req.brief || "").slice(0, 120)}`,
    },
    tickets,
  },
});
