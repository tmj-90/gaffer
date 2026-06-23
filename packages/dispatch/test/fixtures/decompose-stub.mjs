#!/usr/bin/env node
// Test double for the runner `decompose` helper.
//
// The real helper reads {brief,history} on stdin and writes ONE JSON object to
// stdout. This stub does the same but its behaviour is driven entirely by the
// GAFFER_STUB_MODE env var so a single fixture covers every branch the
// planBuild runner must handle:
//
//   clarify   → a clarify turn (exit 0)
//   plan      → a plan turn whose tickets match the create_epic shape (exit 0)
//   error     → an error envelope on stdout + exit 1 (the helper's own failure)
//   badjson   → non-JSON on stdout (helper corruption)
//   crash     → stderr + non-zero exit, nothing on stdout (hard failure)
//   hang      → never exits (exercises the runner's timeout)
//   echo      → echoes the parsed stdin back inside a clarify turn (asserts the
//               brief + history actually reached the child over stdin)
//   echo-force→ echoes whether `forcePlan` reached the child over stdin

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

    case "plan":
      out({
        phase: "plan",
        plan: {
          epic: { name: "Gym tracker", description: "Track workouts" },
          tickets: [
            {
              title: "bootstrap repo",
              description: "scaffold the app",
              acceptanceCriteria: ["repo exists", "hello world builds"],
              priority: 10,
              repo: "gym-tracker",
              bootstrap: true,
              dependsOn: [],
            },
            {
              title: "workout model",
              description: "data model",
              acceptanceCriteria: ["model persists"],
              priority: 5,
              repo: "gym-tracker",
              dependsOn: [0],
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
      process.stderr.write("decompose blew up\n");
      process.exit(7);
      return;

    case "hang":
      // Never resolve — the runner's timeout must reap us.
      setInterval(() => {}, 1000);
      return;

    case "echo":
      out({
        phase: "clarify",
        questions: [JSON.stringify({ brief: input.brief, history: input.history })],
      });
      return;

    case "echo-context":
      // Echo back whatever `context` (extend-existing target) reached us on stdin,
      // so the runner test can assert it threads through unchanged (or is absent).
      out({ phase: "clarify", questions: [JSON.stringify({ context: input.context ?? null })] });
      return;

    case "echo-force":
      // Echo back whether `forcePlan` reached us on stdin (and that nothing leaks
      // when it is absent), so the runner test can assert it threads through.
      out({
        phase: "clarify",
        questions: [JSON.stringify({ forcePlan: input.forcePlan ?? null })],
      });
      return;

    case "echo-token":
      // Report whether the parent's DISPATCH_API_TOKEN leaked into our env.
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
