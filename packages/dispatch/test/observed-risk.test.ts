/**
 * Unit tests for the pure observed-risk module (services/observedRisk.ts).
 *
 * Mirrors risk-annotations.test.ts: pure, deterministic, env-injectable. Covers the
 * aggregation from the real-diff overlay, the size→level mapping + env knobs, the
 * determinacy signal, and the escalation predicate (observed vs declared + ceiling).
 */
import { describe, expect, it } from "vitest";

import { observedRisk, observedRiskCeiling, shouldEscalate } from "../src/services/observedRisk.js";
import type { RepoDiff } from "../src/services/diffService.js";
import type { RiskAnnotation } from "../src/services/riskAnnotations.js";

const NOENV = {} as NodeJS.ProcessEnv;

/** Build a minimal RepoDiff for the observed-risk aggregator. */
function repo(over: Partial<RepoDiff> = {}): RepoDiff {
  return {
    repo: over.repo ?? "svc",
    branch: "feat/x",
    baseBranch: "main",
    diff: "diff --git ...",
    files: over.files ?? 1,
    additions: over.additions ?? 1,
    deletions: over.deletions ?? 0,
    truncated: false,
    riskAnnotations: over.riskAnnotations ?? [],
    ...(over.unavailable ? { unavailable: over.unavailable } : {}),
  };
}

const sensitiveAnn: RiskAnnotation = {
  kind: "sensitive-path",
  severity: "high",
  detail: "1 sensitive path (auth/login.ts)",
  paths: ["auth/login.ts"],
};
const depAnn: RiskAnnotation = {
  kind: "dependency-change",
  severity: "medium",
  detail: "dependency/manifest changed (pnpm-lock.yaml)",
  paths: ["pnpm-lock.yaml"],
};

describe("observedRisk (pure aggregation)", () => {
  it("low for a small benign diff", () => {
    const obs = observedRisk([repo({ files: 1, additions: 5, deletions: 1 })], NOENV);
    expect(obs.level).toBe("low");
    expect(obs.determinate).toBe(true);
  });

  it("a sensitive-path annotation ⇒ high", () => {
    const obs = observedRisk([repo({ riskAnnotations: [sensitiveAnn] })], NOENV);
    expect(obs.level).toBe("high");
    expect(obs.reasons.some((r) => r.includes("sensitive path"))).toBe(true);
  });

  it("a dependency-change annotation ⇒ medium", () => {
    const obs = observedRisk([repo({ riskAnnotations: [depAnn] })], NOENV);
    expect(obs.level).toBe("medium");
  });

  it("size: many files ⇒ high (default threshold 25)", () => {
    const obs = observedRisk([repo({ files: 30, additions: 10, deletions: 0 })], NOENV);
    expect(obs.level).toBe("high");
    expect(obs.files).toBe(30);
  });

  it("size: sizeable lines ⇒ medium (default threshold 200)", () => {
    const obs = observedRisk([repo({ files: 2, additions: 150, deletions: 100 })], NOENV);
    expect(obs.level).toBe("medium");
    expect(obs.lines).toBe(250);
  });

  it("honours env size thresholds", () => {
    const env = {
      DISPATCH_OBSERVED_RISK_FILES_MEDIUM: "2",
      DISPATCH_OBSERVED_RISK_FILES_HIGH: "3",
    } as unknown as NodeJS.ProcessEnv;
    expect(observedRisk([repo({ files: 2, additions: 1, deletions: 0 })], env).level).toBe(
      "medium",
    );
    expect(observedRisk([repo({ files: 3, additions: 1, deletions: 0 })], env).level).toBe("high");
  });

  it("aggregates across multiple write repos (max level + summed size)", () => {
    const obs = observedRisk(
      [repo({ repo: "a", files: 2 }), repo({ repo: "b", files: 3, riskAnnotations: [depAnn] })],
      NOENV,
    );
    expect(obs.level).toBe("medium");
    expect(obs.files).toBe(5);
  });

  it("indeterminate: no write repos", () => {
    const obs = observedRisk([], NOENV);
    expect(obs.determinate).toBe(false);
  });

  it("indeterminate: any repo diff unavailable", () => {
    const obs = observedRisk(
      [repo({ files: 1 }), repo({ repo: "b", unavailable: "no_branch" })],
      NOENV,
    );
    expect(obs.determinate).toBe(false);
  });
});

describe("observedRiskCeiling", () => {
  it("off by default (unset ⇒ null)", () => {
    expect(observedRiskCeiling(NOENV)).toBeNull();
  });
  it("parses a valid level", () => {
    expect(observedRiskCeiling({ DISPATCH_OBSERVED_RISK_CEILING: "high" } as never)).toBe("high");
  });
  it("malformed ⇒ null (inactive, parity preserved)", () => {
    expect(observedRiskCeiling({ DISPATCH_OBSERVED_RISK_CEILING: "nope" } as never)).toBeNull();
  });
});

describe("shouldEscalate (observed vs declared)", () => {
  const low = (over: Partial<ObservedRiskShape> = {}) =>
    ({ level: "low", determinate: true, reasons: [], files: 1, lines: 1, ...over }) as never;
  type ObservedRiskShape = ReturnType<typeof observedRisk>;

  it("observed within declared ⇒ NO escalation (ship as before)", () => {
    expect(shouldEscalate(low({ level: "low" }), "low", NOENV)).toBe(false);
    expect(shouldEscalate(low({ level: "medium" }), "high", NOENV)).toBe(false);
  });

  it("observed exceeds declared ⇒ escalate", () => {
    expect(shouldEscalate(low({ level: "high" }), "low", NOENV)).toBe(true);
    expect(shouldEscalate(low({ level: "medium" }), "low", NOENV)).toBe(true);
  });

  it("honestly-declared high still ships (observed maxes at high)", () => {
    expect(shouldEscalate(low({ level: "high" }), "high", NOENV)).toBe(false);
    expect(shouldEscalate(low({ level: "high" }), "critical", NOENV)).toBe(false);
  });

  it("indeterminate ⇒ escalate (fail toward human)", () => {
    expect(shouldEscalate(low({ determinate: false }), "high", NOENV)).toBe(true);
  });

  it("hard ceiling escalates observed >= ceiling regardless of declared", () => {
    const env = { DISPATCH_OBSERVED_RISK_CEILING: "medium" } as unknown as NodeJS.ProcessEnv;
    expect(shouldEscalate(low({ level: "medium" }), "high", env)).toBe(true);
    expect(shouldEscalate(low({ level: "low" }), "high", env)).toBe(false);
  });
});
