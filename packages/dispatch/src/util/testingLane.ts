import type { Actor } from "../domain/types.js";

/**
 * BBT-001 global toggle: is the independent black-box testing lane ON? Read from
 * `GAFFER_TESTING` (same env-driven path as the other autonomy/idle flags), OFF by
 * default so the lane is fully opt-in. Truthy values are "1"/"true"/"yes"/"on"
 * (case-insensitive); anything else (incl. unset) is OFF. When off, review approval
 * keeps today's behaviour (`in_review -> ready_for_merge`) and the lane is skipped
 * entirely.
 */
export function isTestingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.GAFFER_TESTING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * BBT-001: derive the PROVENANCE of a tester verdict from the recording actor's
 * type, so the dashboard can attribute a pass/fail ("by agent | human | system")
 * instead of surfacing an unattributed verdict. `admin` collapses to `human` (a
 * person), `agent` is the factory tester, `system` is an automated/seam recording.
 */
export function testerProvenance(actor: Actor): "agent" | "human" | "system" {
  switch (actor.type) {
    case "agent":
      return "agent";
    case "system":
      return "system";
    case "human":
    case "admin":
      return "human";
  }
}
