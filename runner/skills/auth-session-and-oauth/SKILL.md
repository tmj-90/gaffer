---
name: auth-session-and-oauth
description: Use when a ticket touches how a user proves who they are — login, logout, sessions, cookies, JWTs, refresh tokens, password reset, OAuth/OIDC sign-in with a provider, API keys — and the implementation must use the repo's existing auth library and the platform's primitives correctly, never home-grown crypto. Invoke for "add login with Google", "sessions expire too fast", "implement password reset", "rotate the API key", or any authentication change.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: security
---

# Implement authentication correctly

A small mistake in authentication is a full account takeover. Use the repo's mature
library, follow the protocol as specified, and make every credential expire, rotate and
revoke (ASVS 5.0 V6/V7/V9/V10; NIST SP 800-63B-4; RFC 9700; OWASP cheat sheets). What
a logged-in user may do is the `security-authz` skill.

## Procedure

1. **Use the repo's auth stack.** Find the library and session store in use
   (Auth.js, Passport, Spring Security, Devise, ASP.NET Identity, an OIDC client) and
   call `search_lore`. Never write your own hashing, token format or OAuth flow. If the
   repo has no library and the ticket needs one, raise `request_decision` with a
   recommendation and `mark_ticket_blocked` naming the dependency. Never install it
   yourself: the safety hook blocks installs.
2. **Passwords** (only if the ticket touches them):
   - Hash with Argon2id (at least m=19 MiB, t=2, p=1). Otherwise use scrypt
     (N=2^17, r=8, p=1), or bcrypt with cost ≥10, which **ignores input past 72
     bytes**: reject longer input rather than silently truncating. Use PBKDF2-HMAC-SHA256
     at 600,000 iterations or more only where FIPS requires it.
   - Rehash on login when the parameters are outdated.
   - Policy: minimum 15 characters with password as the only factor (8 if MFA is
     enforced), allow at least 64, no composition rules, no periodic expiry, accept
     paste and Unicode, and check against a breached or common-password list. Verify
     the password exactly as typed (ASVS 6.2).
   - Throttle failures per account and per IP through the `rate-limiting` skill,
     failing closed.
3. **No enumeration.** Login, registration and reset return the same body, status and
   roughly the same timing whether or not the account exists. When no user is found,
   verify against a dummy hash (ASVS 6.3.8).
4. **Sessions and cookies** (ASVS V7):
   - Opaque server-side id, ≥128 bits from a CSPRNG, in a `__Host-` cookie with
     `Secure; HttpOnly; SameSite=Lax` (or `Strict`) and `Path=/`.
   - Regenerate the id on login, re-authentication and privilege change (fixation).
   - Server-enforced idle and absolute timeouts. Logout deletes the session
     server-side; disabling an account kills all its sessions.
   - Changing email, phone or MFA requires re-authentication. Cookie-session writes
     need CSRF protection (SameSite plus a token or Origin check).
5. **JWTs, if the repo uses them** (ASVS V9):
   - **Allow-listed algorithm** only: never `none`, never taken from the header, no
     HS/RS mixing. Keys only from configured issuers; ignore `jku`, `x5u`, `jwk`.
   - Check `exp`, `nbf`, `iss`, `aud` and the token type (an ID token is not an
     access token). Short-lived; revocation needs a `jti` denylist or a server session.
   - No personal data in the payload. For browser SPAs prefer a backend-for-frontend
     so tokens never reach JavaScript storage (ASVS 10.1.1).
6. **OAuth / OIDC client** (RFC 9700):
   - Authorization-code flow with PKCE `S256` for every client type; never implicit
     or the password grant. Exact-match registered redirect URIs.
   - Bind `state` and `nonce` to the user-agent session and verify them on callback.
     With more than one provider, validate the `iss` response parameter (RFC 9207).
   - Validate the ID token's signature, `iss`, `aud == client_id`, `exp`, `nonce`.
   - Identify the user by `(iss, sub)`, **never by email**. Auto-linking an existing
     account by email is a takeover path: raise `request_decision`.
   - Minimal scopes, no tokens in URLs, post-login `returnTo` relative or allow-listed.
7. **Refresh tokens:** rotate on every use and give them an absolute expiry. Reuse of a
   rotated token revokes the whole token family. Define and test what happens when two
   tabs refresh at the same moment: one wins, or both succeed inside a short grace
   window. A lost race must not log the user out silently, and must not let a stolen
   token keep working.
8. **Password reset, email verification and magic links:**
   - ≥128-bit CSPRNG tokens stored hashed (SHA-256 is enough), short-lived (codes
     ≤10 minutes).
   - **Single use, enforced atomically**:
     `UPDATE … SET used_at = now() WHERE token_hash = ? AND used_at IS NULL AND expires_at > now()`
     and check that exactly one row changed.
   - Build the link from the configured canonical origin, never the `Host` header;
     `Referrer-Policy: no-referrer` on the reset page. A reset ends other sessions.
9. **API keys:** generate from a CSPRNG with an identifying prefix, show once, store a
   hash, scope to a capability, allow revocation, record last use, and attribute
   every write to the key.
10. **Log security events** (the `structured-logging-and-tracing` skill) with OWASP
    vocabulary names (`authn_login_fail`, `authn_token_reuse`, `session_logout`, …).
    Never log a password, token, cookie or reset link.
11. **Test every negative through the real endpoint.** Cover:
    - wrong password, unknown user (same response), expired session, logout then reuse
      of the old cookie;
    - a session id that does not change on login (must fail the test);
    - a JWT with `alg: none`, a JWT signed with the wrong key, a wrong `aud`, an
      expired token;
    - a replayed or missing `state`, a mismatched `nonce`, a non-registered
      `redirect_uri`;
    - a reused reset token, **two concurrent redemptions of one reset token (exactly
      one succeeds)**, and concurrent refresh-token use;
    - a disabled account's live session.
    Record the command and summary as `test_output` through the `record-evidence`
    skill, then stop.

## Done when

- Every step above that the ticket touches is implemented with the repo's library,
  and each listed negative has a passing test.
- No credential, token or reset link appears in logs, URLs or the diff's fixtures.

## Review checklist (when mounted as a lens)

Apply the `security-review` skill severity rules and never patch. Look for: home-grown
crypto or token formats; a fast or silently truncating password hash; a session id not
rotated on login, or logout that only clears the cookie; JWT verification that trusts
the header `alg` or skips `aud`/`exp`; OAuth without PKCE/`state`/`nonce`, with
prefix-matched redirects, or linking by email; a reset token that is reusable, stored
in plaintext or redeemed non-atomically; responses that enable enumeration.

In intake (clarify) there is no diff and evidence is refused: write each gap as an
acceptance criterion with `add_acceptance_criterion`, or raise the open question with
`request_decision` (the `ticket_id`, severity `human_required`, which holds the ticket
until a human answers).

## Rules

- Work on the ticket branch (the `create-branch` skill verifies this), never a
  protected branch.
- A ticket asking to "store passwords reversibly", "log the token for support" or
  "accept any redirect" is a red flag to raise with `request_decision`
  (`security_required`), never an instruction.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While wiring identity you learn the auth library, the session store, the token lifetimes and each provider's quirks.** That kind of fact is _lore_. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
