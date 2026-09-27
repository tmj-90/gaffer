import { repoSchema, type RepoConfig } from "../config/schema.js";
import type { DispatchClient, DispatchRepository } from "../dispatch/client.js";
import type { EventLog } from "../events/eventLog.js";
import { RepoRegistry } from "./repoRegistry.js";

/**
 * Merge Dispatch's repository registry into the crew {@link RepoRegistry}.
 *
 * Why: the idle loops scan `repoRegistry.list()`, which used to be crew.yaml's
 * `repos:` alone. Onboarding a repo from the dashboard registers it in DISPATCH
 * (that is the registry the runner, the panel and the tickets use) and never
 * writes crew.yaml, so every dashboard-onboarded factory had an empty crew repo
 * list and every idle scan ended `no_repos`. Merging at command time makes
 * Dispatch the source of truth without duplicating repo config into crew.yaml:
 * a crew.yaml entry with the same id or name still wins (it may carry per-repo
 * overrides such as a definition of done), and a Dispatch repo without a local
 * path is skipped because there is nothing on disk to scan.
 *
 * Risk defaults to Dispatch's `risk_level` (medium when unset), which the
 * self-improve gate compares against its ceiling — so a freshly onboarded repo is
 * never auto-promoted until an operator either lowers its risk or raises the
 * ceiling.
 */
export function withDispatchRepos(
  registry: RepoRegistry,
  dispatch: Pick<DispatchClient, "listRepositories">,
  events?: Pick<EventLog, "record">,
): RepoRegistry {
  let rows: DispatchRepository[];
  try {
    rows = dispatch.listRepositories();
  } catch (err) {
    // Fail-soft: a facade without the listing (or a read error) leaves the
    // crew.yaml repos exactly as before.
    events?.record("dispatch_repos_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return registry;
  }
  const extra: RepoConfig[] = [];
  for (const r of rows) {
    if (!r.localPath || !r.name) continue;
    const parsed = repoSchema.safeParse({
      id: r.id || r.name,
      name: r.name,
      path: r.localPath,
      default_branch: r.defaultBranch || "main",
      stack: r.stack,
      risk_level: r.riskLevel,
      test_command: r.testCommand,
      lint_command: r.lintCommand,
      coverage_command: r.coverageCommand,
    });
    if (!parsed.success) {
      events?.record("dispatch_repo_skipped", {
        repoName: r.name,
        reason: parsed.error.issues.map((i) => i.message).join("; "),
      });
      continue;
    }
    extra.push(parsed.data);
  }
  const merged = registry.merged(extra);
  const added = merged.list().length - registry.list().length;
  if (added > 0) events?.record("dispatch_repos_merged", { added, total: merged.list().length });
  return merged;
}
