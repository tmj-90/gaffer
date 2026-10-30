#!/usr/bin/env node
// Catastrophic backtracking in the command-position prefix (CMD_POS).
// A wrapper's valued option (`nice -n 5`, `timeout -s KILL 5`) used to accept ANY word
// as its value, so `-n nice` read both as option+value and as flag + the next wrapper:
// every repeated pair doubled the work of a failed match. ~25 `nice -n` pairs ran the
// hook for minutes, past Claude Code's hook timeout, which (without onFailure: block)
// lets the tool run unchecked. This pins:
//   • every deny rule evaluates 40 repeated wrapper pairs in well under a second;
//   • the whole hook answers them (still denying `gh auth token`) in < 1s beyond its
//     own start-up cost;
//   • the inline-interpreter DB rule, which retried every later `-c` / `<<` (cubic:
//     42s for the whole hook on 26KB of `bun -c --yes`), stays fast on long input;
//   • the prefix still sees through real valued options (`nice -n 5 gh …`).
// Run: node test/safety-hook-redos.test.mjs
import { spawnSync } from "node:child_process";

import { HOOK, bash, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-redos");
const ROOT = scratchDir("gaffer-redos-root-");
const HOME = scratchDir("gaffer-redos-home-");
for (const d of [ROOT, HOME]) t.cleanup(d);
const opts = { env: { HOME, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };

const N = 40;
const inputs = {
  "nice -n nice": `nice ${"-n nice ".repeat(N)}`,
  "nice -n /usr/bin/nice": `nice ${"-n /usr/bin/nice ".repeat(N)}`,
  "env -u env": `env ${"-u env ".repeat(N)}`,
  "env -i": "env -i ".repeat(N),
  "timeout -s timeout": `timeout ${"-s timeout ".repeat(N)}`,
  "mixed wrappers": "env -i nice -n 5 timeout -s KILL 5 ".repeat(N),
  "yarn --prod workspace": `yarn ${"--prod workspace ".repeat(N)}`,
  "yarn --cwd": `yarn ${"--cwd --cwd x ".repeat(N)}`,
};
// Long-input cases for polynomial (not exponential) blow-ups: rule level only.
const longInputs = {
  "2048x bun -c --yes": `yarn ${"bun -c --yes ".repeat(2048)}`,
  "2048x node <<": `node ${"x << ".repeat(2048)}`,
};

// Rule level: a failed match (`zz` is no command) is where backtracking explodes.
// Timed in a child process with a hard kill, so a regression reports instead of
// hanging the suite (the exponential form never finishes at N=40).
const RULES = new URL("../lib/dangerous-commands.mjs", import.meta.url).href;
for (const [label, prefix] of Object.entries({ ...inputs, ...longInputs })) {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { DANGEROUS_COMMANDS } = await import(${JSON.stringify(RULES)});
       const s = ${JSON.stringify(`${prefix}zz build`)};
       const start = performance.now();
       for (const rule of DANGEROUS_COMMANDS) rule.re.test(s);
       console.log(Math.round(performance.now() - start));`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const ms = res.status === 0 ? Number(res.stdout.trim()) : Infinity;
  t.assert(`all deny rules on "${label}" finish in < 1s (took ${ms}ms)`, ms < 1000);
}

// Whole hook: a spawned process with a hard kill, so a regression reports instead of
// hanging the suite. Each pathological command must cost < 1s MORE than the slowest
// of a few trivial calls (node start-up and module load, which vary by host); the
// exponential form took minutes.
const timed = (command) => {
  const start = Date.now();
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(bash(command)),
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: res.status, ms: Date.now() - start };
};
const baseline = Math.max(...[1, 2, 3].map(() => timed("echo hi").ms));
for (const [label, prefix] of Object.entries(inputs)) {
  for (const [tail, want] of [
    ["gh auth token", 2],
    ["echo hi", 0],
  ]) {
    if (label.startsWith("yarn")) continue;
    const { status, ms } = timed(`${prefix}${tail}`);
    t.assert(
      `hook answers ${N}x "${label}" + ${tail} with exit ${want} in < 1s over start-up (exit ${status}, ${ms}ms, start-up ${baseline}ms)`,
      status === want && ms - baseline < 1000,
    );
  }
}

// The unambiguous value still lets real valued options through to the command.
for (const cmd of [
  "nice -n 5 gh auth token",
  "timeout -s KILL 5 gh auth token",
  "/usr/bin/nice -n 5 pnpm add evil",
  "env -u FOO nice -n 5 gh auth token",
  "nice -n nice gh auth token",
]) {
  t.deny(`valued wrapper option: ${cmd}`, bash(cmd), opts);
}
t.allow("valued wrapper option before a harmless command", bash("nice -n 5 echo hi"), opts);

t.done();
