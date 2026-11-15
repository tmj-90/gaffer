#!/usr/bin/env node
// =====================================================================
// The prompt quarantine matrix (run by runner/test/prompt-quarantine.test.sh): for each
// agent prompt builder, every outside or agent-written field carries a hostile payload
// (lib/prompt-envelopes.mjs hostile) and must land inside exactly one envelope of its
// own tag, with that closing tag appearing exactly once (or once per repeated item) and
// no raw `<` between the tags.
// Prints one `ok` / `FAIL` line per prompt x field; exits 1 on any FAIL.
// =====================================================================
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEnvelope, hostile } from "./prompt-envelopes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..", "..");
let failed = 0;
function check(promptName, prompt, rows) {
  for (const [field, id, tag, n = 1, alsoIn = []] of rows) {
    const problems = checkEnvelope(prompt, id, tag, n, alsoIn);
    if (problems.length) {
      failed += 1;
      console.log(`  FAIL ${promptName} / ${field}: ${problems.join("; ")}`);
    } else console.log(`  ok   ${promptName} / ${field} inside <untrusted-${tag}>`);
  }
  if (!/&lt; inside these tags is a literal </.test(prompt)) {
    failed += 1;
    console.log(`  FAIL ${promptName}: no quarantine notice explaining &lt;`);
  } else console.log(`  ok   ${promptName}: carries the quarantine notice`);
}

// ── independent tester (bin/tester-run.mjs buildTesterPrompt) ──────────────────────
{
  const { buildTesterPrompt } = await import(resolve(RUNNER, "bin", "tester-run.mjs"));
  const prompt = buildTesterPrompt({
    context: {
      number: 7,
      ticketId: "t-7",
      title: hostile("title", "ticket-title"),
      description: hostile("description", "requirements"),
      mode: "harness",
      acceptanceCriteria: [{ id: "ac-1", text: hostile("criterion", "acceptance-criterion") }],
      testContract: {
        changed_surfaces: [hostile("surface", "test-contract")],
        runtime_deps: [hostile("dep", "test-contract")],
        env_vars: [hostile("env", "test-contract")],
        run_command: hostile("run_command", "test-contract"),
        harness_ready: false,
        profile: hostile("profile", "acceptance-profile"),
      },
    },
    worktree: "/tmp/wt",
    repoName: "app",
    missing: [hostile("need", "declared-need")],
  });
  check("tester", prompt, [
    ["title", "title", "ticket-title"],
    ["description", "description", "requirements"],
    ["criterion text", "criterion", "acceptance-criterion"],
    ["contract changed_surfaces", "surface", "test-contract"],
    ["contract runtime_deps", "dep", "test-contract"],
    ["contract env_vars", "env", "test-contract"],
    ["contract run_command", "run_command", "test-contract"],
    ["contract profile (its own line, and in the contract)", "profile", "acceptance-profile", 1, ["test-contract"]],
    ["declared need the runner does not know", "need", "declared-need"],
  ]);
  if (/<<<REQUIREMENTS|^REQUIREMENTS>>>$/m.test(prompt.replace(/MARK_[\s\S]*?PASS"\}/g, ""))) {
    failed += 1;
    console.log("  FAIL tester: the old REQUIREMENTS markers are still a delimiter");
  } else console.log("  ok   tester: no REQUIREMENTS marker delimiter outside the data");
}

if (failed) {
  console.log(`prompt-quarantine-matrix: ${failed} FAIL`);
  process.exit(1);
}
console.log("prompt-quarantine-matrix: all fields enveloped");
