---
name: data-privacy
description: Use when a ticket handles personal data — collecting a new field about a person, exporting or deleting a user's data, retention and anonymisation, analytics events, sharing with a third party — and the change must minimise what is collected, protect it in storage and logs, honour deletion and access requests, and be explainable to a regulator. Invoke for GDPR/CCPA-style work, "add a tracking event", "delete my account", "export user data", or any new column that describes a person.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: security
---

# Handle personal data with minimisation and control

Personal data is a liability you hold on someone else's behalf. Collect the minimum,
name the purpose, protect it everywhere it flows (including logs and backups), give the
person the controls the law and decency require (access, export, delete), and be able to
show what you hold and why. This is engineering, not a policy document.

## Steps

1. **Inventory the data the ticket touches.** Which fields identify or describe a
   person (directly: name, email, IP, device id; indirectly: location, behaviour,
   free text that may contain anything)? Where does each flow: database, cache, logs,
   analytics, third parties, backups, LLM prompts? Call `search_lore` for the repo's
   data classification and retention conventions and existing helpers (redaction,
   anonymisation, export).
2. **Minimise.** Collect only what the feature needs; store derived or hashed forms
   where the raw value is not needed (a salted hash of an email for dedupe, a truncated
   IP for geo). If a field has no stated purpose, do not add it; raise `request_decision`
   when the ticket asks for data without a purpose.
3. **Classify and mark it in code.** Tag the field in the schema or type as personal
   (the repo's convention: a comment, an annotation, a registry) so redaction, export,
   and deletion tooling can find it. Unmarked personal data is data nobody deletes.
4. **Protect it in every flow.** Encrypt in transit and at rest where the platform
   offers it; never write it to logs, error reports, or metrics labels (the
   `structured-logging-and-tracing` skill's redaction rules); never send it to an
   analytics or LLM endpoint without a purpose, a contract, and minimisation; access
   it only through authorization-checked paths (the `security-authz` skill).
5. **Honour the person's rights in code.** Deletion cascades to every store (including
   caches, search indexes, queues, and derived tables) or anonymises where deletion is
   impossible (ledgers), with a test that proves no trace remains; export produces the
   person's data in a readable format from the same field registry; both are auditable
   events.
6. **Set retention and enforce it.** Every personal field has a retention rule; a
   scheduled job (the `scheduled-jobs` skill) deletes or anonymises expired data, and
   backups age out on a documented schedule.
7. **Third parties and consent.** Sharing with a processor needs a documented basis and
   the minimum fields; behavioural tracking respects consent state and is off until
   granted where the repo's jurisdiction requires it; consent changes are recorded.
8. **Test**: the new field is registered and redacted in logs, deletion leaves no rows
   in any store, export contains the field, retention sweeps expired rows, consent-off
   suppresses the event. Evidence with the `record-evidence` skill and note the data
   inventory in one paragraph.

## Rules

- Minimum data for a stated purpose; no purpose, no field.
- Every personal field registered so redaction, export, and deletion find it.
- Never in logs, error reports, metric labels, or unapproved third-party calls.
- Deletion and export are implemented, tested end to end across every store, and
  audited.
- Retention is a rule with an enforcing job, not an intention.
- Consent gates tracking where required; the default is off.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While inventorying the fields you learn the data classification scheme, the field registry, the retention periods and the processor list.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
