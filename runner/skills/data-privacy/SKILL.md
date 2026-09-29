---
name: data-privacy
description: Use when a ticket handles personal data — collecting a new field about a person, exporting or deleting a user's data, retention and anonymisation, analytics events, sharing with a third party — and the change must minimise what is collected, protect it in storage and logs, honour deletion and access requests, and be explainable to a regulator. Invoke for GDPR/CCPA-style work, "add a tracking event", "delete my account", "export user data", or any new column that describes a person.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: security
---

# Handle personal data with minimisation and control

Personal data is anything that relates to an identifiable person. That includes
emails, IP addresses, device and cookie ids, location, behaviour, and free text that
might contain any of those. GDPR requires minimisation (Art. 5(1)(c)), storage
limitation (5(1)(e)), and data protection by design and by default (Art. 25). People
have rights of access (Art. 15), erasure (Art. 17, with notice to recipients under
Art. 19) and portability (Art. 20), and controllers must answer them within one month
(Art. 12(3)). CCPA/CPRA gives similar rights with a 45-day clock. This skill turns
that into code and tests. **You do not decide the lawful basis, the retention period
or a new processor.** Those are human decisions: raise them.

## Procedure

1. **Inventory before you code.** For every personal field the ticket touches, write
   one line with: the field, its purpose, its classification (the repo's scheme, or
   direct identifier / indirect / special category), and every place it lands: the
   primary DB, replicas, caches, search indexes, object storage, queues, logs,
   traces, metrics, analytics, error reporting, third-party APIs, LLM prompts,
   backups. Call `search_lore` for the classification scheme, the field registry,
   retention periods, the processor list and any existing redaction, export or
   erasure helpers. The inventory goes in your evidence.
2. **Minimise.** Collect only what the stated purpose needs.
   - No purpose, no field. If the ticket asks for data without a purpose, or for
     special-category data (health, biometrics, religion and so on), raise
     `request_decision` with `severity: security_required`.
   - Prefer coarser or derived forms: a birth year instead of a birth date, a
     truncated IP, a city instead of GPS coordinates.
   - A salted hash or tokenised id is **pseudonymised, not anonymous**. It is still
     personal data and still subject to erasure (Recital 26).
   - Return only the fields each caller needs (ASVS 14.2.6).
3. **Register the field in code.** Use the repo's annotation, schema tag or registry,
   so redaction, export and erasure find it automatically. A test should fail when a
   personal-looking column (`email`, `phone`, `ip`, `name`, `dob`, `address`) is
   added without a classification. An unregistered field is a field nobody deletes.
4. **Protect every flow.**
   - Access goes only through authorization-checked paths (the `security-authz`
     skill).
   - Encryption in transit, and at rest where the platform offers it. Field-level
     encryption for special categories if the repo has it.
   - The field is never in logs, traces, metric labels or error reports: add it to the
     redaction list of the `structured-logging-and-tracing` skill.
   - Never in URLs or query strings (ASVS 14.2.1). Never in browser storage (14.3.3).
     Sensitive responses carry `Cache-Control: no-store`.
   - Never sent to analytics, trackers or LLM endpoints unless there is a recorded
     purpose and processor, and then only the minimum (ASVS 14.2.3).
5. **Implement erasure end to end.**
   - One erasure routine walks the registry across every store in the inventory. It
     deletes, or anonymises where law requires the record to stay (ledgers, invoices),
     and calls each processor's deletion API or queues that call.
   - Write a **tombstone or suppression entry** so that late writes, queue redelivery,
     replays and backup restores cannot resurrect the person. A restore must re-apply
     tombstones, which is how backups are kept "beyond use".
   - The routine is idempotent and retry-safe (the `idempotency-and-retries` skill),
     and it emits an audit event without the erased data.
6. **Implement access and export.** Build the export from the same registry. It must
   be structured and machine-readable (JSON or CSV), authorization-checked for the
   requester, gated by re-authentication, delivered through a short-lived link, and
   exclude other people's personal data. Record request and completion timestamps so
   the deadline can be shown to have been met.
7. **Enforce retention.** Every registered field has a retention rule. A job from the
   `scheduled-jobs` skill deletes or anonymises expired rows in bounded, resumable
   batches, and a crashed run must be safe to re-run. If the period is not documented,
   ask with `request_decision`.
8. **Gate on consent where required.** Non-essential cookies and tracking are off
   until consent is granted (ePrivacy Art. 5(3)). Withdrawing consent is as easy as
   granting it (GDPR Art. 7(3)), and a consent change is stored with a timestamp and
   the policy version. Honour Global Privacy Control where CCPA applies.
9. **Test with a PII canary.** Seed a unique sentinel (for example
   `canary-<uuid>@example.test`) into every touched field and drive the flows. Then
   assert:
   - the canary is absent from captured logs and error payloads;
   - after erasure, a query of every store in the inventory finds no canary (not just
     the main table);
   - a write or queue message that arrives after erasure does not recreate the
     record;
   - the export contains the canary and no other user's data;
   - the retention job removes expired rows and leaves live rows alone;
   - with consent off, no tracking event is sent.
   Record the command and summary as `test_output` through the `record-evidence`
   skill, with the inventory paragraph, then stop.

## Done when

- The inventory is recorded, each new field is registered with a purpose and a
  retention rule, and the canary tests pass across every store.
- Unresolved purpose, basis, retention or processor questions are raised with
  `request_decision`, not guessed.

## Review checklist (when mounted as a lens)

Record findings per the `security-review` skill rules, and never patch.

In intake (clarify) there is no diff and evidence is refused: write each gap as an
acceptance criterion with `add_acceptance_criterion`, or raise the open question with
`request_decision` (the `ticket_id`, severity `human_required`, which holds the ticket
until a human answers).

- A new personal field with no registry entry, purpose or retention rule.
- Personal data in a log, metric label, URL or analytics or LLM call.
- An erasure that misses a store, or can be undone by a replay or restore.
- An export without an authorization check, or one that includes other users' data.
- Tracking that fires before consent.

## Rules

- Hashing is not anonymisation, and "we might need it later" is not a purpose.
- Work on the ticket branch (the `create-branch` skill verifies this), never a
  protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While inventorying the fields you learn the data classification scheme, the field registry, the retention periods and the processor list.** That kind of fact is _lore_. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
