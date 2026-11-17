#!/usr/bin/env node
// The directory a relative path is judged in, across shell execution contexts
// (external review 20, lib/hook/cwd-flow.mjs).
//
// The reviewer: change into a read-only directory, run a subshell that changes into the
// write root, then an inline Python write to a relative file name. The subshell does not
// move the parent shell, so the file lands in the read-only directory, yet the hook
// judged the program as running in the write root and allowed it. Skipped conditionals,
// uncalled functions and a `cd` in a pipeline gave the same wrong answer. The analysers
// kept one directory and moved it at every `cd`, whatever context the `cd` ran in.
//
// Now every relative path is judged from EVERY directory the shell may be in when the
// command runs, and the command is allowed only if it is allowed from all of them: a
// `cd` in a subshell, a pipeline, a background job, a conditional or a block only adds
// its directory, a `cd` that may fail leaves both directories, and a loop, function,
// trap or alias that changes directory leaves it unknown.
//
// The commands in test/fixtures/safety-hook-cwd-contexts.json are DATA: each is handed
// to the hook as text and never run. `deny` holds shapes that write (or may write)
// outside the write root, for the inline interpreters and for plain Bash writes;
// `readsDeny` the same for relative reads outside the roots; `allow` the everyday shapes
// that must stay allowed.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { bash, RUNNER_DIR, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-cwd-contexts");
const fixture = JSON.parse(
  readFileSync(resolve(RUNNER_DIR, "test", "fixtures", "safety-hook-cwd-contexts.json"), "utf8"),
);

const base = scratchDir("gaffer-hook-cwd-");
t.cleanup(base);
const W = resolve(base, "work");
const R = resolve(base, "ro");
const O = resolve(base, "outside");
for (const d of [
  W,
  resolve(W, "sub"),
  resolve(W, "sub", "deep"),
  R,
  resolve(R, "rsub"),
  O,
  resolve(O, "osub"),
  resolve(base, "data"),
])
  mkdirSync(d, { recursive: true });
// `cd -P lnk2/..` lands in {O}; the logical `cd lnk2/..` in {W}.
symlinkSync(resolve(O, "osub"), resolve(W, "lnk2"));
writeFileSync(resolve(W, "a"), "a\n");
writeFileSync(resolve(R, "notes.txt"), "r\n");
writeFileSync(resolve(O, "notes.txt"), "o\n");
const opts = {
  env: { GAFFER_WRITE_ROOTS: W, GAFFER_READ_ROOTS: R, GAFFER_DATA: resolve(base, "data") },
  cwd: W,
};
const fill = (cmd) => cmd.replaceAll("{W}", W).replaceAll("{R}", R).replaceAll("{O}", O);

if (fixture.deny.length < 150) t.assert(`deny corpus has ${fixture.deny.length} < 150`, false);
for (const cmd of fixture.deny)
  t.deny(`writes outside: ${cmd.slice(0, 140)}`, bash(fill(cmd)), opts);
for (const cmd of fixture.readsDeny) {
  t.deny(`reads outside: ${cmd.slice(0, 140)}`, bash(fill(cmd)), opts);
}
for (const cmd of fixture.allow)
  t.allow(`stays allowed: ${cmd.slice(0, 140)}`, bash(fill(cmd)), opts);
// The independent review's shapes (see the fixture's note).
for (const cmd of fixture.reviewDeny)
  t.deny(`writes outside (review): ${cmd.slice(0, 140)}`, bash(fill(cmd)), opts);
for (const cmd of fixture.reviewReadsDeny)
  t.deny(`reads outside (review): ${cmd.slice(0, 140)}`, bash(fill(cmd)), opts);
for (const cmd of fixture.reviewAllow)
  t.allow(`stays allowed (review): ${cmd.slice(0, 140)}`, bash(fill(cmd)), opts);

// The reviewer's reproduction, with the reason the agent sees.
{
  const { decide } = await import("../safety-hook-core.mjs");
  const cmd = fill(`cd {R}; (cd {W}); python3 -c 'open("x","w").write("1")'`);
  const full = { env: { ...process.env, ...opts.env }, cwd: W };
  const v = decide(bash(cmd), full);
  t.assert(
    `the subshell reproduction is refused and names the read-only root: ${v.reason ?? "(allowed)"}`,
    !v.allow && /read-only root/.test(v.reason ?? ""),
  );
  // The direct case stays refused.
  const direct = decide(bash(fill(`cd {R}; python3 -c 'open("x","w").write("1")'`)), full);
  t.assert(`the direct cd case stays refused`, !direct.allow);
}

t.done();
