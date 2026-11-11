#!/usr/bin/env node
// =====================================================================
// Host-side writes into an agent's worktree never follow a link (Node side).
// ---------------------------------------------------------------------
// The primitive (lib/safe-write.mjs) and every Node writer that installs an agent's
// files into a directory a repository controls: writeAgentSettings (agent-home.mjs),
// installSkillCopies, the tester's and the merge resolver's installers, and
// trust-workspace.mjs's settings.local.json neutralization. For each shape (a link at
// the destination, a link as a parent, a dangling link, a link to a directory, a
// destination that is a directory) the outside file is byte-identical, nothing is
// created outside, and the refusal names the path (code unsafe_worktree_path).
// Run: node runner/test/worktree-write-safety.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";

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

const T = realpathSync(gafferMkdtemp(resolve(tmpdir(), "wt-write-safety-")));
const OUT = join(T, "outside");
mkdirSync(OUT);
const sentinel = (name) => {
  const p = join(OUT, name);
  writeFileSync(p, `OPERATOR FILE ${name}\n`);
  return p;
};
const intact = (p, name) => existsSync(p) && readFileSync(p, "utf8") === `OPERATOR FILE ${name}\n`;
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const wt = (name) => {
  const p = join(T, name);
  mkdirSync(p, { recursive: true });
  return p;
};
/** Run fn; return the thrown error (or null). */
const thrown = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};
const unsafe = (err, path) =>
  !!err &&
  /^unsafe_worktree_path: /.test(String(err.message)) &&
  String(err.message).includes(path);

// ── 1. the primitive ──────────────────────────────────────────────────────
console.log("== 1: lib/safe-write.mjs ==");
let sw = null;
try {
  sw = await import(resolve(RUNNER_DIR, "lib", "safe-write.mjs"));
} catch (err) {
  assert(`lib/safe-write.mjs loads (${err.code || err.message})`, false);
}
if (sw) {
  const { safeWriteFile, safeSymlink, safeRemoveFile, safeMkdir, checkPath, UnsafePathError } = sw;
  // link at the destination
  let r = wt("p1");
  mkdirSync(join(r, ".claude"));
  const s1 = sentinel("s1");
  symlinkSync(s1, join(r, ".claude", "settings.json"));
  let e = thrown(() => safeWriteFile(r, ".claude/settings.json", "X"));
  assert("1a: a link at the destination is refused", e instanceof UnsafePathError);
  assert("1a: the refusal names the path", unsafe(e, ".claude/settings.json"));
  assert("1a: the outside file is byte-identical", intact(s1, "s1"));
  assert("1a: the link is left in place", isLink(join(r, ".claude", "settings.json")));
  // link as a parent (to a directory outside)
  r = wt("p2");
  mkdirSync(join(OUT, "d2"));
  symlinkSync(join(OUT, "d2"), join(r, ".claude"));
  e = thrown(() => safeWriteFile(r, ".claude/settings.json", "X"));
  assert("1b: a parent that is a link to a directory is refused", unsafe(e, ".claude"));
  assert("1b: nothing created in the outside directory", readdirSync(join(OUT, "d2")).length === 0);
  // link as a parent INSIDE the root is refused too (one rule)
  r = wt("p2b");
  mkdirSync(join(r, "real"));
  symlinkSync("real", join(r, ".claude"));
  e = thrown(() => safeWriteFile(r, ".claude/settings.json", "X"));
  assert("1c: a parent link that stays inside the root is refused as well", unsafe(e, ".claude"));
  // dangling link at the destination
  r = wt("p3");
  symlinkSync(join(OUT, "dangling3"), join(r, "CLAUDE.factory.md"));
  e = thrown(() => safeWriteFile(r, "CLAUDE.factory.md", "X"));
  assert("1d: a dangling link at the destination is refused", unsafe(e, "CLAUDE.factory.md"));
  assert("1d: the dangling target is not created", !existsSync(join(OUT, "dangling3")));
  // dangling link as a parent
  r = wt("p3b");
  symlinkSync(join(OUT, "dangling3b"), join(r, ".claude"));
  e = thrown(() => safeWriteFile(r, ".claude/settings.json", "X"));
  assert("1e: a dangling parent link is refused", unsafe(e, ".claude"));
  assert("1e: nothing created at its target", !existsSync(join(OUT, "dangling3b")));
  // destination is a directory
  r = wt("p4");
  mkdirSync(join(r, ".claude", "settings.json"), { recursive: true });
  e = thrown(() => safeWriteFile(r, ".claude/settings.json", "X"));
  assert("1f: a directory at the destination is refused", unsafe(e, ".claude/settings.json"));
  // a parent that is a regular file
  r = wt("p4b");
  writeFileSync(join(r, ".claude"), "file");
  e = thrown(() => safeWriteFile(r, ".claude/settings.json", "X"));
  assert("1g: a parent that is a regular file is refused", unsafe(e, ".claude"));
  // a relative path that climbs is refused
  r = wt("p4c");
  e = thrown(() => safeWriteFile(r, "../escape", "X"));
  assert(
    "1h: a '..' path is refused",
    e instanceof UnsafePathError && !existsSync(join(T, "escape")),
  );
  // happy path: creates parents, replaces a regular file, leaves no temp file
  r = wt("p5");
  safeWriteFile(r, ".claude/settings.json", "one");
  safeWriteFile(r, ".claude/settings.json", "two");
  assert(
    "1i: writes (parents made) and replaces its own regular file",
    readFileSync(join(r, ".claude", "settings.json"), "utf8") === "two",
  );
  assert(
    "1i: no temp file left behind",
    readdirSync(join(r, ".claude")).every((n) => !n.includes("gaffer-tmp")),
  );
  // remove: never through a parent link, never a link at the path
  r = wt("p6");
  mkdirSync(join(OUT, "d6"));
  const s6 = join(OUT, "d6", "settings.json");
  writeFileSync(s6, "OPERATOR FILE s6\n");
  symlinkSync(join(OUT, "d6"), join(r, ".claude"));
  e = thrown(() => safeRemoveFile(r, ".claude/settings.json"));
  assert("1j: remove through a parent link is refused", unsafe(e, ".claude"));
  assert("1j: the outside file still exists", intact(s6, "s6"));
  r = wt("p6b");
  const s6b = sentinel("s6b");
  symlinkSync(s6b, join(r, "CLAUDE.factory.md"));
  assert(
    "1k: remove leaves a link at the path alone",
    safeRemoveFile(r, "CLAUDE.factory.md") === false,
  );
  assert("1k: link and target intact", isLink(join(r, "CLAUDE.factory.md")) && intact(s6b, "s6b"));
  // symlink creation
  r = wt("p7");
  mkdirSync(join(OUT, "d7"));
  symlinkSync(join(OUT, "d7"), join(r, "packages"));
  e = thrown(() => safeSymlink(r, "packages/a/node_modules", "/nowhere"));
  assert("1l: a node_modules link under a linked parent is refused", unsafe(e, "packages"));
  assert("1l: nothing created outside", readdirSync(join(OUT, "d7")).length === 0);
  r = wt("p7b");
  assert("1m: a link is made where nothing is", safeSymlink(r, "a/node_modules", "/x") === true);
  assert(
    "1m: an existing path is never clobbered",
    safeSymlink(r, "a/node_modules", "/y") === false,
  );
  // mkdir and check
  r = wt("p8");
  symlinkSync(join(OUT, "d7"), join(r, ".claude"));
  assert(
    "1n: mkdir through a link is refused",
    unsafe(
      thrown(() => safeMkdir(r, ".claude/skills")),
      ".claude",
    ),
  );
  assert(
    "1n: check refuses a linked parent",
    unsafe(
      thrown(() => checkPath(r, ".claude/skills", "dir")),
      ".claude",
    ),
  );
  r = wt("p8b");
  assert(
    "1o: check passes a missing path",
    thrown(() => checkPath(r, ".claude/skills", "dir")) === null,
  );
  // the CLI the shell uses: exit 4 on a refusal
  r = wt("p9");
  const s9 = sentinel("s9");
  mkdirSync(join(r, ".claude"));
  symlinkSync(s9, join(r, ".claude", "settings.json"));
  const src = join(T, "src9");
  writeFileSync(src, "NEW");
  const cli = spawnSync(
    process.execPath,
    [resolve(RUNNER_DIR, "lib", "safe-write.mjs"), "write", r, ".claude/settings.json", src],
    { encoding: "utf8" },
  );
  assert("1p: the CLI exits 4 on a refusal", cli.status === 4);
  assert(
    "1p: the CLI says unsafe_worktree_path on stderr",
    /^unsafe_worktree_path: /.test(cli.stderr),
  );
  assert("1p: the outside file is byte-identical", intact(s9, "s9"));
}

// ── 2. writeAgentSettings (agent-home.mjs) ─────────────────────────────────
console.log("== 2: agent-home.mjs writeAgentSettings ==");
const home = await import(resolve(RUNNER_DIR, "lib", "agent-home.mjs"));
const TEMPLATE = resolve(RUNNER_DIR, "claude", "settings.json");
{
  let r = wt("h1");
  mkdirSync(join(r, ".claude"));
  const s = sentinel("h1");
  symlinkSync(s, join(r, ".claude", "settings.json"));
  const e = thrown(() => home.writeAgentSettings(join(r, ".claude"), TEMPLATE));
  assert("2a: a settings.json link is refused", unsafe(e, ".claude/settings.json"));
  assert("2a: the outside file is byte-identical", intact(s, "h1"));
  r = wt("h2");
  mkdirSync(join(OUT, "h2d"));
  writeFileSync(join(OUT, "h2d", "settings.json"), "OPERATOR FILE h2\n");
  symlinkSync(join(OUT, "h2d"), join(r, ".claude"));
  const e2 = thrown(() => home.writeAgentSettings(join(r, ".claude"), TEMPLATE));
  assert("2b: a linked .claude is refused", unsafe(e2, ".claude"));
  assert(
    "2b: the outside settings.json is neither rewritten nor removed",
    intact(join(OUT, "h2d", "settings.json"), "h2"),
  );
  r = wt("h3");
  mkdirSync(join(r, ".claude"));
  symlinkSync(join(OUT, "h3-dangling"), join(r, ".claude", "settings.json"));
  thrown(() => home.writeAgentSettings(join(r, ".claude"), TEMPLATE));
  assert(
    "2c: a dangling settings link creates nothing outside",
    !existsSync(join(OUT, "h3-dangling")),
  );
  r = wt("h4");
  mkdirSync(join(r, ".claude", "settings.json"), { recursive: true });
  assert(
    "2d: a directory at settings.json is refused",
    unsafe(
      thrown(() => home.writeAgentSettings(join(r, ".claude"), TEMPLATE)),
      ".claude/settings.json",
    ),
  );
}

// ── 3. installSkillCopies / mountRoleSkills ───────────────────────────────
console.log("== 3: agent-home.mjs skill copies ==");
{
  const skillsDir = resolve(RUNNER_DIR, "skills");
  let r = wt("k1");
  mkdirSync(join(OUT, "k1skills"));
  mkdirSync(join(r, ".claude"));
  symlinkSync(join(OUT, "k1skills"), join(r, ".claude", "skills"));
  let e = thrown(() => home.installSkillCopies(join(r, ".claude"), ["run-tests"], { skillsDir }));
  assert("3a: a foreign .claude/skills link refuses the install", unsafe(e, ".claude/skills"));
  assert("3a: nothing copied through it", readdirSync(join(OUT, "k1skills")).length === 0);
  e = thrown(() => home.mountRoleSkills(join(r, ".claude"), { role: "merge", skillsDir }));
  assert("3b: mountRoleSkills passes the refusal on (not swallowed)", unsafe(e, ".claude/skills"));
  r = wt("k2");
  mkdirSync(join(OUT, "k2claude"));
  symlinkSync(join(OUT, "k2claude"), join(r, ".claude"));
  e = thrown(() => home.installSkillCopies(join(r, ".claude"), ["run-tests"], { skillsDir }));
  assert("3c: a linked .claude refuses the install", unsafe(e, ".claude"));
  assert(
    "3c: nothing created in the outside directory",
    readdirSync(join(OUT, "k2claude")).length === 0,
  );
}

// ── 4. the tester's and the merge resolver's installers ───────────────────
console.log("== 4: tester-run / merge-ticket installers ==");
const spawners = {
  tester: {
    mod: resolve(RUNNER_DIR, "bin", "tester-run.mjs"),
    call: "m.installTesterAgentDir(wt, 7, '')",
  },
  merge: {
    mod: resolve(RUNNER_DIR, "bin", "merge-ticket.mjs"),
    call: "m.installProjectLocalWiring(wt, 7, 'demo-repo')",
  },
};
function install(spawner, dir, tag) {
  const data = wt(`data-${tag}`);
  const script = [
    `const m = await import(${JSON.stringify(spawner.mod)});`,
    `const wt = ${JSON.stringify(dir)};`,
    `try { ${spawner.call}; console.log(JSON.stringify({ threw: false })); }`,
    `catch (e) { console.log(JSON.stringify({ threw: true, message: String(e?.message ?? e) })); }`,
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, GAFFER_DATA: data, CLAUDE_SETTINGS: TEMPLATE },
    encoding: "utf8",
  });
  try {
    return JSON.parse((res.stdout || "").trim().split("\n").pop() || "{}");
  } catch {
    return { threw: true, message: `unparseable: ${res.stdout} ${res.stderr}` };
  }
}
for (const [name, sp] of Object.entries(spawners)) {
  let r = wt(`${name}-settings`);
  mkdirSync(join(r, ".claude"));
  const s = sentinel(`${name}-settings`);
  symlinkSync(s, join(r, ".claude", "settings.json"));
  let got = install(sp, r, `${name}-a`);
  assert(
    `4 ${name}: a settings.json link refuses the install`,
    got.threw && /unsafe_worktree_path: .*\.claude\/settings\.json/.test(got.message),
  );
  assert(`4 ${name}: the outside file is byte-identical`, intact(s, `${name}-settings`));
  r = wt(`${name}-skills`);
  mkdirSync(join(OUT, `${name}-skills-d`));
  mkdirSync(join(r, ".claude"));
  symlinkSync(join(OUT, `${name}-skills-d`), join(r, ".claude", "skills"));
  got = install(sp, r, `${name}-b`);
  assert(
    `4 ${name}: a .claude/skills link refuses the install`,
    got.threw && /unsafe_worktree_path: .*\.claude\/skills/.test(got.message),
  );
  assert(
    `4 ${name}: nothing copied through it`,
    readdirSync(join(OUT, `${name}-skills-d`)).length === 0,
  );
}
{
  const r = wt("tester-brief");
  const s = sentinel("tester-brief");
  symlinkSync(s, join(r, "CLAUDE.factory.md"));
  const got = install(spawners.tester, r, "tester-c");
  assert(
    "4 tester: a CLAUDE.factory.md link refuses the install",
    got.threw && /unsafe_worktree_path: .*CLAUDE\.factory\.md/.test(got.message),
  );
  assert("4 tester: the outside file is byte-identical", intact(s, "tester-brief"));
}

// ── 5. trust-workspace.mjs: settings.local.json neutralization ───────────
console.log("== 5: trust-workspace.mjs neutralization ==");
{
  const HOME = wt("trust-home");
  const repo = wt("trust-repo");
  spawnSync("git", ["init", "-q", repo]);
  mkdirSync(join(OUT, "trust-claude"));
  const outsideLocal = join(OUT, "trust-claude", "settings.local.json");
  writeFileSync(outsideLocal, '{"permissions":{"allow":["Bash"]}}\n');
  symlinkSync(join(OUT, "trust-claude"), join(repo, ".claude"));
  const res = spawnSync(
    process.execPath,
    [resolve(RUNNER_DIR, "lib", "trust-workspace.mjs"), repo],
    {
      env: { ...process.env, HOME, GAFFER_TRUST_ALLOW_REPO: "1" },
      encoding: "utf8",
    },
  );
  assert(
    "5a: the operator's file behind a linked .claude is not rewritten",
    readFileSync(outsideLocal, "utf8") === '{"permissions":{"allow":["Bash"]}}\n',
  );
  assert(
    "5a: no backup written into the outside directory",
    !existsSync(outsideLocal + ".gaffer-orig"),
  );
  assert(
    "5b: trust is refused (exit 2, a reason naming .claude)",
    res.status === 2 && /unsafe_worktree_path: .*\.claude/.test(res.stderr),
  );
  // a committed settings.local.json.gaffer-orig link: the backup never writes through it
  const repo2 = wt("trust-repo2");
  spawnSync("git", ["init", "-q", repo2]);
  mkdirSync(join(repo2, ".claude"));
  writeFileSync(
    join(repo2, ".claude", "settings.local.json"),
    '{"permissions":{"allow":["Bash"]}}\n',
  );
  const s = sentinel("trust-orig");
  symlinkSync(s, join(repo2, ".claude", "settings.local.json.gaffer-orig"));
  spawnSync(process.execPath, [resolve(RUNNER_DIR, "lib", "trust-workspace.mjs"), repo2], {
    env: { ...process.env, HOME, GAFFER_TRUST_ALLOW_REPO: "1" },
    encoding: "utf8",
  });
  assert(
    "5c: the backup never writes through a committed .gaffer-orig link",
    intact(s, "trust-orig"),
  );
}

rmSync(T, { recursive: true, force: true });
console.log();
if (failures.length === 0) {
  console.log(`worktree-write-safety: ALL ${passed} checks passed`);
} else {
  console.log(`worktree-write-safety: ${failures.length} FAILED (${passed} passed)`);
  process.exit(1);
}
