#!/usr/bin/env node
// Tests for the skill-selection telemetry writer (bin/record-skill-usage.mjs):
// it records which skills were SELECTED per delivery and, best-effort, which were
// APPLIED (detected in the agent's output). Run: node test/skill-telemetry.test.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseList,
  detectApplied,
  buildRecord,
  recordFromOpts,
} from "../bin/record-skill-usage.mjs";

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

// --- parseList --------------------------------------------------------------
check("parseList splits comma/space and de-dupes, order preserved", () => {
  eq(
    parseList("run-tests, run-lint ,run-tests\nminimalism"),
    ["run-tests", "run-lint", "minimalism"],
    "list",
  );
  eq(parseList(""), [], "empty");
  eq(parseList(undefined), [], "undefined");
});

// --- detectApplied ----------------------------------------------------------
check("detectApplied marks a selected skill applied when its name appears", () => {
  const applied = detectApplied(
    ["run-tests", "run-lint", "frontend-component"],
    "I used the run-tests skill; frontend-component too.",
  );
  eq(applied, ["run-tests", "frontend-component"], "applied");
});
check("detectApplied is word-boundary safe (no substring false positives)", () => {
  // "run-tests-extra" must NOT match the selected "run-tests".
  eq(detectApplied(["run-tests"], "ran the run-tests-extra helper"), [], "no substring match");
});
check("detectApplied returns [] for empty output", () => {
  eq(detectApplied(["run-tests"], ""), [], "empty output");
});

// --- buildRecord ------------------------------------------------------------
check("buildRecord captures selected/applied/count and an ISO ts", () => {
  const r = buildRecord({
    ticket: "42",
    role: "delivery",
    stack: "typescript",
    selected: ["a", "b"],
    applied: ["a"],
  });
  eq(r.selected, ["a", "b"], "selected");
  eq(r.applied, ["a"], "applied");
  eq(r.count, 2, "count");
  eq(r.ticket, "42", "ticket");
  assert(!Number.isNaN(Date.parse(r.ts)), "ts is a valid date");
});

// --- recordFromOpts (with scan-file applied detection) ----------------------
check("recordFromOpts reads --scan and unions explicit + scanned applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-"));
  try {
    const scan = join(dir, "out.json");
    writeFileSync(
      scan,
      JSON.stringify({ result: "used run-tests then the record-evidence skill" }),
    );
    const rec = recordFromOpts({
      ticket: "7",
      role: "delivery",
      stack: "typescript",
      selected: "run-tests, run-lint, record-evidence",
      applied: "run-lint",
      scan,
    });
    eq(rec.selected, ["run-tests", "run-lint", "record-evidence"], "selected recorded");
    // explicit run-lint + scanned run-tests + record-evidence (both in text)
    eq(rec.applied, ["run-lint", "run-tests", "record-evidence"], "applied union");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("recordFromOpts tolerates a missing scan file (fail-soft)", () => {
  const rec = recordFromOpts({ selected: "run-tests", scan: "/no/such/file.json" });
  eq(rec.selected, ["run-tests"], "selected still recorded");
  eq(rec.applied, [], "applied empty when scan unreadable");
});

// --- end-to-end CLI append --------------------------------------------------
check("CLI appends one JSONL record per delivery to --out", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-telem-cli-"));
  try {
    const out = join(dir, "telemetry.jsonl");
    const bin = new URL("../bin/record-skill-usage.mjs", import.meta.url).pathname;
    const run = (selected) =>
      spawnSync(
        process.execPath,
        [
          bin,
          "--ticket",
          "1",
          "--role",
          "delivery",
          "--stack",
          "ts",
          "--selected",
          selected,
          "--out",
          out,
        ],
        { encoding: "utf8" },
      );
    run("run-tests, minimalism");
    run("run-lint");
    const lines = readFileSync(out, "utf8").trim().split("\n");
    eq(lines.length, 2, "two records appended");
    const first = JSON.parse(lines[0]);
    eq(first.selected, ["run-tests", "minimalism"], "first record's selected");
    eq(first.role, "delivery", "role recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`skill-telemetry: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`skill-telemetry: ${passed} passed`);
