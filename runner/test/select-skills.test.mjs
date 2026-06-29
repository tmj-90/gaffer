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
check("empty skill stack matches any query stack (fully-unconstrained skill)", () => {
  // An empty stack is "no stack constraint"; with no area tag the skill is
  // fully cross-cutting and matches any stack-only query.
  assert(
    skillMatches({ stack: [], area: "" }, { stacks: ["python"] }),
    "empty stack + empty area = no constraint (matches any stack)",
  );
  // But an empty-stack skill that DOES carry an area is now opt-in (FIX-2): it
  // no longer auto-fires on a stack-only query.
  assert(
    !skillMatches({ stack: [], area: "backend" }, { stacks: ["python"] }),
    "area-tagged skill is opt-in: no longer matches a stack-only query",
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
check("area must equal when both constrain (domain areas)", () => {
  assert(
    skillMatches({ stack: [], area: "marketing" }, { area: "marketing" }),
    "equal area matches",
  );
  assert(
    !skillMatches({ stack: [], area: "marketing" }, { area: "product" }),
    "different area excluded",
  );
});

check("FIX-2: an area-only skill is opt-in — excluded on a stack-only query", () => {
  // No area in the query → an area-only skill (stack:[] + area) does NOT match;
  // it is opt-in and only fires when its area is explicitly named.
  assert(
    !skillMatches({ stack: [], area: "marketing" }, { area: "" }),
    "area-only domain skill must NOT auto-fire when no area is queried",
  );
  assert(
    !skillMatches({ stack: [], area: "marketing" }, { stacks: ["node"] }),
    "area-only marketing skill must NOT fire on a stack-only query",
  );
  // A fully-unconstrained skill (stack:[] area:'') still matches everything.
  assert(
    skillMatches({ stack: [], area: "" }, { stacks: ["node"] }),
    "fully-unconstrained skill still matches any stack",
  );
  // A stack-tagged skill with an area still routes by stack on a stack-only query.
  assert(
    skillMatches({ stack: ["react"], area: "frontend" }, { stacks: ["react"] }),
    "stack-tagged skill routes by stack regardless of its area label",
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

check("minimalism is an always-on QUALITY LENS (area: quality), injected by tick.sh", () => {
  const min = all.find((s) => s.name === "minimalism");
  assert(min, "minimalism skill should load from the library");
  eq(min.stack, [], "minimalism is stack-agnostic (empty stack)");
  eq(min.area, "quality", "minimalism is an area: quality lens");
  // FIX-2 (corrected): `quality` is a UNIVERSAL area — the delivery mechanics
  // (quality/testing/review/workflow) always fire regardless of stack. Only
  // DOMAIN area packs (marketing/product/docs/…) are opt-in. So minimalism DOES
  // auto-fire on every stack-only query.
  for (const stack of ["node", "python", "go"]) {
    const names = selectSkills({ stacks: [stack] }).map((s) => s.name);
    assert(
      names.includes("minimalism"),
      `minimalism (area: quality, universal) must fire on the ${stack} stack-only query`,
    );
  }
});

check(
  "security skills are always-on (area: security is universal) — defense-in-depth policy",
  () => {
    // Policy: every delivery gets the security lenses regardless of stack/domain.
    for (const stack of ["node", "java", "python", "go", "typescript-react"]) {
      const names = selectSkills({ stacks: [stack] }).map((s) => s.name);
      for (const sec of [
        "security-authz",
        "security-input-validation",
        "security-secret-handling",
      ]) {
        assert(
          names.includes(sec),
          `${sec} must auto-fire on the ${stack} stack-only query (security is always-on)`,
        );
      }
    }
  },
);

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
  // FIX-2 (corrected): the universal delivery areas (testing/review/workflow/
  // quality) always fire — run-tests (area: testing) auto-fires on every ticket.
  assert(
    pyNames.includes("run-tests"),
    "run-tests (area: testing, universal) must fire on a stack-only query",
  );
  assert(
    pyNames.includes("submit-review") && pyNames.includes("record-evidence"),
    "the universal review/workflow delivery skills must fire on a stack-only query",
  );
  // ...but DOMAIN area packs (marketing/product/meta) must NOT leak onto a plain
  // backend ticket — that was the original FIX-2 defect.
  for (const leak of [
    "aeo",
    "seo-audit",
    "copywriting",
    "landing-page-generator",
    "rice",
    "caveman",
  ]) {
    assert(!pyNames.includes(leak), `domain pack ${leak} must NOT auto-fire on a stack-only query`);
  }
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
  // Original three stack-specific node security packs must be present
  for (const name of ["security-authz", "security-input-validation", "security-secret-handling"]) {
    assert(sel.includes(name), `node+security must include ${name}`);
  }
  // cloud-security (re-tagged area: infra) and threat-detection (area:
  // security-ops) are specialised — they no longer ride the security area and
  // resolve only under their own areas.
  assert(
    !sel.includes("cloud-security"),
    "cloud-security re-tagged to infra: must not appear in a security query",
  );
  assert(
    selectSkills({ area: "infra" })
      .map((s) => s.name)
      .includes("cloud-security"),
    "cloud-security resolves under area: infra",
  );
  assert(
    selectSkills({ area: "security-ops" })
      .map((s) => s.name)
      .includes("threat-detection"),
    "threat-detection resolves under area: security-ops",
  );
  // No non-security packs appear
  assert(
    !sel.includes("typescript-conventions"),
    "security area must not pull typescript-conventions",
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

// --- new skill-pack area routing (feat/skill-enrichment-v2) -----------------

check("marketing area packs exist and route for marketing area", () => {
  const marketingNames = selectSkills({ area: "marketing" }).map((s) => s.name);
  for (const name of [
    "landing-page-generator",
    "page-cro",
    "copywriting",
    "seo-audit",
    "schema-markup",
    "aeo",
    "slides-deck",
  ]) {
    assert(marketingNames.includes(name), `marketing area missing ${name}`);
  }
  // marketing packs must NOT appear for devops area
  const devopsNames = selectSkills({ area: "devops" }).map((s) => s.name);
  assert(
    !devopsNames.includes("landing-page-generator"),
    "landing-page-generator must not appear in devops area",
  );
  assert(!devopsNames.includes("copywriting"), "copywriting must not appear in devops area");
});

check("devops area packs exist and route correctly", () => {
  const devopsNames = selectSkills({ area: "devops" }).map((s) => s.name);
  for (const name of [
    "observability-designer",
    "slo-architect",
    "runbook-generator",
    "ci-cd-pipeline",
    "incident-response",
  ]) {
    assert(devopsNames.includes(name), `devops area missing ${name}`);
  }
  // devops packs must NOT appear for marketing area
  const marketingNames = selectSkills({ area: "marketing" }).map((s) => s.name);
  assert(
    !marketingNames.includes("observability-designer"),
    "observability-designer must not appear in marketing area",
  );
  assert(
    !marketingNames.includes("slo-architect"),
    "slo-architect must not appear in marketing area",
  );
});

check("infra area packs exist and route correctly", () => {
  const infraNames = selectSkills({ area: "infra" }).map((s) => s.name);
  for (const name of ["terraform-patterns", "kubernetes-operator", "docker-development"]) {
    assert(infraNames.includes(name), `infra area missing ${name}`);
  }
  // infra packs must NOT appear for product area
  const productNames = selectSkills({ area: "product" }).map((s) => s.name);
  assert(
    !productNames.includes("terraform-patterns"),
    "terraform-patterns must not appear in product area",
  );
});

check("product area packs exist and route correctly", () => {
  const productNames = selectSkills({ area: "product" }).map((s) => s.name);
  for (const name of ["prd", "user-story", "rice", "product-discovery"]) {
    assert(productNames.includes(name), `product area missing ${name}`);
  }
});

check("docs area packs exist and route correctly", () => {
  const docsNames = selectSkills({ area: "docs" }).map((s) => s.name);
  for (const name of ["md-document", "changelog-generator", "code-tour"]) {
    assert(docsNames.includes(name), `docs area missing ${name}`);
  }
});

check("review area packs exist and route correctly", () => {
  const reviewNames = selectSkills({ area: "review" }).map((s) => s.name);
  for (const name of ["adversarial-reviewer", "api-design-reviewer"]) {
    assert(reviewNames.includes(name), `review area missing ${name}`);
  }
});

check("data area packs exist", () => {
  const dataNames = selectSkills({ area: "data" }).map((s) => s.name);
  assert(
    dataNames.includes("database-schema-designer"),
    "data area missing database-schema-designer",
  );
});

check("FIX-3: caveman (area: meta) is manual-only — does NOT auto-fire on any stack", () => {
  const caveman = all.find((s) => s.name === "caveman");
  assert(caveman, "caveman skill should load from the library");
  assert(caveman.area === "meta", "caveman must have area: meta");
  eq(caveman.stack, [], "caveman is stack-agnostic");
  // caveman is a user-comms mode, not a delivery lens. After FIX-2's area-gating
  // it must not be auto-injected on a stack-only selection (every ticket).
  for (const stack of ["node", "python", "go", "java"]) {
    const names = selectSkills({ stacks: [stack] }).map((s) => s.name);
    assert(
      !names.includes("caveman"),
      `caveman must NOT auto-fire on the ${stack} stack-only query`,
    );
  }
});

check("stack-constrained infra skills (terraform, k8s) route by stack token", () => {
  // terraform stack → terraform-patterns
  const tf = selectSkills({ stacks: ["terraform"] }).map((s) => s.name);
  assert(tf.includes("terraform-patterns"), "terraform stack → terraform-patterns");
  // kubernetes stack → kubernetes-operator
  const k8s = selectSkills({ stacks: ["kubernetes"] }).map((s) => s.name);
  assert(k8s.includes("kubernetes-operator"), "kubernetes stack → kubernetes-operator");
  // plain node must not pull stack-constrained infra packs
  const node = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  assert(!node.includes("terraform-patterns"), "plain node must not pull terraform-patterns");
  assert(!node.includes("kubernetes-operator"), "plain node must not pull kubernetes-operator");
});

check("landing-page-generator is area-only (opt-in marketing, not stack-routed)", () => {
  // After making stack: [], it is area-only — must NOT fire on a react stack query.
  const react = selectSkills({ stacks: ["react"] }).map((s) => s.name);
  assert(
    !react.includes("landing-page-generator"),
    "react stack must NOT pull landing-page-generator (now area-only)",
  );
  // It DOES resolve under --area marketing.
  const marketing = selectSkills({ area: "marketing" }).map((s) => s.name);
  assert(
    marketing.includes("landing-page-generator"),
    "landing-page-generator resolves under area: marketing",
  );
});

// --- FIX-2: area packs must NOT auto-fire on a stack-only selection ---------

check("FIX-2: a stack-only node selection excludes area-only packs (no over-fire)", () => {
  const names = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  // Area-only packs (stack:[] + non-empty area) must NOT auto-inject on a
  // stack-only query — previously they leaked onto every backend ticket.
  for (const leaked of [
    "aeo",
    "seo-audit",
    "copywriting",
    "landing-page-generator",
    "prd",
    "rice",
    "caveman",
    "page-cro",
    "schema-markup",
    "user-story",
    "product-discovery",
    "slides-deck",
    "observability-designer",
    "slo-architect",
  ]) {
    assert(!names.includes(leaked), `stack-only node selection must NOT include '${leaked}'`);
  }
  // Stack-tagged language/quality packs still route by stack.
  assert(names.includes("typescript-conventions"), "node stack still gets typescript-conventions");
});

check("FIX-2: java / go stacks still get their conventions; no area leak", () => {
  const java = selectSkills({ stacks: ["java"] }).map((s) => s.name);
  assert(java.includes("java-conventions"), "java stack still gets java-conventions");
  assert(!java.includes("aeo"), "java stack must not leak the marketing aeo pack");
  assert(!java.includes("prd"), "java stack must not leak the product prd pack");

  const go = selectSkills({ stacks: ["go"] }).map((s) => s.name);
  assert(go.includes("go-conventions"), "go stack still gets go-conventions");
  assert(!go.includes("copywriting"), "go stack must not leak the marketing copywriting pack");
});

check("FIX-2: a frontend (react) stack still gets frontend-design by stack", () => {
  // frontend-design is stack-tagged (stack:[typescript,javascript,react]); it
  // must still fire for a web/react stack purely on the stack match.
  const react = selectSkills({ stacks: ["typescript-react"] }).map((s) => s.name);
  assert(react.includes("frontend-design"), "react stack still gets frontend-design");
  // ...but the area-only marketing/product packs still must not leak in.
  assert(!react.includes("prd"), "react stack must not leak the product prd pack");
  assert(!react.includes("aeo"), "react stack must not leak the marketing aeo pack");
});

check("FIX-2: explicit area query still composes (security area excludes language pack)", () => {
  const sel = selectSkills({ stacks: ["node"], area: "security" }).map((s) => s.name);
  assert(sel.includes("security-authz"), "explicit security area still selects the security pack");
  assert(
    !sel.includes("typescript-conventions"),
    "explicit security area still excludes the language pack",
  );
});

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS — ${passed} checks passed (library: ${DEFAULT_SKILLS_DIR})`);
