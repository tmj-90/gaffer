#!/usr/bin/env node
// Zero-dependency tests for the stack/area skill selector. Run: node test/select-skills.test.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseFrontmatter,
  skillMatches,
  selectSkills,
  loadSkills,
  listAreas,
  expandStacks,
  DEFAULT_SKILLS_DIR,
} from "../bin/select-skills.mjs";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`,
  );
}

// --- parseFrontmatter -------------------------------------------------------
check("parseFrontmatter reads name, stack list and area", () => {
  const fm = parseFrontmatter(
    "---\nname: x\ndescription: d\nstack: [typescript, node]\narea: language\n---\nbody",
  );
  eq(fm.name, "x", "name");
  eq(fm.description, "d", "description");
  eq(fm.stack, ["typescript", "node"], "stack");
  eq(fm.area, "language", "area");
});
check("parseFrontmatter treats empty list / missing keys as no constraint", () => {
  const fm = parseFrontmatter("---\nname: y\nstack: []\narea: backend\n---");
  eq(fm.stack, [], "empty stack");
  const fm2 = parseFrontmatter("---\nname: z\n---");
  eq(fm2.stack, [], "missing stack defaults empty");
  eq(fm2.area, "", "missing area defaults empty");
});
check("parseFrontmatter falls back to dir name when name absent", () => {
  eq(parseFrontmatter("---\narea: x\n---", "fallback").name, "fallback", "fallback name");
});

// --- skillMatches semantics (mirror Crew registry) --------------------
check("empty skill stack matches any query stack", () => {
  assert(
    skillMatches({ stack: [], area: "backend" }, { stacks: ["python"] }),
    "empty stack = no constraint",
  );
});
check("empty query stack matches any skill stack", () => {
  assert(
    skillMatches({ stack: ["typescript"], area: "language" }, {}),
    "empty query = no constraint",
  );
});
check("non-empty stacks must intersect", () => {
  assert(
    skillMatches({ stack: ["typescript", "node"], area: "" }, { stacks: ["node"] }),
    "intersect matches",
  );
  assert(
    !skillMatches({ stack: ["typescript"], area: "" }, { stacks: ["python"] }),
    "disjoint does not match",
  );
});
check("area must equal when both constrain", () => {
  assert(skillMatches({ stack: [], area: "security" }, { area: "security" }), "equal area matches");
  assert(
    !skillMatches({ stack: [], area: "security" }, { area: "frontend" }),
    "different area excluded",
  );
  assert(
    skillMatches({ stack: [], area: "security" }, { area: "" }),
    "empty query area = no constraint",
  );
});

// --- selection against the live library (also validates AC2) ----------------
const all = loadSkills();
check("library loads tagged skills", () => {
  assert(all.length >= 20, `expected the full tagged library, got ${all.length}`);
  for (const s of all) assert(s.area, `skill '${s.name}' is missing an area tag`);
});

check("AC2: frontend, backend, security and a language pack all exist", () => {
  const areas = listAreas();
  for (const pack of ["frontend", "backend", "security", "language"]) {
    assert(areas.includes(pack), `missing '${pack}' pack (areas: ${areas.join(", ")})`);
  }
});

check("each domain pack has its expected skills", () => {
  const byArea = (a) =>
    selectSkills({ area: a })
      .map((s) => s.name)
      .sort();
  for (const name of ["frontend-a11y", "frontend-component", "frontend-responsive"]) {
    assert(byArea("frontend").includes(name), `frontend pack missing ${name}`);
  }
  for (const name of ["add-api-endpoint", "add-db-migration", "backend-service"]) {
    assert(byArea("backend").includes(name), `backend pack missing ${name}`);
  }
  for (const name of ["security-authz", "security-input-validation", "security-secret-handling"]) {
    assert(byArea("security").includes(name), `security pack missing ${name}`);
  }
  assert(
    byArea("language").includes("typescript-conventions"),
    "language pack missing typescript-conventions",
  );
});

check("minimalism skill is cross-cutting (selectable for any stack) and area-tagged", () => {
  const min = all.find((s) => s.name === "minimalism");
  assert(min, "minimalism skill should load from the library");
  eq(min.stack, [], "minimalism is stack-agnostic (empty stack = selectable for any stack)");
  assert(min.area, "minimalism must carry an area tag like every other skill");
  for (const stack of ["node", "python", "go"]) {
    const names = selectSkills({ stacks: [stack] }).map((s) => s.name);
    assert(names.includes("minimalism"), `minimalism should be selectable for the ${stack} stack`);
  }
});

check("minimalism skill preserves safety guards and documents YAGNI + intensity levels", () => {
  const body = readFileSync(join(DEFAULT_SKILLS_DIR, "minimalism", "SKILL.md"), "utf8");
  assert(/YAGNI/.test(body), "must instruct YAGNI");
  assert(/standard library/i.test(body), "must instruct stdlib-first");
  assert(
    /native[\s-]*platform|native .*before .*dependency/i.test(body),
    "must instruct native-before-dependency",
  );
  assert(/one line before fifty|one-line/i.test(body), "must instruct one-line-over-fifty");
  for (const level of ["lite", "full", "ultra"]) {
    assert(new RegExp(`\\b${level}\\b`).test(body), `must define the ${level} intensity level`);
  }
  assert(/default/i.test(body) && /full/.test(body), "must state the default intensity is full");
  assert(/NEVER weaken a safety guard/i.test(body), "must explicitly preserve safety guards");
});

check("AC1: selection by stack picks the right skills", () => {
  const tsNames = selectSkills({ stacks: ["typescript"] }).map((s) => s.name);
  assert(tsNames.includes("typescript-conventions"), "typescript stack should select the TS pack");
  const pyNames = selectSkills({ stacks: ["python"] }).map((s) => s.name);
  assert(!pyNames.includes("typescript-conventions"), "python stack must not select the TS pack");
  // stack-agnostic skills remain selectable for any stack
  assert(pyNames.includes("run-tests"), "stack-agnostic skill should select for any stack");
});

check("AC1: node stack (this repo) selects the typescript pack", () => {
  const nodeNames = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  assert(
    nodeNames.includes("typescript-conventions"),
    "node stack should select the TS pack (TS runs on node)",
  );
});

check("stack + area compose", () => {
  const sel = selectSkills({ stacks: ["node"], area: "security" })
    .map((s) => s.name)
    .sort();
  eq(
    sel,
    ["security-authz", "security-input-validation", "security-secret-handling"],
    "node+security",
  );
});

// --- expandStacks (mirror the Crew registry compound expansion) -------------
check("expandStacks splits a compound label into parts plus the whole", () => {
  eq(
    expandStacks(["typescript-react"]).sort(),
    ["react", "typescript", "typescript-react"],
    "typescript-react expands to its parts + whole",
  );
  eq(
    expandStacks(["typescript-react-native-expo"]).sort(),
    ["expo", "native", "react", "typescript", "typescript-react-native-expo"],
    "RN+expo label expands to expo/native/react/typescript + whole",
  );
  eq(expandStacks(["java"]).sort(), ["java"], "a bare label expands to itself");
  eq(expandStacks([]), [], "no stacks → no constraint");
});

// --- per-stack conventions/design packs route correctly ---------------------
const conv = (stack) =>
  selectSkills({ stacks: [stack] })
    .map((s) => s.name)
    .filter((n) => /-conventions$|^frontend-design$|^mobile-ui$/.test(n))
    .sort();

check("java stack recommends java-conventions and no other language pack", () => {
  const names = conv("java");
  assert(names.includes("java-conventions"), "java → java-conventions");
  assert(!names.includes("python-conventions"), "java must not pull python-conventions");
  assert(!names.includes("go-conventions"), "java must not pull go-conventions");
  assert(!names.includes("typescript-conventions"), "java must not pull typescript-conventions");
});

check("go stack recommends go-conventions and excludes the others", () => {
  const names = conv("go");
  assert(names.includes("go-conventions"), "go → go-conventions");
  assert(!names.includes("java-conventions"), "go must not pull java-conventions");
  assert(!names.includes("python-conventions"), "go must not pull python-conventions");
});

check("python stack recommends python-conventions and excludes the others", () => {
  const names = conv("python");
  assert(names.includes("python-conventions"), "python → python-conventions");
  assert(!names.includes("java-conventions"), "python must not pull java-conventions");
  assert(!names.includes("go-conventions"), "python must not pull go-conventions");
});

check("plain node stack recommends typescript-conventions but NOT frontend-design", () => {
  const names = conv("node");
  assert(names.includes("typescript-conventions"), "node → typescript-conventions");
  assert(!names.includes("frontend-design"), "plain node (no react) must not pull frontend-design");
  assert(!names.includes("mobile-ui"), "plain node must not pull mobile-ui");
});

check("compound typescript-react routes the TS + frontend-design packs (web, not mobile)", () => {
  const names = conv("typescript-react");
  assert(names.includes("typescript-conventions"), "typescript-react → typescript-conventions");
  assert(names.includes("frontend-design"), "typescript-react → frontend-design");
  assert(!names.includes("mobile-ui"), "a web react app must NOT pull the mobile pack");
});

check("web/react stack routes the design-system pack (not plain node, not java)", () => {
  const tsReact = selectSkills({ stacks: ["typescript-react"] }).map((s) => s.name);
  assert(tsReact.includes("design-system"), "typescript-react → design-system");
  assert(tsReact.includes("frontend-design"), "design-system routes alongside frontend-design");

  const node = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  assert(!node.includes("design-system"), "plain node (no react) must not pull design-system");

  const java = selectSkills({ stacks: ["java"] }).map((s) => s.name);
  assert(!java.includes("design-system"), "a java stack must not pull design-system");
});

check("react-native / expo labels route the mobile pack (and not from plain web react)", () => {
  for (const label of ["typescript-react-native", "typescript-react-native-expo"]) {
    const names = conv(label);
    assert(names.includes("mobile-ui"), `${label} → mobile-ui`);
    assert(names.includes("frontend-design"), `${label} → frontend-design`);
    assert(names.includes("typescript-conventions"), `${label} → typescript-conventions`);
  }
});

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS — ${passed} checks passed (library: ${DEFAULT_SKILLS_DIR})`);
