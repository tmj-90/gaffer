// =====================================================================
// .github/dependabot.yml — the dependency queue stays actionable.
// ---------------------------------------------------------------------
// With no group and no ignore entries, dependabot kept re-filing majors that are
// known not to build (zod 4, TypeScript 6/7), a @types/node major above the engines
// floor, and vitest + @vitest/coverage-v8 majors as two PRs that cannot land apart.
//   D1  vitest + @vitest/* in ONE group covering majors, matched before minor-and-patch
//   D2  @types/node majors ignored while engines.node is ">=22"
//   D3  zod / typescript holds are VERSION-SCOPED (the next major still arrives)
// Run: node runner/test/dependabot-config.test.mjs
// =====================================================================
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
// `yaml` is a dispatch dependency; resolve it from there (pnpm does not hoist it).
const { parse } = createRequire(resolve(ROOT, "packages", "dispatch", "package.json"))("yaml");

let passed = 0;
const failures = [];
function check(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

const cfg = parse(readFileSync(resolve(ROOT, ".github", "dependabot.yml"), "utf8"));
const npm = (cfg.updates || []).find((u) => u["package-ecosystem"] === "npm");
check(!!npm, "an npm update entry exists");
const groups = Object.entries(npm?.groups || {});
const runnerIdx = groups.findIndex(([, g]) => (g.patterns || []).includes("vitest"));
const tr = runnerIdx >= 0 ? groups[runnerIdx][1] : {};

console.log("== D1: vitest + @vitest/* move together ==");
check(runnerIdx >= 0, "D1 a group matches vitest");
check(
  (tr.patterns || []).includes("@vitest/*"),
  "D1 …and @vitest/* (coverage-v8 rides the same PR)",
);
check(
  ["major", "minor", "patch"].every((t) => (tr["update-types"] || []).includes(t)),
  "D1 the group covers majors (vitest N and coverage-v8 N arrive as ONE PR)",
);
const mpIdx = groups.findIndex(([name]) => name === "minor-and-patch");
check(mpIdx < 0 || runnerIdx < mpIdx, "D1 it is matched before minor-and-patch");

console.log("== D2: @types/node tracks the engines floor ==");
const ignores = npm?.ignore || [];
const engines = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).engines?.node;
const typesNode = ignores.find((i) => i["dependency-name"] === "@types/node");
check(engines === ">=22", `D2 engines.node is ">=22" (got ${engines})`);
check(
  (typesNode?.["update-types"] || []).includes("version-update:semver-major"),
  "D2 @types/node majors are ignored (a Node 24+ API must not typecheck on a Node 22 floor)",
);

console.log("== D3: held majors are scoped, not blanket ==");
for (const dep of ["zod", "typescript"]) {
  const ig = ignores.find((i) => i["dependency-name"] === dep);
  check(!!ig && (ig.versions || []).length > 0, `D3 ${dep}: held by an explicit version range`);
  check(
    !(ig?.["update-types"] || []).includes("version-update:semver-major"),
    `D3 ${dep}: not a blanket major ignore (the next major still opens a PR)`,
  );
}

console.log("");
if (failures.length === 0) {
  console.log(`dependabot-config: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`dependabot-config: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
