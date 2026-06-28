---
name: incident-response
description: Use when a production incident has been declared and needs classification, triage, escalation, and post-mortem. Covers SEV1-SEV4 severity, false-positive filtering, NIST SP 800-61 lifecycle, and blameless post-mortem facilitation. For proactive threat hunting before an incident fires, use `threat-detection`. For cloud misconfigs, use `cloud-security`.
stack: []
area: devops
---

# Manage declared incidents end-to-end

Triage fast, escalate correctly, contain early, learn systematically. An incident not reviewed is an incident that will recur.

## Severity framework

| Severity | Impact | Response time | Escalation |
|---------|--------|--------------|-----------|
| **SEV1** | Customer data loss, full outage, SLA breach | Immediate — wake on-call lead | Engineering director + comms |
| **SEV2** | Major feature degraded, >20% error rate | < 15 min | On-call lead + affected team |
| **SEV3** | Minor degradation, workaround available | < 1h | Team Slack channel |
| **SEV4** | Low impact, no SLO breach | Next business day | Ticket only |

## NIST SP 800-61 lifecycle

```
Detect → Triage → Contain → Eradicate → Recover → Post-mortem
```

## Steps

1. **Detect and classify.** Is this a real incident or a false positive? Check: baseline metrics normal? Alert recently changed? If false positive → suppress alert and file a tuning ticket; stop here.
2. **Declare severity.** Apply the severity framework above. When in doubt, escalate up and downgrade later — under-escalation costs more than over-escalation.
3. **Assign roles.** Incident commander (owns comms + decisions), tech lead (owns diagnosis + fix), comms lead (stakeholder updates). One person can cover multiple roles for SEV3/4.
4. **Contain.** Isolate blast radius before root-cause analysis. Feature flag off? Rollback? Kill canary? Do the fastest safe contain action first.
5. **Diagnose.** Read logs and traces chronologically from the first anomaly. Golden signals: which of latency/traffic/errors/saturation broke first? Follow the causal chain.
6. **Eradicate + recover.** Apply the fix; verify with health checks and SLI recovery; confirm SLO is back inside budget.
7. **Post-mortem (mandatory for SEV1/2).** Blameless — systems and processes, not people. Template: timeline, impact, root cause, contributing factors, action items with owners + due dates. Review within 5 business days.

## Post-mortem template (key sections)

- **Timeline** — minute-by-minute from first signal to resolution.
- **Impact** — affected users, revenue impact, SLO budget consumed.
- **Root cause** — the specific technical failure; one sentence.
- **Contributing factors** — conditions that made root cause possible.
- **What went well** — detection speed, escalation, comms.
- **Action items** — owner + due date + tracking issue; at least one per contributing factor.

## Review checklist

- **Severity assessed within 5 min** — not retrospectively at resolution.
- **Roles assigned** — commander, tech lead, and comms lead identified at declaration.
- **Contain before diagnose** — blast-radius reduction happened before deep RCA.
- **Post-mortem scheduled** — calendar invite within 24h of resolution for SEV1/2.
- **Action items tracked** — every item has an owner and a due date in the issue tracker.

## Rules

- Blame the system, not the person. A post-mortem that names individuals as the cause is wrong.
- Never close a SEV1/2 without a scheduled post-mortem.
- Contain first, diagnose second — preserving customer experience beats knowing the root cause faster.

## Capture lore

Escalation contacts, on-call rotation, incident Slack channel, and post-mortem process are high-value facts — call `suggest_lore` with `tags: [incidents, on-call, post-mortem]`.
