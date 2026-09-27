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
  textMatches,
  relevanceTokens,
  selectForRole,
  ROLE_PROFILES,
  ROLE_NAMES,
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
  // Broad-inclusion: a DELIVERY-area skill (backend/language/frontend/mobile/…)
  // is ALWAYS eligible regardless of stack, so it fires on a stack-only query
  // even with an empty stack list — a mis-registered stack can never silently
  // EXCLUDE a code-relevant pack.
  assert(
    skillMatches({ stack: [], area: "backend" }, { stacks: ["python"] }),
    "delivery-area skill is always eligible on a stack-only query",
  );
  // Only OFF-DOMAIN areas stay opt-in: they do NOT auto-fire on a stack-only query.
  assert(
    !skillMatches({ stack: [], area: "marketing" }, { stacks: ["python"] }),
    "off-domain area skill is opt-in: no match on a stack-only query",
  );
});
check("empty query stack matches any skill stack", () => {
  assert(
    skillMatches({ stack: ["typescript"], area: "language" }, {}),
    "empty query = no constraint",
  );
});
check("non-empty stacks must intersect (stack-tagged packs honour a known stack)", () => {
  // Off-domain packs: the intersect/disjoint contract.
  assert(
    skillMatches({ stack: ["terraform", "kubernetes"], area: "infra" }, { stacks: ["terraform"] }),
    "off-domain stack-tagged skill matches when stacks intersect",
  );
  assert(
    !skillMatches({ stack: ["terraform"], area: "infra" }, { stacks: ["python"] }),
    "off-domain stack-tagged skill does not match a disjoint stack",
  );
  // An UNTAGGED no-area skill is always eligible, whatever the stack.
  assert(
    skillMatches({ stack: [], area: "" }, { stacks: ["python"] }),
    "untagged no-area skill is always eligible",
  );
  // A TAGGED no-area skill is its author's applicability statement: honoured once the
  // stack is known (python is known; typescript is not python) …
  assert(
    !skillMatches({ stack: ["typescript"], area: "" }, { stacks: ["python"] }),
    "tagged no-area skill does not ride a known disjoint stack",
  );
  // … and fail-open for an unknown stack (nothing the library recognises).
  assert(
    skillMatches({ stack: ["typescript"], area: "" }, { stacks: ["cobol"] }),
    "tagged no-area skill fails open on an unknown stack",
  );
  assert(
    skillMatches({ stack: ["typescript"], area: "" }, { stacks: [] }),
    "tagged no-area skill fails open on an empty stack",
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
  assert(pyNames.includes("python-conventions"), "python stack selects the python pack");
  // Language packs follow the STACK: a python ticket is not handed the TS conventions
  // (a wrong-language pack contradicts the files in front of the agent).
  assert(
    !pyNames.includes("typescript-conventions"),
    "python stack must not mount the TS language pack",
  );
  // The universal delivery areas (testing/review/workflow/quality) always fire —
  // run-tests (area: testing) auto-fires on every ticket.
  assert(
    pyNames.includes("run-tests"),
    "run-tests (area: testing, universal) must fire on a stack-only query",
  );
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
  // Broad-inclusion: DELIVERY packs (language/frontend/…) are always eligible,
  // so they ride along even under an explicit off-domain area query.
  assert(
    sel.includes("typescript-conventions"),
    "explicit area query still mounts the always-eligible language pack",
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

// STACK PACKS follow the stack: a stack gets its OWN conventions pack and the surface
// packs its label implies — never another language's pack. The mis-registration
// concern is kept as FAIL-OPEN: an unknown / empty stack mounts every stack pack.
const ALL_LANGUAGE_PACKS = [
  "java-conventions",
  "go-conventions",
  "python-conventions",
  "typescript-conventions",
  "csharp-conventions",
  "rust-conventions",
  "kotlin-conventions",
  "swift-conventions",
  "ruby-conventions",
];

for (const [stack, own] of [
  ["java", "java-conventions"],
  ["go", "go-conventions"],
  ["python", "python-conventions"],
  ["rust", "rust-conventions"],
  ["csharp", "csharp-conventions"],
]) {
  check(`${stack} stack mounts ${own} and NO other language pack`, () => {
    const names = conv(stack);
    assert(names.includes(own), `${stack} → ${own}`);
    for (const pack of ALL_LANGUAGE_PACKS) {
      if (pack === own) continue;
      assert(!names.includes(pack), `${pack} must not ride a ${stack} stack`);
    }
    assert(!names.includes("frontend-design"), `${stack} (no web surface) → no frontend-design`);
    assert(!names.includes("mobile-ui"), `${stack} (no mobile surface) → no mobile-ui`);
  });
}

check("plain node stack mounts the TS pack only — no surface packs", () => {
  const names = conv("node");
  assert(names.includes("typescript-conventions"), "node → typescript-conventions");
  assert(!names.includes("frontend-design"), "node (backend) → no frontend-design");
  assert(!names.includes("mobile-ui"), "node (backend) → no mobile-ui");
  const all = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  for (const surface of ["brand", "design-system", "frontend-component", "react-patterns"]) {
    assert(!all.includes(surface), `node (backend) → no ${surface}`);
  }
  // Stack-tagged always-on skills honour the known stack too.
  assert(!all.includes("frontend-testing"), "frontend-testing (react/web only) stays off node");
  assert(
    !all.includes("accessibility-review"),
    "accessibility-review (web/mobile lens) stays off node",
  );
  // …while the ones tagged for node ride along.
  assert(all.includes("e2e-browser-test"), "e2e-browser-test is tagged node → mounted");
  assert(all.includes("contract-test"), "contract-test is tagged node → mounted");
});

check("compound typescript-react mounts TS + the web surface packs, not mobile", () => {
  const names = conv("typescript-react");
  assert(names.includes("typescript-conventions"), "typescript-react → typescript-conventions");
  assert(names.includes("frontend-design"), "typescript-react → frontend-design");
  assert(!names.includes("mobile-ui"), "a web stack is not a mobile one → no mobile-ui");
  const all = selectSkills({ stacks: ["typescript-react"] }).map((s) => s.name);
  for (const web of [
    "design-system",
    "brand",
    "react-patterns",
    "frontend-component",
    "frontend-testing",
    "accessibility-review",
  ]) {
    assert(all.includes(web), `typescript-react → ${web}`);
  }
});

check("react-native / expo labels route the mobile pack (and the web design bar)", () => {
  for (const label of ["typescript-react-native", "typescript-react-native-expo"]) {
    const names = conv(label);
    assert(names.includes("mobile-ui"), `${label} → mobile-ui`);
    assert(names.includes("frontend-design"), `${label} → frontend-design`);
    assert(names.includes("typescript-conventions"), `${label} → typescript-conventions`);
  }
});

check("FAIL-OPEN: an unknown or empty stack mounts every stack pack", () => {
  for (const stacks of [["cobol"], [], ["my-internal-stack-label"]]) {
    const names = selectSkills({ stacks }).map((s) => s.name);
    for (const pack of ALL_LANGUAGE_PACKS) {
      assert(names.includes(pack), `${JSON.stringify(stacks)} → ${pack} (fail-open)`);
    }
    for (const surface of ["frontend-design", "mobile-ui", "brand", "design-system"]) {
      assert(names.includes(surface), `${JSON.stringify(stacks)} → ${surface} (fail-open)`);
    }
  }
});

check("the ticket text pulls a foreign language pack in by name", () => {
  const plain = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  assert(!plain.includes("kotlin-conventions"), "node alone → no kotlin pack");
  const withText = selectSkills({
    stacks: ["node"],
    text: "Port the Kotlin client to the new API",
  }).map((s) => s.name);
  assert(withText.includes("kotlin-conventions"), "text naming Kotlin → kotlin-conventions");
  assert(withText.includes("typescript-conventions"), "the stack's own pack still rides");
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

check("explicit area query still mounts the always-eligible delivery packs", () => {
  const sel = selectSkills({ stacks: ["node"], area: "security" }).map((s) => s.name);
  assert(sel.includes("security-authz"), "explicit security area still selects the security pack");
  // Broad-inclusion: DELIVERY/UNIVERSAL packs are always eligible and ride along
  // even under an explicit area query — the language pack is no longer excluded.
  assert(
    sel.includes("typescript-conventions"),
    "explicit area query still mounts the always-eligible language pack",
  );
});

// --- broad-inclusion / denylist model (locks the new contract) --------------

check("stack packs: java-conventions is NOT selected for a python-only stack", () => {
  const py = selectSkills({ stacks: ["python"] }).map((s) => s.name);
  assert(!py.includes("java-conventions"), "python stack must not mount java-conventions");
  assert(py.includes("python-conventions"), "python stack mounts its own pack");
});

check("stack packs: mobile-ui and brand follow the surface, not every stack", () => {
  for (const stack of ["node", "python", "go", "java"]) {
    const names = selectSkills({ stacks: [stack] }).map((s) => s.name);
    assert(!names.includes("mobile-ui"), `mobile-ui must not mount on a ${stack} backend`);
    assert(!names.includes("brand"), `brand must not mount on a ${stack} backend`);
  }
  const web = selectSkills({ stacks: ["typescript-react"] }).map((s) => s.name);
  assert(web.includes("brand"), "brand mounts on a web stack");
  const mobile = selectSkills({ stacks: ["typescript-react-native"] }).map((s) => s.name);
  assert(mobile.includes("mobile-ui"), "mobile-ui mounts on a mobile stack");
});

check("denylist: off-domain packs stay opt-in on a plain node stack", () => {
  const node = selectSkills({ stacks: ["node"] }).map((s) => s.name);
  // infra (kubernetes/terraform) + marketing (seo/copywriting) are off-domain —
  // a plain node feature ticket must NOT be handed Terraform or SEO skills.
  for (const optIn of ["kubernetes-operator", "terraform-patterns", "seo-audit", "copywriting"]) {
    assert(!node.includes(optIn), `off-domain pack ${optIn} must stay opt-in on a node stack`);
  }
});

check("denylist: an off-domain pack IS selected when its --area is explicitly requested", () => {
  const marketing = selectSkills({ area: "marketing" }).map((s) => s.name);
  assert(marketing.includes("seo-audit"), "seo-audit resolves under --area marketing");
  assert(marketing.includes("copywriting"), "copywriting resolves under --area marketing");
  const infra = selectSkills({ area: "infra" }).map((s) => s.name);
  assert(infra.includes("kubernetes-operator"), "kubernetes-operator resolves under --area infra");
  assert(infra.includes("terraform-patterns"), "terraform-patterns resolves under --area infra");
});

// --- report -----------------------------------------------------------------
// --- TEXT RELEVANCE (additive, opt-in via --text) ---------------------------
check("relevanceTokens drops stop words, short and numeric tokens; keeps tech tokens", () => {
  const t = relevanceTokens(
    "Add a Terraform module for the S3 bucket in 2 regions, c++ and node.js",
  );
  assert(
    t.has("terraform") && t.has("module") && t.has("bucket") && t.has("regions"),
    "keeps content words",
  );
  assert(
    !t.has("add") && !t.has("the") && !t.has("for") && !t.has("2"),
    "drops stop/short/numeric",
  );
});
check("textMatches: a skill's name as a phrase in the text mounts it", () => {
  const sk = {
    name: "terraform-patterns",
    description: "Terraform module layout and state",
    stack: [],
    area: "infra",
  };
  assert(textMatches(sk, "Add a terraform patterns module for the bucket"), "phrase match");
  assert(textMatches(sk, "Refactor the Terraform state layout"), "two description words match");
  assert(!textMatches(sk, "Fix the login form validation bug"), "unrelated text does not match");
  assert(!textMatches(sk, ""), "no text → no match");
});
check(
  "selectSkills with text mounts an off-domain pack the ticket calls for, and nothing else changes",
  () => {
    const base = selectSkills({ stacks: ["node"] }).map((s) => s.name);
    const withText = selectSkills({
      stacks: ["node"],
      text: "Write a Terraform module for the S3 bucket and its state backend",
    }).map((s) => s.name);
    assert(!base.includes("terraform-patterns"), "off-domain pack is NOT mounted without text");
    assert(
      withText.includes("terraform-patterns"),
      "off-domain pack IS mounted when the text calls for it",
    );
    for (const n of base) assert(withText.includes(n), `text never removes a skill (${n})`);
    const unrelated = selectSkills({
      stacks: ["node"],
      text: "Fix the off-by-one in the pagination helper",
    }).map((s) => s.name);
    eq(unrelated, base, "unrelated text leaves the selection byte-identical");
  },
);
check("selectSkills without text is byte-identical to before (no text arg == empty text)", () => {
  eq(
    selectSkills({ stacks: ["typescript"] }).map((s) => s.name),
    selectSkills({ stacks: ["typescript"], text: "" }).map((s) => s.name),
    "identical",
  );
});

if (failures.length) {
  console.error(`FAIL — ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
// --- ROLE profiles: every agent role gets its own set, not the delivery's ---------
const libNames = new Set(loadSkills().map((s) => s.name));
check("every ROLE_PROFILES core skill exists in the library (no dangling names)", () => {
  for (const [role, p] of Object.entries(ROLE_PROFILES)) {
    for (const n of p.core)
      assert(libNames.has(n), `${role}: core skill "${n}" is not in the library`);
  }
});
check("ROLE_NAMES covers every factory spawn site", () => {
  for (const r of [
    "delivery",
    "review",
    "clarify",
    "test",
    "plan",
    "spec",
    "product",
    "merge",
    "bootstrap",
  ])
    assert(ROLE_NAMES.includes(r), `missing role ${r}`);
});
check("delivery role == legacy selection (byte-identical set)", () => {
  for (const q of [
    { stacks: ["typescript-react"], text: "add a login form" },
    { stacks: ["java"], area: "backend", text: "" },
    { stacks: [], text: "add a Terraform module for the S3 bucket" },
  ]) {
    const legacy = new Set([...selectSkills(q).map((s) => s.name), ...ROLE_PROFILES.delivery.core]);
    const role = new Set(selectForRole("delivery", q).map((s) => s.name));
    eq([...role].sort(), [...legacy].sort(), `delivery parity for ${JSON.stringify(q)}`);
  }
});
check("review role: procedure + lenses + the stack's conventions pack, never build skills", () => {
  const names = selectForRole("review", { stacks: ["typescript-react"] }).map((s) => s.name);
  for (const n of [
    "review-ticket",
    "adversarial-reviewer",
    "record-evidence",
    "typescript-conventions",
    "security-authz",
    "frontend-design",
  ])
    assert(names.includes(n), `review should mount ${n}`);
  for (const n of [
    "add-api-endpoint",
    "backend-service",
    "add-db-migration",
    "create-branch",
    "prepare-digest-delta",
    "run-coverage",
  ])
    assert(!names.includes(n), `review must NOT mount ${n}`);
  eq(names[0], "review-ticket", "the procedure comes first");
});
check("review role: a Java backend gets java-conventions and no frontend design bar", () => {
  const names = selectForRole("review", { stacks: ["java"] }).map((s) => s.name);
  assert(names.includes("java-conventions"), "java-conventions");
  assert(!names.includes("typescript-conventions"), "no typescript pack for a java repo");
  assert(!names.includes("frontend-design"), "no frontend design bar for a backend stack");
});
check("clarify role: intake + product-shaping, never the delivery mechanics", () => {
  const names = selectForRole("clarify", { stacks: ["python"] }).map((s) => s.name);
  for (const n of ["clarify", "user-story", "record-evidence", "python-conventions"])
    assert(names.includes(n), n);
  for (const n of ["run-tests", "create-branch", "prepare-digest-delta", "add-unit-test"])
    assert(!names.includes(n), `clarify must NOT mount ${n}`);
});
check("merge role: the resolver's tools only", () => {
  const names = selectForRole("merge", { stacks: ["go"] }).map((s) => s.name);
  eq(
    names.slice(0, 5),
    ["resolve-merge-conflict", "run-tests", "run-lint", "record-evidence", "minimalism"],
    "core order",
  );
  assert(
    names.includes("go-conventions") && !names.includes("brand"),
    "language pack yes, design packs no",
  );
});
check("product role: proposes work; no code packs", () => {
  const names = selectForRole("product", { stacks: ["typescript"] }).map((s) => s.name);
  assert(names[0] === "product-owner" && names.includes("rice"), "product core");
  assert(
    !names.includes("typescript-conventions") && !names.includes("run-tests"),
    "no code packs",
  );
});
check("unknown role falls back to the delivery profile (never an empty mount)", () => {
  const names = selectForRole("nope", { stacks: ["node"] }).map((s) => s.name);
  assert(names.includes("run-tests") && names.includes("record-evidence"), "delivery core present");
});
check("roles never return duplicates", () => {
  for (const r of ROLE_NAMES) {
    const names = selectForRole(r, {
      stacks: ["typescript-react-native"],
      text: "seo audit terraform",
    }).map((s) => s.name);
    eq(names.length, new Set(names).size, `${r} has duplicates`);
  }
});

console.log(`PASS — ${passed} checks passed (library: ${DEFAULT_SKILLS_DIR})`);
