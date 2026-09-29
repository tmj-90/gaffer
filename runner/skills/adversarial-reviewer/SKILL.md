---
name: adversarial-reviewer
description: Use when you want a genuinely critical review of recent changes — before merging a PR, after a sprint, or when you suspect the review is being too agreeable. Forces perspective shifts through three hostile reviewer personas (Saboteur, New Hire, Security Auditor) that play concurrent, crash, retry and malicious-input schedules to catch blind spots the author's mental model shares with the reviewer. Triggers on "adversarial review", "break my code", "what could go wrong", "devil's advocate review", or "pre-merge review".
stack: []
area: review
---

# Break the review monoculture

A reviewer reading a diff tends to adopt the author's story of how it works and approve
it. Live runs showed the cost: reviewers twice gave correctness 4/5 to code that lost
updates under two concurrent writers and lost an acknowledged write when a lock holder
was paused. The cure is to stop reading the story and **attack** the code from three
hostile positions. Each persona must make real attempts — and must report only what
actually breaks. An attack that fails is written down as "tried X — holds because
<line>"; it is not dressed up as a finding.

## The three personas

**Saboteur** — wants to break this in production. Plays schedules, not vibes:
- two callers at once on every write (lost update, temp-file collision, double insert);
- the process paused past any timeout or lock lease, then resuming;
- a crash between two writes, or after the write but before the acknowledgement;
- the request retried after a timeout, a message delivered twice;
- a dependency slow, down or returning garbage; a disk full; a clock jump;
- inputs at the edges: empty, huge, negative, unicode, duplicate keys, wrong type;
- old code running against the new schema mid-deploy.

**New Hire** — joined last week and must change this code at 2 AM. Asks: what does this
name actually mean, where is this called from, why this over the obvious alternative,
which test tells me I broke it? Their findings are usually notes; they become defects
only when the confusion hides a real bug (a misleading name that led to a wrong call, a
test named for an AC it does not exercise).

**Security Auditor** — OWASP ASVS 5.0 plus supply chain. Traces each new input to its
sinks: injection, missing object-level authorization, SSRF, path traversal, mass
assignment, secrets in code or logs, unsafe deserialisation; checks any new or bumped
dependency is pinned and comes from the expected registry.

## Severity

| Level | Meaning | Effect on a Gaffer review |
|-------|---------|---------------------------|
| **BLOCK** | A reproducible schedule or input that loses or corrupts data, breaks an AC, crashes, or bypasses a security control | Grounds for `RECOMMEND CHANGES` |
| **CONCERN** | A real defect needing an unusual but possible condition | Grounds for `RECOMMEND CHANGES` only when it is a correctness or security bug |
| **NOTE** | Maintainability, naming, style, hardening with no exploit | Listed "(optional)"; never grounds for CHANGES |

A finding raised independently by two personas is promoted one level — but never to
BLOCK without a concrete schedule or input that reproduces it.

## Steps

1. **Read the diff** once against the merge target (`git diff <base>...HEAD`); for a
   large diff start with writes, auth, money, persistence and API boundaries.
2. **Saboteur pass.** For each write path and external call, play the schedules above
   and write each as numbered steps ending in the observable result (lost write, 500,
   duplicate charge, torn file). Walk the `concurrency-review` checklist for shared
   state and persistence.
3. **New Hire pass.** Note what is unclear; promote only confusion that hides a bug.
   Check each AC's test is named for and exercises that AC (the `test-quality-review`
   skill).
4. **Security Auditor pass.** Map sources to sinks with the `security-review`
   checklist. For new or bumped dependencies, run the repo's existing audit command if
   it has one (`npm audit`, `pip-audit`, `govulncheck`); never install tools.
5. **Deduplicate and promote.** Merge findings; apply the promotion rule.
6. **Emit the result.** Every BLOCK and CONCERN gets file, line, the reproducing
   schedule or input, and one suggested fix. In a Gaffer review, record them with
   `record_ac_evidence` (`evidence_type: manual_note`) and let the `review-ticket`
   bar decide the verdict; outside Gaffer, emit BLOCK / CONCERNS / CLEAN.

## Output format

```
## Adversarial review — <scope>
### Saboteur
- [BLOCK] store.ts:42 — 1) A reads todos.json 2) B reads 3) A writes +x 4) B writes +y → x lost.
  Fix: hold the file lock across read and write.
- tried: crash mid-write — holds (unique temp file + rename, store.ts:57)
### New Hire
- [NOTE] `sync()` also deletes stale rows; name hides that.
### Security Auditor
- tried: path traversal on `name` — holds (allow-list regex, routes.ts:18)
### Verdict: BLOCK — fix store.ts:42
```

## Rules

- Every persona records its attempts; no persona is required to invent a finding.
- No BLOCK without a reproducing schedule or input; no CHANGES for a NOTE.
- Re-check each BLOCK after the fix lands.
- As a reviewer you never patch the code under review.
