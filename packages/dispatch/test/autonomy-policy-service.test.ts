/**
 * Unit tests for the Graduated Autonomy ENFORCEMENT decision (Spec 2, Phase 3) —
 * services/autonomyPolicyService.ts. SECURITY-CRITICAL; negative controls mandatory.
 *
 * The whole point of these tests is the PROOF-OF-NO-REGRESSION: with no policy row,
 * isAutonomyAllowed reduces to exactly the pre-Phase-3 env flag. A mode='auto' row is
 * an ADDITIONAL allow-path scoped precisely to its (repo × risk × gate); mode='off'/
 * 'recommend' never grant; and the risk/gate/repo scoping is exact (fail-closed).
 */
import { describe, expect, it } from "vitest";

import {
  ALLOW_AGENT_APPROVE_ENV,
  envAllowsAuto,
  isAutonomyAllowed,
  policyGrantsAuto,
  type PolicyLookup,
} from "../src/services/autonomyPolicyService.js";
import type { AutonomyMode } from "../src/repositories/autonomyPolicyRepository.js";

/** A hand-rolled policy store keyed by "repo|risk|gate" → mode. */
function lookupOf(rows: Record<string, AutonomyMode>): PolicyLookup {
  return {
    get(repoId, riskLevel, gate) {
      const mode = rows[`${repoId}|${riskLevel}|${gate}`];
      return mode ? { mode } : undefined;
    },
  };
}

const EMPTY = lookupOf({});
const ENV_ON = { [ALLOW_AGENT_APPROVE_ENV]: "1" } as NodeJS.ProcessEnv;
const ENV_OFF = {} as NodeJS.ProcessEnv;

describe("envAllowsAuto — the per-gate env fallback (today's behaviour)", () => {
  it("approve gate follows DISPATCH_ALLOW_AGENT_APPROVE exactly", () => {
    expect(envAllowsAuto("approve", ENV_ON)).toBe(true);
    expect(envAllowsAuto("approve", ENV_OFF)).toBe(false);
    expect(envAllowsAuto("approve", { [ALLOW_AGENT_APPROVE_ENV]: "0" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  it("merge gate defaults to true (today the auto-merge always fires post-approve)", () => {
    expect(envAllowsAuto("merge", ENV_OFF)).toBe(true);
    expect(envAllowsAuto("merge", ENV_ON)).toBe(true);
  });

  it("memory gate follows MEMORY_AUTO_APPROVE", () => {
    expect(envAllowsAuto("memory", ENV_OFF)).toBe(false);
    expect(envAllowsAuto("memory", { MEMORY_AUTO_APPROVE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("isAutonomyAllowed — no policy row ⇒ byte-identical to the env flag [no-regression]", () => {
  it("approve: env=1 allows, env unset blocks — exactly as today", () => {
    expect(isAutonomyAllowed(EMPTY, ["repo-a"], "low", "approve", ENV_ON)).toBe(true);
    expect(isAutonomyAllowed(EMPTY, ["repo-a"], "low", "approve", ENV_OFF)).toBe(false);
  });

  it("approve: env='0' blocks (only exactly '1' opts in)", () => {
    const env = { [ALLOW_AGENT_APPROVE_ENV]: "0" } as NodeJS.ProcessEnv;
    expect(isAutonomyAllowed(EMPTY, ["repo-a"], "low", "approve", env)).toBe(false);
  });
});

describe("policyGrantsAuto — a mode='auto' row is an additional allow-path", () => {
  it("mode='auto' allows ONLY that (repo × risk × gate)", () => {
    const lookup = lookupOf({ "repo-a|low|approve": "auto" });
    expect(policyGrantsAuto(lookup, ["repo-a"], "low", "approve")).toBe(true);
    // A policy for risk=low does NOT allow risk=high [negative control].
    expect(policyGrantsAuto(lookup, ["repo-a"], "high", "approve")).toBe(false);
    // Nor a different gate.
    expect(policyGrantsAuto(lookup, ["repo-a"], "low", "merge")).toBe(false);
    // Nor a different repo.
    expect(policyGrantsAuto(lookup, ["repo-b"], "low", "approve")).toBe(false);
  });

  it("mode='off' and 'recommend' do NOT grant auto [negative control]", () => {
    expect(
      policyGrantsAuto(lookupOf({ "repo-a|low|approve": "off" }), ["repo-a"], "low", "approve"),
    ).toBe(false);
    expect(
      policyGrantsAuto(
        lookupOf({ "repo-a|low|approve": "recommend" }),
        ["repo-a"],
        "low",
        "approve",
      ),
    ).toBe(false);
  });

  it("an empty write-repo set never grants (fail-closed)", () => {
    expect(policyGrantsAuto(lookupOf({ "repo-a|low|approve": "auto" }), [], "low", "approve")).toBe(
      false,
    );
  });

  it("a multi-repo ticket needs a mode='auto' row for EVERY write repo (fail-closed)", () => {
    const lookup = lookupOf({ "repo-a|low|approve": "auto" }); // repo-b uncovered.
    expect(policyGrantsAuto(lookup, ["repo-a", "repo-b"], "low", "approve")).toBe(false);
    const both = lookupOf({ "repo-a|low|approve": "auto", "repo-b|low|approve": "auto" });
    expect(policyGrantsAuto(both, ["repo-a", "repo-b"], "low", "approve")).toBe(true);
  });
});

describe("isAutonomyAllowed — policy OR env (the additional path never subtracts)", () => {
  it("mode='auto' allows even when the env flag is unset", () => {
    const lookup = lookupOf({ "repo-a|low|approve": "auto" });
    expect(isAutonomyAllowed(lookup, ["repo-a"], "low", "approve", ENV_OFF)).toBe(true);
  });

  it("mode='off' falls through to the env flag (does not tighten below env)", () => {
    const lookup = lookupOf({ "repo-a|low|approve": "off" });
    // env=1 still allows despite an 'off' row — 'off' only means "no auto grant", it
    // does not override the operator's env opt-in.
    expect(isAutonomyAllowed(lookup, ["repo-a"], "low", "approve", ENV_ON)).toBe(true);
    // env unset ⇒ blocked (the 'off' row grants nothing).
    expect(isAutonomyAllowed(lookup, ["repo-a"], "low", "approve", ENV_OFF)).toBe(false);
  });

  it("risk=low auto does NOT leak to a risk=high ticket even with the policy present [negative control]", () => {
    const lookup = lookupOf({ "repo-a|low|approve": "auto" });
    expect(isAutonomyAllowed(lookup, ["repo-a"], "high", "approve", ENV_OFF)).toBe(false);
  });
});
