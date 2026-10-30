import { createHash, randomBytes, randomUUID } from "node:crypto";

/** A fresh entity id (UUID v4). */
export function newId(): string {
  return randomUUID();
}

/**
 * A high-entropy opaque claim token handed to the claiming agent. The `ct_` prefix
 * keeps it from starting with "-": bare base64url does 1 time in 64, and the CLI
 * then read the token as an option (`-v…` printed the version and exited 0, so a
 * submit, release or heartbeat silently did nothing). Only the hash is stored, so
 * tokens issued before the prefix still validate.
 */
export function newClaimToken(): string {
  return `ct_${randomBytes(24).toString("base64url")}`;
}

/** Hash a claim token for at-rest storage; the raw token is never persisted. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
