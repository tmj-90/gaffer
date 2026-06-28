---
name: ci-cd-pipeline
description: Use when setting up CI for a new project, refactoring existing pipelines, migrating between platforms, or standardising deployment workflows. Triggers on "set up CI/CD", "GitHub Actions", "GitLab CI", "pipeline for this repo", "deployment workflow", or "why is CI slow".
stack: []
area: devops
---

# Build pragmatic CI/CD pipelines

A pipeline that runs in 2 minutes and deploys reliably beats one that does everything and breaks weekly. Detect the real stack; emit stages that match the project's actual commands.

## Canonical pipeline stages

```
lint → test → build → scan → deploy-staging → smoke-test → deploy-prod
```

Not every project needs all stages. Drop what adds no signal; never skip `test` and `lint`.

## Stack detection signals

| File present | Inferred stack |
|-------------|---------------|
| `package.json` + `tsconfig.json` | TypeScript/Node |
| `pom.xml` | Java/Maven |
| `build.gradle` | Java/Gradle |
| `requirements.txt` / `pyproject.toml` | Python |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `Dockerfile` | Container build needed |
| `.terraform/` or `*.tf` | Terraform plan/apply stage |

## Steps

1. **Detect the stack.** Read `package.json`, `pom.xml`, lockfiles, and `Dockerfile` — do not guess. Extract the actual test, lint, and build commands from the project's own scripts.
2. **Choose the minimal stage set.** Map detected commands to pipeline stages. If a stage has no command, omit it — a placeholder stage that always passes adds noise.
3. **Configure caching.** Cache dependency directories keyed by lockfile hash (e.g. `pnpm-lock.yaml`, `go.sum`). A cache miss should still produce a correct build.
4. **Add secrets hygiene.** All credentials via CI secret store — never hardcoded. Mask secrets in logs. Principle of least privilege for deploy tokens.
5. **Emit the pipeline file.** GitHub Actions (`.github/workflows/ci.yml`) or GitLab CI (`.gitlab-ci.yml`) depending on the platform. Validate YAML syntax before committing.
6. **Verify.** Trigger the pipeline on a feature branch; confirm all stages pass; record timings; submit for review.

## Build / Test

- Validate YAML with the platform's own linter (`actionlint` for GitHub Actions, `gitlab-ci-lint` for GitLab) before push.
- Confirm cache restores by running the pipeline twice — second run should be significantly faster.
- Deploy stages: dry-run (`--dry-run` or preview) first; then gate production deploy on staging smoke-test pass.

## Review checklist

- **Stages match actual project commands** — no placeholder steps, no undocumented scripts.
- **Caching wired** — lockfile-keyed; cache miss still produces correct build.
- **No secrets in YAML** — all credentials from CI secret store; masked in output.
- **Minimal stage set** — every stage has a real command and a reason to exist.
- **Branch protection respected** — PR pipeline required-to-pass before merge on default branch.

## Rules

- Always read the project's own `package.json`/`Makefile`/`pom.xml` for the real commands — never invent them.
- Secrets from the CI secret store only; rotation policy documented.
- Fail fast: put linting before testing; put cheap checks before expensive ones.

## Capture lore

Pipeline structure, deploy targets, secret names, and environment promotion policy are high-value lore. Call `suggest_lore` with `tags: [ci-cd, pipeline, deploy]` when you learn them.
