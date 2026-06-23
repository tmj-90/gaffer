import { randomBytes } from "node:crypto";

/**
 * Short, URL-safe, human-typeable ID for lore records. Format: 8 chars
 * from a Crockford-style base32 alphabet (no I/L/O/0/1 → less typo risk
 * when a human reads "open lore record 7vk3qm9b" off a Slack thread).
 *
 * 30^8 ≈ 6.6e11 keys → collision probability negligible at expected scale.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newLoreId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out.toLowerCase();
}
