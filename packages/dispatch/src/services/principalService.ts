import { createHash, randomBytes } from "node:crypto";

import type { Actor } from "../domain/types.js";
import type { PrincipalView } from "../repositories/principalRepository.js";

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

/** Principal names: short, URL/CLI-safe identifiers. */
export const PRINCIPAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
