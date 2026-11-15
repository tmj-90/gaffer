#!/usr/bin/env node
// =====================================================================
// The prompt quarantine matrix (run by runner/test/prompt-quarantine.test.sh): for each
// agent prompt builder, every outside or agent-written field carries a hostile payload
// (lib/prompt-envelopes.mjs hostile) and must land inside exactly one envelope of its
// own tag, with that closing tag appearing exactly once (or once per repeated item) and
// no raw `<` between the tags.
// Prints one `ok` / `FAIL` line per prompt x field; exits 1 on any FAIL.
// =====================================================================
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEnvelope, hostile } from "./prompt-envelopes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "..", "..");
let failed = 0;
function check(promptName, prompt, rows) {
  for (const [field, id, tag, n = 1, alsoIn = []] of rows) {
    const problems = checkEnvelope(prompt, id, tag, n, alsoIn);
    if (problems.length) {
      failed += 1;
      console.log(`  FAIL ${promptName} / ${field}: ${problems.join("; ")}`);
    } else console.log(`  ok   ${promptName} / ${field} inside <untrusted-${tag}>`);
  }
  if (!/&lt; inside these tags is a literal </.test(prompt)) {
    failed += 1;
    console.log(`  FAIL ${promptName}: no quarantine notice explaining &lt;`);
  } else console.log(`  ok   ${promptName}: carries the quarantine notice`);
}

// ── independent tester (bin/tester-run.mjs buildTesterPrompt) ──────────────────────
{
  const { buildTesterPrompt } = await import(resolve(RUNNER, "bin", "tester-run.mjs"));
  const prompt = buildTesterPrompt({
    context: {
      number: 7,
      ticketId: "t-7",
      title: hostile("title", "ticket-title"),
      description: hostile("description", "requirements"),
      mode: "harness",
      acceptanceCriteria: [{ id: "ac-1", text: hostile("criterion", "acceptance-criterion") }],
      testContract: {
        changed_surfaces: [hostile("surface", "test-contract")],
        runtime_deps: [hostile("dep", "test-contract")],
        env_vars: [hostile("env", "test-contract")],
        run_command: hostile("run_command", "test-contract"),
        harness_ready: false,
        profile: hostile("profile", "acceptance-profile"),
      },
    },
    worktree: "/tmp/wt",
    repoName: "app",
    missing: [hostile("need", "declared-need")],
  });
  check("tester", prompt, [
    ["title", "title", "ticket-title"],
    ["description", "description", "requirements"],
    ["criterion text", "criterion", "acceptance-criterion"],
    ["contract changed_surfaces", "surface", "test-contract"],
    ["contract runtime_deps", "dep", "test-contract"],
    ["contract env_vars", "env", "test-contract"],
    ["contract run_command", "run_command", "test-contract"],
    ["contract profile (its own line, and in the contract)", "profile", "acceptance-profile", 1, ["test-contract"]],
    ["declared need the runner does not know", "need", "declared-need"],
  ]);
  if (/<<<REQUIREMENTS|^REQUIREMENTS>>>$/m.test(prompt.replace(/MARK_[\s\S]*?PASS"\}/g, ""))) {
    failed += 1;
    console.log("  FAIL tester: the old REQUIREMENTS markers are still a delimiter");
  } else console.log("  ok   tester: no REQUIREMENTS marker delimiter outside the data");
}

// ── decompose / plan-build (bin/decompose.mjs) ─────────────────────────────────────
{
  const d = await import(resolve(RUNNER, "bin", "decompose.mjs"));
  const prompt = d.buildPrompt({
    brief: hostile("brief", "app-brief"),
    repo: hostile("repo", "target-repo"),
    history: [{ role: "user", text: hostile("history", "conversation-history") }],
    spec: [{ clause_id: "c1", kind: "requirement", text: hostile("clause", "spec"), rationale: hostile("rationale", "spec") }],
  });
  check("decompose", prompt, [
    ["brief", "brief", "app-brief"],
    ["target repo", "repo", "target-repo"],
    ["conversation history", "history", "conversation-history"],
    ["spec clause text", "clause", "spec"],
    ["spec clause rationale", "rationale", "spec"],
  ]);
  check("decompose critic", d.buildCriticPrompt(hostile("plan", "plan-under-review")), [
    ["plan JSON", "plan", "plan-under-review"],
  ]);
  check(
    "decompose revision",
    d.buildRevisionPrompt({ brief: hostile("rbrief", "app-brief") }, hostile("cplan", "current-plan"), hostile("critique", "critique")),
    [
      ["current plan", "cplan", "current-plan"],
      ["critique", "critique", "critique"],
      ["brief", "rbrief", "app-brief"],
    ],
  );
}

// ── spec author (bin/spec-author.mjs) ──────────────────────────────────────────────
{
  const sa = await import(resolve(RUNNER, "bin", "spec-author.mjs"));
  const prompt = sa.buildPrompt({
    brief: hostile("pbrief", "product-brief"),
    context: hostile("context", "spec-context"),
    history: [{ role: "user", text: hostile("shistory", "conversation-history") }],
  });
  check("spec-author", prompt, [
    ["brief", "pbrief", "product-brief"],
    ["supporting context", "context", "spec-context"],
    ["conversation history", "shistory", "conversation-history"],
  ]);
}

// ── product owner (bin/product-owner-run.mjs) ──────────────────────────────────────
{
  const po = await import(resolve(RUNNER, "bin", "product-owner-run.mjs"));
  const prompt = po.buildPrompt({
    repoName: "app",
    repoPath: "/nonexistent/app",
    maxTickets: 3,
    openWork: { items: [{ number: 4, status: "ready", title: hostile("openwork", "open-work") }], more: 0 },
  });
  check("product-owner", prompt, [["open work titles", "openwork", "open-work"]]);
}

// ── onboarding (lib/onboard-analyze.mjs) ───────────────────────────────────────────
{
  const ob = await import(resolve(RUNNER, "lib", "onboard-analyze.mjs"));
  const prompt = ob.buildAnalysisPrompt({
    name: "app",
    readme: hostile("readme", "readme"),
    tree: hostile("tree", "tree"),
    modulesInfo: { kind: "maven-multimodule", modules: [hostile("module", "modules")] },
    subManifests: [{ module: hostile("smpath", "submanifest-path"), file: "pom.xml", content: hostile("smbody", "submanifest") }],
    adrTitles: [hostile("adr", "adr-titles")],
    recentCommits: [{ sha: "abc1234", subject: hostile("commit", "recent-commits") }],
    deprecationMarkers: [{ file: "a.js", line: 1, text: hostile("marker", "deprecation-markers") }],
    scan: { stack: "node", testCommand: hostile("testcmd", "scan-facts") },
    skipped: [hostile("skipped", "skipped-paths")],
  });
  check("onboard analysis", prompt, [
    ["README", "readme", "readme"],
    ["directory tree", "tree", "tree"],
    ["module names", "module", "modules"],
    ["sub-manifest path", "smpath", "submanifest-path"],
    ["sub-manifest content", "smbody", "submanifest"],
    ["ADR titles", "adr", "adr-titles"],
    ["commit subjects", "commit", "recent-commits"],
    ["deprecation markers", "marker", "deprecation-markers"],
    ["scan facts (repo commands)", "testcmd", "scan-facts"],
    ["paths not read", "skipped", "skipped-paths"],
  ]);
  const st = { imports: [hostile("imports", "imports")], symbols: [hostile("symbols", "symbols")] };
  check("onboard card", ob.buildCardPrompt(hostile("path", "file-path"), "js", st, hostile("snippet", "snippet")), [
    ["file path", "path", "file-path"],
    ["imports", "imports", "imports"],
    ["symbols", "symbols", "symbols"],
    ["snippet", "snippet", "snippet"],
  ]);
  check(
    "onboard card batch",
    ob.buildCardBatchPrompt([
      { rel: hostile("bpath", "file-path-0"), fileType: "js", structure: { imports: [hostile("bimports", "imports-0")], symbols: [hostile("bsymbols", "symbols-0")] }, snippet: hostile("bsnippet", "snippet-0") },
    ]),
    [
      ["file path", "bpath", "file-path-0"],
      ["imports", "bimports", "imports-0"],
      ["symbols", "bsymbols", "symbols-0"],
      ["snippet", "bsnippet", "snippet-0"],
    ],
  );
  check(
    "onboard card review",
    ob.buildCardReviewPrompt(hostile("rpath", "file-path"), "js", { imports: [], symbols: [] }, hostile("rsnippet", "snippet"), {
      tldr: hostile("tldr", "card-draft"),
      rolePrimary: "x",
      roleTags: [],
    }),
    [
      ["file path", "rpath", "file-path"],
      ["snippet", "rsnippet", "snippet"],
      ["draft card", "tldr", "card-draft"],
    ],
  );
}

// ── multi-app repo classifier (bin/inherit-repo.mjs) ───────────────────────────────
{
  const ih = await import(resolve(RUNNER, "bin", "inherit-repo.mjs"));
  const prompt = ih.buildPrompt({
    title: hostile("ititle", "ticket-title"),
    description: hostile("idesc", "ticket-description"),
    candidates: [{ repo: "web", purpose: hostile("purpose", "repo-purpose") }],
  });
  check("inherit classifier", prompt, [
    ["title", "ititle", "ticket-title"],
    ["description", "idesc", "ticket-description"],
    ["repo purpose", "purpose", "repo-purpose"],
  ]);
}

// ── crew render seams the runner calls (eval judge, model scout) ───────────────────
{
  const CREW = resolve(RUNNER, "..", "packages", "crew", "dist");
  const { renderJudgePrompt } = await import(resolve(CREW, "eval", "deliveryJudge.js"));
  const judge = renderJudgePrompt({
    ticketTitle: hostile("jtitle", "ticket-title"),
    acceptanceCriteria: [{ id: "ac1", text: hostile("jac", "acceptance-criterion") }],
    diff: hostile("jdiff", "delivery-diff"),
    evidence: hostile("jev", "delivery-evidence"),
    testOutput: hostile("jtest", "test-output"),
  });
  check("eval judge", judge, [
    ["title", "jtitle", "ticket-title"],
    ["criterion text", "jac", "acceptance-criterion"],
    ["diff", "jdiff", "delivery-diff"],
    ["evidence", "jev", "delivery-evidence"],
    ["test output", "jtest", "test-output"],
  ]);
  const { renderScoutPrompt } = await import(resolve(CREW, "runtime", "context", "scoutPrompt.js"));
  const scout = renderScoutPrompt({
    ticketNumber: "7",
    title: hostile("stitle", "ticket-title"),
    description: hostile("sdesc", "ticket-description"),
    repoPath: "/r",
    risk: "medium",
    scout: null,
  });
  check("scout", scout, [
    ["title", "stitle", "ticket-title"],
    ["description", "sdesc", "ticket-description"],
  ]);
}

if (failed) {
  console.log(`prompt-quarantine-matrix: ${failed} FAIL`);
  process.exit(1);
}
console.log("prompt-quarantine-matrix: all fields enveloped");
