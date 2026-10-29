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
// product-owner-run.mjs installs: a `.claude/skills` symlink to the factory's
// skills dir and the project settings with the safety-hook path resolved for
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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
/**
 * Mount an agent ROLE's skill set under `<claudeDir>/skills`: a per-home mount dir of
 * symlinks to the selected `runner/skills/<name>` packs (select-skills --role), so the
 * agent's progressive-disclosure list carries only the skills its job calls for. With
 * no role, or when nothing resolves, `.claude/skills` points at the whole library (the
 * pre-role behaviour — never an empty mount). Returns the mounted skill names.
 */
export function mountRoleSkills(claudeDir, { role = "", stacks = [], text = "" } = {}) {
  const skillsDir = process.env.SKILLS_DIR || resolve(RUNNER_DIR, "skills");
  const link = resolve(claudeDir, "skills");
  rmSync(link, { recursive: true, force: true });
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
  if (names.length === 0) {
    try {
      symlinkSync(skillsDir, link, "dir");
    } catch {
      /* skills stay invisible for this turn; the prompt still carries the contract */
    }
    return [];
  }
  const mount = resolve(claudeDir, "skills-mount");
  rmSync(mount, { recursive: true, force: true });
  mkdirSync(mount, { recursive: true });
  const mounted = [];
  for (const name of names) {
    try {
      symlinkSync(resolve(skillsDir, name), resolve(mount, name), "dir");
      mounted.push(name);
    } catch {
      /* duplicate or unlinkable — skip */
    }
  }
  try {
    symlinkSync(mount, link, "dir");
  } catch {
    /* as above */
  }
  return mounted;
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
 * the write tools and Read. The file is read back and compared. On any failure the
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
