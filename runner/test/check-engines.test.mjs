// scripts/check-engines.mjs — the Node engine floor guard. Pins:
//   1 the range evaluator agrees with npm semantics on the forms lockfiles use
//     (>=, ^, ~, <, x-ranges, partial versions, "> = 1" spacing, AND, ||);
//   2 minVersion of a root range is its lowest admitted version;
//   3 the REAL repo passes: every locked engines.node admits the root floor
//     (lint-staged 17 needs >=22.22.1; the root used to declare >=22, so the
//     documented floor could not install under engine-strict);
//   4 the guard FAILS, naming the package, when the root floor sits below a
//     locked package's floor (a temp copy with engines.node ">=22");
//   5 --runtime refuses a Node below the root floor with the version + a fix.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-engines.mjs");
const { satisfies, minVersion, lockEngines, engineConflicts } = await import(SCRIPT);

test("satisfies() follows npm range semantics", () => {
  const cases = [
    ["22.22.0", ">=22.22.1", false],
    ["22.22.1", ">=22.22.1", true],
    ["22.0.0", "^20.19.0 || ^22.12.0 || >=24.0.0", false],
    ["22.13.0", "^20.19.0 || ^22.13.0 || >=24", true],
    ["23.1.0", "^20.19.0 || ^22.13.0 || >=24", false],
    ["24.0.0", "^20.19.0 || ^22.13.0 || >=24", true],
    ["22.0.0", ">= 0.4", true],
    ["22.0.0", ">=16 || 14 >=14.17", true],
    ["22.0.0", ">=v12.22.7", true],
    ["21.9.9", "<22", true],
    ["22.0.0", "<22", false],
    ["22.4.9", "~22.4", true],
    ["22.5.0", "~22.4", false],
    ["22.9.0", "22", true],
    ["23.0.0", "22.x", false],
    ["v22.22.1", "*", true],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} vs "${r}"`);
});

test("minVersion() is the lowest admitted version", () => {
  assert.equal(minVersion(">=22"), "22.0.0");
  assert.equal(minVersion(">=22.22.1"), "22.22.1");
  assert.equal(minVersion("^22.22.1 || >=24"), "22.22.1");
});

test("the repo's root floor admits every locked engines.node", () => {
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /every locked engines\.node admits Node/);
  const locked = lockEngines(readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8"));
  assert.ok(locked.length > 50, `parsed the lockfile's engines (${locked.length})`);
});

test("a root floor below a locked package's floor fails, naming the package", () => {
  const lock = readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8");
  const { floor, conflicts } = engineConflicts(">=22", lock);
  assert.equal(floor, "22.0.0");
  assert.ok(
    conflicts.some((c) => c.pkg.startsWith("lint-staged@")),
    "lint-staged is named as excluding 22.0.0",
  );
  const dir = mkdtempSync(path.join(tmpdir(), "check-engines-"));
  try {
    writeFileSync(path.join(dir, "package.json"), '{"engines":{"node":">=22"}}');
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), lock);
    const r = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lint-staged@[\d.]+ {2}engines\.node ">=22\.22\.1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--runtime refuses a Node below the root floor", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-engines-rt-"));
  try {
    writeFileSync(path.join(dir, "package.json"), '{"engines":{"node":">=99.0.0"}}');
    const r = spawnSync(process.execPath, [SCRIPT, "--runtime", "--root", dir], {
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`Node ${process.version} is below Gaffer's floor`), r.stderr);
    assert.match(r.stderr, /nvm install 22/);
    writeFileSync(path.join(dir, "package.json"), '{"engines":{"node":">=18"}}');
    const ok = spawnSync(process.execPath, [SCRIPT, "--runtime", "--root", dir]);
    assert.equal(ok.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
