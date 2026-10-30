#!/usr/bin/env node
// =====================================================================
// The onboarding pass's lore rules stay in sync with the memory-onboard SKILL.
// ---------------------------------------------------------------------
// lib/onboard-analyze.mjs inlines the card-generation / card-review skills, but the
// memory-onboard skill ("the way to seed a repo with lore") is an interactive
// interview, so the one-shot pass carries a hand-distilled copy of its hard rules
// (MEMORY_ONBOARD_RULE). Before this, an edit to the skill never reached the agent and
// nothing noticed. Now:
//   1. the skill's "## Hard rules" section is read at runtime and hashed; the hash must
//      equal MEMORY_ONBOARD_RULES_SYNCED_SHA — change the skill's rules and this fails
//      until the distillation is re-checked and the pin bumped;
//   2. every hard rule that applies to a one-shot, JSON-emitting pass is present in the
//      distillation (drafts only, the induction tag, a Source: citation, no secrets,
//      skip the obvious, selective).
// Run: node test/onboard-memory-rules-sync.test.mjs
// =====================================================================
import {
  MEMORY_ONBOARD_HARD_RULES,
  MEMORY_ONBOARD_RULE,
  MEMORY_ONBOARD_RULES_HASH,
  MEMORY_ONBOARD_RULES_SYNCED_SHA,
} from "../lib/onboard-analyze.mjs";

let passed = 0;
const failures = [];
const check = (label, cond) => (cond ? (passed += 1) : failures.push(label));

check(
  "the memory-onboard skill's '## Hard rules' section is read at runtime",
  typeof MEMORY_ONBOARD_HARD_RULES === "string" && /^## Hard rules/.test(MEMORY_ONBOARD_HARD_RULES),
);
check(
  `the skill's hard rules match the version MEMORY_ONBOARD_RULE was distilled from ` +
    `(skill ${MEMORY_ONBOARD_RULES_HASH}, synced ${MEMORY_ONBOARD_RULES_SYNCED_SHA}) — ` +
    `re-sync MEMORY_ONBOARD_RULE in lib/onboard-analyze.mjs, then bump the pin`,
  MEMORY_ONBOARD_RULES_HASH === MEMORY_ONBOARD_RULES_SYNCED_SHA,
);

// Rule (skill wording) → what the distillation must carry.
const rules = MEMORY_ONBOARD_HARD_RULES ?? "";
for (const [skillSays, distilled, label] of [
  [/is a \*\*DRAFT\*\*|DRAFT/, /DRAFTS? for a human to ratify|DRAFT lore/i, "records are drafts"],
  [/tag `induction`/, /"induction"/, "the induction tag"],
  [/Cite sources in the body/, /Source: <ref>/, "a Source: citation in the body"],
  [/Never put secrets/, /NEVER include secrets/, "no secrets / personal data"],
  [/Skip the obvious/, /SKIP THE OBVIOUS/, "skip the obvious"],
]) {
  check(`the skill still states: ${label}`, skillSays.test(rules));
  check(`MEMORY_ONBOARD_RULE carries: ${label}`, distilled.test(MEMORY_ONBOARD_RULE));
}

if (failures.length) {
  console.error(`onboard-memory-rules-sync: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`onboard-memory-rules-sync: ${passed} passed`);
