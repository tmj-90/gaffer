---
name: adversarial-reviewer
description: Use when you want a genuinely critical review of recent changes — before merging a PR, after a sprint, or when you suspect the review is being too agreeable. Forces perspective shifts through three hostile reviewer personas that catch blind spots the author's mental model shares with the reviewer. Triggers on "adversarial review", "break my code", "what could go wrong", "devil's advocate review", or "pre-merge review".
stack: []
area: review
---

# Break the self-review monoculture

When an agent reviews code it just wrote, it shares the author's assumptions and blind spots. This produces "Looks good to me" on code a fresh reviewer would flag immediately. Three hostile personas; each must find at least one issue.

## The three personas

**Saboteur** — wants to break this in production. Asks: what input crashes this? What race condition emerges under load? What happens when a dependency is down? What deploy order causes data corruption?

**New Hire** — joined last week. Asks: what does this variable name actually mean? Why was this chosen over the obvious alternative? Where does this function get called? Could I maintain this at 2 AM?

**Security Auditor** — OWASP Top 10 + supply chain. Asks: where is user input validated? Where could injection occur? What happens if this secret leaks? Are dependencies pinned and scanned?

## Severity classification

| Level | Meaning | Action |
|-------|---------|--------|
| **BLOCK** | Production break, data loss, security vulnerability | Must fix before merge |
| **CONCERN** | Quality, maintainability, or performance issue | Should fix before merge |
| **NOTE** | Suggestion, style, minor smell | Optional; document if skipping |

**Severity promotion:** a finding caught by 2+ personas is promoted one level (CONCERN → BLOCK; NOTE → CONCERN). Cross-persona findings reveal a systemic blind spot.

## Steps

1. **Read the diff.** `git diff` against the merge target. If the diff is large, read the most critical files first: auth, payments, data mutations, API boundaries.
2. **Adopt the Saboteur.** Look for: unhandled error paths, race conditions, wrong assumptions about input range, missing retries, state corruption, resource leaks. The Saboteur must find at least one finding.
3. **Adopt the New Hire.** Look for: unclear names, missing context, surprising behaviour, missing tests, no docstring on a complex function, a choice that needs explanation. The New Hire must find at least one finding.
4. **Adopt the Security Auditor.** Look for: unvalidated input, SQL/command injection, hardcoded secrets, insecure defaults, over-permissive access, dependency risks. The Auditor must find at least one finding.
5. **Deduplicate and promote.** Merge findings; promote cross-persona findings one severity level.
6. **Emit the verdict.** BLOCK (any BLOCK finding) / CONCERNS (CONCERN only) / CLEAN (notes only). Include the evidence: file, line, description, and suggested fix for every BLOCK/CONCERN.

## Output format

```
## Adversarial Review — <scope>

### Saboteur
- [BLOCK] `src/auth.ts:42` — JWT verified without checking `exp` claim; expired tokens accepted.

### New Hire
- [CONCERN] `processPayment()` — 120 lines; no inline doc; unclear why retry limit is 3. Extract and document.

### Security Auditor
- [BLOCK] `src/auth.ts:42` — (shared with Saboteur — promoted from CONCERN)
- [CONCERN] `package.json` — `axios@0.27.2` has known SSRF CVE (CVE-2023-45857); upgrade to 1.6+.

### Verdict: BLOCK
Fix `src/auth.ts:42` before merge.
```

## Review checklist

- **Every persona has at least one finding** — no persona is allowed a clean pass.
- **Every BLOCK includes a suggested fix** — not just a description of the problem.
- **Cross-persona findings promoted** — check for overlap before finalising severity.
- **Verdict matches the highest severity** — BLOCK if any BLOCK; CONCERNS if any CONCERN.

## Rules

- No "looks good" without running all three personas.
- BLOCK findings must be fixed before merge — the reviewer must re-check after the fix.
- Security Auditor always checks dependencies for known CVEs, not just the diff.
