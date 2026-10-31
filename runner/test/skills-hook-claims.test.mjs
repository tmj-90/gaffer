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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

const WORK = mkdtempSync(join(tmpdir(), "skills-hook-claims-"));
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
check("found the install claims the skills make (the parser still sees them)", claims >= 10);

// EVERY skill Gaffer can mount is readable by the agent it is mounted for. The REAL hook
// (a subprocess, as Claude Code runs it) decides a Read of each mounted SKILL.md with the
// worktree as the only root, then a Read of the same file through the OLD symlink layout,
// which resolves into the library and must stay refused. The decision-stamped ledger row
// the hook writes is what the skill telemetry reads.
const { installSkillCopies } = await import("../lib/agent-home.mjs");
const WT = mkdtempSync(join(tmpdir(), "skills-hook-mounted-"));
const DATA = mkdtempSync(join(tmpdir(), "skills-hook-data-"));
const names = readdirSync(SKILLS_DIR).filter((n) => {
  try {
    return readFileSync(join(SKILLS_DIR, n, "SKILL.md"), "utf8").length > 0;
  } catch {
    return false;
  }
});
const installed = installSkillCopies(join(WT, ".claude"), names, {
  skillsDir: SKILLS_DIR,
  key: "claims",
});
check(
  `every library skill installs as a copy (${installed.length} of ${names.length})`,
  installed.length === names.length,
);
const readRc = (file, cwd) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }),
    cwd,
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      GAFFER_WRITE_ROOTS: cwd,
      GAFFER_READ_ROOTS: "",
      GAFFER_DATA: DATA,
      GAFFER_TICKET: "",
    },
  }).status;
const unreadable = installed.filter(
  (n) => readRc(join(WT, ".claude", "skills", n, "SKILL.md"), WT) !== 0,
);
check(
  `every mounted skill is readable through the hook (refused: ${unreadable.join(", ")})`,
  unreadable.length === 0,
);
const OLD = mkdtempSync(join(tmpdir(), "skills-hook-oldlayout-"));
mkdirSync(join(OLD, ".claude"));
symlinkSync(SKILLS_DIR, join(OLD, ".claude", "skills"), "dir");
check(
  "a skill reached through a symlink into the library stays refused (no read widening)",
  readRc(join(OLD, ".claude", "skills", "run-tests", "SKILL.md"), OLD) === 2,
);
const rows = readFileSync(join(DATA, "tool-metrics.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
check(
  "the hook stamped every Read with its own decision",
  rows.length === installed.length + 1 &&
    rows.slice(0, -1).every((r) => r.decision === "allow") &&
    rows.at(-1).decision === "block",
);
for (const d of [WORK, WT, DATA, OLD]) rmSync(d, { recursive: true, force: true });

if (failures.length) {
  console.error(`skills-hook-claims: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`skills-hook-claims: ${passed} passed (${claims} claims checked)`);
