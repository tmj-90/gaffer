---
name: auth-session-and-oauth
description: Use when a ticket touches how a user proves who they are — login, logout, sessions, cookies, JWTs, refresh tokens, password reset, OAuth/OIDC sign-in with a provider, API keys — and the implementation must use the repo's existing auth library and the platform's primitives correctly, never home-grown crypto. Invoke for "add login with Google", "sessions expire too fast", "implement password reset", "rotate the API key", or any authentication change.
stack: [node, python, go, java, rust, csharp, kotlin, ruby, react, web]
area: security
---

# Implement authentication correctly

Authentication is where a small mistake is a full compromise. The rule is to use the
mature library the repo already has, follow the protocol as specified, store nothing you
do not need, and make every token expire, rotate, and revoke. Authorization (what a
logged-in user may do) is the `security-authz` skill; this one is about identity.

## Steps

1. **Use the repo's auth stack.** Find the library and pattern already in place
   (Passport/Auth.js/Lucia, Spring Security, Devise, ASP.NET Identity, an OIDC client)
   and the session store. Call `search_lore` for the conventions. Never write your own
   password hashing, token format, or OAuth flow when a maintained library exists;
   if none exists, raise `request_decision` with a recommendation before building.
2. **Passwords**: hash with argon2id or bcrypt at the library's recommended cost, never
   store or log plaintext, compare in constant time (the library does), enforce a
   sensible minimum length and check against known-breached lists where the repo does,
   and rate-limit attempts (the `rate-limiting` skill, fail closed).
3. **Sessions and cookies**: an opaque random session id stored server-side, or a
   short-lived signed token plus a rotating refresh token; cookies `HttpOnly`, `Secure`,
   `SameSite=Lax` or `Strict`, scoped path and domain, with an absolute and an idle
   expiry. Regenerate the session id on login and privilege change; destroy it
   server-side on logout.
4. **JWTs, if the repo uses them**: short expiry, a pinned algorithm (never `none`, never
   trusting the header's `alg`), audience and issuer checked, keys rotated with a `kid`,
   revocation handled through a short lifetime plus a refresh-token allow-list. Never put
   secrets or personal data in a JWT; it is readable.
5. **OAuth / OIDC sign-in**: authorization-code flow with PKCE, a `state` parameter
   checked on return, the `nonce` checked in the id token, redirect URIs exact-matched
   from an allow-list, tokens from the provider validated (signature, `iss`, `aud`,
   `exp`) and never trusted on the basis of a successful HTTP call alone. Link accounts
   by the provider's stable subject id, not by email.
6. **Password reset and email verification**: single-use, short-lived, random tokens
   stored hashed; the response is identical whether or not the email exists; the reset
   invalidates other sessions; the link uses HTTPS and the canonical host.
7. **API keys**: generated with a CSPRNG, shown once, stored hashed, prefixed for
   identification, scoped to a capability, revocable, and attributed on every write they
   make (the `security-secret-handling` skill covers storage and rotation).
8. **Log the security events** (login success/failure by account, logout, reset
   requested, key created/revoked) without logging credentials, through the
   `structured-logging-and-tracing` conventions. Test every path including the
   negatives: wrong password, expired token, replayed `state`, mismatched redirect,
   tampered JWT, reused reset token. Evidence with the `record-evidence` skill.

## Rules

- The repo's auth library and protocol as specified; no home-grown crypto or flows.
- Passwords hashed with argon2id/bcrypt; never logged; attempts rate-limited, fail
  closed.
- Cookies `HttpOnly`/`Secure`/`SameSite`; sessions regenerate on login and die on
  logout, server-side.
- Tokens are short-lived, algorithm-pinned, audience-checked, rotatable, revocable.
- OAuth: code flow with PKCE, `state` and `nonce` verified, exact redirect allow-list,
  accounts linked by subject id.
- Enumeration-safe responses; single-use hashed reset tokens.
- Security events logged; credentials never are.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While wiring identity you learn the auth library, the session store, the token lifetimes and each provider's quirks.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
