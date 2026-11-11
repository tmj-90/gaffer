#!/usr/bin/env node
// =====================================================================
// ONE settings rule for the shell and the Node writer.
// ---------------------------------------------------------------------
// External review 17: the shell writer (lib/agent-env.sh gaffer_write_agent_settings)
// grepped the rendered file for "PreToolUse" and the hook path ANYWHERE and counted
// "onFailure"/"timeout" across the whole file, while the Node writer
// (lib/agent-home.mjs writeAgentSettings) parsed the JSON. A custom template with the
// hook under another event and the word PreToolUse elsewhere passed the shell check
// and was refused by Node. Both entry points now apply lib/agent-settings.mjs: the
// rendered settings parse as JSON and carry the safety hook as a PreToolUse command
// hook covering every tool the hook decides, each entry with "onFailure": "block" and
// a timeout. This runs the SAME table of templates through both and requires the
// expected verdict from each.
// Run: node runner/test/agent-settings-rule.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { writeAgentSettings } from "../lib/agent-home.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");

let passed = 0;
const failures = [];
const assert = (label, ok) => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
};

const T = gafferMkdtemp(resolve(tmpdir(), "agent-settings-rule-"));
const HOOK = "node ${RUNNER_DIR}/safety-hook.mjs";
const ALL = "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|LS";
const entry = (matcher, extra = {}) => ({
  matcher,
  hooks: [{ type: "command", command: HOOK, timeout: 60, onFailure: "block", ...extra }],
});
const shipped = readFileSync(resolve(RUNNER_DIR, "claude", "settings.json"), "utf8");

// label → [template text, expected: true = accepted]
const TABLE = {
  "the shipped template": [shipped, true],
  "one entry covering every tool": [JSON.stringify({ hooks: { PreToolUse: [entry(ALL)] } }), true],
  'matcher "*" covers every tool': [JSON.stringify({ hooks: { PreToolUse: [entry("*")] } }), true],
  // The reviewer's case: the hook under another event, the word PreToolUse elsewhere.
  "hook under PostToolUse, PreToolUse only in a comment (the reviewer's case)": [
    JSON.stringify({ _comment: "PreToolUse", hooks: { PostToolUse: [entry(ALL)] } }),
    false,
  ],
  "a PreToolUse entry whose matcher covers nothing": [
    JSON.stringify({ hooks: { PreToolUse: [entry("NoSuchTool")] } }),
    false,
  ],
  "Read / write tools not covered (Bash only)": [
    JSON.stringify({ hooks: { PreToolUse: [entry("Bash")] } }),
    false,
  ],
  "Grep/Glob/LS not covered": [
    JSON.stringify({
      hooks: { PreToolUse: [entry("Bash|Write|Edit|MultiEdit|NotebookEdit|Read")] },
    }),
    false,
  ],
  "onFailure: block borrowed from an unrelated entry": [
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: ALL, hooks: [{ type: "command", command: HOOK, timeout: 60 }] },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "true", timeout: 5, onFailure: "block" }],
          },
        ],
      },
    }),
    false,
  ],
  "no timeout": [
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: ALL, hooks: [{ type: "command", command: HOOK, onFailure: "block" }] },
        ],
      },
    }),
    false,
  ],
  "hook path inside a _comment only": [
    JSON.stringify({
      _comment: `PreToolUse ${HOOK} "onFailure": "block" "timeout": 60`,
      hooks: {},
    }),
    false,
  ],
  "not JSON": ['{"hooks": {"PreToolUse": [ ' + HOOK, false],
  "no hooks at all": [JSON.stringify({ permissions: {} }), false],
};

/** Shell verdict: gaffer_write_agent_settings into a fresh dir with this template. */
function shellVerdict(path, dir) {
  const script = [
    '_gaffer_sed_repl() { printf "%s" "$1" | sed -e "s/[\\\\&#]/\\\\&/g"; }',
    'RUNNER_DIR="$1"; CLAUDE_SETTINGS="$2"',
    'source "$RUNNER_DIR/lib/agent-env.sh"',
    'gaffer_write_agent_settings "$3"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script, "x", RUNNER_DIR, path, dir], { encoding: "utf8" });
  return {
    accepted: r.status === 0,
    file: existsSync(join(dir, ".claude", "settings.json")),
    err: r.stderr,
  };
}

/** Node verdict: writeAgentSettings into a fresh .claude with this template. */
function nodeVerdict(path, dir) {
  const claudeDir = join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  try {
    writeAgentSettings(claudeDir, path);
    return { accepted: true, file: existsSync(join(claudeDir, "settings.json")) };
  } catch (err) {
    return {
      accepted: false,
      file: existsSync(join(claudeDir, "settings.json")),
      err: err.message,
    };
  }
}

let i = 0;
for (const [label, [text, expected]] of Object.entries(TABLE)) {
  i += 1;
  const path = join(T, `t${i}.json`);
  writeFileSync(path, text);
  const sh = shellVerdict(path, join(T, `sh${i}`));
  const nd = nodeVerdict(path, join(T, `nd${i}`));
  const want = expected ? "accepted" : "refused";
  assert(`${label}: shell ${want}`, sh.accepted === expected);
  assert(`${label}: node ${want}`, nd.accepted === expected);
  assert(
    `${label}: a settings file exists only when accepted (both)`,
    sh.file === expected && nd.file === expected,
  );
  if (!expected) {
    assert(
      `${label}: the shell refusal says SAFETY ... fail closed`,
      /SAFETY: .*fail closed/.test(sh.err || ""),
    );
  }
}

// The runner directory as the shell hands it over is not always normalised (factory.config.sh
// keeps an inherited RUNNER_DIR, a trailing slash included). The old shell check grepped for
// the raw "$RUNNER_DIR/safety-hook.mjs" and accepted it; the shared rule must too, from both
// entry points, or every shell-launched agent is refused.
{
  const shipPath = resolve(RUNNER_DIR, "claude", "settings.json");
  const dir = join(T, "slash-sh");
  const script = [
    'RUNNER_DIR="$1"; CLAUDE_SETTINGS="$2"',
    'source "$RUNNER_DIR/lib/agent-env.sh"',
    'gaffer_write_agent_settings "$3"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script, "x", `${RUNNER_DIR}/`, shipPath, dir], {
    encoding: "utf8",
  });
  assert(
    "a RUNNER_DIR with a trailing slash: the shell writer accepts the shipped template",
    r.status === 0 && existsSync(join(dir, ".claude", "settings.json")),
  );
  const { writeVerifiedSettings } = await import("../lib/agent-settings.mjs");
  const nd = join(T, "slash-nd");
  mkdirSync(nd, { recursive: true });
  let ok = true;
  try {
    writeVerifiedSettings(nd, ".claude/settings.json", shipPath, `${RUNNER_DIR}/`);
  } catch {
    ok = false;
  }
  assert("a runner dir with a trailing slash: the Node writer accepts the shipped template", ok);
}

rmSync(T, { recursive: true, force: true });
console.log();
if (failures.length === 0) {
  console.log(`agent-settings-rule: ALL ${passed} checks passed`);
} else {
  console.log(`agent-settings-rule: ${failures.length} FAILED (${passed} passed)`);
  process.exit(1);
}
