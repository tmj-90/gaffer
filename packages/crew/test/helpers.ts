import { crewConfigSchema, type CrewConfig } from "../src/index.js";
import { RepoRegistry } from "../src/index.js";

export function testConfig(overrides: Partial<CrewConfig> = {}): CrewConfig {
  const base = crewConfigSchema.parse({
    factory: { name: "test-factory", mode: "local_strict" },
    repos: [
      {
        id: "web-app",
        name: "web-app",
        path: "/tmp/test-web-app",
        default_branch: "main",
        protected_branches: ["main", "release/*"],
        stack: "typescript-react",
        package_manager: "pnpm",
        test_command: "pnpm test",
        lint_command: "pnpm lint",
        coverage_command: "pnpm test -- --coverage",
        mutation_mode: "branch_only",
        risk_level: "medium",
        lore_tags: ["frontend", "react", "auth"],
      },
    ],
    agents: [
      {
        id: "claude-auth-01",
        capabilities: ["backend", "auth", "tests"],
        max_risk: "medium",
        allowed_repos: ["web-app"],
        status: "active",
      },
    ],
    loops: { idle_coverage: { repos: ["web-app"], minimum_gap_threshold: 80 } },
  });
  return { ...base, ...overrides };
}

export function testRepoRegistry(config = testConfig()): RepoRegistry {
  return RepoRegistry.fromConfig(config, "/tmp");
}
