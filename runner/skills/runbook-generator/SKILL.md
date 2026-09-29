---
name: runbook-generator
description: Use when a service has no runbook, existing runbooks are inconsistent across teams, or on-call onboarding requires standardised operations docs. Triggers on "write a runbook", "document on-call procedures", "operational playbook", "incident playbook", or "runbook for <service>".
stack: []
area: devops
---

# Generate operational runbooks

A runbook lets an on-call engineer who has never seen this service diagnose and mitigate
it at 3am. It is a how-to guide in Diátaxis terms: task-first, numbered, copy-pasteable,
with the expected result after each step. A wrong command is worse than a missing one.

## Required sections

| Section | Contents |
|---|---|
| Overview | What the service does, owner team, criticality, SLO link |
| Dependencies | Upstream/downstream services, data stores, queues; what breaks if each fails |
| Health | How to tell it is healthy: endpoint, metric, dashboard; the expected healthy output |
| Alerts | One subsection per alert, anchored so the alert can link to it (below) |
| Routine operations | Start, stop, restart, scale, rotate a credential — exact commands |
| Deploy and rollback | How a release goes out; the exact rollback command and how to confirm it worked |
| Data safety | Backups, restore procedure, what must never be done to the data store |
| Escalation | Who next, how to reach them, when (time or severity threshold); postmortem template link |

## Per-alert template

```markdown
### <AlertName>
**Means:** <user impact in one sentence>
**Check:** <command/query> → healthy looks like <output>
**Likely causes:** <ranked, each with the check that confirms it>
**Mitigate:** 1. <command> → expect <output>  2. ...
**Escalate if:** <condition or elapsed time> → <team/channel>
```

## Procedure

1. **Gather facts, not memories.** `search_lore` for existing runbooks and on-call
   conventions; find existing runbooks in the repo (`docs/runbooks/`, `ops/`, `README`).
   Extend one if it exists. Read the deployment manifests, Dockerfile/compose, health
   endpoints, config keys, and alert rule files — the alert names and thresholds come from
   there, not from invention.
2. **List every alert** defined for the service and give each a subsection with a stable
   anchor. An alert without a runbook section is a gap to report.
3. **Write every command against the real service**: real binary names, flags, namespaces,
   label selectors, metric names. Parameterise only what varies (`<pod-name>`), and say how
   to obtain it (`kubectl get pods -l app=api -n prod`). Mark destructive commands
   (delete, restore, force-unlock, failover) with a warning and a precondition check.
4. **Make lock and lease recovery safe.** If the service uses locks, leases or leader
   election, the runbook must say how to prove the holder is dead (process gone, node
   drained, fencing token advanced) before breaking the lock — never "delete the stale lock
   file". Breaking a lock held by a paused-but-alive process lost acknowledged writes in
   live runs.
5. **Include rollback as steps**, with the verification that it worked (version endpoint,
   error ratio back under threshold), not "revert the deploy".
6. **Verify what you can** (below). Anything you could not execute is marked
   `UNVERIFIED:` with the reason; do not present it as tested.
7. **Link both ways.** Put the runbook next to the code (`docs/runbooks/<service>.md`
   unless the repo has a convention) and add or update each alert's `runbook_url`
   annotation to point at its anchor. Evidence with the `record-evidence` skill, then
   stop.

## Verification

- Read-only commands (status, logs, health, queries) run locally or against the dev
  compose/kind stack if the repo provides one; record the command and output. Check
  `kubectl config current-context` first, and never run anything against a shared,
  staging or production environment, even read-only; mark those steps `UNVERIFIED:`.
- Destructive commands are verified by `--help`/syntax only. A `kubectl … --dry-run`
  still talks to the API server, so run one only after `kubectl config current-context`
  names a local kind/minikube cluster; otherwise mark the step `UNVERIFIED:`. Never
  execute a destructive command against a shared environment.
- Every alert name in the runbook exists in the alert rules, and vice versa (grep both).
- Every link and anchor resolves; markdown renders (`npx --no -- prettier --check` if the repo
  uses it).

## Review checklist (concrete defects only)

- A command references a binary, flag, namespace, metric or endpoint that does not exist
  in the repo.
- An alert has no section, or a section has no "Escalate if".
- Rollback or restore is prose instead of steps with a verification.
- A destructive step has no precondition check or warning.
- Lock/lease recovery lacks a "prove the holder is dead" step.
- Secrets appear inline instead of a reference to where they are stored.

## Capture lore

Alert-to-runbook links, escalation paths and on-call structure are high-value lore: call
`suggest_lore` with `tags: [runbook, on-call, incidents]`.
