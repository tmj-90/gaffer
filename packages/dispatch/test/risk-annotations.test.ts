import { describe, expect, it } from "vitest";

import { computeRiskAnnotations } from "../src/services/riskAnnotations.js";

const NOENV = {} as NodeJS.ProcessEnv;

describe("computeRiskAnnotations", () => {
  it("returns [] when nothing is elevated", () => {
    expect(computeRiskAnnotations(["src/util.ts", "README.md"], 10, NOENV)).toEqual([]);
  });

  it("flags sensitive paths (auth/migrations/CI/secrets/.env/keys) as high", () => {
    const paths = [
      "packages/auth/login.ts",
      "db/migrations/003_add.sql",
      ".github/workflows/ci.yml",
      "config/secrets.json",
      ".env.production",
      "deploy/id_rsa",
    ];
    const anns = computeRiskAnnotations(paths, 0, NOENV);
    const ann = anns.find((a) => a.kind === "sensitive-path");
    expect(ann).toBeDefined();
    expect(ann!.severity).toBe("high");
    expect(ann!.paths).toHaveLength(6);
  });

  it("does NOT trip 'auth' on 'author.ts' (segment-anchored)", () => {
    expect(computeRiskAnnotations(["src/author.ts", "src/oauthClient.ts"], 0, NOENV)).toEqual([]);
  });

  it("flags dependency/manifest changes as medium", () => {
    const anns = computeRiskAnnotations(["pnpm-lock.yaml", "packages/x/package.json"], 0, NOENV);
    const dep = anns.find((a) => a.kind === "dependency-change");
    expect(dep).toBeDefined();
    expect(dep!.severity).toBe("medium");
    expect(dep!.paths).toHaveLength(2);
  });

  it("flags a large deletion at/above the threshold", () => {
    expect(
      computeRiskAnnotations(["src/a.ts"], 200, NOENV).some((a) => a.kind === "large-deletion"),
    ).toBe(true);
    expect(
      computeRiskAnnotations(["src/a.ts"], 149, NOENV).some((a) => a.kind === "large-deletion"),
    ).toBe(false);
  });

  it("honours env overrides (sensitive RE + deletion threshold)", () => {
    const env = {
      DISPATCH_SENSITIVE_PATH_RE: "payments/",
      DISPATCH_LARGE_DELETION_LINES: "10",
    } as unknown as NodeJS.ProcessEnv;
    const anns = computeRiskAnnotations(["src/payments/charge.ts"], 12, env);
    expect(anns.some((a) => a.kind === "sensitive-path")).toBe(true);
    expect(anns.some((a) => a.kind === "large-deletion")).toBe(true);
    // The default auth pattern no longer applies (override replaced it).
    expect(computeRiskAnnotations(["packages/auth/x.ts"], 0, env)).toEqual([]);
  });

  it("a malformed override regex falls back to the default (never throws)", () => {
    const env = { DISPATCH_SENSITIVE_PATH_RE: "(" } as unknown as NodeJS.ProcessEnv;
    // Falls back to the default → auth path still flagged, no throw.
    expect(
      computeRiskAnnotations(["auth/login.ts"], 0, env).some((a) => a.kind === "sensitive-path"),
    ).toBe(true);
  });

  it("can return multiple annotations for one repo", () => {
    const anns = computeRiskAnnotations(["db/migrations/1.sql", "pnpm-lock.yaml"], 300, NOENV);
    expect(anns.map((a) => a.kind).sort()).toEqual([
      "dependency-change",
      "large-deletion",
      "sensitive-path",
    ]);
  });
});
