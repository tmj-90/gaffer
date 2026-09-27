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
// =====================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");

/**
 * Create the throwaway agent home. `prefix` names the temp dir (e.g. "decompose-").
 * Lives under GAFFER_DATA (the factory's trusted workspace root) when set, else the OS
 * temp dir. Returns `{ dir, remove }`.
 */
export function makeAgentHome(prefix = "agent-home-") {
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

  const skillsDir = process.env.SKILLS_DIR || resolve(RUNNER_DIR, "skills");
  try {
    symlinkSync(skillsDir, resolve(claudeDir, "skills"), "dir");
  } catch {
    /* skills stay invisible for this turn; the prompt still carries the contract */
  }
  const settingsPath =
    process.env.CLAUDE_SETTINGS || resolve(RUNNER_DIR, "claude", "settings.json");
  try {
    const settings = readFileSync(settingsPath, "utf8").split("${RUNNER_DIR}").join(RUNNER_DIR);
    writeFileSync(resolve(claudeDir, "settings.json"), settings);
  } catch {
    /* no project settings to mirror */
  }
  return {
    dir,
    remove() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* stale temp dir is not a failure */
      }
    },
  };
}
