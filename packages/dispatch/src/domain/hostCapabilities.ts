/**
 * DECLARED NEEDS: the host capabilities a ticket's test contract may say its proof needs
 * (`needs: ["browser"]`). A closed list: a name outside it is refused when the contract
 * is set. The runner probes the host for each one itself (runner/bin/tester-run.mjs
 * probeHostCapability; the agent's word is never the probe), and when one is missing the
 * tester is told so and the outcome for the ticket's criteria is a hold for a person
 * (`tester_unprovable`), never a PASS. No zod here: domain/types.ts imports it.
 */
export const HOST_CAPABILITIES = ["browser"] as const;
export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export function isHostCapability(v: unknown): v is HostCapability {
  return typeof v === "string" && (HOST_CAPABILITIES as readonly string[]).includes(v);
}
