---
name: terraform-patterns
description: Use when designing Terraform modules, managing state backends, reviewing IaC for security or anti-patterns, implementing multi-region deployments, or standardising Terraform CI/CD. Triggers on ".tf files", "Terraform module", "remote state", "IaC review", "Terraform security", or "multi-region infra".
stack: [terraform]
area: infra
---

# Write predictable, secure Terraform

Terraform changes real infrastructure, and its state file is a shared, lock-protected
database that also holds secrets in plaintext. Follow HashiCorp's style guide and module
guidance; verify with `fmt`, `validate` and `terraform test`; never apply from an agent
session.

## Layout (HashiCorp style guide)

```
terraform.tf   # terraform { required_version, required_providers }
providers.tf   # provider blocks — ROOT modules only
backend.tf     # backend config — root only
main.tf        # resources and data sources (split by concern when large: network.tf …)
variables.tf   # alphabetical; type, description, default?, sensitive?, validation
outputs.tf     # alphabetical; description, value, sensitive?
locals.tf
modules/<name>/  # local child modules, same layout minus providers/backend
```

Names are descriptive snake_case nouns without the type (`aws_instance.web_api`, not
`aws_instance.web-api-instance`).

## Procedure

1. **Read what exists.** `search_lore` for backend, naming, tagging and module
   conventions. Read the root modules, `.terraform.lock.hcl`, CI jobs and any policy
   (tflint, checkov, trivy config). Extend the existing module style.
2. **Design the module interface.** One module = one coherent concern. Every variable has
   `type` and `description`; optional ones have a sensible `default`; secrets set
   `sensitive = true`; `validation` blocks only for real invariants. Outputs are the
   minimum callers need, each with a `description`. Child modules declare
   `required_providers` with a minimum version (`>=`) and **never** contain `provider`
   blocks; the root pins providers (`~>` or exact) and commits `.terraform.lock.hcl`.
3. **Write resources safely.**
   - `for_each` keyed by stable names for collections of distinct things; `count` only for
     on/off. Index-shifting `count` lists destroy and recreate resources.
   - Stateful resources (databases, buckets, KMS keys) get
     `lifecycle { prevent_destroy = true }`.
   - Refactors use `moved` blocks (and `removed`/`import` blocks) instead of manual
     `terraform state mv`, so the plan shows no destroy.
   - Least-privilege IAM (no `"*"` actions or resources without a written reason),
     encryption at rest and in transit, no public buckets, no `0.0.0.0/0` on admin ports.
   - Tags via provider `default_tags` where supported: environment, owner, managed-by.
4. **State and locking.** Remote backend with locking and encryption; for S3 use
   `use_lockfile = true` (Terraform ≥ 1.11; DynamoDB locking is deprecated). Separate state per environment
   (directory or workspace), and restrict who can read state — `sensitive` hides values in
   plan output, not in state. Share data across states with data sources or
   `terraform_remote_state` outputs, not whole-state access.
5. **Respect the lock.** Never pass `-lock=false`. Never `terraform force-unlock` unless you
   have proven the holder process is gone (not merely slow or paused) — breaking a live
   holder's lock is the concurrent-writer bug that lost acknowledged writes in live runs,
   and here it corrupts state. Use `-lock-timeout=5m` in CI instead.
6. **Credentials.** From the environment or OIDC/dynamic credentials — never in `.tf`,
   `.tfvars` committed to git, or provider blocks.
7. **CI.** On PR: `fmt -check`, `validate`, `terraform test`, security scan, and `plan`
   posted for review. Apply only from the protected default branch, one run per state at a
   time.
8. **Verify** (below), evidence each acceptance criterion with the `record-evidence`
   skill, then stop. Do not run `plan`, `apply` or `destroy`: they reach the cloud with
   whatever ambient credentials the host holds (`~/.aws`, gcloud). If an AC needs a real
   plan, state in evidence that a human must run it, or `mark_ticket_blocked`.

## Verification

- `terraform fmt -check -recursive` — clean.
- `terraform validate` only where the module is already initialised (`.terraform/`
  present and gitignored). Never run `terraform init`: it downloads providers and modules
  (with the host's ambient credentials for remote module sources) and rewrites
  `.terraform.lock.hcl`. If validate cannot run, say so in evidence.
- `terraform test`, in an already-initialised module, with `.tftest.hcl` files that `mock_provider` every provider
  (Terraform 1.7+): these cover variable validation, conditional resources, and
  computed names without the cloud. Never run an unmocked test: the default
  `command = apply` creates real resources. Add a test per AC behaviour.
- `tflint`, `checkov -d .` or `trivy config .` if installed; no HIGH/CRITICAL findings.
- When a human supplies a plan (for example CI output): no unexpected `destroy` or
  `-/+` replace actions.

## Review checklist (concrete defects only)

- `provider` block inside a child module; missing version constraints or lock file.
- Variable without type/description; secret without `sensitive`; secret in committed tfvars.
- `count` over a list of distinct items; rename without a `moved` block (plan destroys).
- Stateful resource without `prevent_destroy`.
- Wildcard IAM, public bucket, open admin ingress, unencrypted storage.
- Local state, no locking, `-lock=false`, or an unconditional `force-unlock` in scripts.

## Capture lore

Backend layout, naming and tagging policy, and approved module sources are high-value
lore: call `suggest_lore` with `tags: [terraform, infra, iac]`.
