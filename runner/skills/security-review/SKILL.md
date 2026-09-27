---
name: security-review
description: Use as a REVIEW LENS when judging another agent's diff for security defects — injection, broken authentication or authorization, secrets in code, unsafe deserialisation, SSRF, path traversal, missing validation, insecure defaults — before recommending approval. Invoke on every review of a ticket that touches auth, input handling, data access, outbound requests, files, crypto, or configuration, and on any high-risk ticket; it complements review-ticket, it does not replace it.
stack: []
area: review
---

# Security review lens

The reviewer's job is to find the defect the author could not see. Security defects are
the most expensive to miss and the easiest to skim past, because the code looks like it
works. Walk the diff against this checklist deliberately; a finding here is a concrete
defect under the review bar (a correctness or security bug), never a style wish.

## Steps

1. **Map the attack surface of the diff.** What new input arrives (HTTP params, headers,
   bodies, files, messages, env), what new data is read or written, what new outbound
   calls are made, what new privileges are exercised. If the diff touches none of these,
   say so and move on; if it touches any, walk the relevant checklist sections below.
   Call `search_lore` for the repo's security conventions and past incidents.
2. **Walk the checklist against the actual code**, opening the files, not the summary.
   For each item either write "n/a", "ok — because <the line that makes it so>", or a
   finding with file, line, and the concrete fix.
3. **Rate each finding.** Blocking: exploitable by an unauthenticated or ordinary user,
   leaks data, or bypasses a control. Should-fix: exploitable only with elevated access
   or in combination. Note: hardening. Only blocking and should-fix findings justify
   `RECOMMEND CHANGES`; notes are listed as "(optional)".
4. **Record the findings as evidence** with `record_ac_evidence` (a `manual_note` per
   finding naming the checklist item), then let the `review-ticket` verdict carry the
   result. Never fix the code yourself — you are the reviewer.

## Checklist

- **Input validation**: every new external input validated at the boundary with an
  allow-list schema (type, length, range, format); rejected with the documented error;
  nothing trusted from the client (ids, roles, prices, paths).
- **Injection**: SQL through parameters or the ORM (no string building); shell commands
  through argv arrays (no `sh -c` with interpolation); HTML escaped by the template
  engine (no `innerHTML`/`html_safe`/`dangerouslySetInnerHTML` on untrusted data); LDAP,
  XPath, NoSQL, log injection considered where relevant.
- **Authentication**: no new path bypasses login; tokens validated fully (signature,
  expiry, audience); passwords and secrets never logged; session handling unchanged or
  improved (the `auth-session-and-oauth` skill).
- **Authorization**: every new read and write checks the caller's permission on the
  specific object (not just "is logged in"); no IDOR (an id from the client used without
  an ownership check); privilege changes audited (the `security-authz` skill).
- **Secrets**: no credentials, keys, or tokens in code, tests, fixtures, or logs; secrets
  read from the repo's secret mechanism (the `security-secret-handling` skill); no
  secret in a URL or a client bundle.
- **Outbound requests**: user-supplied URLs validated against private/loopback/metadata
  ranges (SSRF), HTTPS enforced, redirects bounded, timeouts set.
- **Files and paths**: user-supplied names never used as paths; traversal rejected;
  uploads limited, type-checked, stored outside executable roots (the `file-uploads`
  skill).
- **Deserialisation and parsing**: no unsafe deserialisers (`pickle`, Java native
  serialisation, `yaml.load`) on untrusted data; JSON parsed with size limits; XML with
  external entities disabled.
- **Crypto**: standard libraries and algorithms only; no home-grown hashing or
  encryption; random values from a CSPRNG; constant-time comparison for secrets.
- **Errors and logging**: stack traces, SQL, and internal paths never returned to
  clients; personal data and secrets never logged; failures fail closed.
- **Dependencies and config**: new dependencies justified and audited; debug modes,
  permissive CORS, disabled TLS verification, or wildcard permissions not introduced;
  security-relevant defaults not loosened.
- **Prompt and agent surfaces** (where the code drives an LLM or agent): untrusted text
  quarantined and never treated as instructions; tools scoped; outputs validated.

## Rules

- Walk the checklist against the code, not the description; "looks fine" is not a
  finding or a pass.
- Findings name file, line, and fix; severity decides whether they block.
- You review; you do not patch. Findings go into evidence, the verdict goes through
  `review-ticket`.
- A security defect is always a concrete defect under the review bar; it is never
  "optional".
