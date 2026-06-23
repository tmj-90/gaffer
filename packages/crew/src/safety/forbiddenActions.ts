import type { SafetyPolicy } from "./policySchema.js";

/**
 * Derive the human-readable forbidden-actions list embedded in every context
 * packet. This tells the agent, in plain language, what the safety layer will
 * refuse — so it never wastes a turn attempting a denied action.
 */
export function forbiddenActions(policy: SafetyPolicy): string[] {
  const actions: string[] = [];
  const { git, filesystem, commands } = policy;

  if (git.deny_force_push) actions.push("Force-push (git push --force / -f / +refspec)");
  if (git.deny_push_to_protected_branches) {
    actions.push(`Push to protected branches: ${git.protected_branches.join(", ")}`);
  }
  if (git.deny_delete_branch) actions.push("Delete branches (local or remote)");
  if (git.deny_tag_mutation) actions.push("Delete or move tags");

  actions.push(`Write to secret/protected paths: ${filesystem.deny_write_paths.join(", ")}`);
  actions.push("Write outside the repository root");

  for (const denied of commands.deny) {
    actions.push(`Run command: ${denied}`);
  }

  return actions;
}
