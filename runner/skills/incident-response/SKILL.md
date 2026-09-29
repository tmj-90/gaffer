---
name: incident-response
description: Use when a production incident has been declared and needs classification, triage, escalation, and post-mortem. Covers SEV1-SEV4 severity, false-positive filtering, NIST SP 800-61 lifecycle, and blameless post-mortem facilitation. For proactive threat hunting before an incident fires, use `threat-detection`. For cloud misconfigs, use `cloud-security`.
stack: []
area: devops
---

# Manage declared incidents end-to-end

Mitigate first, understand second, learn always. Structure follows the Google SRE book
("Managing Incidents", "Postmortem Culture") and, for security incidents, NIST SP 800-61
Rev. 3 (detect → respond → recover, feeding back into preparation). In Gaffer you usually
act on artefacts — classification notes, the incident timeline, the postmortem, the
follow-up tickets — not on production: you cannot deploy, roll back or reach cloud
consoles, and never run a production-changing command. Mitigations are recommendations a
human executes; if one is needed now, raise `request_decision` with
`severity: human_required` (or `security_required` for a security incident).

## Severity and declaration

| Sev | Impact | Examples |
|---|---|---|
| SEV1 | Data loss or corruption, security breach, full outage | acknowledged writes lost, credentials leaked |
| SEV2 | Major user journey broken or SLO fast-burn page firing | checkout 30% errors |
| SEV3 | Degradation with workaround, slow-burn budget consumption | one region slow |
| SEV4 | No user impact yet | a single replica crash-looping |

Declare an incident (SRE book criteria) if any is true: a second team is needed; the
problem is user-visible; it is unresolved after an hour of focused work. When in doubt,
declare at the higher severity and downgrade later. **Any loss of acknowledged data is
SEV1** regardless of how few users saw it.

## Procedure

1. **Confirm it is real.** Compare the firing signal to its baseline; check whether the
   alert rule, the deploy, or the telemetry pipeline changed recently. A false positive
   ends here: record why, and file an alert-tuning follow-up. Do not silence without a
   record.
2. **Classify and assign roles.** Severity from the table. Roles: Incident Commander
   (coordinates, decides, owns the state document), Operations lead (the only one changing
   systems), Communications lead (stakeholder updates on a fixed cadence), Planning lead
   (tracks follow-ups, handoffs). One person may hold several roles for SEV3/4; the IC
   role is always explicit and handed off explicitly.
3. **Open a live state document** and keep a UTC timeline: every observation, decision,
   and action with who/when. It becomes the postmortem's timeline.
4. **Mitigate before root cause.** Fastest safe action that stops user harm: roll back the
   last change, disable the feature flag, shift traffic, shed load, stop the writer that is
   corrupting data. For suspected data loss, stop further writes to the affected store
   before anything else. For security incidents, contain (revoke credentials, isolate
   hosts) while **preserving evidence** — snapshot logs and disks before restarting or
   deleting anything. Write the chosen action into the state document for a human to
   execute; you do not execute it.
5. **Diagnose from the first anomaly forward.** Which golden signal moved first, in which
   component, right after which change? Check deploys, config changes, dependency status,
   traffic shape. For data-integrity incidents look specifically for concurrent writers,
   read-modify-write without locking or versioning, temp-file name collisions, and
   time-based locks or leases that another process could break while the holder was paused
   (GC, SIGSTOP, VM migration) — the class of defect that shipped twice in live runs.
6. **Recover and verify.** The code fix goes on this ticket's branch; a human deploys it.
   Write the recovery check into the state document: the SLI back within SLO over a full
   short window and, for data incidents, what was acknowledged reconciled against what
   was persisted. State the impact numerically from the data you were given.
7. **Postmortem** — mandatory for SEV1/SEV2, any data loss, any on-call intervention
   (rollback, traffic reroute), any incident found by a human rather than monitoring.
   Draft within 2 business days. Sections: summary; impact (users, duration, error budget
   consumed, data affected); UTC timeline; root cause(s) and trigger; contributing factors;
   detection (how, how fast, what would have caught it sooner); what went well; where we
   got lucky; action items.
8. **Action items** each have an owner, a priority, a due date, and a tracking reference;
   at least one per contributing factor; prefer items that prevent a class of failure
   (a test schedule that pauses the lock holder, an alert on lease takeovers) over "be
   more careful". Evidence the postmortem with the `record-evidence` skill, then stop.

## Review checklist (concrete defects only)

- Timeline has UTC timestamps from first signal to recovery and names the trigger.
- Impact is quantified; data loss is stated explicitly (or explicitly ruled out, with how).
- Root cause is a system condition, not a person; no individual is blamed.
- Every contributing factor maps to at least one action item with owner and date.
- A regression test or detection signal is among the actions for any correctness bug.
- Security incident: evidence preservation and credential rotation are recorded.

## Anti-patterns

- Debugging for an hour while users are still failing and a rollback was available.
- Several people changing production at once without the Operations lead.
- "Root cause: human error." Ask why the system allowed the error.
- Closing the incident when the graph recovers but acknowledged writes were never
  reconciled.

## Capture lore

Escalation contacts, on-call rotation, incident channel and postmortem location are
high-value facts: call `suggest_lore` with `tags: [incidents, on-call, post-mortem]`.
