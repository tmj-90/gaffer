#!/usr/bin/env node
// =====================================================================
// MODEL-BACKED onboarding analysis (lib/onboard-analyze.mjs) — material gathering,
// prompt rules, strict-JSON parse/validate, the honest fallback, the memory writes
// + de-dupe, and the end-to-end pass — all proven WITHOUT a live `claude -p` call
// (the model turn + the memory CLI are stubbed).
//
//   AC1  parseMavenModules pulls <module> entries (commented-out ones excluded)
//   AC2  detectModules enumerates a Maven multi-module repo
//   AC3  buildAnalysisPrompt FORBIDS infrastructure-as-features (tests/CI/build/…)
//   AC4  buildAnalysisPrompt names the multi-module layout + lists the modules
//   AC5  extractLastJsonBlock + validateAnalysis parse a strict-JSON analysis
//   AC6  validateAnalysis drops infra-shaped duplicates by name + coerces status
//   AC7  an empty / garbage features array stays EMPTY (no fake features)
//   AC8  fallbackUnderstanding is minimal, honest, and carries ZERO features
//   AC9  writeUnderstanding de-dupes features by name on re-onboard
//   AC10 analyzeAndWrite end-to-end: model JSON → memory writes (stubbed)
//   AC11 analyzeAndWrite falls back to the honest digest on unparseable model output
//   AC12 the prompt is DRIVEN BY the memory-onboard skill (grounded, cited drafts)
//   AC13 validateLore enforces the skill's hard rules (cite, induction tag, conf cap)
//   AC14 validateLore drops UNCITED lore (the noise the skill warns against) + dedupes
//   AC15 an empty/garbage lore array stays EMPTY (zero drafts is correct)
//   AC16 writeUnderstanding drafts lore via `suggest` (DRAFT, never approved)
//   AC17 lore drafts de-dupe by title on re-onboard
//   AC18 analyzeAndWrite end-to-end drafts grounded+cited+induction-tagged lore
//
// Zero deps. Run: node test/onboard-analyze.test.mjs
// =====================================================================
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(HERE, "..", "lib", "onboard-analyze.mjs");
const {
  parseMavenModules,
  detectModules,
  buildAnalysisPrompt,
  gatherMaterial,
  extractLastJsonBlock,
  validateAnalysis,
  fallbackUnderstanding,
  writeUnderstanding,
  analyzeAndWrite,
  validateLore,
  parseLoreTitles,
  normalizeDedupKey,
  isSourceUrl,
  cardModel,
  cardBatch,
  cardSnippetChars,
  analysisCaps,
  buildCardBatchPrompt,
  validateCardBatch,
  emitFileCards,
  refreshFileCards,
  INFRA_NOT_FEATURES_RULE,
  MEMORY_ONBOARD_RULE,
  INDUCTION_TAG,
} = await import(MOD);

let passed = 0;
const failures = [];
function ok(label) {
  passed += 1;
  console.log(`  ok   ${label}`);
}
function fail(label) {
  failures.push(label);
  console.log(`  FAIL ${label}`);
}
function assert(label, cond) {
  cond ? ok(label) : fail(label);
}
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// --- A throwaway multi-module Maven repo on disk -----------------------------
function mavenRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-analyze-"));
  writeFileSync(
    join(dir, "pom.xml"),
    [
      "<project><modules>",
      "  <module>common/domain</module>",
      "  <!-- <module>legacy/removed-connector</module> a commented-out module must NOT count -->",
      "  <module>services/booking</module>",
      "  <module>services/universal-connector</module>",
      "</modules></project>",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "README.md"),
    "# Demo\n\nA Kafka-native market data normalisation platform. It connects to suppliers and " +
      "publishes a single canonical feed for marketplace operators.\n",
  );
  mkdirSync(join(dir, "services", "booking"), { recursive: true });
  writeFileSync(
    join(dir, "services", "booking", "pom.xml"),
    "<project><artifactId>booking</artifactId><description>Booking service.</description></project>",
  );
  // An ADR + a deprecation marker so the skill-grounded prompt has real signals to cite.
  mkdirSync(join(dir, "docs", "adrs"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "adrs", "0009-webhook-retry-cap.md"),
    "# Webhook retry cap\n\nDecision: cap backoff at 2h.\n",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "legacyAuth.java"),
    "// DEPRECATED: do not use legacyAuth — migrate to requireSession()\nclass LegacyAuth {}\n",
  );
  return dir;
}

console.log("== AC1: parseMavenModules pulls <module> entries; commented-out excluded ==");
{
  const xml =
    "<project><modules>\n  <module>a</module>\n  <!-- <module>commented</module> -->\n  <module>b/c</module>\n</modules></project>";
  eq("parses two modules, skips the commented one", parseMavenModules(xml), ["a", "b/c"]);
  eq("no <modules> → empty", parseMavenModules("<project/>"), []);
}

console.log("== AC2: detectModules enumerates a Maven multi-module repo ==");
{
  const dir = mavenRepo();
  const info = detectModules(dir);
  assert("kind is maven-multimodule", info?.kind === "maven-multimodule");
  eq("modules listed (no commented entry)", info?.modules, [
    "common/domain",
    "services/booking",
    "services/universal-connector",
  ]);
  // Gradle / pnpm / npm / cargo single-module → null.
  const single = mkdtempSync(resolve(tmpdir(), "onboard-single-"));
  writeFileSync(join(single, "package.json"), JSON.stringify({ name: "x" }));
  assert("single-module repo → null", detectModules(single) === null);
}

console.log("== AC3: the prompt FORBIDS infrastructure as features ==");
{
  const dir = mavenRepo();
  const material = gatherMaterial(dir, {
    name: "demo",
    stack: "java",
    buildCommand: "mvn package",
    testCommand: "mvn test",
  });
  const prompt = buildAnalysisPrompt(material);
  assert("prompt embeds the anti-infra rule", prompt.includes(INFRA_NOT_FEATURES_RULE));
  for (const banned of [
    "tests",
    "CI / CD",
    "build pipelines",
    "linting",
    "Docker",
    "dependency management",
  ]) {
    assert(
      `forbids '${banned}'`,
      new RegExp(banned.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "i").test(prompt),
    );
  }
  assert("tells the model EMPTY is correct when nothing fits", /EMPTY IS CORRECT/.test(prompt));
  assert(
    "README is quarantined as untrusted",
    /<untrusted-readme>[\s\S]*<\/untrusted-readme>/.test(prompt),
  );
}

console.log("== AC4: the prompt names the multi-module layout + lists the modules ==");
{
  const dir = mavenRepo();
  const material = gatherMaterial(dir, { name: "demo", stack: "java" });
  const prompt = buildAnalysisPrompt(material);
  assert(
    "declares it a multi-module build",
    /MULTI-MODULE BUILD/.test(prompt) && /maven-multimodule/.test(prompt),
  );
  assert("structure MUST name the modules", /name the actual modules/i.test(prompt));
  assert("lists a real module", /services\/universal-connector/.test(prompt));
}

console.log("== AC5: extract + validate a strict-JSON analysis ==");
{
  const text =
    "Here is my analysis.\n```json\n" +
    JSON.stringify({
      digest: {
        overview: "A market data normalisation platform.",
        structure: "Multi-module Maven build with services/booking and common/domain.",
        conventions: "Java 21, Maven. Build with mvn package.",
        stack: "java-maven",
      },
      features: [
        {
          name: "Supplier feed normalisation",
          summary: "Normalises N suppliers.",
          status: "shipped",
        },
        { name: "Entity registry", summary: "Canonical entity store.", status: "shipped" },
      ],
    }) +
    "\n```\n";
  const parsed = extractLastJsonBlock(text);
  const v = validateAnalysis(parsed);
  assert("digest overview parsed", /normalisation/.test(v.digest.overview));
  assert("digest structure names modules", /services\/booking/.test(v.digest.structure));
  eq("stack carried through", v.digest.stack, "java-maven");
  eq(
    "two real features",
    v.features.map((f) => f.name),
    ["Supplier feed normalisation", "Entity registry"],
  );
  assert(
    "all shipped",
    v.features.every((f) => f.status === "shipped"),
  );
}

console.log("== AC6: de-dupe by name + status coercion ==");
{
  const v = validateAnalysis({
    digest: { overview: "x", structure: "y", conventions: "z", stack: null },
    features: [
      { name: "Feed", summary: "a", status: "shipped" },
      { name: "feed", summary: "dup by case", status: "shipped" }, // dropped
      { name: "Registry", summary: "b", status: "weird" }, // coerced → shipped
      { name: "", summary: "no name" }, // dropped
      { name: "NoSummary", summary: "" }, // dropped
    ],
  });
  eq(
    "kept Feed + Registry only",
    v.features.map((f) => f.name),
    ["Feed", "Registry"],
  );
  assert(
    "invalid status coerced to shipped",
    v.features.find((f) => f.name === "Registry").status === "shipped",
  );
}

console.log("== AC7: empty / garbage features stay EMPTY (no fake features) ==");
{
  const empty = validateAnalysis({
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [],
  });
  eq("empty array preserved", empty.features, []);
  const garbage = validateAnalysis({
    digest: { overview: "o", structure: "s", conventions: "c" },
    features: "not-an-array",
  });
  eq("non-array features → empty", garbage.features, []);
  // No digest / no overview → null (caller falls back).
  assert("no digest → null", validateAnalysis({ features: [] }) === null);
  assert("no overview → null", validateAnalysis({ digest: { structure: "s" } }) === null);
}

console.log("== AC8: fallbackUnderstanding is minimal, honest, ZERO features ==");
{
  const dir = mavenRepo();
  const material = gatherMaterial(dir, { name: "demo", stack: "java" });
  const fb = fallbackUnderstanding(material);
  eq("no features in the fallback", fb.features, []);
  assert(
    "fallback names the multi-module layout",
    /Multi-module/.test(fb.digest.structure) && /services\/booking/.test(fb.digest.structure),
  );
  assert(
    "fallback is honest about being scan-only",
    /minimal scan-only|model-backed analysis was unavailable/i.test(fb.digest.overview),
  );
}

console.log("== AC9: writeUnderstanding de-dupes features by name on re-onboard ==");
{
  // A real tiny memory-CLI script on disk that records each invocation's argv and,
  // for `features <repo>`, prints a canned listing so de-dupe can be exercised.
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-memcli-"));
  const logFile = join(dir, "calls.jsonl");
  const featuresFile = join(dir, "features.txt");
  writeFileSync(featuresFile, ""); // start: nothing recorded
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const LOG = ${JSON.stringify(logFile)};`,
      `const FEATURES = ${JSON.stringify(featuresFile)};`,
      "const argv = process.argv.slice(2);",
      "appendFileSync(LOG, JSON.stringify(argv) + '\\n');",
      "if (argv[0] === 'features') { try { process.stdout.write(readFileSync(FEATURES,'utf8')); } catch {} }",
      "process.exit(0);",
    ].join("\n"),
  );
  const cfg = { cliBin, db: join(dir, "lore.sqlite") };
  const understanding = {
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [
      { name: "Feed normalisation", summary: "a", status: "shipped" },
      { name: "Entity registry", summary: "b", status: "shipped" },
    ],
  };

  const first = writeUnderstanding(cfg, "demo", understanding, { env: process.env });
  assert("first onboard: digest written", first.digestWritten === true);
  eq("first onboard: both features added", first.featuresAdded, 2);
  eq("first onboard: none skipped", first.featuresSkipped, 0);

  // Simulate the store now containing those two features (what `features demo` returns).
  writeFileSync(
    featuresFile,
    "Features for demo: 2\n\nSHIPPED (2)\n  [shipped] Feed normalisation  (aaa11111)\n  [shipped] Entity registry  (bbb22222)\n",
  );
  const second = writeUnderstanding(cfg, "demo", understanding, { env: process.env });
  assert("re-onboard: digest re-written (upsert)", second.digestWritten === true);
  eq("re-onboard: zero features added (de-duped)", second.featuresAdded, 0);
  eq("re-onboard: both features skipped", second.featuresSkipped, 2);
}

console.log("== AC10: analyzeAndWrite end-to-end (model JSON → memory writes) ==");
{
  const repo = mavenRepo();
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-e2e-"));
  const logFile = join(dir, "calls.jsonl");
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.exit(0);",
    ].join("\n"),
  );
  const env = { ...process.env, MEMORY_CLI_BIN: cliBin, MEMORY_DB: join(dir, "lore.sqlite") };
  const modelJson =
    "```json\n" +
    JSON.stringify({
      digest: {
        overview: "A normalisation platform.",
        structure: "Multi-module Maven.",
        conventions: "Java/Maven.",
        stack: "java-maven",
      },
      features: [
        { name: "Supplier normalisation", summary: "Normalises suppliers.", status: "shipped" },
      ],
    }) +
    "\n```";
  const res = analyzeAndWrite(
    repo,
    { repoId: "demo", name: "demo", stack: "java" },
    { env, runTurn: () => ({ timedOut: false, stdout: modelJson }) },
  );
  assert("ran with the model", res.ran === true && res.usedModel === true);
  eq("one feature added", res.stats.featuresAdded, 1);
  // Assert the memory CLI actually saw a `digest set` and a `feature add`.
  const calls = (await import("node:fs"))
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert(
    "digest set invoked with --source onboard",
    calls.some(
      (c) => c[0] === "digest" && c[1] === "set" && c.includes("--source") && c.includes("onboard"),
    ),
  );
  assert(
    "feature add invoked for the real capability",
    calls.some((c) => c[0] === "feature" && c[1] === "add" && c.includes("Supplier normalisation")),
  );
}

console.log(
  "== AC11: analyzeAndWrite falls back on unparseable model output (no fake features) ==",
);
{
  const repo = mavenRepo();
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-fb-"));
  const logFile = join(dir, "calls.jsonl");
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.exit(0);",
    ].join("\n"),
  );
  const env = { ...process.env, MEMORY_CLI_BIN: cliBin, MEMORY_DB: join(dir, "lore.sqlite") };
  const res = analyzeAndWrite(
    repo,
    { repoId: "demo", name: "demo", stack: "java" },
    { env, runTurn: () => ({ timedOut: false, stdout: "the model said nothing parseable" }) },
  );
  assert("ran but did NOT use the model output", res.ran === true && res.usedModel === false);
  eq("fallback adds ZERO features", res.stats.featuresAdded, 0);
  const calls = (await import("node:fs"))
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert(
    "still wrote the honest digest",
    calls.some((c) => c[0] === "digest" && c[1] === "set"),
  );
  assert("NO feature add was issued", !calls.some((c) => c[0] === "feature" && c[1] === "add"));

  // And: with the memory CLI unconfigured, the whole pass is skipped.
  const skipped = analyzeAndWrite(
    repo,
    { repoId: "demo", name: "demo" },
    {
      env: { ...process.env, MEMORY_CLI_BIN: "", MEMORY_DB: "" },
      runTurn: () => ({ timedOut: false, stdout: "" }),
    },
  );
  assert("unconfigured memory CLI → pass skipped", skipped.ran === false);
}

console.log("== AC12: the prompt is DRIVEN BY the memory-onboard skill ==");
{
  const dir = mavenRepo();
  const material = gatherMaterial(dir, { name: "demo", stack: "java" });
  const prompt = buildAnalysisPrompt(material);
  assert("embeds the memory-onboard skill rule", prompt.includes(MEMORY_ONBOARD_RULE));
  assert("references the memory-onboard methodology by name", /memory-onboard/i.test(prompt));
  assert(
    "demands GROUNDED + CITED drafts",
    /CITE THE SOURCE/i.test(prompt) && /induction/.test(prompt),
  );
  assert(
    "warns against flooding the review queue (anti-noise)",
    /flood/i.test(prompt) && /SELECTIVE/i.test(prompt),
  );
  assert("contract includes a lore array", /"lore"\s*:/.test(prompt));
  assert("confidence is capped (never high)", /never "high"/i.test(prompt));
  // The grounding signals must actually reach the prompt.
  assert("ADR doc is offered as a citation source", /0009-webhook-retry-cap\.md/.test(prompt));
  assert(
    "deprecation marker is offered as a citation source",
    /DEPRECATED/.test(prompt) && /legacyAuth/.test(prompt),
  );
}

console.log("== isSourceUrl: only a real http(s) URL is eligible for --source ==");
{
  assert("https URL accepted", isSourceUrl("https://github.com/acme/x/pull/9"));
  assert("http URL accepted", isSourceUrl("http://example.com/adr/9"));
  assert("a file path is NOT a URL", !isSourceUrl("docs/adrs/0009-webhook-retry-cap.md"));
  assert("a commit sha is NOT a URL", !isSourceUrl("commit a4f12c0"));
  assert("blank is NOT a URL", !isSourceUrl(""));
}

console.log("== AC13: validateLore enforces the skill's hard rules ==");
{
  // A FILE/DOC citation (not a URL): grounded → kept; citation goes to the BODY, the
  // `--source` FIELD stays null (memory rejects a non-URL source), confidence low.
  const fileCited = validateLore([
    {
      title: "Webhook retries cap at 2h backoff",
      summary: "To avoid downstream DoS, webhook retries cap their backoff at 2h.",
      body: "ADR 0009 decided the cap.",
      tags: ["migrations"],
      source: "docs/adrs/0009-webhook-retry-cap.md",
      confidence: "high", // never high for a draft
    },
  ]);
  eq("one record kept", fileCited.length, 1);
  assert("induction tag enforced", fileCited[0].tags.includes(INDUCTION_TAG));
  assert("topic tag kept", fileCited[0].tags.includes("migrations"));
  assert("confidence capped (no high); file citation → low", fileCited[0].confidence === "low");
  assert("file citation NOT placed in --source (URL-only field)", fileCited[0].source === null);
  assert(
    "file citation lands in the body as Source:",
    /^Source: docs\/adrs\/0009-webhook-retry-cap\.md/m.test(fileCited[0].body),
  );

  // A real URL citation: eligible for --source AND earns medium confidence.
  const urlCited = validateLore([
    {
      title: "Argon2id is the default",
      summary: "Password hashing uses Argon2id.",
      body: "see ADR",
      source: "https://github.com/acme/x/pull/42",
      confidence: "high",
    },
  ]);
  assert("URL carried into --source", urlCited[0].source === "https://github.com/acme/x/pull/42");
  assert("URL-sourced draft capped to medium (was high)", urlCited[0].confidence === "medium");

  // A record with NO source field but a Source: line in the body is still grounded.
  const fromBody = validateLore([
    { title: "T", summary: "S", body: "Source: README.md L1\n\ndetail", tags: [] },
  ]);
  eq("body-cited record kept", fromBody.length, 1);
  assert("body-cited gets induction tag", fromBody[0].tags.includes(INDUCTION_TAG));
  assert(
    "body-cited (no URL) → low confidence + null source",
    fromBody[0].confidence === "low" && fromBody[0].source === null,
  );
}

console.log("== AC14: validateLore drops UNCITED lore + dedupes by title ==");
{
  const lore = validateLore([
    { title: "Grounded", summary: "s", body: "Source: README.md\n\nd", source: "README.md" },
    { title: "Uncited", summary: "s", body: "no citation anywhere" }, // dropped — noise
    { title: "grounded", summary: "dup by case", body: "Source: x", source: "x" }, // dropped — dup
    { title: "", summary: "s", source: "y" }, // dropped — no title
    { title: "NoSummary", summary: "", source: "z" }, // dropped — no summary
  ]);
  eq(
    "only the grounded, unique record survives",
    lore.map((r) => r.title),
    ["Grounded"],
  );
}

console.log("== AC15: empty / garbage lore stays EMPTY (zero drafts is correct) ==");
{
  eq("empty array preserved", validateLore([]), []);
  eq("non-array → empty", validateLore("not-an-array"), []);
  eq("undefined → empty", validateLore(undefined), []);
  // And validateAnalysis surfaces a lore array even when the model omits it.
  const v = validateAnalysis({
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [],
  });
  eq("validateAnalysis always carries a lore array", v.lore, []);
}

console.log("== AC16/AC17: writeUnderstanding drafts lore via `suggest` (DRAFT) + dedupes ==");
{
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-lore-"));
  const logFile = join(dir, "calls.jsonl");
  const searchFile = join(dir, "search.txt");
  writeFileSync(searchFile, "memory: no matches\n"); // first onboard: nothing recorded
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const LOG = ${JSON.stringify(logFile)};`,
      `const SEARCH = ${JSON.stringify(searchFile)};`,
      "const argv = process.argv.slice(2);",
      "appendFileSync(LOG, JSON.stringify(argv) + '\\n');",
      "if (argv[0] === 'search') { try { process.stdout.write(readFileSync(SEARCH,'utf8')); } catch {} }",
      "process.exit(0);",
    ].join("\n"),
  );
  const cfg = { cliBin, db: join(dir, "lore.sqlite") };
  const understanding = {
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [],
    // Shape AS validateLore PRODUCES IT: a file citation lives in the body, the
    // `source` FIELD is null (URL-only), confidence low.
    lore: [
      {
        title: "Webhook retries cap at 2h backoff",
        summary: "Webhook retry backoff caps at 2h to avoid downstream DoS.",
        body: "Source: docs/adrs/0009-webhook-retry-cap.md\n\nADR 0009.",
        tags: [INDUCTION_TAG, "migrations"],
        source: null,
        confidence: "low",
      },
    ],
  };

  const first = writeUnderstanding(cfg, "demo", understanding, { env: process.env });
  eq("first onboard: one lore drafted", first.loreDrafted, 1);
  eq("first onboard: none skipped", first.loreSkipped, 0);
  const calls = (await import("node:fs"))
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const suggestCall = calls.find((c) => c[0] === "suggest");
  assert("AC16: used the DRAFT path (`suggest`, not `add`/`approve`)", Boolean(suggestCall));
  assert(
    "AC16: NO approve was ever issued",
    !calls.some((c) => c[0] === "approve" || c[0] === "add"),
  );
  assert(
    "AC16: draft carries --tag induction",
    suggestCall.includes("--tag") && suggestCall.includes(INDUCTION_TAG),
  );
  // The ADR FILE citation is body-only (not --source, which is URL-only) — but the
  // body the suggest carries cites it, so the reviewer still sees the source.
  const bodyArg = suggestCall[suggestCall.indexOf("--body") + 1];
  assert(
    "AC16: draft body cites the source doc",
    /Source:/.test(bodyArg) && /0009-webhook-retry-cap\.md/.test(bodyArg),
  );
  assert("AC16: a file citation is NOT passed as --source", !suggestCall.includes("--source"));
  assert(
    "AC16: draft scoped to the repo",
    suggestCall.includes("--repo") && suggestCall.includes("demo"),
  );

  // Simulate the store now containing that draft (what `search … --include-drafts` returns).
  writeFileSync(
    searchFile,
    "Webhook retries cap at 2h backoff (lore-aaa111)\n  [draft] conf=medium  tags=induction,migrations\n",
  );
  const second = writeUnderstanding(cfg, "demo", understanding, { env: process.env });
  eq("AC17: re-onboard drafts zero (de-duped by title)", second.loreDrafted, 0);
  eq("AC17: the lore was skipped", second.loreSkipped, 1);
}

console.log("== parseLoreTitles recovers titles from a search listing ==");
{
  const titles = parseLoreTitles(
    "Webhook retries cap at 2h backoff (lore-aaa111)\n  [draft] conf=medium\n\nmemory: showing 1 of 1\n",
  );
  assert("title recovered + lower-cased", titles.has("webhook retries cap at 2h backoff"));
  assert("the meta/memory lines are ignored", titles.size === 1);
}

console.log("== AC18: analyzeAndWrite end-to-end drafts grounded+cited+induction lore ==");
{
  const repo = mavenRepo();
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-lore-e2e-"));
  const logFile = join(dir, "calls.jsonl");
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "if (process.argv[2] === 'search') process.stdout.write('memory: no matches\\n');",
      "process.exit(0);",
    ].join("\n"),
  );
  const env = { ...process.env, MEMORY_CLI_BIN: cliBin, MEMORY_DB: join(dir, "lore.sqlite") };
  const modelJson =
    "```json\n" +
    JSON.stringify({
      digest: {
        overview: "A normalisation platform.",
        structure: "Multi-module Maven.",
        conventions: "Java/Maven.",
        stack: "java-maven",
      },
      features: [],
      lore: [
        // grounded by a URL → kept, --source set, confidence medium (clamped from high)
        {
          title: "Webhook retries cap at 2h",
          summary: "caps backoff",
          body: "ADR.",
          tags: ["migrations"],
          source: "https://github.com/acme/acme-bridge/pull/9",
          confidence: "high",
        },
        // grounded by a FILE doc → kept, body-cited, NO --source, low confidence
        {
          title: "Profile-guard fails fast on dev-sentinel",
          summary: "startup guard",
          body: "Source: common/profile-guard/pom.xml\n\nfails fast.",
          tags: ["invariants"],
        },
        // uncited → dropped as noise
        { title: "Generic advice", summary: "use tests", body: "no source" },
      ],
    }) +
    "\n```";
  const res = analyzeAndWrite(
    repo,
    { repoId: "demo", name: "demo", stack: "java" },
    { env, runTurn: () => ({ timedOut: false, stdout: modelJson }) },
  );
  assert("ran with the model", res.ran === true && res.usedModel === true);
  eq("two grounded lore drafted (uncited dropped)", res.stats.loreDrafted, 2);
  const calls = (await import("node:fs"))
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const suggests = calls.filter((c) => c[0] === "suggest");
  eq("two suggest calls", suggests.length, 2);
  assert(
    "every draft is induction-tagged",
    suggests.every((s) => s.includes("--tag") && s.includes(INDUCTION_TAG)),
  );
  // The URL-sourced draft: --source set, confidence medium (never high).
  const urlDraft = suggests.find((s) => s.includes("Webhook retries cap at 2h"));
  assert(
    "URL draft sets --source",
    urlDraft.includes("--source") &&
      urlDraft.includes("https://github.com/acme/acme-bridge/pull/9"),
  );
  assert(
    "URL draft confidence capped to medium (model said high)",
    urlDraft.includes("--confidence") && urlDraft.includes("medium") && !urlDraft.includes("high"),
  );
  // The file-cited draft: NO --source, but the body cites the doc.
  const fileDraft = suggests.find((s) => s.includes("Profile-guard fails fast on dev-sentinel"));
  assert("file draft does NOT pass --source", !fileDraft.includes("--source"));
  const fileBody = fileDraft[fileDraft.indexOf("--body") + 1];
  assert(
    "file draft body cites the source doc",
    /Source:/.test(fileBody) && /profile-guard/.test(fileBody),
  );
  assert(
    "the uncited 'Generic advice' was NOT drafted",
    !calls.some((c) => c[0] === "suggest" && c.includes("Generic advice")),
  );
}

console.log("== normalizeDedupKey collides reworded-but-equivalent names ==");
{
  const k = normalizeDedupKey;
  // The exact case from the regression: three phrasings of the same capability.
  eq("'URL shortening' === 'Shorten URL'", k("URL shortening"), k("Shorten URL"));
  eq("'Shorten URL' === 'Shorten a URL'", k("Shorten URL"), k("Shorten a URL"));
  eq("'URL shortening' === 'Shorten a URL'", k("URL shortening"), k("Shorten a URL"));
  // Genuinely distinct capabilities must NOT collide.
  assert("distinct capabilities keep distinct keys", k("URL shortening") !== k("Webhook retries"));
  // A title made entirely of stopwords falls back to the lowercased original.
  eq("all-stopword title falls back to lowered original", k("The A Of"), "the a of");
}

console.log("== AC9b: feature dedup survives model REWORDING across re-onboards ==");
{
  // The regression: on re-onboard the model rephrases the SAME capability
  // ("URL shortening" → "Shorten a URL"). With exact-lowercase dedup these
  // would NOT collide and a near-duplicate row would accumulate. The
  // normalised key must catch it → zero added on the second run.
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-dedup-rw-"));
  const logFile = join(dir, "calls.jsonl");
  const featuresFile = join(dir, "features.txt");
  writeFileSync(featuresFile, ""); // first onboard: store empty
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const LOG = ${JSON.stringify(logFile)};`,
      `const FEATURES = ${JSON.stringify(featuresFile)};`,
      "const argv = process.argv.slice(2);",
      "appendFileSync(LOG, JSON.stringify(argv) + '\\n');",
      "if (argv[0] === 'features') { try { process.stdout.write(readFileSync(FEATURES,'utf8')); } catch {} }",
      "process.exit(0);",
    ].join("\n"),
  );
  const cfg = { cliBin, db: join(dir, "lore.sqlite") };

  const firstRun = {
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [{ name: "URL shortening", summary: "Shorten long URLs.", status: "shipped" }],
  };
  const first = writeUnderstanding(cfg, "demo", firstRun, { env: process.env });
  eq("first onboard: feature added", first.featuresAdded, 1);

  // Store now lists the first run's feature (what `features demo` returns).
  writeFileSync(
    featuresFile,
    "Features for demo: 1\n\nSHIPPED (1)\n  [shipped] URL shortening  (aaa11111)\n",
  );
  // Second run: SAME capability, REWORDED name.
  const secondRun = {
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [{ name: "Shorten a URL", summary: "Create short links.", status: "shipped" }],
  };
  const second = writeUnderstanding(cfg, "demo", secondRun, { env: process.env });
  eq("re-onboard: reworded duplicate NOT added (no accumulation)", second.featuresAdded, 0);
  eq("re-onboard: reworded duplicate skipped", second.featuresSkipped, 1);
}

console.log("== AC17b: lore dedup survives model REWORDING across re-onboards ==");
{
  const dir = mkdtempSync(resolve(tmpdir(), "onboard-lore-rw-"));
  const logFile = join(dir, "calls.jsonl");
  const searchFile = join(dir, "search.txt");
  writeFileSync(searchFile, "memory: no matches\n"); // first onboard: nothing recorded
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const LOG = ${JSON.stringify(logFile)};`,
      `const SEARCH = ${JSON.stringify(searchFile)};`,
      "const argv = process.argv.slice(2);",
      "appendFileSync(LOG, JSON.stringify(argv) + '\\n');",
      "if (argv[0] === 'search') { try { process.stdout.write(readFileSync(SEARCH,'utf8')); } catch {} }",
      "process.exit(0);",
    ].join("\n"),
  );
  const cfg = { cliBin, db: join(dir, "lore.sqlite") };

  const firstRun = {
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [],
    lore: [
      {
        title: "Webhook retries cap at 2h backoff",
        summary: "Retry backoff caps at 2h.",
        body: "Source: docs/adrs/0009.md\n\nADR 0009.",
        tags: [INDUCTION_TAG],
        source: null,
        confidence: "low",
      },
    ],
  };
  const first = writeUnderstanding(cfg, "demo", firstRun, { env: process.env });
  eq("first onboard: lore drafted", first.loreDrafted, 1);

  // Store now lists that draft (what the search returns on re-onboard).
  writeFileSync(
    searchFile,
    "Webhook retries cap at 2h backoff (lore-aaa111)\n  [draft] conf=low  tags=induction\n",
  );
  // Second run: SAME lore, REWORDED title.
  const secondRun = {
    digest: { overview: "o", structure: "s", conventions: "c", stack: "java" },
    features: [],
    lore: [
      {
        title: "Backoff for webhook retries caps at 2h",
        summary: "Retry backoff caps at 2h.",
        body: "Source: docs/adrs/0009.md\n\nADR 0009.",
        tags: [INDUCTION_TAG],
        source: null,
        confidence: "low",
      },
    ],
  };
  const second = writeUnderstanding(cfg, "demo", secondRun, { env: process.env });
  eq("re-onboard: reworded lore NOT drafted (no accumulation)", second.loreDrafted, 0);
  eq("re-onboard: reworded lore skipped", second.loreSkipped, 1);
}

console.log("== cardModel: GAFFER_CARD_MODEL / default Haiku (cheap per-file tier) ==");
{
  assert("cardModel defaults to claude-haiku-4-5", cardModel({}) === "claude-haiku-4-5");
  assert(
    "cardModel respects GAFFER_CARD_MODEL override",
    cardModel({ GAFFER_CARD_MODEL: "claude-opus-4" }) === "claude-opus-4",
  );
  assert(
    "cardModel ignores blank GAFFER_CARD_MODEL",
    cardModel({ GAFFER_CARD_MODEL: "  " }) === "claude-haiku-4-5",
  );
}

console.log("== analysisCaps: synthesis model stays on Sonnet (separate knob) ==");
{
  assert(
    "synth model defaults to claude-sonnet-4-5",
    analysisCaps({}).model === "claude-sonnet-4-5",
  );
  assert(
    "GAFFER_PLAN_MODEL overrides synth model",
    analysisCaps({ GAFFER_PLAN_MODEL: "claude-opus-4" }).model === "claude-opus-4",
  );
  assert(
    "GAFFER_ONBOARD_SYNTH_MODEL wins over GAFFER_PLAN_MODEL",
    analysisCaps({ GAFFER_ONBOARD_SYNTH_MODEL: "m1", GAFFER_PLAN_MODEL: "m2" }).model === "m1",
  );
}

console.log("== cardBatch: GAFFER_CARD_BATCH / default 8, min 1 ==");
{
  assert("cardBatch defaults to 8", cardBatch({}) === 8);
  assert("cardBatch respects override", cardBatch({ GAFFER_CARD_BATCH: "4" }) === 4);
  assert("cardBatch floors at 1 (0 → default)", cardBatch({ GAFFER_CARD_BATCH: "0" }) === 8);
  assert("cardBatch ignores garbage", cardBatch({ GAFFER_CARD_BATCH: "x" }) === 8);
}

console.log("== cardSnippetChars: GAFFER_CARD_SNIPPET_CHARS / small default, 0 allowed ==");
{
  assert("snippet default is small (<=400)", cardSnippetChars({}) <= 400);
  assert(
    "snippet 0 is honoured (structure-only)",
    cardSnippetChars({ GAFFER_CARD_SNIPPET_CHARS: "0" }) === 0,
  );
  assert("snippet override", cardSnippetChars({ GAFFER_CARD_SNIPPET_CHARS: "120" }) === 120);
}

console.log("== buildCardBatchPrompt + validateCardBatch: B files → B cards ==");
{
  const entries = [
    {
      rel: "src/a.ts",
      fileType: "typescript",
      structure: { imports: ["x"], symbols: ["add"] },
      snippet: "export function add(){}",
    },
    {
      rel: "src/b.ts",
      fileType: "typescript",
      structure: { imports: [], symbols: ["Server"] },
      snippet: "",
    },
  ];
  const prompt = buildCardBatchPrompt(entries);
  assert(
    "batch prompt lists both files by index",
    prompt.includes("FILE 0: src/a.ts") && prompt.includes("FILE 1: src/b.ts"),
  );
  assert(
    "batch prompt sends the skill prefix once",
    (prompt.match(/CARD-GENERATION SKILL RULES/g) || []).length === 1,
  );
  assert("batch prompt omits empty snippet", !prompt.includes("snippet-1"));

  // Well-formed batch result → aligned by index, each through validateCardFields.
  const ok = validateCardBatch(
    {
      cards: [
        { index: 1, tldr: "Server bootstrap.", role_primary: "entrypoint", role_tags: ["http"] },
        { index: 0, tldr: "Adds two numbers.", role_primary: "util", role_tags: [] },
      ],
    },
    2,
  );
  assert("batch result length matches count", ok.length === 2);
  assert(
    "batch result aligned by index (0)",
    ok[0]?.tldr === "Adds two numbers." && ok[0]?.rolePrimary === "util",
  );
  assert("batch result aligned by index (1)", ok[1]?.tldr === "Server bootstrap.");

  // Bare array + position fallback when index missing.
  const bare = validateCardBatch([{ tldr: "A." }, { tldr: "B." }], 2);
  assert("bare array uses positional index", bare[0]?.tldr === "A." && bare[1]?.tldr === "B.");

  // Out-of-range / missing entries → null, never throws.
  const partial = validateCardBatch(
    {
      cards: [
        { index: 5, tldr: "oob" },
        { index: 0, tldr: "Only this." },
      ],
    },
    2,
  );
  assert(
    "out-of-range index dropped, in-range kept",
    partial[0]?.tldr === "Only this." && partial[1] === null,
  );
  assert(
    "garbage input → dense nulls, no throw",
    validateCardBatch(null, 3).every((x) => x === null),
  );
}

console.log("== emitFileCards: B=1 vs B>1 both card every file (trust-split preserved) ==");
{
  const { execSync } = await import("node:child_process");
  const mkRepo = () => {
    const repoDir = mkdtempSync(resolve(tmpdir(), "emit-batch-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "a.ts"), "export function add(a,b){return a+b;}\n");
    writeFileSync(join(repoDir, "src", "b.ts"), "export class Server{start(){return 'up';}}\n");
    writeFileSync(join(repoDir, "src", "c.ts"), "export const PI = 3.14;\n");
    execSync(
      "git init -q && git add -A && git -c user.email=t@e.st -c user.name=T commit -q -m init",
      {
        cwd: repoDir,
        stdio: "ignore",
      },
    );
    return repoDir;
  };
  const mkCli = () => {
    const dir = mkdtempSync(resolve(tmpdir(), "emit-batch-cli-"));
    const cliBin = join(dir, "fake-lg.mjs");
    writeFileSync(
      cliBin,
      [
        "if (process.argv[2] === 'card' && process.argv[3] === 'upsert') { process.stdout.write(JSON.stringify({ modelStatus: 'active' }) + '\\n'); }",
        "process.exit(0);",
      ].join("\n"),
    );
    return { cliBin, db: join(dir, "lore.sqlite") };
  };

  // B=1 safe fallback — single-file runTurn used, one card per file.
  {
    const repoDir = mkRepo();
    const cfg = mkCli();
    const env = { ...process.env, GAFFER_CARD_BATCH: "1", GAFFER_CARD_REVIEW_SAMPLE: "0" };
    let singleCalls = 0;
    const s = emitFileCards(
      repoDir,
      { repoId: "demo", name: "demo" },
      {
        cfg,
        env,
        runTurn: () => {
          singleCalls += 1;
          return { tldr: "One file.", rolePrimary: "util", roleTags: [] };
        },
        runBatchTurn: () => {
          throw new Error("batch turn must NOT be used when B=1");
        },
      },
    );
    assert("B=1: all 3 files carded", s.carded === 3 && s.modelCarded === 3);
    assert("B=1: one single-turn call per file", singleCalls === 3);
  }

  // B>1 — one batch call, B cards parsed back, each finalized like today.
  {
    const repoDir = mkRepo();
    const cfg = mkCli();
    const env = { ...process.env, GAFFER_CARD_BATCH: "8", GAFFER_CARD_REVIEW_SAMPLE: "0" };
    let batchCalls = 0;
    let lastCount = 0;
    const s = emitFileCards(
      repoDir,
      { repoId: "demo", name: "demo" },
      {
        cfg,
        env,
        runTurn: () => {
          throw new Error("single turn must NOT be used when B>1");
        },
        runBatchTurn: (_p, count) => {
          batchCalls += 1;
          lastCount = count;
          return Array.from({ length: count }, (_, i) => ({
            tldr: `File ${i}.`,
            rolePrimary: "util",
            roleTags: [],
          }));
        },
      },
    );
    assert("B>1: single batch call for 3 files", batchCalls === 1 && lastCount === 3);
    assert("B>1: all 3 files carded", s.carded === 3 && s.modelCarded === 3);
    assert(
      "B>1: collectedCards has 3 entries (rollup input intact)",
      s.collectedCards.length === 3,
    );
  }

  // B>1 with a null batch result → mechanical-only cards, trust-split holds (no model fields).
  {
    const repoDir = mkRepo();
    const cfg = mkCli();
    const env = { ...process.env, GAFFER_CARD_BATCH: "8", GAFFER_CARD_REVIEW_SAMPLE: "0" };
    const s = emitFileCards(
      repoDir,
      { repoId: "demo", name: "demo" },
      {
        cfg,
        env,
        runBatchTurn: () => null, // timeout / unparseable
      },
    );
    assert("B>1 null result: files still carded mechanically", s.carded === 3);
    assert("B>1 null result: zero model summaries (fail-safe)", s.modelCarded === 0);
  }
}

console.log("== refreshFileCards: changed file gets re-carded + watermark advances ==");
{
  // Build a tiny git repo with one source file.
  const repoDir = mkdtempSync(resolve(tmpdir(), "refresh-cards-"));
  const srcFile = join(repoDir, "src", "util.ts");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(srcFile, "export function greet(name: string) { return `Hi ${name}`; }\n");
  const { execSync } = await import("node:child_process");
  execSync(
    "git init -q && git add -A && git -c user.email=t@e.st -c user.name=T commit -q -m init",
    {
      cwd: repoDir,
      stdio: "ignore",
    },
  );

  // A fake memory CLI that records calls + returns success.
  const dir = mkdtempSync(resolve(tmpdir(), "refresh-memcli-"));
  const logFile = join(dir, "calls.jsonl");
  const cliBin = join(dir, "fake-lg.mjs");
  writeFileSync(
    cliBin,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      // card upsert returns JSON with modelStatus so the review path can parse it.
      "if (process.argv[2] === 'card' && process.argv[3] === 'upsert') { process.stdout.write(JSON.stringify({ modelStatus: 'active' }) + '\\n'); }",
      "process.exit(0);",
    ].join("\n"),
  );

  const cfg = { cliBin, db: join(dir, "lore.sqlite") };
  const env = {
    ...process.env,
    MEMORY_CLI_BIN: cliBin,
    MEMORY_DB: cfg.db,
    GAFFER_PLAN_MODEL: "test-model",
  };
  const stubTurn = () => ({ tldr: "Greet utility.", rolePrimary: "util", roleTags: ["strings"] });

  const rStats = refreshFileCards(repoDir, ["src/util.ts"], {
    cfg,
    env,
    log: () => {},
    repo: "test-repo",
    canonical: "file://" + repoDir,
    runTurn: stubTurn,
  });

  assert("refreshed count = 1 for one changed source file", rStats.refreshed === 1);
  assert("watermark advanced (non-null)", rStats.watermark !== null);

  const { readFileSync: readFS } = await import("node:fs");
  const calls = readFS(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert(
    "card upsert was called for src/util.ts",
    calls.some((c) => c[0] === "card" && c[1] === "upsert" && c.includes("src/util.ts")),
  );
  assert(
    "card sync (watermark advance) was called",
    calls.some((c) => c[0] === "card" && c[1] === "sync" && c.includes("--commit")),
  );
  assert(
    "non-source files in changedPaths are skipped",
    (() => {
      // .md and .json should not produce upsert calls — refreshed count stays 0
      const r2 = refreshFileCards(repoDir, ["README.md", "package.json"], {
        cfg,
        env,
        log: () => {},
        repo: "test-repo",
        canonical: "file://" + repoDir,
        runTurn: stubTurn,
      });
      return r2.refreshed === 0;
    })(),
  );
}

console.log("");
if (failures.length === 0) {
  console.log(`onboard-analyze: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`onboard-analyze: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
