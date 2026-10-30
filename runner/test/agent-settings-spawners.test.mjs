#!/usr/bin/env node
// =====================================================================
// The live tester (bin/tester-run.mjs) and the merge-conflict resolver
// (bin/merge-ticket.mjs) both launch an agent with Bash and write access. They used
// to render .claude/settings.json with a bare readFileSync/split/writeFileSync, so a
// template with no safety-hook wiring launched the agent with NO hook (fail open).
// Both now go through lib/agent-home.mjs writeAgentSettings, which verifies the
// wiring and throws "SAFETY: …"; the callers turn that into a refused spawn.
// Each scenario runs in its own node process, because both modules read
// CLAUDE_SETTINGS once at import time.
// Run: node test/agent-settings-spawners.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const T = mkdtempSync(resolve(tmpdir(), "agent-settings-spawners-"));
const hook = "node ${RUNNER_DIR}/safety-hook.mjs";
const templates = {
  "no hooks": JSON.stringify({ permissions: {} }),
  "hook path only inside _comment": JSON.stringify({
    _comment: `PreToolUse runs ${hook}`,
    hooks: {},
  }),
  "Read not covered": JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash|Write|Edit", hooks: [{ type: "command", command: hook }] }],
    },
  }),
  "not JSON": "{ hooks: ",
};

// Each spawner: the module, and a call that installs its wiring into `wt`.
const spawners = {
  "tester-run installTesterAgentDir": {
    mod: resolve(RUNNER_DIR, "bin", "tester-run.mjs"),
    call: "m.installTesterAgentDir(wt, 7, '')",
  },
  "merge-ticket installProjectLocalWiring": {
    mod: resolve(RUNNER_DIR, "bin", "merge-ticket.mjs"),
    call: "m.installProjectLocalWiring(wt, 7, 'demo-repo')",
  },
};

/** Run one spawner's install against `settingsPath`; returns { threw, message, wt }. */
function install(spawner, settingsPath, tag) {
  const wt = resolve(T, `wt-${tag}`);
  const data = resolve(T, `data-${tag}`);
  mkdirSync(wt, { recursive: true });
  mkdirSync(data, { recursive: true });
  const script = [
    `const m = await import(${JSON.stringify(spawner.mod)});`,
    `const wt = ${JSON.stringify(wt)};`,
    `try { ${spawner.call}; console.log(JSON.stringify({ threw: false })); }`,
    `catch (e) { console.log(JSON.stringify({ threw: true, message: String(e?.message ?? e) })); }`,
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CLAUDE_SETTINGS: settingsPath, GAFFER_DATA: data },
    encoding: "utf8",
  });
  const line = (res.stdout || "").trim().split("\n").pop() || "{}";
  try {
    return { ...JSON.parse(line), wt };
  } catch {
    return { threw: true, message: `child crashed: ${res.stderr}`, wt };
  }
}

let n = 0;
for (const [name, spawner] of Object.entries(spawners)) {
  console.log(`== ${name}: an unwired settings template refuses the spawn ==`);
  for (const [label, body] of Object.entries(templates)) {
    const tpl = resolve(T, `tpl-${(n += 1)}.json`);
    writeFileSync(tpl, body);
    const r = install(spawner, tpl, `${n}`);
    assert(`${name} / ${label}: throws SAFETY`, r.threw && /^SAFETY:/.test(r.message ?? ""));
    assert(
      `${name} / ${label}: no settings.json left in the worktree`,
      !existsSync(resolve(r.wt, ".claude", "settings.json")),
    );
  }
  const missing = install(spawner, resolve(T, "does-not-exist.json"), `${(n += 1)}`);
  assert(
    `${name} / missing template: throws SAFETY`,
    missing.threw && /^SAFETY:/.test(missing.message ?? ""),
  );

  console.log(`== ${name}: the shipped template renders with the hook resolved ==`);
  const ok = install(spawner, resolve(RUNNER_DIR, "claude", "settings.json"), `${(n += 1)}`);
  const settings = resolve(ok.wt, ".claude", "settings.json");
  assert(`${name} / shipped template: no throw (${ok.message ?? ""})`, !ok.threw);
  assert(
    `${name} / shipped template: \${RUNNER_DIR} resolved to this runner`,
    existsSync(settings) &&
      !readFileSync(settings, "utf8").includes("${RUNNER_DIR}") &&
      readFileSync(settings, "utf8").includes(resolve(RUNNER_DIR, "safety-hook.mjs")),
  );
}

rmSync(T, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAIL agent-settings-spawners — ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`PASS agent-settings-spawners — ${passed} checks passed`);
