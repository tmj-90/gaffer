#!/usr/bin/env node
// Test double for the runner `spec-author` helper.
//
// The real helper reads {brief,history,context?,forcePlan?} on stdin and writes
// ONE JSON object to stdout. This stub does the same but its behaviour is driven
// entirely by the GAFFER_STUB_MODE env var so a single fixture covers every branch
// the specAuthor runner must handle:
//
//   clarify     → a clarify turn (exit 0)
//   spec        → a spec turn whose clauses match the create_spec shape (exit 0)
//   error       → an error envelope on stdout + exit 1 (the helper's own failure)
//   badjson     → non-JSON on stdout (helper corruption)
//   crash       → stderr + non-zero exit, nothing on stdout (hard failure)
//   hang        → never exits (exercises the runner's timeout)
//   echo        → echoes the parsed {brief,history} back inside a clarify turn
//   echo-context→ echoes whether `context` reached the child over stdin
//   echo-force  → echoes whether `forcePlan` reached the child over stdin
//   echo-token  → reports whether the parent's DISPATCH_API_TOKEN leaked into env

const mode = process.env.GAFFER_STUB_MODE || "clarify";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => run(raw));

function run(stdin) {
  let input;
  try {
    input = JSON.parse(stdin || "{}");
  } catch {
    input = {};
  }

  switch (mode) {
    case "clarify":
      out({ phase: "clarify", questions: ["Web or mobile?", "Which database?"] });
      return;

    case "spec":
      out({
        phase: "spec",
        spec: {
          clauses: [
            {
              clause_id: "c1",
              kind: "requirement",
              text: "The app tracks gym workouts per user.",
              rationale: "Core value.",
            },
            {
              clause_id: "c2",
              kind: "non-goal",
              text: "Social feed is out of scope for v1.",
            },
          ],
        },
      });
      return;

    case "error":
      process.stdout.write(JSON.stringify({ phase: "error", error: "brief too vague" }));
      process.exit(1);
      return;

    case "badjson":
      process.stdout.write("this is not json {");
      process.exit(0);
      return;

    case "crash":
      process.stderr.write("spec-author blew up\n");
      process.exit(7);
      return;

    case "hang":
      setInterval(() => {}, 1000);
      return;

    case "echo":
      out({
        phase: "clarify",
        questions: [JSON.stringify({ brief: input.brief, history: input.history })],
      });
      return;

    case "echo-context":
      out({ phase: "clarify", questions: [JSON.stringify({ context: input.context ?? null })] });
      return;

    case "echo-force":
      out({
        phase: "clarify",
        questions: [JSON.stringify({ forcePlan: input.forcePlan ?? null })],
      });
      return;

    case "echo-token":
      out({ phase: "clarify", questions: [`token:${process.env.DISPATCH_API_TOKEN ?? "ABSENT"}`] });
      return;

    default:
      out({ phase: "error", error: `unknown stub mode ${mode}` });
  }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
