/**
 * ACCEPTANCE PROFILES: the profile names, with no zod (domain/types.ts imports these,
 * and the CLI's help and parse paths must not load zod; testspeed/TS-2). The specs and
 * their schemas live in acceptanceProfile.ts.
 */
export const ACCEPTANCE_PROFILES = [
  "unit",
  "cli",
  "api",
  "web",
  "migration",
  "performance",
] as const;
export type AcceptanceProfile = (typeof ACCEPTANCE_PROFILES)[number];

/** The profiles the runner can run today. */
export const EXECUTABLE_PROFILES: readonly AcceptanceProfile[] = ["cli", "api"];

export function isAcceptanceProfile(v: unknown): v is AcceptanceProfile {
  return typeof v === "string" && (ACCEPTANCE_PROFILES as readonly string[]).includes(v);
}

/** The contract's profile (absent or unknown = unit). */
export function contractProfile(contract: { profile?: unknown } | null): AcceptanceProfile {
  return contract && isAcceptanceProfile(contract.profile) ? contract.profile : "unit";
}
