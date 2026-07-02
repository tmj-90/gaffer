#!/usr/bin/env node
// =====================================================================
// MODEL ROUTING (audit item I1) — the pure router + the config-driven registry.
//
// Proves the deterministic routing FUNCTION (bin/route-model.mjs), against the
// REAL shipped registry (runner/model-registry.json) and a synthetic one:
//   1  phase defaults resolve from the registry (implement→mid, plan→strong, …)
//   2  trivial ticket (low risk, ≤1 AC) on implement/test → cheapest tier
//   3  high-risk / large-AC → stronger tier
//   4  attempt>1 escalates one tier per extra attempt; plan-phase enables debate
//   5  budget-low biases one tier cheaper AND logs the trade-off (a reason line)
//   6  unknown/missing inputs fall back safely — never throws
//   7  REGISTRY-AS-CONFIG: a tier/model ADDED in config is picked up with NO code
//      change (a new tier + an escalation entry routes to it)
//   8  REGRESSION: default registry + a normal ticket → today's models
//      (plan=opus / implement=sonnet)
//
// Zero deps; node's built-in assert. Run: node test/model-routing.test.mjs
// =====================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  routeModel,
  loadRegistry,
  normaliseRegistry,
  scoreDifficulty,
  cheapClassFromEnv,
  FALLBACK_REGISTRY,
  DEFAULT_REGISTRY_PATH,
} from "../bin/route-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = resolve(HERE, "..", "model-registry.json");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

const reg = loadRegistry(SHIPPED);

console.log("== 1: phase defaults resolve from the registry ==");
check("implement → mid → sonnet", () => {
  const d = routeModel({ phase: "implement", risk: "medium", acCount: 3 }, reg);
  assert.equal(d.tier, "mid");
  assert.equal(d.model, "sonnet");
});
check("plan → strong → opus", () => {
  const d = routeModel({ phase: "plan", risk: "medium", acCount: 3 }, reg);
  assert.equal(d.tier, "strong");
  assert.equal(d.model, "opus");
});
check("merge-conflict-resolve → strong", () => {
  assert.equal(routeModel({ phase: "merge-conflict-resolve" }, reg).tier, "strong");
});
check("onboarding → cheap", () => {
  assert.equal(routeModel({ phase: "onboarding" }, reg).tier, "cheap");
});

console.log("== 2: trivial ticket → cheapest tier (implement/test only) ==");
check("trivial implement → cheap → haiku", () => {
  const d = routeModel({ phase: "implement", risk: "low", acCount: 1 }, reg);
  assert.equal(d.tier, "cheap");
  assert.equal(d.model, "haiku");
});
check("trivial test → cheap", () => {
  assert.equal(routeModel({ phase: "test", risk: "low", acCount: 0 }, reg).tier, "cheap");
});
check("trivial does NOT downgrade a plan phase", () => {
  // plan is not in the trivial-downgrade set; it stays at its strong default.
  assert.equal(routeModel({ phase: "plan", risk: "low", acCount: 1 }, reg).tier, "strong");
});

console.log("== 3: high-risk / large-AC → stronger tier ==");
check("high-risk implement → strong", () => {
  assert.equal(routeModel({ phase: "implement", risk: "high", acCount: 2 }, reg).tier, "strong");
});
check("critical-risk implement → strong (clamped, never past top)", () => {
  assert.equal(
    routeModel({ phase: "implement", risk: "critical", acCount: 2 }, reg).tier,
    "strong",
  );
});
check("large-AC implement → strong", () => {
  assert.equal(routeModel({ phase: "implement", risk: "medium", acCount: 6 }, reg).tier, "strong");
});

console.log("== 4: attempt>1 escalates + plan-debate ==");
check("attempt=2 implement → +1 tier (mid → strong)", () => {
  const d = routeModel({ phase: "implement", risk: "medium", acCount: 2, attempt: 2 }, reg);
  assert.equal(d.tier, "strong");
});
check("attempt=2 plan → enables plan-debate", () => {
  const d = routeModel({ phase: "plan", attempt: 2 }, reg);
  assert.equal(d.planDebate, true);
});
check("attempt=1 (first try) does NOT escalate", () => {
  assert.equal(
    routeModel({ phase: "implement", risk: "medium", acCount: 2, attempt: 1 }, reg).tier,
    "mid",
  );
});
check("attempt=3 escalates two tiers from the default (mid → strong, clamped)", () => {
  // cheap default would go cheap→mid→strong; from mid it clamps at strong.
  assert.equal(routeModel({ phase: "onboarding", attempt: 3 }, reg).tier, "strong");
});

console.log("== 5: budget-low biases cheaper + logs the trade-off ==");
check("budget below threshold → -1 tier with a logged reason", () => {
  // GAFFER_BUDGET_LOW_THRESHOLD is read from env inside routeModel.
  process.env.GAFFER_BUDGET_LOW_THRESHOLD = "100";
  try {
    const d = routeModel(
      { phase: "implement", risk: "medium", acCount: 3, budgetRemaining: 10 },
      reg,
    );
    assert.equal(d.tier, "cheap", "should bias one tier cheaper (mid → cheap)");
    assert.ok(
      d.reasons.some((r) => /budget/i.test(r) && /trade-off/i.test(r)),
      "must log the budget trade-off",
    );
  } finally {
    delete process.env.GAFFER_BUDGET_LOW_THRESHOLD;
  }
});
check("unlimited budget (default) never downgrades", () => {
  const d = routeModel({ phase: "implement", risk: "medium", acCount: 3 }, reg);
  assert.equal(d.tier, "mid");
});

console.log("== 6: unknown/missing inputs fall back safely (never throw) ==");
check("unknown phase → safe mid-of-order tier, no throw", () => {
  const d = routeModel({ phase: "totally-unknown-phase" }, reg);
  assert.ok(reg.escalationOrder.includes(d.tier));
});
check("empty context → defaults to implement, never throws", () => {
  const d = routeModel({}, reg);
  assert.equal(d.inputs.phase, "implement");
  assert.equal(d.inputs.risk, "medium");
});
check("garbage inputs → coerced, never throws", () => {
  const d = routeModel(
    { phase: 42, risk: "purple", acCount: -3, attempt: "x", budgetRemaining: "nan" },
    reg,
  );
  assert.equal(d.inputs.risk, "medium");
  assert.equal(d.inputs.acCount, 0);
  assert.equal(d.inputs.attempt, 1);
  assert.equal(d.inputs.budgetRemaining, "unlimited");
});
check("missing registry file → FALLBACK_REGISTRY, never throws", () => {
  const r = loadRegistry("/no/such/registry-file.json");
  assert.deepEqual(r.tiers, FALLBACK_REGISTRY.tiers);
  assert.equal(routeModel({ phase: "implement", risk: "medium", acCount: 2 }, r).model, "sonnet");
});

console.log("== 7: REGISTRY-AS-CONFIG — a new tier/model is config-only ==");
check("adding a 'local' tier + escalation entry routes with NO code change", () => {
  // Mutate ONLY the (parsed) config — not the router code — and prove the new
  // model id flows straight through the same routeModel().
  const shipped = JSON.parse(readFileSync(SHIPPED, "utf8"));
  const edited = normaliseRegistry({
    ...shipped,
    tiers: { ...shipped.tiers, local: "ollama:qwen2.5-coder" },
    escalationOrder: ["local", ...shipped.escalationOrder],
    phaseDefaults: { ...shipped.phaseDefaults, onboarding: "local" },
  });
  const d = routeModel({ phase: "onboarding" }, edited);
  assert.equal(d.tier, "local");
  assert.equal(d.model, "ollama:qwen2.5-coder");
});
check("changing a tier's model id is picked up from config", () => {
  const edited = normaliseRegistry({
    tiers: { cheap: "haiku", mid: "claude-4-sonnet-next", strong: "opus" },
    escalationOrder: ["cheap", "mid", "strong"],
    phaseDefaults: { implement: "mid" },
  });
  assert.equal(
    routeModel({ phase: "implement", risk: "medium", acCount: 2 }, edited).model,
    "claude-4-sonnet-next",
  );
});
check("local seam (config flag) routes the idle/scan path to the local tier", () => {
  const edited = normaliseRegistry({
    tiers: { cheap: "haiku", mid: "sonnet", strong: "opus", local: "ollama:phi" },
    escalationOrder: ["local", "cheap", "mid", "strong"],
    phaseDefaults: { onboarding: "cheap" },
    localSeam: { enabled: true, tier: "local", phases: ["onboarding"] },
  });
  assert.equal(routeModel({ phase: "onboarding" }, edited).tier, "local");
});

console.log("== 8: REGRESSION — default registry + normal ticket → today's models ==");
check("default registry exists + is the shipped path", () => {
  assert.equal(resolve(DEFAULT_REGISTRY_PATH), SHIPPED);
});
check("normal medium-risk 3-AC ticket: plan=opus, implement=sonnet (unchanged)", () => {
  const plan = routeModel({ phase: "plan", risk: "medium", acCount: 3, attempt: 1 }, reg);
  const impl = routeModel({ phase: "implement", risk: "medium", acCount: 3, attempt: 1 }, reg);
  assert.equal(plan.model, "opus", "plan must stay opus for a normal ticket");
  assert.equal(impl.model, "sonnet", "implement must stay sonnet for a normal ticket");
});

console.log("== 9: DIFFICULTY-AWARE routing (3b) — hard routes stronger from the start ==");
check("scoreDifficulty: a big diff alone → 'high'", () => {
  const d = scoreDifficulty({ diffBytes: 60000, fileCount: 1, historicalCostUsd: 0.01 });
  assert.equal(d.label, "high");
  assert.ok(d.reasons.some((r) => /diffBytes/.test(r)));
});
check("scoreDifficulty: many files → 'high'", () => {
  assert.equal(scoreDifficulty({ fileCount: 12 }).label, "high");
});
check("scoreDifficulty: a historically costly area → 'high'", () => {
  assert.equal(scoreDifficulty({ historicalCostUsd: 3.2 }).label, "high");
});
check("scoreDifficulty: all-small signals → 'low'", () => {
  assert.equal(
    scoreDifficulty({ diffBytes: 500, fileCount: 1, historicalCostUsd: 0.02 }).label,
    "low",
  );
});
check("scoreDifficulty: no signals → 'medium' (unknown, not a guess)", () => {
  assert.equal(scoreDifficulty({}).label, "medium");
  assert.equal(scoreDifficulty({ diffBytes: NaN, fileCount: -1 }).label, "medium");
});
check("scoreDifficulty: zero signals are ABSENT, not 'low' (a fresh ticket)", () => {
  // $0 spend / 0 bytes / 0 files = no history yet — must not be mistaken for 'easy'.
  assert.equal(
    scoreDifficulty({ historicalCostUsd: 0, diffBytes: 0, fileCount: 0 }).label,
    "medium",
  );
});
check("high difficulty routes a normal implement ticket STRONGER from attempt 1", () => {
  const base = routeModel({ phase: "implement", risk: "medium", acCount: 3, attempt: 1 }, reg);
  const hard = routeModel(
    { phase: "implement", risk: "medium", acCount: 3, attempt: 1, difficulty: "high" },
    reg,
  );
  assert.equal(base.tier, "mid", "baseline is mid");
  assert.equal(hard.tier, "strong", "a hard ticket escalates up front, not on retry");
  assert.ok(hard.reasons.some((r) => /difficulty 'high'/.test(r)));
});
check("low difficulty keeps an implement ticket cheap (even at 2 ACs)", () => {
  const easy = routeModel(
    { phase: "implement", risk: "medium", acCount: 2, difficulty: "low" },
    reg,
  );
  assert.equal(easy.tier, "cheap");
  assert.ok(easy.reasons.some((r) => /difficulty 'low'/.test(r)));
});
check("high risk still wins over low difficulty (safety over thrift)", () => {
  const d = routeModel({ phase: "implement", risk: "high", acCount: 1, difficulty: "low" }, reg);
  assert.equal(d.tier, "strong");
});
check("difficulty surfaces in the audit inputs", () => {
  const d = routeModel({ phase: "implement", difficulty: "high" }, reg);
  assert.equal(d.inputs.difficulty, "high");
});

console.log("== 10: COST-AS-CONTROL class knob (3a) — Settings biases a class cheap ==");
check("cheapClass biases a mid ticket one tier down", () => {
  const d = routeModel({ phase: "implement", risk: "medium", acCount: 3, cheapClass: true }, reg);
  assert.equal(d.tier, "cheap");
  assert.ok(d.reasons.some((r) => /Settings routed this class to cheap/.test(r)));
});
check("cheapClass NEVER overrides a high-risk escalation (safety wins)", () => {
  const d = routeModel({ phase: "implement", risk: "high", acCount: 2, cheapClass: true }, reg);
  assert.equal(d.tier, "strong");
});
check("cheapClass reflected in the audit inputs", () => {
  assert.equal(routeModel({ phase: "plan", cheapClass: true }, reg).inputs.cheapClass, true);
});
check("cheapClassFromEnv reads GAFFER_CHEAP_PHASES allow-list", () => {
  assert.equal(cheapClassFromEnv("test", { GAFFER_CHEAP_PHASES: "test, self-review" }), true);
  assert.equal(cheapClassFromEnv("implement", { GAFFER_CHEAP_PHASES: "test,self-review" }), false);
  assert.equal(cheapClassFromEnv("test", {}), false);
});

console.log();
if (failures.length === 0) {
  console.log(`PASS: ${pass} checks`);
  process.exit(0);
} else {
  console.log(`FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
