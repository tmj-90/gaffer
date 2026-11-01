import { createHash, randomBytes } from "node:crypto";

import type { Actor } from "../domain/types.js";
import type { PrincipalView } from "../repositories/principalRepository.js";
import type { Access, AccessScope } from "./accessScope.js";

/**
 * PER-PRINCIPAL CREDENTIALS — the token discipline.
 *
 * - A token is 256 bits of CSPRNG output, base64url, with a recognisable prefix so
 *   a leaked one is identifiable in logs and secret scanners (`gfp_…`).
 * - Only `sha256(token)` is stored. Lookup is by hash: the hash is of the secret,
 *   so an equality lookup on it leaks nothing about the secret itself.
 * - The actor a principal speaks for is fixed at creation: `{ type, id }`. Every
 *   event and evidence row written under that credential carries this identity.
 */

export const PRINCIPAL_TOKEN_PREFIX = "gfp_";

export function mintPrincipalToken(): string {
  return `${PRINCIPAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashPrincipalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when a bearer credential has the principal-token shape (cheap pre-filter). */
export function looksLikePrincipalToken(credential: string): boolean {
  return credential.startsWith(PRINCIPAL_TOKEN_PREFIX) && credential.length >= 20;
}

/** The actor a principal's requests act as. */
export function principalActor(p: PrincipalView): Actor {
  return { type: p.actor_type, id: p.actor_id };
}

/** A principal's scope as the evaluation takes it (ids only; null: unscoped). */
export function principalScope(p: PrincipalView): AccessScope | null {
  if (!p.scope) return null;
  return {
    ...(p.scope.repos ? { repos: p.scope.repos.map((r) => r.id) } : {}),
    ...(p.scope.tickets ? { tickets: p.scope.tickets.map((t) => t.id) } : {}),
  };
}

/**
 * What a principal may do, for {@link import("./accessScope.js").authorizeAccess}:
 * read-only from its capability, admin from its actor type, and its scope.
 */
export function principalAccess(p: PrincipalView): Access {
  return {
    readOnly: p.capability === "read",
    admin: p.actor_type === "admin",
    scope: principalScope(p),
  };
}

/** Principal names: short, URL/CLI-safe identifiers. */
export const PRINCIPAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
