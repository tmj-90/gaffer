#!/usr/bin/env node
// =====================================================================
// B7 — headless planning turns can SEE the factory's skills.
// ---------------------------------------------------------------------
// decompose.mjs / spec-author.mjs used to spawn `claude -p` with cwd = RUNNER_DIR,
// which has no .claude/skills, so the plan-build / spec-author skill each prompt
// names was invisible unless the operator had run `gaffer skills install --user`.
// lib/agent-home.mjs builds a throwaway agent home (skills symlink + resolved
// project settings) and both helpers now spawn from it. Run: node test/agent-home.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const { makeAgentHome } = await import(resolve(RUNNER_DIR, "lib", "agent-home.mjs"));

let passed = 0;
const failures = [];
const ok = (l) => {
  passed += 1;
  console.log(`  ok   ${l}`);
};
const fail = (l) => {
  failures.push(l);
  console.log(`  FAIL ${l}`);
};
const assert = (l, c) => (c ? ok(l) : fail(l));

const DATA = mkdtempSync(resolve(tmpdir(), "agent-home-test-"));
process.env.GAFFER_DATA = DATA;
delete process.env.SKILLS_DIR;
delete process.env.CLAUDE_SETTINGS;

console.log("== makeAgentHome: skill copies + resolved settings, under GAFFER_DATA ==");
{
  const home = makeAgentHome("decompose-");
  assert("home dir created under GAFFER_DATA", home.dir.startsWith(DATA) && existsSync(home.dir));
  const link = resolve(home.dir, ".claude", "skills");
  // Real copies, not a link into the library: the safety hook refuses a Read that
  // resolves outside the agent's roots, so a symlinked skill could not be read.
  assert(".claude/skills is a real directory", existsSync(link) && lstatSync(link).isDirectory());
  assert(
    "…holding copies of the factory's skills (plan-build + spec-author resolve)",
    !lstatSync(resolve(link, "plan-build")).isSymbolicLink() &&
      readFileSync(resolve(link, "plan-build", "SKILL.md"), "utf8") ===
        readFileSync(resolve(RUNNER_DIR, "skills", "plan-build", "SKILL.md"), "utf8") &&
      existsSync(resolve(link, "spec-author", "SKILL.md")),
  );
  const settings = resolve(home.dir, ".claude", "settings.json");
  assert(
    "settings.json mirrored with ${RUNNER_DIR} resolved",
    existsSync(settings) &&
      !readFileSync(settings, "utf8").includes("${RUNNER_DIR}") &&
      readFileSync(settings, "utf8").includes(RUNNER_DIR),
  );
  home.remove();
  assert("remove() deletes the home", !existsSync(home.dir));
  home.remove();
  ok("remove() is idempotent");
}

console.log("== FAIL CLOSED: an unwired / missing settings template refuses the home ==");
{
  const T = mkdtempSync(resolve(tmpdir(), "agent-home-tpl-"));
  const hook = "node ${RUNNER_DIR}/safety-hook.mjs";
  const templates = {
    "missing file": resolve(T, "does-not-exist.json"),
    "no hooks": [resolve(T, "nohooks.json"), JSON.stringify({ permissions: {} })],
    "PreToolUse + hook path only inside _comment": [
      resolve(T, "comment.json"),
      JSON.stringify({ _comment: `PreToolUse ${hook}`, permissions: {} }),
    ],
    "invalid JSON": [resolve(T, "bad.json"), `{"hooks": {"PreToolUse": [ ${hook}`],
    "every tool wired, but the hook fails open on a timeout (no onFailure: block)": [
      resolve(T, "failopen.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob",
              hooks: [{ type: "command", command: hook, timeout: 60 }],
            },
          ],
        },
      }),
    ],
    "hook wired for Bash only (no Read / write tools)": [
      resolve(T, "bashonly.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook }] }] },
      }),
    ],
  };
  for (const [label, spec] of Object.entries(templates)) {
    const path = Array.isArray(spec) ? spec[0] : spec;
    if (Array.isArray(spec)) writeFileSync(path, spec[1]);
    process.env.CLAUDE_SETTINGS = path;
    const before = readdirSync(DATA).length;
    let threw = null;
    try {
      makeAgentHome("decompose-").remove();
    } catch (err) {
      threw = err;
    }
    assert(`${label}: makeAgentHome throws`, threw !== null);
    assert(
      `${label}: the error says SAFETY … fail closed`,
      /^SAFETY: .*fail closed/.test(threw?.message ?? ""),
    );
    assert(
      `${label}: no half-built home left under GAFFER_DATA`,
      readdirSync(DATA).length === before,
    );
  }
  delete process.env.CLAUDE_SETTINGS;

  // product-owner-run: the live path refuses the run on an unwired template.
  const DB = resolve(T, "dispatch.sqlite");
  const REPO = resolve(T, "repo");
  mkdirSync(REPO, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB);
  db.exec(
    "CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, local_path TEXT, default_branch TEXT NOT NULL DEFAULT 'main')",
  );
  db.prepare("INSERT INTO repositories (id,name,local_path,default_branch) VALUES (?,?,?,?)").run(
    "r1",
    "demo",
    REPO,
    "main",
  );
  db.close();
  const FAKE = resolve(T, "claude");
  writeFileSync(FAKE, '#!/bin/sh\necho SPAWNED > "$(dirname "$0")/spawned"\nexit 0\n', {
    mode: 0o755,
  });
  const po = spawnSync(process.execPath, [resolve(RUNNER_DIR, "bin", "product-owner-run.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_PRODUCT_OWNER_REPO: "demo",
      DISPATCH_DB: DB,
      GAFFER_DATA: DATA,
      CLAUDE_BIN: FAKE,
      CLAUDE_SETTINGS: templates["no hooks"][0],
    },
  });
  assert("product-owner-run exits non-zero on an unwired template", po.status !== 0);
  assert("…and never spawns claude", !existsSync(resolve(T, "spawned")));
  assert("…reporting the SAFETY refusal", /SAFETY: /.test(po.stdout + po.stderr));
  rmSync(T, { recursive: true, force: true });
}

console.log("== decompose.mjs + spec-author.mjs spawn from the agent home, not RUNNER_DIR ==");
for (const f of ["decompose.mjs", "spec-author.mjs"]) {
  const src = readFileSync(resolve(RUNNER_DIR, "bin", f), "utf8");
  assert(
    `${f} imports makeAgentHome`,
    /import \{ makeAgentHome \} from "\.\.\/lib\/agent-home\.mjs"/.test(src),
  );
  assert(`${f} spawns with cwd: home.dir`, /cwd: home\.dir/.test(src));
  assert(`${f} no longer spawns the agent with cwd: RUNNER_DIR`, !/cwd: RUNNER_DIR/.test(src));
  assert(
    `${f} keeps the unconditional write/exec denylist`,
    src.includes('"--disallowedTools", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"'),
  );
  assert(
    `${f} removes the home after the turn (finally)`,
    /finally \{\s*home\.remove\(\);/.test(src),
  );
  assert(
    `${f} turns a makeAgentHome refusal into its fail() (no uncaught stack trace)`,
    /try \{\s*home = makeAgentHome\([^)]*\);\s*\} catch \(err\) \{\s*return fail\(/.test(src),
  );
}
{
  const src = readFileSync(resolve(RUNNER_DIR, "bin", "product-owner-run.mjs"), "utf8");
  assert(
    "product-owner-run.mjs renders settings through writeAgentSettings",
    /writeAgentSettings\(claudeDir/.test(src),
  );
}

rmSync(DATA, { recursive: true, force: true });
console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed`);
  process.exit(0);
}
console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
