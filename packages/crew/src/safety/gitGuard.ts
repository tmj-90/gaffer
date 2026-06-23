import { allow, deny, needsApproval, type SafetyDecision } from "./decision.js";
import { isProtectedBranch } from "./branchPolicy.js";
import type { GitPolicy } from "./policySchema.js";

/** Tokenise a shell-ish command into words, respecting simple quoting. */
function tokenise(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function hasFlag(tokens: string[], ...flags: string[]): boolean {
  return tokens.some((token) => flags.includes(token));
}

/**
 * Classify a `git` command against the git safety policy. Returns a structured
 * decision. Non-git commands return `allowed` here (the command classifier owns
 * general commands); this guard focuses on Git-specific destructive operations.
 */
export function classifyGitCommand(command: string, gitPolicy: GitPolicy): SafetyDecision {
  const tokens = tokenise(command.trim());
  if (tokens[0] !== "git") {
    return allow("Not a git command.", "git.not_git");
  }
  const sub = tokens[1] ?? "";

  // Force push: --force / -f / +refspec / --mirror.
  if (sub === "push") {
    if (
      gitPolicy.deny_force_push &&
      hasFlag(tokens, "--force", "-f", "--force-with-lease", "--mirror")
    ) {
      return deny("Force push is denied by safety policy.", "git.force_push");
    }
    if (gitPolicy.deny_force_push && tokens.some((t) => t.startsWith("+") && t.includes(":"))) {
      return deny("Force push via '+refspec' is denied by safety policy.", "git.force_push");
    }
    // Delete remote branch: `git push origin :branch`.
    if (gitPolicy.deny_delete_branch && tokens.some((t) => t.startsWith(":") && t.length > 1)) {
      return deny(
        "Deleting a remote branch via push is denied by safety policy.",
        "git.delete_branch",
      );
    }
    // Push to a protected branch: `git push origin main` or `git push origin HEAD:main`.
    if (gitPolicy.deny_push_to_protected_branches) {
      const refs = tokens.slice(3).filter((t) => !t.startsWith("-"));
      for (const ref of refs) {
        const branch = ref.includes(":") ? (ref.split(":")[1] ?? "") : ref;
        if (branch && isProtectedBranch(branch, gitPolicy)) {
          return deny(`Pushing to protected branch '${branch}' is denied.`, "git.protected_push");
        }
      }
    }
    return allow("Push is allowed by safety policy.", "git.push_ok");
  }

  // Branch / tag deletion.
  if (gitPolicy.deny_delete_branch && sub === "branch" && hasFlag(tokens, "-D", "-d", "--delete")) {
    return deny("Branch deletion is denied by safety policy.", "git.delete_branch");
  }
  if (gitPolicy.deny_tag_mutation && sub === "tag" && hasFlag(tokens, "-d", "--delete")) {
    return deny("Tag deletion is denied by safety policy.", "git.tag_mutation");
  }

  // Destructive resets / cleans.
  if (sub === "reset" && hasFlag(tokens, "--hard")) {
    return needsApproval(
      "Hard reset can discard work; it is approval-gated.",
      "command:git reset --hard",
      "git.hard_reset",
    );
  }
  if (sub === "clean" && tokens.some((t) => /^-[a-z]*f[a-z]*d/.test(t) || t === "-fdx")) {
    return deny("'git clean -fdx' is denied by safety policy.", "git.clean");
  }
  if (gitPolicy.deny_rebase_shared_branch && sub === "rebase") {
    return needsApproval(
      "Rebase of a potentially shared branch is approval-gated.",
      "command:git rebase",
      "git.rebase",
    );
  }

  return allow("Git command is allowed by safety policy.", "git.ok");
}
