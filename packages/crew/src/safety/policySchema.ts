import { z } from "zod";

/**
 * Zod schema for `safety_policy.yaml`. Mirrors examples/safety-policy-example.yaml.
 * Every field has a safe-by-default value so a minimal policy file still yields
 * strict protections.
 */
export const gitPolicySchema = z
  .object({
    deny_force_push: z.boolean().default(true),
    deny_push_to_protected_branches: z.boolean().default(true),
    deny_delete_branch: z.boolean().default(true),
    deny_tag_mutation: z.boolean().default(true),
    deny_rebase_shared_branch: z.boolean().default(true),
    require_branch_prefix: z.string().default("dispatch/"),
    protected_branches: z
      .array(z.string())
      .default(["main", "master", "develop", "production", "release/*", "hotfix/*"]),
  })
  .default({});

export const filesystemPolicySchema = z
  .object({
    allowed_roots: z.array(z.string()).default([]),
    deny_write_paths: z
      .array(z.string())
      .default([
        ".git/**",
        ".env",
        ".env.*",
        "**/secrets/**",
        "**/credentials/**",
        "**/*.pem",
        "**/*.key",
        "**/id_rsa",
        "**/id_ed25519",
        "**/.aws/**",
        "**/.ssh/**",
      ]),
    require_approval_write_paths: z
      .array(z.string())
      .default([
        ".github/workflows/**",
        "infra/**",
        "terraform/**",
        "k8s/**",
        "Dockerfile",
        "docker-compose.yml",
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "poetry.lock",
        "requirements.txt",
        "migrations/**",
      ]),
  })
  .default({});

export const commandPolicySchema = z
  .object({
    deny: z
      .array(z.string())
      .default([
        "rm -rf /",
        "rm -rf .git",
        "chmod -R 777",
        "chown -R",
        "git push --force",
        "git push -f",
        "git clean -fdx",
        "git branch -D",
        "git tag -d",
        "terraform destroy",
        "kubectl delete",
        "docker system prune -a",
      ]),
    require_approval: z
      .array(z.string())
      .default([
        "git reset --hard",
        "git rebase",
        "npm install",
        "pnpm install",
        "yarn install",
        "pip install",
        "poetry add",
        "cargo update",
        "docker compose down -v",
        "terraform apply",
        "kubectl apply",
      ]),
    allow: z.array(z.string()).default([]),
    allow_from_repo_config: z.boolean().default(true),
  })
  .default({});

export const secretsPolicySchema = z
  .object({
    redact_in_context: z.boolean().default(true),
    deny_secret_file_reads: z.boolean().default(true),
    high_entropy_redaction: z.boolean().default(true),
  })
  .default({});

export const safetyPolicySchema = z.object({
  git: gitPolicySchema,
  filesystem: filesystemPolicySchema,
  commands: commandPolicySchema,
  secrets: secretsPolicySchema,
});

export type SafetyPolicy = z.infer<typeof safetyPolicySchema>;
export type GitPolicy = z.infer<typeof gitPolicySchema>;
export type FilesystemPolicy = z.infer<typeof filesystemPolicySchema>;
export type CommandPolicy = z.infer<typeof commandPolicySchema>;

/** A fully-defaulted policy, useful for tests and when no file is present. */
export function defaultSafetyPolicy(): SafetyPolicy {
  return safetyPolicySchema.parse({});
}
