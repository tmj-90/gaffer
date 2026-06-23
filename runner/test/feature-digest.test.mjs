#!/usr/bin/env node
// =====================================================================
// FEATURE-LIFECYCLE + REPO-DIGEST wiring — prepare-at-delivery / apply-at-merge.
// ---------------------------------------------------------------------
// Proves the lib (lib/feature-digest.mjs) pure builders/parsers AND the two call
// sites (bin/merge-ticket.mjs applyDigestAndFeature, bin/epic-feature.mjs) against a
// STUB Dispatch CLI that records every argv — so NO live `claude -p` and NO real
// dispatch build are needed:
//   AC1  encode/parseDigestDeltaSummary round-trips; non-marker / garbage → null
//   AC2  selectPreparedDelta picks the LAST GAFFER_DIGEST_DELTA_V1 row from a view
//   AC3  buildApplyCommands → digest update (--source merge:#N) + feature ship
//   AC4  buildMinimalDigestStamp + buildFeatureShippedCommands shape (fallback)
//   AC5  buildEpicBuildingCommands: advance existing id, else add_feature(building)
//   AC6  a merge WITH a prepared delta APPLIES it deterministically: digest section
//        stamped source=merge:#N + feature shipped, NO agent (stub wg only)
//   AC7  a merge WITHOUT a prepared delta falls back to the MINIMAL stamp + ship
//   AC8  a Dispatch-write FAILURE is swallowed — applyDigestAndFeature never throws
//   AC9  GAFFER_DIGEST_DISABLE=1 short-circuits (no writes)
//   AC10 brownfield epic-feature CLI yields a building feature (add_feature) +
//        --feature-id advances; --dry-run prints argv and runs nothing
//
// Zero deps. No live claude. Run: node test/feature-digest.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const MERGE = resolve(RUNNER_DIR, "bin", "merge-ticket.mjs");
const EPIC = resolve(RUNNER_DIR, "bin", "epic-feature.mjs");
const LIB = resolve(RUNNER_DIR, "lib", "feature-digest.mjs");

const {
  DIGEST_DELTA_MARKER,
  FEATURE_STATUS,
  mergeSource,
  encodeDigestDelta,
  parseDigestDeltaSummary,
  selectPreparedDelta,
  buildApplyCommands,
  buildMinimalDigestStamp,
  buildFeatureShippedCommands,
  buildEpicBuildingCommands,
} = await import(LIB);
const { applyDigestAndFeature } = await import(MERGE);

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

const WORKDIR = mkdtempSync(resolve(tmpdir(), "feature-digest-test-"));

// --- A SHARED STUB CLI -------------------------------------------------------------
// Stands in for BOTH the dispatch CLI (the `ticket show` read in readTicketView) AND
// the MEMORY CLI (the `digest set` / `digest touch` / `feature add|advance` writes the
// repointed builders now emit). Records every invocation's argv (one JSON line per call)
// to $WG_LOG and exits with $WG_EXIT (default 0). Serves `ticket show <n>` from a planted
// view at $WG_VIEW when present, so the merge's readTicketView path is exercised offline.
//
// The two CLIs differ in how the DB is passed: dispatch prepends `--db <path>`, the
// memory CLI passes it via the MEMORY_DB env var (no flag). The stub strips a leading
// `--db <path>` pair only when present, so the LOGGED argv is the real verb either way —
// the assertions below check the memory-CLI argv shape (`digest set …`, `feature …`).
const STUB = resolve(WORKDIR, "cli-stub.mjs");
writeFileSync(
  STUB,
  [
    "import { appendFileSync, readFileSync, existsSync } from 'node:fs';",
    // dispatch prepends [--db, <path>, ...realArgs]; the memory CLI does not.
    "const argv = process.argv.slice(2);",
    "const real = argv[0] === '--db' ? argv.slice(2) : argv;",
    "const log = process.env.WG_LOG;",
    "if (log) appendFileSync(log, JSON.stringify(real) + '\\n');",
    "if (real[0] === 'ticket' && real[1] === 'show') {",
    "  const v = process.env.WG_VIEW;",
    "  if (v && existsSync(v)) { process.stdout.write(readFileSync(v, 'utf8')); process.exit(0); }",
    "  process.stdout.write('{}'); process.exit(0);",
    "}",
    "process.exit(parseInt(process.env.WG_EXIT || '0', 10));",
  ].join("\n"),
);

function readCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Run applyDigestAndFeature in a CHILD node process so process.env / DISPATCH_CLI are
// scoped per case (the function reads them lazily via runDispatch). Returns the parsed
// summary it prints.
function runApply({ ticket, repo, view, wgExit }, logPath) {
  const driver = resolve(WORKDIR, `apply-driver-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    driver,
    [
      `const { applyDigestAndFeature } = await import(${JSON.stringify(MERGE)});`,
      `const r = applyDigestAndFeature({ ticketNumber: ${ticket}, repo: ${JSON.stringify(repo)} });`,
      "process.stdout.write(JSON.stringify(r));",
    ].join("\n"),
  );
  const viewPath = view ? resolve(WORKDIR, `view-${ticket}.json`) : "";
  if (view) writeFileSync(viewPath, JSON.stringify(view));
  const res = spawnSync(process.execPath, [driver], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISPATCH_CLI: STUB, // serves `ticket show` (readTicketView)
      MEMORY_CLI: STUB, // serves the digest/feature memory-CLI writes
      WG_LOG: logPath,
      WG_EXIT: String(wgExit ?? 0),
      ...(view ? { WG_VIEW: viewPath } : {}),
    },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }
  return { code: res.status, out, stderr: res.stderr };
}

// ── AC1: encode/parse round-trip ──────────────────────────────────────────────────
console.log("== AC1: encode/parseDigestDeltaSummary round-trips; garbage → null ==");
{
  const delta = {
    repo: "demo",
    sections: [{ section: "arch", content: "now layered" }],
    feature: { name: "F" },
  };
  const s = encodeDigestDelta(delta);
  assert("encoded starts with marker", s.startsWith(DIGEST_DELTA_MARKER + " "));
  eq("parse round-trips the payload", parseDigestDeltaSummary(s), delta);
  eq("non-marker summary → null", parseDigestDeltaSummary("just a normal note"), null);
  eq(
    "marker + garbage json → null",
    parseDigestDeltaSummary(DIGEST_DELTA_MARKER + " {not json"),
    null,
  );
  eq("marker alone → null", parseDigestDeltaSummary(DIGEST_DELTA_MARKER), null);
  eq("empty → null", parseDigestDeltaSummary(""), null);
}

// ── AC2: selectPreparedDelta picks the LAST match ─────────────────────────────────
console.log("== AC2: selectPreparedDelta picks the LAST GAFFER_DIGEST_DELTA_V1 row ==");
{
  const view = {
    evidence: [
      { summary: "ordinary test_output note" },
      {
        summary: encodeDigestDelta({ repo: "demo", sections: [{ section: "a", content: "old" }] }),
      },
      { summary: "another normal note" },
      {
        summary: encodeDigestDelta({ repo: "demo", sections: [{ section: "a", content: "new" }] }),
      },
    ],
  };
  const got = selectPreparedDelta(view);
  eq("last delta wins", got && got.sections[0].content, "new");
  eq("no evidence → null", selectPreparedDelta({ evidence: [] }), null);
  eq("missing evidence array → null", selectPreparedDelta({}), null);
}

// ── AC3: buildApplyCommands ───────────────────────────────────────────────────────
console.log("== AC3: buildApplyCommands → memory `digest set` (source=merge:#N) + feature ship ==");
{
  const delta = {
    // `overview` is a recognised digest section → mapped to --overview; `arch` is not
    // → skipped; the empty section is skipped too.
    repo: "demo",
    sections: [
      { section: "overview", content: "now layered" },
      { section: "arch", content: "unknown section, skipped" },
      { section: "", content: "skip" },
    ],
    feature: { name: "Login", summary: "OAuth login", provenance: "epic-1" },
  };
  const jobs = buildApplyCommands(delta, { ticketNumber: 42, repo: "fallback" });
  const digest = jobs.find((j) => j.kind === "digest");
  assert(
    "one digest job (unknown + empty sections skipped)",
    jobs.filter((j) => j.kind === "digest").length === 1,
  );
  assert("digest job targets the MEMORY CLI (lg), not wg", digest.command === "lg");
  eq("digest job is `digest set <repo> --overview <c> --source …`", digest.args, [
    "digest",
    "set",
    "demo",
    "--overview",
    "now layered",
    "--source",
    "merge:#42",
  ]);
  const feat = jobs.find((j) => j.kind === "feature-add");
  assert("feature add(shipped) present (no linked id)", feat && feat.args.includes("shipped"));
  assert("feature add targets the MEMORY CLI", feat.command === "lg");
  assert("feature add carries provenance", feat.args.includes("epic-1"));
  assert(
    "feature add takes repo as a positional (no --repo, no --as)",
    feat.args[2] === "demo" && !feat.args.includes("--repo") && !feat.args.includes("--as"),
  );
  // With a linked featureId, ship by advancing instead of adding.
  const jobs2 = buildApplyCommands(
    { feature: { name: "X" } },
    { ticketNumber: 7, repo: "demo", featureId: "f-9" },
  );
  const adv = jobs2.find((j) => j.kind === "feature-advance");
  eq("linked id → advance to shipped (no --as)", adv && adv.args, [
    "feature",
    "advance",
    "f-9",
    "--to",
    "shipped",
  ]);
}

// ── AC4: minimal stamp + feature ship builders ────────────────────────────────────
console.log("== AC4: buildMinimalDigestStamp + buildFeatureShippedCommands ==");
{
  const stamp = buildMinimalDigestStamp({ ticketNumber: 5, repo: "demo" });
  assert("minimal stamp targets the MEMORY CLI", stamp.command === "lg");
  eq("minimal stamp argv (digest touch)", stamp.args, [
    "digest",
    "touch",
    "demo",
    "--source",
    "merge:#5",
  ]);
  eq(
    "no id + no feature → no ship job",
    buildFeatureShippedCommands({ ticketNumber: 5, repo: "demo" }),
    [],
  );
  const byId = buildFeatureShippedCommands({ ticketNumber: 5, repo: "demo", featureId: "f-1" });
  eq("id → advance shipped (no --as)", byId[0].args, [
    "feature",
    "advance",
    "f-1",
    "--to",
    "shipped",
  ]);
}

// ── AC5: brownfield epic → feature(building) builders ─────────────────────────────
console.log("== AC5: buildEpicBuildingCommands advance-or-add(building) ==");
{
  const add = buildEpicBuildingCommands({
    repo: "demo",
    name: "Search",
    summary: "full-text",
    provenance: "epic-7",
  });
  const j = add[0];
  assert("adds a feature", j.kind === "feature-add");
  assert("targets the MEMORY CLI (lg)", j.command === "lg");
  assert("status building", j.args.includes("building") && !j.args.includes("shipped"));
  assert("provenance is the epic ref", j.args.includes("epic-7"));
  assert(
    "repo positional + name carried (no --repo, no --as)",
    j.args[2] === "demo" &&
      j.args.includes("Search") &&
      !j.args.includes("--repo") &&
      !j.args.includes("--as"),
  );
  const adv = buildEpicBuildingCommands({ featureId: "f-2", provenance: "epic-7" });
  eq("existing id → advance to building (no --as)", adv[0].args, [
    "feature",
    "advance",
    "f-2",
    "--to",
    "building",
  ]);
  eq("no id + no name → nothing", buildEpicBuildingCommands({ provenance: "epic-7" }), []);
}

// ── AC6: merge WITH a prepared delta applies it deterministically (stub wg) ────────
console.log("== AC6: merge WITH prepared delta → applies (source=merge:#N) + ships, no agent ==");
{
  const log = resolve(WORKDIR, "calls-ac6.log");
  const view = {
    evidence: [
      { summary: "ran tests: 12 passed" },
      {
        summary: encodeDigestDelta({
          repo: "demo",
          sections: [{ section: "overview", content: "adds /login route" }],
          feature: { name: "Login", summary: "OAuth", provenance: "epic-1" },
        }),
      },
    ],
  };
  const { out } = runApply({ ticket: 99, repo: "demo", view }, log);
  assert("applied", out && out.applied === true);
  assert("recognised as prepared", out && out.prepared === true);
  const calls = readCalls(log);
  const digestCall = calls.find((c) => c[0] === "digest" && c[1] === "set");
  assert("a memory-CLI `digest set` ran (not `wg digest update`)", Boolean(digestCall));
  assert(
    "digest stamped source=merge:#99",
    digestCall && digestCall.join(" ").includes("--source merge:#99"),
  );
  const featCall = calls.find((c) => c[0] === "feature" && c[1] === "add" && c.includes("shipped"));
  assert("a memory-CLI `feature add … shipped` ran", Boolean(featCall));
  // No `ticket show` other than the single read; certainly no `claude` involved.
  const shows = calls.filter((c) => c[0] === "ticket" && c[1] === "show");
  assert("exactly one ticket-show read", shows.length === 1);
}

// ── AC7: merge WITHOUT a prepared delta → minimal fallback ─────────────────────────
console.log("== AC7: merge WITHOUT prepared delta → minimal freshness stamp ==");
{
  const log = resolve(WORKDIR, "calls-ac7.log");
  const view = { evidence: [{ summary: "ordinary diff_summary note, no delta" }] };
  const { out } = runApply({ ticket: 100, repo: "demo", view }, log);
  assert("applied", out && out.applied === true);
  assert("NOT prepared (fell back)", out && out.prepared === false);
  const calls = readCalls(log);
  const touch = calls.find((c) => c[0] === "digest" && c[1] === "touch");
  assert("minimal `wg digest touch` ran", Boolean(touch));
  assert(
    "touch stamps source=merge:#100",
    touch && touch.join(" ").includes("--source merge:#100"),
  );
  // No feature job (no linked id known in the fallback).
  assert("no feature write without a linked id", !calls.some((c) => c[0] === "feature"));
}

// ── AC8: a Dispatch-write FAILURE is swallowed ───────────────────────────────────
console.log("== AC8: a Dispatch-write failure is swallowed (never throws/fails) ==");
{
  const log = resolve(WORKDIR, "calls-ac8.log");
  const view = {
    evidence: [
      { summary: encodeDigestDelta({ repo: "demo", sections: [{ section: "x", content: "y" }] }) },
    ],
  };
  // WG_EXIT=1 makes every stub call fail; readTicketView returns the planted view BEFORE
  // exit code matters (it prints then exits 0 for `ticket show`), but the write jobs fail.
  const { code, out } = runApply({ ticket: 101, repo: "demo", view, wgExit: 1 }, log);
  // The driver process must still exit 0 — apply swallowed the failures.
  assert("driver exited 0 (no throw)", code === 0);
  assert(
    "applied:true but jobs marked not-ok",
    out && out.applied === true && out.jobs.every((j) => j.ok === false),
  );
}

// ── AC9: GAFFER_DIGEST_DISABLE short-circuits ──────────────────────────────────────
console.log("== AC9: GAFFER_DIGEST_DISABLE=1 short-circuits (no writes) ==");
{
  const prev = process.env.GAFFER_DIGEST_DISABLE;
  process.env.GAFFER_DIGEST_DISABLE = "1";
  const r = applyDigestAndFeature({ ticketNumber: 1, repo: "demo" });
  if (prev === undefined) delete process.env.GAFFER_DIGEST_DISABLE;
  else process.env.GAFFER_DIGEST_DISABLE = prev;
  assert("skipped, not applied", r.applied === false && r.skipped === "GAFFER_DIGEST_DISABLE=1");
}

// ── AC10: brownfield epic-feature CLI ─────────────────────────────────────────────
console.log("== AC10: brownfield epic-feature CLI yields a building feature ==");
{
  const log = resolve(WORKDIR, "calls-ac10.log");
  const run = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [EPIC, ...args], {
      encoding: "utf8",
      env: { ...process.env, MEMORY_CLI: STUB, WG_LOG: log, ...extraEnv },
    });

  // dry-run: prints argv, runs nothing.
  const dry = run([
    "--repo",
    "demo",
    "--epic",
    "epic-7",
    "--name",
    "Search",
    "--summary",
    "fts",
    "--dry-run",
  ]);
  let dout = null;
  try {
    dout = JSON.parse(dry.stdout);
  } catch {
    /* */
  }
  assert("dry-run exit 0", dry.status === 0);
  assert("dry-run phase", dout && dout.phase === "dry-run");
  assert("dry-run plans add_feature(building)", dout && dout.jobs[0].args.includes("building"));
  assert("dry-run wrote NO calls", !existsSync(log));

  // live add: a new building feature.
  const add = run(["--repo", "demo", "--epic", "epic-7", "--name", "Search", "--summary", "fts"]);
  let aout = null;
  try {
    aout = JSON.parse(add.stdout);
  } catch {
    /* */
  }
  assert("live add exit 0", add.status === 0 && aout && aout.phase === "building");
  const calls = readCalls(log);
  const addCall = calls.find((c) => c[0] === "feature" && c[1] === "add");
  assert(
    "ran feature add building w/ epic provenance",
    addCall && addCall.includes("building") && addCall.includes("epic-7"),
  );

  // live advance: an existing backlog feature → building.
  rmSync(log, { force: true });
  const adv = run(["--epic", "epic-7", "--feature-id", "f-3"]);
  let avout = null;
  try {
    avout = JSON.parse(adv.stdout);
  } catch {
    /* */
  }
  assert("advance exit 0", adv.status === 0 && avout && avout.phase === "building");
  const advCalls = readCalls(log);
  eq("advanced f-3 → building (no --as)", advCalls[0], [
    "feature",
    "advance",
    "f-3",
    "--to",
    "building",
  ]);

  // nothing resolvable → noop, exit 0 (not an error).
  rmSync(log, { force: true });
  const noop = run(["--epic", "epic-7"]);
  let nout = null;
  try {
    nout = JSON.parse(noop.stdout);
  } catch {
    /* */
  }
  assert("noop when nothing to do", noop.status === 0 && nout && nout.phase === "noop");

  // missing --epic → usage error exit 1.
  const err = run(["--repo", "demo", "--name", "x"]);
  let eout = null;
  try {
    eout = JSON.parse(err.stdout);
  } catch {
    /* */
  }
  assert("missing --epic → exit 1 error", err.status === 1 && eout && eout.phase === "error");
}

// ── constants sanity ──────────────────────────────────────────────────────────────
console.log("== sanity: lifecycle constants + mergeSource ==");
{
  eq(
    "statuses",
    [FEATURE_STATUS.BACKLOG, FEATURE_STATUS.BUILDING, FEATURE_STATUS.SHIPPED],
    ["backlog", "building", "shipped"],
  );
  eq("mergeSource", mergeSource(7), "merge:#7");
}

try {
  rmSync(WORKDIR, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (lib: ${LIB})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
