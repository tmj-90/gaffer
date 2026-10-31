// =====================================================================
// Throwaway AGENT HOME for headless planning turns (decompose / spec-author).
// ---------------------------------------------------------------------
// A headless `claude -p` only sees project skills that live under its cwd's
// `.claude/skills`. decompose.mjs and spec-author.mjs used to spawn with
// cwd = RUNNER_DIR, which has no `.claude/`, so the plan-build / spec-author
// skills their prompts name were invisible unless the operator had run
// `gaffer skills install --user` (labelled optional; never done in Docker).
//
// makeAgentHome() creates an ephemeral directory carrying the SAME wiring
// product-owner-run.mjs installs: the role's skills copied into `.claude/skills`
// and the project settings with the safety-hook path resolved for
// THIS checkout. The caller spawns with cwd = home.dir and removes it after
// the turn (a failed rm is swallowed — a stale temp dir is not a failure).
//
// Containment is unchanged: the callers keep their unconditional write/exec
// tool denylist; this widens what the agent can SEE, never what it can write.
//
// FAIL CLOSED: the rendered settings carry the PreToolUse safety hook. If they
// cannot be rendered, parsed or verified (missing/unwired template, full disk),
// writeAgentSettings throws, makeAgentHome removes the half-built dir and rethrows,
// and the caller refuses the spawn — exactly like the shell writer
// gaffer_write_agent_settings (lib/agent-env.sh).
// =====================================================================
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectForRole } from "../bin/select-skills.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");

/**
 * Create the throwaway agent home. `prefix` names the temp dir (e.g. "decompose-").
 * Lives under GAFFER_DATA (the factory's trusted workspace root) when set, else the OS
 * temp dir. Returns `{ dir, remove }`.
 */
/** Marker file inside every skill copy Gaffer installs (holds its mount key). */
export const SKILL_COPY_MARK = ".gaffer-mount";
/** Marker file inside a `.claude/skills` dir Gaffer itself created. */
export const SKILL_ROOT_MARK = ".gaffer-skills-root";

function isDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Remove the Gaffer-installed copies from `skillsPath` (dirs carrying SKILL_COPY_MARK). */
export function removeSkillCopies(skillsPath) {
  if (!isDir(skillsPath)) return;
  for (const name of readdirSync(skillsPath)) {
    const d = resolve(skillsPath, name);
    if (isDir(d) && existsSync(resolve(d, SKILL_COPY_MARK))) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  if (existsSync(resolve(skillsPath, SKILL_ROOT_MARK))) {
    rmSync(resolve(skillsPath, SKILL_ROOT_MARK), { force: true });
    try {
      rmdirSync(skillsPath);
    } catch {
      /* not empty — something else lives here */
    }
  }
}

/**
 * Install `names` from `skillsDir` into `<claudeDir>/skills/<name>/` as REAL COPIES (each
 * marked with SKILL_COPY_MARK), and record them as links in `manifestDir` when given (the
 * telemetry's view of the mount). Returns the names installed.
 *
 * WHY COPIES: the safety hook canonicalises a Read and refuses one that resolves outside
 * the agent's roots; a `.claude/skills` symlink into runner/skills made every explicit
 * Read of a mounted skill a refusal. A copy resolves inside the agent's own directory.
 */
export function installSkillCopies(claudeDir, names, { skillsDir, key = "mount", manifestDir = "" }) {
  const link = resolve(claudeDir, "skills");
  let st = null;
  try {
    st = lstatSync(link);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    // An older Gaffer mount (a link into the library or a manifest) is replaced; any
    // other link is the repo's, and is left alone with nothing installed through it.
    let target = "";
    try {
      target = resolve(dirname(link), readlinkSync(link));
    } catch {
      target = "";
    }
    const ours =
      target === resolve(skillsDir) ||
      target.startsWith(resolve(skillsDir) + "/") ||
      /\/skills-mounts?(\/|$)/.test(target);
    if (!ours) return [];
    rmSync(link, { force: true });
  } else if (st && !st.isDirectory()) {
    return []; // a file the repo owns: never replaced
  } else if (st) {
    // Gaffer's previous copies go; the repo's OWN skills (no marker) stay, and Gaffer's
    // are installed beside them at `.claude/skills/<name>/` (never a level deeper).
    removeSkillCopies(link);
  }
  if (!isDir(link)) {
    mkdirSync(link, { recursive: true });
    writeFileSync(resolve(link, SKILL_ROOT_MARK), "");
  }
  if (manifestDir) {
    rmSync(manifestDir, { recursive: true, force: true });
    mkdirSync(manifestDir, { recursive: true });
  }
  const installed = [];
  for (const name of names) {
    const dest = resolve(link, name);
    // A repo skill of the same name WINS (see shadowedSkills); never overwritten.
    if (existsSync(dest) || installed.includes(name)) continue;
    try {
      cpSync(resolve(skillsDir, name), dest, { recursive: true, dereference: true });
      writeFileSync(resolve(dest, SKILL_COPY_MARK), `${key}\n`);
      if (manifestDir) symlinkSync(resolve(skillsDir, name), resolve(manifestDir, name), "dir");
      installed.push(name);
    } catch {
      rmSync(dest, { recursive: true, force: true });
    }
  }
  return installed;
}

/**
 * The names whose `<claudeDir>/skills/<name>` is the REPO'S own skill (present, no Gaffer
 * marker): the repo's version wins over Gaffer's pack of that name. Sorted.
 */
export function shadowedSkills(claudeDir, names) {
  const link = resolve(claudeDir, "skills");
  return [...new Set(names)]
    .filter((n) => existsSync(resolve(link, n)) && !existsSync(resolve(link, n, SKILL_COPY_MARK)))
    .sort();
}

/** The prompt sentence naming the repo skills that shadow Gaffer's packs ("" when none). */
export function shadowNote(shadowed) {
  return shadowed.length
    ? ` (this repo has its own .claude/skills of the same name, which take precedence over Gaffer's pack: ${shadowed.join(", ")} — follow the repo's version)`
    : "";
}

/** Every skill directory in the library that carries a SKILL.md. */
function libraryNames(skillsDir) {
  try {
    return readdirSync(skillsDir).filter((n) => existsSync(resolve(skillsDir, n, "SKILL.md")));
  } catch {
    return [];
  }
}

/**
 * Mount an agent ROLE's skill set under `<claudeDir>/skills`: copies of the selected
 * `runner/skills/<name>` packs (select-skills --role), with a manifest of links at
 * `<claudeDir>/skills-mount`, so the agent's progressive-disclosure list carries only the
 * skills its job calls for. With no role, or when nothing resolves, the whole library is
 * installed (the pre-role behaviour — never an empty mount). Returns the mounted skill
 * names ([] for the whole-library fallback).
 */
export function mountRoleSkills(
  claudeDir,
  { role = "", stacks = [], text = "", skillsDir = process.env.SKILLS_DIR || "" } = {},
) {
  skillsDir = skillsDir || resolve(RUNNER_DIR, "skills");
  let names = [];
  if (role) {
    try {
      names = selectForRole(role, { skillsDir, stacks, text })
        .map((s) => s.name)
        .filter((name) => existsSync(resolve(skillsDir, name, "SKILL.md")));
    } catch {
      names = [];
    }
  }
  const manifestDir = resolve(claudeDir, "skills-mount");
  try {
    if (names.length === 0) {
      rmSync(manifestDir, { recursive: true, force: true });
      installSkillCopies(claudeDir, libraryNames(skillsDir), { skillsDir, key: role || "library" });
      return [];
    }
    return installSkillCopies(claudeDir, names, { skillsDir, key: role, manifestDir });
  } catch {
    /* skills stay invisible for this turn; the prompt still carries the contract */
    return [];
  }
}

/**
 * The settings template's `Read(...)` deny rules (recursive secret-file families).
 * A spawn that runs WITHOUT the rendered project settings (onboard-analyze runs in
 * RUNNER_DIR, where no .claude/ exists) passes these through --disallowedTools so
 * Claude Code still turns them into ripgrep excludes for Grep/Glob and refuses the
 * Read. Returns [] when the template cannot be read (the caller's own tool denylist
 * still applies).
 */
export function secretReadDenyRules() {
  const settingsPath =
    process.env.CLAUDE_SETTINGS || resolve(RUNNER_DIR, "claude", "settings.json");
  try {
    const deny = JSON.parse(readFileSync(settingsPath, "utf8"))?.permissions?.deny;
    return Array.isArray(deny)
      ? deny.filter((r) => typeof r === "string" && /^Read\(/.test(r))
      : [];
  } catch {
    return [];
  }
}

/** Does some PreToolUse matcher (a `A|B` regex) cover `tool`? */
function hookCovers(entries, tool) {
  return entries.some((m) => {
    try {
      return new RegExp(`^(?:${m.matcher})$`).test(tool);
    } catch {
      return false;
    }
  });
}

/**
 * Render the settings template into `<claudeDir>/settings.json` with ${RUNNER_DIR}
 * resolved for THIS checkout, and VERIFY the safety-hook wiring by parsing the JSON
 * (a "PreToolUse" string inside a _comment does not count): hooks.PreToolUse must
 * hold entries whose command runs `${RUNNER_DIR}/safety-hook.mjs`, covering Bash,
 * the write tools and Read, and each such hook must carry `"onFailure": "block"` and a
 * timeout (a hook that times out otherwise lets the tool run). The file is read back
 * and compared. On any failure the
 * file is removed and an Error starting "SAFETY:" is thrown (fail closed).
 */
export function writeAgentSettings(
  claudeDir,
  settingsPath = process.env.CLAUDE_SETTINGS || resolve(RUNNER_DIR, "claude", "settings.json"),
) {
  const target = resolve(claudeDir, "settings.json");
  const hookPath = resolve(RUNNER_DIR, "safety-hook.mjs");
  const refuse = (why) => {
    rmSync(target, { force: true });
    throw new Error(
      `SAFETY: ${why} — refusing to launch an agent without its safety hook (fail closed)`,
    );
  };
  let rendered;
  try {
    rendered = readFileSync(settingsPath, "utf8").split("${RUNNER_DIR}").join(RUNNER_DIR);
  } catch (err) {
    return refuse(`cannot read the agent settings template ${settingsPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rendered);
  } catch (err) {
    return refuse(`agent settings template ${settingsPath} is not valid JSON: ${err.message}`);
  }
  const pre = parsed?.hooks?.PreToolUse;
  const wired = Array.isArray(pre)
    ? pre.filter(
        (m) =>
          m &&
          typeof m.matcher === "string" &&
          Array.isArray(m.hooks) &&
          m.hooks.some((h) => typeof h?.command === "string" && h.command.includes(hookPath)),
      )
    : [];
  // Claude Code RUNS the tool when a hook times out or crashes unless the entry says
  // onFailure: block, so every safety-hook entry must say it, with a bounded timeout.
  for (const m of wired) {
    for (const h of m.hooks) {
      if (typeof h?.command !== "string" || !h.command.includes(hookPath)) continue;
      if (h.onFailure !== "block" || !(typeof h.timeout === "number" && h.timeout > 0)) {
        return refuse(
          `${settingsPath} safety-hook entry for ${m.matcher} lacks "onFailure": "block" and a timeout (a timed-out hook would let the tool run)`,
        );
      }
    }
  }
  for (const tool of ["Bash", "Write", "Edit", "Read"]) {
    if (!hookCovers(wired, tool)) {
      return refuse(
        `${settingsPath} has no PreToolUse safety-hook (${hookPath}) matcher for ${tool}`,
      );
    }
  }
  try {
    writeFileSync(target, rendered);
    if (readFileSync(target, "utf8") !== rendered) throw new Error("read-back mismatch");
  } catch (err) {
    return refuse(`could not write ${target}: ${err.message}`);
  }
  return target;
}

export function makeAgentHome(prefix = "agent-home-", { role = "", stacks = [], text = "" } = {}) {
  const base = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");
  let root = base;
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    root = tmpdir();
  }
  let dir;
  try {
    dir = mkdtempSync(resolve(root, prefix));
  } catch {
    dir = mkdtempSync(resolve(tmpdir(), prefix));
  }
  const claudeDir = resolve(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const skills = mountRoleSkills(claudeDir, { role, stacks, text });
  try {
    writeAgentSettings(claudeDir);
  } catch (err) {
    // Never leave the half-built home behind on a refusal.
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    skills,
    remove() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* stale temp dir is not a failure */
      }
    },
  };
}
