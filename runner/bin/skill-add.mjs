#!/usr/bin/env node
// =====================================================================
// Gaffer factory — install an EXTERNAL skill into the runner library.
// ---------------------------------------------------------------------
// `gaffer skills install` only mounts the BUNDLED skills into your own
// Claude Code; there was no supported path to bring an external skill
// INTO the factory's library (`runner/skills/`), only a manual copy with
// no validation. This is the first useful slice of a "skill marketplace":
// `gaffer skills add <path|git-url>` — fetch, VALIDATE against the SKILL.md
// contract BEFORE accepting, then install so `select-skills` picks it up
// per-ticket like any bundled skill. Invalid skills are rejected with a
// clear reason and NOTHING is installed (no partial/side-effected state).
//
// Targets the LIVE runner SKILL.md library the real agent loads — NOT the
// crew descriptive-skill schema (that path only feeds the mock loop).
//
// Zero runtime deps; reuses select-skills.mjs's frontmatter parser so the
// accept contract matches what the selector actually reads.
//
//   node bin/skill-add.mjs <path|git-url> [--force] [--skills-dir DIR]
//
// Exit 0 = installed; 2 = rejected/failed (nothing written).
// =====================================================================
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parseFrontmatter, DEFAULT_SKILLS_DIR } from "./select-skills.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A skill's install name must be a safe slug — it becomes a directory under the
 *  skills library, so anything with a path separator / traversal / leading dot is
 *  refused before it can escape the library root. */
export function isValidSkillName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(name) && !name.includes("..");
}

/** True when `source` looks like a git remote we should clone rather than copy. */
export function looksLikeGitUrl(source) {
  return (
    /^git@/.test(source) ||
    /^ssh:\/\//.test(source) ||
    /^git:\/\//.test(source) ||
    /^file:\/\//.test(source) || // git's local transport (used by the hermetic test)
    /^https?:\/\/.+\.git$/.test(source) ||
    /\.git$/.test(source)
  );
}

/**
 * Validate a candidate skill DIRECTORY against the runner SKILL.md contract.
 * Returns { ok, name, errors }. `errors` is a list of human-readable reasons;
 * on ok the resolved install `name` (from frontmatter, validated) is returned.
 * Pure + filesystem-read-only — no install side effects.
 */
export function validateSkillDir(dir) {
  const errors = [];
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, name: "", errors: [`not a directory: ${dir}`] };
  }
  const md = join(dir, "SKILL.md");
  if (!existsSync(md)) {
    return { ok: false, name: "", errors: ["no SKILL.md in the skill directory"] };
  }
  const text = readFileSync(md, "utf8");
  if (!/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.test(text)) {
    errors.push("SKILL.md has no YAML frontmatter block (--- … ---)");
  }
  const meta = parseFrontmatter(text, "");
  if (!meta.name) errors.push("frontmatter is missing a `name`");
  else if (!isValidSkillName(meta.name)) {
    errors.push(
      `\`name\` "${meta.name}" is not a safe slug (lowercase alphanumeric, . _ - only; no path separators)`,
    );
  }
  if (!meta.description || meta.description.trim() === "") {
    errors.push("frontmatter is missing a `description` (the selector needs it to match skills)");
  }
  if (!Array.isArray(meta.stack))
    errors.push("`stack` must be an inline list (e.g. [react, node])");
  return { ok: errors.length === 0, name: meta.name, errors };
}

/**
 * Resolve `source` to a local directory that should contain a SKILL.md, cloning a
 * git remote into a throwaway dir when needed. Returns { dir, cleanup } where
 * cleanup() removes any temp clone (a no-op for a local source). Throws on a
 * fetch failure so the caller can report it and install nothing.
 */
export function fetchSkillSource(source) {
  if (looksLikeGitUrl(source)) {
    const tmp = mkdtempSync(join(tmpdir(), "gaffer-skill-"));
    // `--` ends option parsing so a `source` shaped like a git flag (e.g.
    // `--upload-pack=…`, `--config=…`, anything ending `.git`) is always treated as
    // the repo URL, never as an option git would act on. Untrusted input as an
    // unguarded git argument is a smell; close it regardless of today's exploitability.
    const clone = spawnSync("git", ["clone", "--depth", "1", "--quiet", "--", source, tmp], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (clone.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${(clone.stderr || "").trim() || `exit ${clone.status}`}`);
    }
    return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }
  const abs = resolve(source);
  if (!existsSync(abs)) throw new Error(`source not found: ${source}`);
  // A path to a SKILL.md file → treat its parent directory as the skill.
  const dir = statSync(abs).isFile() && basename(abs) === "SKILL.md" ? dirname(abs) : abs;
  return { dir, cleanup: () => {} };
}

/**
 * Install an external skill into `skillsDir`. Validates BEFORE writing anything;
 * refuses to overwrite an existing skill unless `force`. Copies to a staging dir
 * then renames into place so a mid-copy failure can't leave a half-written skill.
 * Returns { ok, name, errors, installedTo }.
 */
export function addSkill({ source, skillsDir = DEFAULT_SKILLS_DIR, force = false } = {}) {
  if (!source) return { ok: false, name: "", errors: ["no source given"], installedTo: null };
  let fetched;
  try {
    fetched = fetchSkillSource(source);
  } catch (err) {
    return { ok: false, name: "", errors: [String(err.message || err)], installedTo: null };
  }
  try {
    const v = validateSkillDir(fetched.dir);
    if (!v.ok) return { ok: false, name: v.name, errors: v.errors, installedTo: null };

    const dest = join(skillsDir, v.name);
    if (existsSync(dest) && !force) {
      return {
        ok: false,
        name: v.name,
        errors: [`a skill named "${v.name}" is already installed — pass --force to replace it`],
        installedTo: null,
      };
    }
    // Stage → rename so a partial copy never becomes the live skill.
    const staging = `${dest}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    // DROP symlinks entirely (filter returns false for any symlink). A malicious
    // skill could point a symlink at a host path the agent later reads through
    // (e.g. `references/x -> ~/.aws/credentials` or a mounted worktree). We don't
    // dereference (that would copy a sensitive target's CONTENT into the library) —
    // we simply don't carry symlinks in. Regular files/dirs copy normally.
    cpSync(fetched.dir, staging, {
      recursive: true,
      filter: (src) => !lstatSync(src).isSymbolicLink(),
    });
    // Never carry a nested .git from a clone into the library.
    rmSync(join(staging, ".git"), { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    return { ok: true, name: v.name, errors: [], installedTo: dest };
  } finally {
    fetched.cleanup();
  }
}

// --- CLI -------------------------------------------------------------------
function main(argv) {
  let source = "";
  let force = false;
  let skillsDir = process.env["SKILLS_DIR"] || DEFAULT_SKILLS_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--force") force = true;
    else if (a === "--skills-dir") skillsDir = argv[(i += 1)];
    else if (!a.startsWith("--") && !source) source = a;
  }
  if (!source) {
    process.stderr.write("usage: skill-add.mjs <path|git-url> [--force] [--skills-dir DIR]\n");
    return 2;
  }
  const res = addSkill({ source, skillsDir, force });
  if (res.ok) {
    process.stdout.write(`installed skill "${res.name}" → ${res.installedTo}\n`);
    return 0;
  }
  process.stderr.write(`skill rejected — nothing installed:\n`);
  for (const e of res.errors) process.stderr.write(`  • ${e}\n`);
  return 2;
}

if (resolve(process.argv[1] || "") === resolve(HERE, "skill-add.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
