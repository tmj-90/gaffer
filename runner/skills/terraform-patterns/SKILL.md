---
name: terraform-patterns
description: Use when designing Terraform modules, managing state backends, reviewing IaC for security or anti-patterns, implementing multi-region deployments, or standardising Terraform CI/CD. Triggers on ".tf files", "Terraform module", "remote state", "IaC review", "Terraform security", or "multi-region infra".
stack: [terraform]
area: infra
---

# Write predictable, secure Terraform

Predictable infrastructure. Secure state. Modules that compose. No drift.

## Module structure (standard layout)

```
modules/<name>/
  main.tf        # resources only — no provider config
  variables.tf   # typed inputs with descriptions and validation
  outputs.tf     # only what callers need
  versions.tf    # required_providers + minimum version constraints
```

Environments (`envs/prod/`, `envs/staging/`) consume modules via `module` blocks — never paste resources directly into env files.

## Non-negotiable rules

| Rule | Why |
|------|-----|
| Remote state backend (S3+DynamoDB or GCS) | Local state breaks team workflows and loses history |
| State locking enabled | Concurrent applies corrupt state |
| No credentials in `.tf` files | Rotate via environment/vault; never hardcode |
| Pin provider versions with `~>` | Minor-version drift breaks plans silently |
| `lifecycle { prevent_destroy = true }` on data resources | Accidental drops are unrecoverable |

## Steps

1. **Read the lore + existing modules.** `search_lore` for state backend, naming conventions, and existing module registry. Extend existing patterns; don't introduce a competing module style.
2. **Design the module interface.** Variables: typed + validated + described. Outputs: only what callers need — not every internal resource attribute. One module = one coherent infrastructure concern.
3. **Implement resources.** Follow least-privilege on IAM. Encrypt at rest and in transit by default. Tag all resources with `environment`, `team`, and `managed-by = terraform`.
4. **Configure the backend.** Remote state with locking. Workspace or path-based isolation between environments.
5. **CI/CD integration.** `terraform fmt` + `terraform validate` on every PR; `terraform plan` as a required check; apply only on merge to main via a protected pipeline.
6. **Security review.** Check for: hardcoded credentials, `0.0.0.0/0` ingress, public S3 buckets, overly permissive IAM. Use `tfsec` or `checkov` in CI.
7. **Verify.** `terraform plan` shows expected change set only; `terraform apply` completes without errors; spot-check resources in cloud console; record evidence.

## Build / Test

- `terraform fmt -check -recursive` — format violations fail CI.
- `terraform validate` — catches provider config errors before plan.
- `tfsec` or `checkov` — static security analysis; block on HIGH/CRITICAL findings.
- `terraform plan` output reviewed and linked in PR before apply.

## Review checklist

- **Module interface clean** — typed variables with descriptions; outputs are the minimum callers need.
- **Remote state + locking** — no local state; lock configured.
- **No hardcoded credentials** — secrets from environment or vault only.
- **IAM least privilege** — no `*` actions or resources without documented justification.
- **Resource tagging** — `environment`, `team`, `managed-by` on every resource.
- **Security scan clean** — no HIGH/CRITICAL findings from `tfsec`/`checkov`.

## Capture lore

State backend configuration, naming conventions, tagging policy, and approved module registry are high-value Terraform lore — call `suggest_lore` with `tags: [terraform, infra, iac]`.
