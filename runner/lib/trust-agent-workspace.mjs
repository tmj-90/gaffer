// trust-agent-workspace.mjs: the Node launchers' counterpart of lib/tick-launch.sh
// gaffer_trust_workspace. Marks an agent's worktree trusted in ~/.claude.json
// (lib/trust-workspace.mjs), and the MAIN repo working tree its trust is keyed on, so
// the agent CLI honours the .claude/settings.json permissions the launcher installed.
//
// FAIL CLOSED: any non-zero trust-workspace.mjs exit (3: the lock stayed held by a live
// process, or ~/.claude.json could not be parsed; 2: a refused path) throws
// `trust_unwritable: <path> (exit N): <stderr tail>; <fix>`, and the caller refuses the
// spawn: an agent whose project permissions are ignored cannot run the repo's scripts
// or commit. Used by bin/tester-run.mjs (the tester) and bin/merge-ticket.mjs (the
// merge-conflict resolver).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "trust-workspace.mjs");

/**
 * The main repo working tree for a git dir, as gaffer_git_main_worktree computes it: for
 * a LINKED worktree the parent of the shared `.git` (git-common-dir), for a repo root the
 * dir itself. Empty when git cannot say.
 */
export function gitMainWorktree(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  const common = r.status === 0 ? String(r.stdout || "").trim() : "";
  if (!common) return "";
  return common.startsWith("/") ? dirname(common) : dir;
}

/**
 * trustAgentWorkspace(worktree, { gafferData, log }) → void, or throws trust_unwritable.
 * Trusts `worktree` (neutralizing a committed settings.local.json there), then its main
 * repo root with the trust key only (the onboarded repo's working tree is never touched).
 */
export function trustAgentWorkspace(worktree, { gafferData = "", log = () => {} } = {}) {
  const main = gitMainWorktree(worktree);
  const targets = [[worktree, ""]];
  if (main && resolve(main) !== resolve(worktree)) targets.push([main, "1"]);
  for (const [path, keyOnly] of targets) {
    const r = spawnSync(process.execPath, [SCRIPT, path], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GAFFER_DATA: gafferData,
        GAFFER_TRUST_ALLOW_REPO: "1",
        GAFFER_TRUST_KEY_ONLY: keyOnly,
      },
    });
    const err = String(r.stderr ?? "").trim();
    if (err) log(err);
    if (r.status !== 0) {
      const tail = err.split("\n").slice(-2).join(" ").slice(0, 300);
      const fix = /unsafe_worktree_path/.test(tail)
        ? "replace the symbolic link the message names with a regular file or directory in the repository"
        : /not valid JSON/.test(tail)
          ? "fix ~/.claude.json (it is not valid JSON)"
          : /refusing/.test(tail)
            ? "the path is not a factory worktree or a repo the factory vouches for"
            : "remove the stale lock ~/.claude.json.gaffer-trust.lock if no factory run is writing trust right now, or fix ~/.claude.json";
      throw new Error(
        `trust_unwritable: ${path} (exit ${r.status ?? r.signal}): ${tail || "no output"}; ${fix}`,
      );
    }
  }
}
