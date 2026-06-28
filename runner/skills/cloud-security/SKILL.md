---
name: cloud-security
description: Use when assessing cloud infrastructure for security misconfigurations, IAM privilege-escalation paths, S3 public exposure, open security-group rules, or IaC security gaps. Covers AWS, Azure, and GCP posture. For active cloud compromise, use `incident-response`. For behavioural anomalies, use `threat-detection`.
stack: []
area: security
---

# Assess cloud posture before attackers do

Cloud misconfigurations are the most common initial-access vector. Find them in review, not in an incident.

## The four critical categories

| Category | Most common mistake | Check |
|----------|---------------------|-------|
| **IAM** | Privilege escalation via `PassRole` + `AssumeRole` + wildcard policies | No `*` on `Action` without explicit justification; no inline policies |
| **Storage** | Public S3 / GCS / Azure Blob | Block Public Access enabled; no `*` principal in bucket policies |
| **Network** | `0.0.0.0/0` ingress on admin ports | No open 22/3389 to internet; VPC peering limited to known CIDRs |
| **IaC** | Secrets in `.tf`/`.yml` | No hardcoded credentials; no `var` with default that contains a secret |

## IAM analysis

Work the privilege-escalation graph:

1. What actions does this principal have?
2. Can it `iam:PassRole` to a more-privileged role?
3. Can it `sts:AssumeRole` on a wildcard or overly-permissive trust policy?
4. Does it have `*` on resource for any action?

Principle of least privilege: every principal has only the permissions it needs to perform its function, nothing more.

## S3 / storage

- `BlockPublicAcls: true`, `BlockPublicPolicy: true`, `IgnorePublicAcls: true`, `RestrictPublicBuckets: true` — all four on every bucket unless public hosting is the explicit purpose.
- Bucket policy principal `"*"` (unauthenticated) is a BLOCK finding unless the bucket is a public CDN origin.
- Server-side encryption (SSE-S3 minimum; SSE-KMS preferred for sensitive data).
- Access logging enabled for compliance buckets.

## Network / security groups

- No inbound `0.0.0.0/0` or `::/0` on ports 22 (SSH), 3389 (RDP), 5432 (Postgres), 3306 (MySQL), 27017 (MongoDB).
- Egress rules: restrict to known destinations where possible — a blanket `0.0.0.0/0` egress allows C2.
- VPC flow logs enabled for forensic capability.

## IaC security review

- No credentials in `.tf`, `.yml`, or `.json` committed to version control.
- Provider credentials from environment or secrets manager, not hardcoded.
- Run `tfsec`/`checkov`/`kics` in CI; block on HIGH/CRITICAL.

## Steps

1. **Read the lore + existing posture.** `search_lore` for past security findings, approved exceptions, and compliance requirements (SOC2, PCI, HIPAA).
2. **Enumerate IAM principals.** List roles and users with `*` actions or `*` resources. Map privilege-escalation paths.
3. **Audit storage.** Check Block Public Access settings; bucket policies; encryption; logging.
4. **Audit network.** Security groups and NACLs for open admin ports; egress rules.
5. **Audit IaC.** Grep for hardcoded secrets; run static analysis.
6. **Classify findings.** BLOCK (exploitable now), CONCERN (risk without mitigating control), NOTE (hardening opportunity).
7. **Verify.** Re-run checks after remediation; confirm findings are closed; record evidence.

## Review checklist

- **No `*` Action on any IAM policy** without documented justification.
- **Block Public Access on all storage** — no exceptions without documented business reason.
- **No 0.0.0.0/0 ingress on admin ports** — reviewed and closed or restricted.
- **No hardcoded credentials** in IaC or config files.
- **Static analysis clean** — `tfsec`/`checkov` with no HIGH/CRITICAL.
- **Encryption at rest** — enabled on all storage with sensitive data.

## Rules

- Public bucket without explicit CDN purpose is a BLOCK finding.
- Wildcard IAM action (`*`) without documented justification is a BLOCK finding.
- Every cloud account has a posture baseline before any new workload deploys.

## Capture lore

Approved security exceptions, compliance requirements, and IAM policy conventions are high-value lore — call `suggest_lore` with `tags: [security, cloud, iam]`.
