#!/usr/bin/env node
// =====================================================================
// SKILL TEXT vs THE SAFETY HOOK — what a skill says the hook blocks must be true.
// ---------------------------------------------------------------------
// Several skills told the agent "`go install`, `cargo install`, `uv`/`pipx` and a
// fetching `npx` are not blocked" when the hook in fact blocks them (rc 2). A skill
// that misdescribes the boundary teaches the agent the wrong model of it. This runs
// the REAL runner/safety-hook.mjs on every install-shaped command a skill names in a
// "the hook blocks …" clause (must be blocked) or a "… not blocked / the hook does not
// catch …" clause (must NOT be blocked — otherwise the sentence is stale).
// Run: node test/skills-hook-claims.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const SKILLS_DIR = resolve(RUNNER_DIR, "skills");
const HOOK = resolve(RUNNER_DIR, "safety-hook.mjs");

let passed = 0;
const failures = [];
const check = (label, cond) => (cond ? (passed += 1) : failures.push(label));

// Install-shaped commands only: the clauses also name files (`.env`) and paths.
const TOOL = /^(npm|pnpm|yarn|pip|pip3|uv|pipx|npx|go|cargo|poetry|gem|bundle|dotnet|mvn|gradle)\b/;

const WORK = gafferMkdtemp(join(tmpdir(), "skills-hook-claims-"));
spawnSync("git", ["init", "-q", WORK]);
const cache = new Map();
function hookRc(command) {
  if (cache.has(command)) return cache.get(command);
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    cwd: WORK,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, GAFFER_WRITE_ROOTS: WORK, GAFFER_DATA: "" },
  });
  cache.set(command, r.status);
  return r.status;
}

const commands = (segment) =>
  [...segment.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((c) => TOOL.test(c));
/** The clause a phrase belongs to: back to the nearest clause boundary. */
function clauseBefore(text, idx) {
  const head = text.slice(0, idx);
  const cut = Math.max(
    ...["; ", ", and ", "(", ". ", ": ", " — "].map((b) => {
      const i = head.lastIndexOf(b);
      return i === -1 ? -1 : i + b.length;
    }),
  );
  return head.slice(Math.max(cut, 0));
}
function clauseAfter(text, idx) {
  const tail = text.slice(idx);
  const ends = ["; ", ", and ", ")", ". "].map((b) => tail.indexOf(b)).filter((i) => i >= 0);
  return tail.slice(0, ends.length ? Math.min(...ends) : tail.length);
}

let claims = 0;
for (const dir of readdirSync(SKILLS_DIR).sort()) {
  let text;
  try {
    text = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  } catch {
    continue;
  }
  const flat = text.replace(/\s+/g, " ");
  for (const m of flat.matchAll(/not blocked|does not catch|not hook-blocked|not caught/g)) {
    for (const cmd of commands(clauseBefore(flat, m.index))) {
      claims += 1;
      check(
        `${dir}: says \`${cmd}\` is not blocked, but the hook blocks it (rc ${hookRc(cmd)})`,
        hookRc(cmd) === 0,
      );
    }
  }
  for (const m of flat.matchAll(/the hook blocks /g)) {
    for (const cmd of commands(clauseAfter(flat, m.index + m[0].length))) {
      claims += 1;
      check(
        `${dir}: says the hook blocks \`${cmd}\`, but it is allowed (rc ${hookRc(cmd)})`,
        hookRc(cmd) === 2,
      );
    }
  }
}
rmSync(WORK, { recursive: true, force: true });
check("found the install claims the skills make (the parser still sees them)", claims >= 10);

if (failures.length) {
  console.error(`skills-hook-claims: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`skills-hook-claims: ${passed} passed (${claims} claims checked)`);
