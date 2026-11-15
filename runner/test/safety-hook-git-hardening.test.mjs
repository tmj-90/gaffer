#!/usr/bin/env node
// The safety hook's own git lookups (lib/hook/reads.mjs: `git add .` secret checks, the
// tracked env-template check) run with the hardening lib/hook/git.mjs already passes:
// -c core.fsmonitor=false -c core.hooksPath=/dev/null. A repository whose config names an
// fsmonitor program must not make the hook run it (sandbox audit, low note).
// Run: node runner/test/safety-hook-git-hardening.test.mjs
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTrackedEnvTemplate, secretBoundaryReason } from "../lib/hook/reads.mjs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

let pass = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fails.push(label);
    console.log(`  FAIL ${label}`);
  }
};

const dir = gafferMkdtemp(join(tmpdir(), "gaffer-hook-git-"));
try {
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  const marker = join(dir, "..", `${dir.split("/").pop()}.fsmonitor-ran`);
  const prog = join(dir, "fsmon.sh");
  writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(prog, 0o755);
  git("config", "core.fsmonitor", prog);
  writeFileSync(join(dir, ".env.example"), "A=1\n");
  git("add", ".env.example");
  // Sanity: a plain `git status` in this repo DOES run the fsmonitor program.
  git("status", "--porcelain");
  const armed = existsSync(marker);
  rmSync(marker, { force: true });
  ok(armed, "the fixture's fsmonitor program runs on a plain git status (the test can see it)");

  secretBoundaryReason("git add .", dir);
  ok(!existsSync(marker), "the hook's `git add .` secret check never runs the repo's fsmonitor");
  rmSync(marker, { force: true });
  isTrackedEnvTemplate(join(dir, ".env.example"));
  ok(!existsSync(marker), "the hook's tracked env-template lookup never runs the repo's fsmonitor");
  rmSync(marker, { force: true });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  fails.length === 0
    ? `safety-hook-git-hardening: ALL ${pass} checks passed`
    : `safety-hook-git-hardening: ${fails.length} FAILED`,
);
process.exit(fails.length === 0 ? 0 : 1);
