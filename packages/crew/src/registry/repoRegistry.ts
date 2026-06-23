import { isAbsolute, resolve } from "node:path";

import { notFound } from "../util/errors.js";
import type { CrewConfig, RepoConfig } from "../config/schema.js";

/**
 * Read-only view over the configured repositories. Resolves repo paths against
 * the factory root so loops and guards get absolute paths.
 */
export class RepoRegistry {
  private readonly byId: Map<string, RepoConfig>;
  private readonly byName: Map<string, RepoConfig>;

  constructor(
    repos: readonly RepoConfig[],
    private readonly rootDir: string,
  ) {
    this.byId = new Map(repos.map((r) => [r.id, r]));
    this.byName = new Map(repos.map((r) => [r.name, r]));
  }

  static fromConfig(config: CrewConfig, rootDir: string): RepoRegistry {
    return new RepoRegistry(config.repos, rootDir);
  }

  list(): RepoConfig[] {
    return [...this.byId.values()];
  }

  find(ref: string): RepoConfig | undefined {
    return this.byId.get(ref) ?? this.byName.get(ref);
  }

  get(ref: string): RepoConfig {
    const repo = this.find(ref);
    if (!repo) throw notFound("repository", ref);
    return repo;
  }

  /** Absolute filesystem path for a repo, resolved against the factory root. */
  absolutePath(repo: RepoConfig): string {
    return isAbsolute(repo.path) ? repo.path : resolve(this.rootDir, repo.path);
  }
}
