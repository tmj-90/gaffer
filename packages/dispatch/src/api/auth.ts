// Lightweight bearer-token auth for the Dispatch API.
//
// Opt-in: when `DISPATCH_API_TOKEN` is set, every request except public static
// assets and `/healthz` must carry `Authorization: Bearer <token>`. When it is
// unset, auth is disabled (the historical loopback-only dev behaviour), so this
// is fully backwards-compatible. A configured token also satisfies the safe-bind
// guard — an authenticated API is safe to expose beyond loopback.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The configured bearer token, trimmed; "" means auth is disabled. */
export function apiToken(): string {
  return (process.env.DISPATCH_API_TOKEN ?? "").trim();
}

/** True when a token is configured (auth enforced + non-loopback bind allowed). */
export function authConfigured(): boolean {
  return apiToken().length > 0;
}

/** SHA-256 digest — fixed 32-byte length so token length never leaks via timing. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time token comparison over fixed-length digests. */
function tokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Extract the bearer credential from an Authorization header, or "" if absent. */
function bearer(req: IncomingMessage): string {
  const raw = req.headers.authorization;
  const header = (Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")).trim();
  const credential = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  return credential ? credential.trim() : "";
}

/**
 * True when the request may proceed: either auth is disabled (no token
 * configured), or a correct `Authorization: Bearer <token>` is present.
 */
export function isAuthorized(req: IncomingMessage): boolean {
  const expected = apiToken();
  if (!expected) return true;
  const provided = bearer(req);
  return provided.length > 0 && tokenMatches(provided, expected);
}
