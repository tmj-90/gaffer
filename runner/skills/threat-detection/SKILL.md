---
name: threat-detection
description: Use when hunting for threats in an environment, analysing IOCs, or detecting behavioural anomalies in telemetry. Covers hypothesis-driven threat hunting, IOC sweep generation, and MITRE ATT&CK-mapped signal prioritisation. For active declared incidents, use `incident-response`. For cloud misconfigurations, use `cloud-security`.
stack: []
area: security
---

# Find threats that evaded automated controls

Proactive, hypothesis-driven. Threat hunting starts with a question — "what if a service account was compromised?" — and ends with evidence or explicit closure of the hypothesis.

## Hunt methodology (PEAK model)

```
Purpose → Execution → Analysis → Knowledge
```

1. **Purpose** — State the hypothesis explicitly. "I believe attacker X used technique Y (ATT&CK TTP Z) to compromise target W." Scope the data sources needed.
2. **Execution** — Query SIEM/EDR for the signals that hypothesis predicts. Collect raw evidence before analysis.
3. **Analysis** — Statistical baselines + anomaly detection + IOC correlation. Distinguish signal from noise.
4. **Knowledge** — Output: confirmed threat (→ `incident-response`), false positive (document why), or detection gap (→ new detection rule).

## MITRE ATT&CK prioritisation

Not all techniques are equally probable. Prioritise hunts by:

1. **Actor relevance** — is this technique used by actors that target your industry/region?
2. **Control gap** — do existing detections cover this technique? No → higher priority.
3. **Data availability** — do you have the logs to run this hunt? No data = can't hunt.

Weight each 1–3; multiply. Hunt the highest scores first.

## IOC analysis

IOCs decay fast. Before sweeping, check freshness (< 30 days for IPs; < 90 days for domains; hashes are permanent).

For each IOC: domain, IP, hash, or user-agent — generate sweep queries for your SIEM/EDR. Correlate hits with process trees and lateral movement signals before escalating.

## Anomaly detection signals

Statistical anomaly = behaviour outside the baseline for that entity. Useful baselines:

- **Authentication** — login frequency, hours, geolocation, user-agent per account.
- **Network** — outbound connection volume, destination ASN, protocol by host.
- **Process** — spawned child processes, execution frequency by host and user.
- **Data access** — file reads per hour, new file extensions accessed.

A z-score >3 on any of these warrants investigation, not immediate escalation.

## Steps

1. **Form the hypothesis.** Specific attacker technique + expected observable signal. Vague hunts waste time.
2. **Identify data sources.** Confirm the required telemetry is available and retention covers the hunt window. Gap in data = gap in hunt.
3. **Generate queries.** SIEM/EDR searches for the predicted signals. Save queries for reuse.
4. **Sweep IOCs.** Run freshness check; query all sources; correlate hits.
5. **Analyse results.** Calculate baselines; flag z-score outliers; correlate across telemetry sources.
6. **Closure.** Three outcomes: escalate to `incident-response`, document false positive with reasoning, or file a detection gap as a new detection rule.
7. **Record evidence.** Save hunt queries, raw results, and analysis. Call `record-evidence`.

## Review checklist

- **Hypothesis explicit** — not "look for anything suspicious".
- **Data sources confirmed** — not assumed.
- **IOC freshness checked** — stale IOCs discard first.
- **Every hit correlated** — single-source hits require corroboration before escalation.
- **Closure documented** — confirmed / false-positive / detection-gap, not just "nothing found".

## Rules

- Never escalate to an incident on a single uncorroborated IOC hit.
- Every hunt produces a documented output — even "nothing found" with the queries used.
- Detection gaps discovered during hunts become new detection rules — not backlog items.
