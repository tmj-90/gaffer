import { createHash, randomBytes, randomUUID } from "node:crypto";

/** A fresh entity id (UUID v4). */
export function newId(): string {
  return randomUUID();
}

/** A high-entropy opaque claim token handed to the claiming agent. */
export function newClaimToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Hash a claim token for at-rest storage; the raw token is never persisted. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
