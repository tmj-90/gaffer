import { describe, expect, it } from "vitest";

// The canonical dangerous-command deny list lives in the runtime hook's package
// as plain ESM (zero deps). Importing it HERE — rather than re-typing the list —
// is the whole point of S-3: the parity assertions are DERIVED from the one
// source of truth, so the runtime hook and the crew classifier cannot drift
// silently. See runner/lib/dangerous-commands.mjs for why a shared data module
// (not a shared classifier) is the right seam across the .mjs/.ts boundary.
import { DANGEROUS_COMMANDS } from "../../../runner/lib/dangerous-commands.mjs";
import { classifyCommand } from "../src/safety/commandGuard.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";

/**
 * Parity guard for the duplicated dangerous-command logic.
 *
 * `runner/safety-hook.mjs` is the RUNTIME enforcer: Claude Code invokes it as a
 * PreToolUse hook and it deny-by-defaults the dangerous command classes (exit 2
 * = block). Crew ships an independent TypeScript classifier
 * (`src/safety/commandGuard.ts`, `classifyCommand`) that encodes the same intent.
 * The two are deliberately duplicated so a security control never depends on
 * another build.
 *
 * S-3 makes parity STRUCTURAL: instead of a hand-maintained copy of the deny
 * list, this test imports the SAME `DANGEROUS_COMMANDS` array the hook enforces
 * and derives its assertions from it:
 *
 *   • Every rule the crew classifier is EXPECTED to mirror (`crewFlags: true`)
 *     has its representative `example` fed to `classifyCommand`, which must NOT
 *     allow it (deny or needs_approval). If the crew classifier loses coverage
 *     of a mirrored family, the test fails.
 *
 *   • Every rule carries an explicit `crewFlags` verdict and an `example` that
 *     actually matches the runtime `re`. Adding a NEW deny family to the shared
 *     source therefore forces a parity decision for it — it can no longer slip in
 *     uncovered. The families the crew classifier does NOT currently mirror
 *     (`crewFlags: false` — scheduled execution, control-plane CLI, raw DB, …)
 *     are recorded as runtime-only rather than passing silently.
 *
 * Note: the hook is binary (allow/block), whereas the TS classifier is
 * three-valued. Some classes the hook hard-blocks (dependency installs, hard
 * reset) are `needs_approval` here — still "flagged, not silently allowed", which
 * is the parity property we care about.
 */

const policy = defaultSafetyPolicy();
const ctx = { commands: policy.commands, git: policy.git };

/** A command is "flagged" if the classifier does not allow it outright. */
function isFlagged(command: string): boolean {
  return classifyCommand(command, ctx).outcome !== "allowed";
}

const BENIGN_COMMANDS = [
  "pnpm test",
  "git commit -m x",
  "node build.mjs",
  "cat package.json",
  "grep foo src/app.ts",
] as const;

describe("safety classifier parity with runner/safety-hook.mjs", () => {
  // Sanity: the shared source is non-empty (guards against an import resolving to
  // an empty/undefined module, which would make every loop below vacuously pass).
  it("imports a non-empty canonical deny list from the runtime hook's source", () => {
    expect(Array.isArray(DANGEROUS_COMMANDS)).toBe(true);
    expect(DANGEROUS_COMMANDS.length).toBeGreaterThan(15);
  });

  // Structural integrity: every rule must carry an `example` that ACTUALLY
  // matches its runtime regex and an explicit boolean `crewFlags` verdict. This
  // is what forces a new deny family to declare its parity intent instead of
  // sneaking in untested.
  describe("every canonical rule is well-formed (example matches re, crewFlags declared)", () => {
    for (const rule of DANGEROUS_COMMANDS) {
      it(`well-formed: ${rule.why}`, () => {
        expect(typeof rule.crewFlags).toBe("boolean");
        expect(typeof rule.example).toBe("string");
        expect(rule.example.length).toBeGreaterThan(0);
        // The example MUST trip the runtime rule it claims to represent.
        expect(rule.re.test(rule.example)).toBe(true);
      });
    }
  });

  // The parity property: every family the crew classifier is expected to mirror
  // must be flagged (denied or approval-gated) for its representative example.
  describe("crew-mirrored rules are flagged by the TS classifier", () => {
    const mirrored = DANGEROUS_COMMANDS.filter((r) => r.crewFlags);
    it("at least the historical mirrored set is covered", () => {
      // Pin a floor so the structural derivation cannot regress to "nothing is
      // mirrored" (which would make the loop below vacuously pass).
      expect(mirrored.length).toBeGreaterThanOrEqual(9);
    });
    for (const rule of mirrored) {
      it(`flags (${rule.why}): ${rule.example}`, () => {
        expect(isFlagged(rule.example)).toBe(true);
      });
    }
  });

  // Runtime-only families: documented as NOT currently mirrored by the crew
  // classifier. Listed explicitly (not silently dropped) so the gap is visible
  // and a future decision to mirror one is a deliberate flag flip.
  it("records runtime-only deny families (crewFlags=false) for visibility", () => {
    const runtimeOnly = DANGEROUS_COMMANDS.filter((r) => !r.crewFlags).map((r) => r.why);
    // These are enforced ONLY at the runtime hook today (scheduled execution,
    // control-plane CLI, raw DB, brew, find tree-walks, shred, git-config hijack).
    expect(runtimeOnly.length).toBeGreaterThan(0);
  });

  describe("benign commands pass", () => {
    for (const command of BENIGN_COMMANDS) {
      it(`allows: ${command}`, () => {
        expect(classifyCommand(command, ctx).outcome).toBe("allowed");
      });
    }
  });
});
