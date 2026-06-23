import { allow, deny, type SafetyDecision } from "./decision.js";
import { matchesGlob } from "./glob.js";
import type { GitPolicy } from "./policySchema.js";

/** True when `branch` matches one of the protected-branch patterns. */
export function isProtectedBranch(branch: string, gitPolicy: GitPolicy): boolean {
  return gitPolicy.protected_branches.some((pattern) => matchesGlob(branch, pattern));
}

/**
 * Branch-policy checker: a branch a Crew loop creates must carry the
 * required prefix and must not collide with a protected branch name.
 */
export function checkBranchPolicy(branch: string, gitPolicy: GitPolicy): SafetyDecision {
  if (isProtectedBranch(branch, gitPolicy)) {
    return deny(
      `Branch '${branch}' is a protected branch; loops must work on prefixed branches.`,
      "branch.protected",
    );
  }
  const prefix = gitPolicy.require_branch_prefix;
  if (prefix && !branch.startsWith(prefix)) {
    return deny(
      `Branch '${branch}' must start with the required prefix '${prefix}'.`,
      "branch.prefix",
    );
  }
  return allow(`Branch '${branch}' satisfies the branch policy.`, "branch.ok");
}

/**
 * Build a policy-compliant branch name from a slug, ensuring the required prefix.
 * The slug is lowercased and sanitised to `[a-z0-9-]`.
 */
export function buildBranchName(slug: string, gitPolicy: GitPolicy): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = gitPolicy.require_branch_prefix;
  if (!prefix) return clean;
  return clean.startsWith(prefix) ? clean : `${prefix}${clean}`;
}
