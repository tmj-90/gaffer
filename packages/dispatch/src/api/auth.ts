// Lightweight bearer-token auth for the Dispatch API.
//
// Opt-in: when `DISPATCH_API_TOKEN` is set, every request except public static
// assets and `/healthz` must carry `Authorization: Bearer <token>`. When it is
// unset, auth is disabled (the historical loopback-only dev behaviour), so this
// is fully backwards-compatible. A configured token also satisfies the safe-bind
// guard — an authenticated API is safe to expose beyond loopback.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The configured bearer token, trimmed; "" means auth is disabled. */
export function apiToken(): string {
  return (process.env.DISPATCH_API_TOKEN ?? "").trim();
}

/**
 * Where the auto-generated operator token is persisted. Precedence mirrors the
 * rest of the API surface (runs / settings / idle-loops): `$GAFFER_DATA` →
 * `~/.gaffer` when unset. The runner sets `$GAFFER_DATA` to the repo-local
 * `.gaffer/`, so the token lives beside the other operator state.
 */
export function resolveDashboardTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = (env.GAFFER_DATA ?? "").trim();
  const base = dataDir !== "" ? resolve(dataDir) : join(homedir(), ".gaffer");
  return join(base, "dashboard-token");
}

/** How the effective API token was obtained (for operator-facing startup logs). */
export type ApiTokenSource = "env" | "file" | "generated";

export interface EnsuredApiToken {
  token: string;
  source: ApiTokenSource;
  /** Filesystem path the token was read from / written to (absent for `env`). */
  path?: string;
}

/**
 * Guarantee the API has a bearer token so the control-plane mutations are gated
 * by construction, not merely by deployment posture.
 *
 * Precedence:
 *   1. An operator-set `DISPATCH_API_TOKEN` always wins (source `env`).
 *   2. A previously-persisted `$GAFFER_DATA/dashboard-token` is reused so the
 *      operator's saved token survives restarts (source `file`).
 *   3. Otherwise a fresh 256-bit token is generated, written 0600, and exported
 *      (source `generated`).
 *
 * In cases 2/3 the resolved token is written back into `env.DISPATCH_API_TOKEN`
 * so the rest of the auth path ({@link apiToken}/{@link isAuthorized}) and the
 * safe-bind guard pick it up with no further wiring. This is what stops the
 * delivery agent — whose child env is token-scrubbed by the runner and which
 * therefore cannot present the token — from reaching any mutating endpoint.
 */
export function ensureApiToken(env: NodeJS.ProcessEnv = process.env): EnsuredApiToken {
  const existing = (env.DISPATCH_API_TOKEN ?? "").trim();
  if (existing.length > 0) return { token: existing, source: "env" };

  const path = resolveDashboardTokenPath(env);
  try {
    const persisted = readFileSync(path, "utf8").trim();
    if (persisted.length > 0) {
      env.DISPATCH_API_TOKEN = persisted;
      return { token: persisted, source: "file", path };
    }
  } catch {
    // No readable token file yet — fall through and generate a fresh one.
  }

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  // Enforce 0600 even if the file pre-existed with looser perms (writeFileSync's
  // mode is only applied on creation).
  chmodSync(path, 0o600);
  env.DISPATCH_API_TOKEN = token;
  return { token, source: "generated", path };
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

/** True for HTTP methods that do not change state (safe to leave open locally). */
function isReadOnlyMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/**
 * Full control-plane authorization decision.
 *
 * - No token configured → always allowed (backwards-compatible dev posture). The
 *   standard `dispatch-api` entrypoint auto-provisions a token via
 *   {@link ensureApiToken}, so this branch is only reached by embedders that
 *   construct the server directly (e.g. tests).
 * - Token configured + correct bearer → allowed.
 * - Token configured with a missing/invalid bearer:
 *     - a READ-ONLY request (GET/HEAD) on a LOOPBACK bind is allowed, so the
 *       local dashboard keeps working without the operator wiring the token into
 *       the SPA;
 *     - EVERY mutating/state-changing request (and any request on a non-loopback
 *       bind) is refused. This is the structural stop on the delivery agent —
 *       whose child env the runner scrubs of `DISPATCH_API_TOKEN` — self-approving
 *       its own work over the REST API.
 */
export function isRequestAuthorized(req: IncomingMessage, loopbackBind: boolean): boolean {
  if (isAuthorized(req)) return true;
  const method = (req.method ?? "GET").toUpperCase();
  return isReadOnlyMethod(method) && loopbackBind;
}
