---
name: runbook-generator
description: Use when a service has no runbook, existing runbooks are inconsistent across teams, or on-call onboarding requires standardised operations docs. Triggers on "write a runbook", "document on-call procedures", "operational playbook", "incident playbook", or "runbook for <service>".
stack: []
area: devops
---

# Generate operational runbooks

A runbook exists so the on-call engineer who has never touched this service can keep it alive at 2 AM. Every section must be executable, not aspirational.

## Standard sections (every runbook)

| Section | Contents |
|---------|---------|
| **Overview** | What this service does; who owns it; criticality (P1/P2/P3) |
| **Architecture** | Dependencies in + out; SLOs; data store(s); diagram link |
| **Start / Stop / Restart** | Exact commands with flags; expected stdout on success |
| **Health checks** | How to confirm the service is healthy; which endpoint / metric to check |
| **Common alerts** | Alert name → probable cause → remediation steps → escalation threshold |
| **Deployment** | Branch-to-deploy flow; how to roll back; known deploy risks |
| **Rollback** | Step-by-step; blast radius of a bad deploy; who to notify |
| **Escalation** | Tier-1 (on-call) → tier-2 (team lead) → tier-3 (vendor / SRE) contacts + SLA |
| **Post-incident checklist** | What to capture; blameless post-mortem template link |

## Steps

1. **Read the lore + existing runbooks.** `search_lore` for any existing runbook, ADR, or on-call guide for this service. Extend the existing one rather than creating a duplicate.
2. **Inspect the service.** Read the Dockerfile/deployment config, health-check endpoint, environment variables, and alert rules. Every command in the runbook must be real.
3. **Draft from the standard template.** Fill every section. Placeholder (`TODO:`) is acceptable only if you mark it clearly — a missing command is better than a wrong one.
4. **Verify commands.** Run start/stop/health commands in a staging environment or against the repo's CI; confirm the expected output matches.
5. **Link to the service.** Store the runbook in version control alongside the service code (e.g. `docs/runbooks/<service>.md`). Link it from the monitoring alert annotations.
6. **Record evidence.** Commit the runbook; record `test_output` via `record-evidence`; submit for review.

## Build / Test

- Lint for placeholder-only sections — every `TODO:` must have a GitHub issue tracking the gap.
- Verify every `kubectl`/`docker`/`systemctl` command runs without error in staging before the runbook is considered done.
- Confirm the alert → runbook link is live in the alerting platform.

## Review checklist

- **Every section complete** — no untouched template headers.
- **Commands are real** — tested in staging or CI; not copy-pasted from memory.
- **Rollback is documented** — step-by-step, not "revert the deploy".
- **Escalation contacts are current** — names + channels, not just role titles.
- **Post-incident template linked** — blameless, structured, time-bounded.

## Rules

- A runbook with wrong commands is worse than no runbook. Verify before committing.
- Keep every runbook in the repo next to the service it documents — not in a separate wiki that drifts.
- Every alert annotation must link to the relevant runbook section, not the root page.

## Capture lore

Alert-to-runbook links, on-call rotation structure, and escalation contacts are high-value lore — call `suggest_lore` when you learn them with `tags: [runbook, on-call, incidents]`.
