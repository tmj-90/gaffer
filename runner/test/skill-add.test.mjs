// =====================================================================
// skill-add.mjs — `gaffer skills add` validate-then-install.
// ---------------------------------------------------------------------
// Asserts the accept contract for bringing an EXTERNAL skill into the
// runner library:
//   • a valid local skill dir installs and becomes selectable by name;
//   • a lone SKILL.md file path installs via its parent dir;
//   • malformed skills (no frontmatter / no name / no description /
//     unsafe name) are REJECTED with a reason and install NOTHING;
//   • an existing skill is not overwritten without --force;
//   • a git url (exercised via a local file:// repo — hermetic) clones,
//     installs, and does NOT carry a nested .git into the library.
//
// Run: node runner/test/skill-add.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(HERE, "..", "bin", "skill-add.mjs");

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
/** True if `p` is a symlink (even a dangling one) — existsSync follows links + would
 *  miss a carried-in dangling symlink, so we lstat to detect the link itself. */
const symlinkExists = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const { addSkill, validateSkillDir } = await import(MOD);

const WORK = mkdtempSync(join(tmpdir(), "skill-add-test."));
const SKILLS = join(WORK, "library");
mkdirSync(SKILLS, { recursive: true });

/** Write a candidate skill dir with the given SKILL.md body. Returns its path. */
function makeSkillDir(name, frontmatter) {
  const dir = join(WORK, "src-" + name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter);
  return dir;
}

const VALID = `---
name: greeter
description: Greets the user warmly and specifically.
stack: [node]
area: workflow
---

# Greet
Say hello.
`;

console.log("== valid local skill dir installs + is selectable by name ==");
{
  const src = makeSkillDir("greeter", VALID);
  const res = addSkill({ source: src, skillsDir: SKILLS });
  assert("returns ok", res.ok === true);
  assert("name resolved from frontmatter", res.name === "greeter");
  assert("installed into the library", existsSync(join(SKILLS, "greeter", "SKILL.md")));
}

console.log("== a lone SKILL.md file path installs via its parent dir ==");
{
  const dir = join(WORK, "lone");
  mkdirSync(dir, { recursive: true });
  const md = join(dir, "SKILL.md");
  writeFileSync(
    md,
    `---\nname: lonely\ndescription: A skill given as a bare SKILL.md path.\nstack: []\n---\nBody.\n`,
  );
  const res = addSkill({ source: md, skillsDir: SKILLS });
  assert("installs from a SKILL.md file path", res.ok === true && res.name === "lonely");
  assert("landed in the library", existsSync(join(SKILLS, "lonely", "SKILL.md")));
}

console.log("== malformed skills are REJECTED and install nothing ==");
{
  const noFm = makeSkillDir("nofm", `# No frontmatter here\nJust prose.\n`);
  let res = addSkill({ source: noFm, skillsDir: SKILLS });
  assert("no frontmatter → rejected", res.ok === false);
  assert("no frontmatter → nothing installed", !existsSync(join(SKILLS, "nofm")));

  const noName = makeSkillDir("noname", `---\ndescription: Has no name.\nstack: []\n---\nBody.\n`);
  res = addSkill({ source: noName, skillsDir: SKILLS });
  assert("missing name → rejected", res.ok === false);
  assert(
    "missing name → reason mentions name",
    res.errors.some((e) => /name/i.test(e)),
  );

  const noDesc = makeSkillDir("nodesc", `---\nname: nodesc\nstack: []\n---\nBody.\n`);
  res = addSkill({ source: noDesc, skillsDir: SKILLS });
  assert("missing description → rejected", res.ok === false);
  assert("missing description → not installed", !existsSync(join(SKILLS, "nodesc")));
}

console.log("== an unsafe skill name cannot escape the library root ==");
{
  const evil = makeSkillDir(
    "evil",
    `---\nname: ../../etc/evil\ndescription: Tries to traverse.\nstack: []\n---\nBody.\n`,
  );
  const res = addSkill({ source: evil, skillsDir: SKILLS });
  assert("traversal name → rejected", res.ok === false);
  assert("traversal name → nothing written outside root", !existsSync(join(WORK, "etc")));
  // validateSkillDir surfaces the reason directly too.
  const v = validateSkillDir(evil);
  assert(
    "validateSkillDir flags the unsafe slug",
    v.ok === false && v.errors.some((e) => /slug/i.test(e)),
  );
}

console.log("== an existing skill is not overwritten without --force ==");
{
  const again = makeSkillDir("greeter2", VALID.replace("greeter", "greeter")); // same name 'greeter'
  let res = addSkill({ source: again, skillsDir: SKILLS });
  assert("duplicate without --force → rejected", res.ok === false);
  assert(
    "duplicate reason mentions force",
    res.errors.some((e) => /force/i.test(e)),
  );
  res = addSkill({ source: again, skillsDir: SKILLS, force: true });
  assert("duplicate WITH --force → installed", res.ok === true);
}

console.log("== a git url (local file:// repo — hermetic) clones + installs, no nested .git ==");
{
  const repo = join(WORK, "remote-skill");
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "SKILL.md"),
    `---\nname: fromgit\ndescription: A skill fetched from a git remote.\nstack: [node]\narea: workflow\n---\nBody.\n`,
  );
  const git = (...args) =>
    spawnSync("git", ["-C", repo, ...args], { stdio: "ignore", encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "x",
  );
  const res = addSkill({ source: `file://${repo}`, skillsDir: SKILLS });
  assert("git url → installed", res.ok === true && res.name === "fromgit");
  assert("git url → SKILL.md present", existsSync(join(SKILLS, "fromgit", "SKILL.md")));
  assert(
    "git url → nested .git NOT carried into the library",
    !existsSync(join(SKILLS, "fromgit", ".git")),
  );
}

console.log("== a bare scalar `stack` is coerced to a one-element list + accepted ==");
{
  // The frontmatter parser coerces `stack: node` to `["node"]` (always an array), so
  // validateSkillDir's Array.isArray guard is a defensive belt-and-braces check and a
  // scalar stack installs fine. Assert the REAL behaviour rather than a rejection the
  // parser makes impossible.
  const scalarStack = makeSkillDir(
    "scalarstack",
    `---\nname: scalarstack\ndescription: stack given as a bare string.\nstack: node\n---\nBody.\n`,
  );
  const v = validateSkillDir(scalarStack);
  assert("scalar stack → validates ok", v.ok === true);
  const res = addSkill({ source: scalarStack, skillsDir: SKILLS });
  assert("scalar stack → installed (coerced to a list)", res.ok === true);
  assert(
    "scalar stack → landed in the library",
    existsSync(join(SKILLS, "scalarstack", "SKILL.md")),
  );
}

console.log("== a symlink inside the skill is NOT carried into the library (dropped) ==");
{
  const secret = join(WORK, "pretend-secret.txt");
  writeFileSync(secret, "PRETEND SECRET\n");
  const src = makeSkillDir(
    "symlinky",
    `---\nname: symlinky\ndescription: Ships a symlink alongside a valid SKILL.md.\nstack: [node]\n---\nBody.\n`,
  );
  symlinkSync(secret, join(src, "leak.txt")); // absolute symlink to a host path
  const res = addSkill({ source: src, skillsDir: SKILLS });
  assert("symlink skill still installs (valid SKILL.md)", res.ok === true);
  assert(
    "the symlink was NOT carried into the library",
    !existsSync(join(SKILLS, "symlinky", "leak.txt")) &&
      !symlinkExists(join(SKILLS, "symlinky", "leak.txt")),
  );
  assert("the real SKILL.md still installed", existsSync(join(SKILLS, "symlinky", "SKILL.md")));
}

console.log("== a failed git clone rejects cleanly and installs nothing ==");
{
  const res = addSkill({
    source: `file://${join(WORK, "does-not-exist-repo")}`,
    skillsDir: SKILLS,
  });
  assert("unreachable git source → rejected", res.ok === false);
  assert(
    "unreachable git source → reason mentions the clone failure",
    res.errors.some((e) => /clone/i.test(e)),
  );
}

console.log("== a flag-shaped git source is treated as a URL, never a git option ==");
{
  // Ends in `.git` so it's routed to the clone path; the `--` guard means git treats
  // it as a (nonexistent) repo URL rather than acting on it as an option. Either way
  // the clone fails and NOTHING is installed — the point is it isn't executed as a flag.
  const res = addSkill({ source: "--upload-pack=/tmp/evil.git", skillsDir: SKILLS });
  assert("flag-shaped source → rejected, nothing installed", res.ok === false);
}

rmSync(WORK, { recursive: true, force: true });

console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (module: ${MOD})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
