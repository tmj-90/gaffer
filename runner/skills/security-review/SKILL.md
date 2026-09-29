---
name: security-review
description: Use as a REVIEW LENS when judging another agent's diff for security defects — injection, broken authentication or authorization, secrets in code, unsafe deserialisation, SSRF, path traversal, missing validation, mass assignment, insecure defaults — before recommending approval. Invoke on every review of a ticket that touches auth, input handling, data access, outbound requests, files, crypto, or configuration, and on any high-risk ticket; it complements review-ticket, it does not replace it.
stack: []
area: review
---

# Security review lens

Security defects are the most expensive to miss and the easiest to skim past, because
the code works. Walk the diff against this checklist, organised by OWASP ASVS 5.0
chapter. A finding is a concrete, reachable defect — a **source** (input an attacker
controls), a **sink** (where it does harm) and the missing control between them — never
a hardening wish.

## Steps

1. **Map the attack surface of the diff.** New inputs (params, headers, bodies, files,
   messages, env, webhook payloads), new data read or written, new outbound calls, new
   privileges or roles. If the diff touches none, write "no new attack surface" and stop.
   Call `search_lore` for the repo's security conventions and past incidents.
2. **Trace each input to its sinks** by opening the files: query builders, shell/exec,
   templates, file paths, URL fetchers, deserialisers, redirects, authorisation checks.
   Walk only the checklist sections those sinks need.
3. **For each item** write "n/a", "ok — <the line that makes it so>", or a finding with
   file, line, attacker, input, impact and the single concrete fix.
4. **Rate each finding.** Blocking: exploitable by an unauthenticated or ordinary user,
   leaks data, or bypasses a control. Should-fix: exploitable only with elevated access or
   in combination. Note: hardening with no exploit path. Only blocking and should-fix
   justify `RECOMMEND CHANGES`; notes are "(optional)".
5. **Record each finding** with `record_ac_evidence` (`evidence_type: manual_note`: the
   checklist item, file, line, severity, fix). As a lens inside the primary review, the
   `review-ticket` verdict carries the result. As the second-opinion security reviewer,
   you give the verdict: RECOMMEND CHANGES for any blocking or should-fix finding, else
   RECOMMEND APPROVE, then as the very last line, alone, exactly `{"verdict":"CHANGES"}`
   or `{"verdict":"APPROVE"}`; do not run tests or the build, and stay under 12 tool
   calls. Never fix the code yourself. Read the diff once and open only
   the files it touches.

## Checklist

- **Encoding and injection (V1)**: SQL through parameters or the ORM, never string
  building (including `ORDER BY`/column names — allow-list them); shell via argv arrays,
  never `sh -c` with interpolation; output encoded by the template engine, no
  `innerHTML`/`dangerouslySetInnerHTML`/`v-html`/`|safe` on untrusted data; NoSQL
  operators (`$where`, `$ne`) not accepted from JSON bodies; no CRLF into headers or logs.
- **Validation and business logic (V2)**: every new input validated at the boundary
  with an allow-list schema (type, length, range, format); server re-checks prices,
  quantities, ids and states the client sends; steps cannot be skipped; limited resources
  cannot be double-booked by concurrent requests (the `concurrency-review` skill).
- **Web frontend (V3)**: state-changing requests protected against CSRF (SameSite
  cookies plus token or custom-header check); cookies `Secure`, `HttpOnly` for session,
  `SameSite` set; CORS never reflects arbitrary `Origin` with credentials; no open
  redirect to a user-supplied URL.
- **API (V4) and defensive coding (V15.3)**: responses return only the fields the caller
  may see (no whole ORM object); mass assignment blocked — writable fields allow-listed
  per action (no `role`, `owner_id`, `is_admin` from the body); strict type comparisons;
  JavaScript merges immune to prototype pollution (`__proto__`, `constructor`).
- **Files (V5)**: user-supplied names never used as paths; canonicalised path checked
  inside the allowed root; archive entries checked for `../` (zip slip); uploads limited
  in size and type, stored outside executable roots (the `file-uploads` skill).
- **Authentication and sessions (V6, V7)**: no new route bypasses login; passwords
  hashed with a slow KDF (argon2id, bcrypt, scrypt); session id rotated on login and
  invalidated on logout; login and reset responses do not reveal whether an account
  exists (the `auth-session-and-oauth` skill).
- **Authorization (V8)**: every new read and write checks the caller's right to the
  specific object, not just "is logged in"; no IDOR — a client id is scoped by owner or
  tenant in the query itself; checks happen server-side on every path, including
  list, export and bulk endpoints (the `security-authz` skill).
- **Tokens and OAuth (V9, V10)**: JWTs verified with a fixed algorithm allow-list (no
  `none`, no HS/RS confusion), expiry, issuer and audience checked; OAuth uses exact
  redirect-URI matching, `state` or PKCE, and never puts tokens in URLs.
- **Crypto (V11)**: standard libraries only; CSPRNG for tokens and ids that grant access;
  constant-time comparison for secrets and signatures; no ECB, MD5 or SHA-1 for security.
- **Communication and outbound calls (V12)**: TLS verification never disabled;
  user-supplied URLs checked against private, loopback, link-local and metadata ranges
  after DNS resolution (SSRF); redirects not followed unless intended; timeouts set.
- **Configuration and secrets (V13)**: no credentials, keys or tokens in code, tests,
  fixtures, logs or client bundles (the `security-secret-handling` skill); debug modes,
  wildcard permissions and permissive defaults not introduced; new dependencies pinned
  in the lockfile and from the expected registry.
- **Data protection (V14)**: personal and secret data not logged, cached publicly or
  returned in errors; sensitive responses not cacheable.
- **Parsing (V1, V5)**: no unsafe deserialisers (`pickle`, Java native serialisation,
  `yaml.load`, `Marshal`) on untrusted data; XML external entities disabled; body and
  JSON size limited; regexes over user input free of catastrophic backtracking.
- **Errors and logging (V16)**: stack traces, SQL and internal paths never returned to
  clients; failures fail closed; security events (login, permission denied) logged
  without secrets.
- **Agent and LLM surfaces**: untrusted text quarantined and never treated as
  instructions; tools scoped to least privilege; model output validated before it
  reaches a sink.

## Rules

- Walk the checklist against the code, not the description; "looks fine" is neither a
  finding nor a pass.
- Every finding names source, sink, file, line and fix; severity decides whether it
  blocks.
- A reachable security defect is never "optional"; a hardening idea with no exploit
  path always is.
- You review; you do not patch. Findings go into evidence.
