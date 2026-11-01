#!/usr/bin/env node
// Factory front door: a delivery agent must not run the factory's own entry points —
// `runner/gaffer approve` records a HUMAN approval, `gaffer merge` /
// `bin/merge-ticket.mjs` land a branch, tick/loop spawn agents. The hook refuses
// executing or sourcing any file inside its own RUNNER_DIR (and package dist/), and
// the path-less forms are deny-listed. Branch names and commit messages that merely
// contain the word `gaffer` stay allowed.
// Run: node test/safety-hook-front-door.test.mjs
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { bash, RUNNER_DIR, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-front-door");
const ROOT = scratchDir("gaffer-front-door-");
t.cleanup(ROOT);
mkdirSync(`${ROOT}/runner/test`, { recursive: true });
const opts = { env: { GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };
const R = RUNNER_DIR;
const PKG = `${R}/../packages`;

for (const cmd of [
  `node ${R}/bin/merge-ticket.mjs --ticket 3`,
  `${R}/gaffer merge 3`,
  `${R}/gaffer approve 3`,
  `cd ${R} && ./gaffer approve 1`,
  `bash ${R}/gaffer approve 3 --reviewer me`,
  `${R}/gaffer run`,
  `${R}/gaffer wg review approve 3`,
  `node ${R}/bin/tester-run.mjs`,
  `node ${R}/bin/product-owner-run.mjs`,
  `bash ${R}/tick.sh`,
  `setsid ${R}/loop.sh`,
  `bash ${R}/bin/poll-once.sh`,
  `source ${R}/factory.config.sh`,
  `. ${R}/factory.config.sh`,
  `(sleep 900; ${R}/gaffer approve 3) &`,
  `nohup sh -c 'sleep 900; ${R}/gaffer merge 3' &`,
  `env -u GAFFER_WRITE_ROOTS ${R}/gaffer approve 3`,
  `exec node ${R}/bin/merge-ticket.mjs --ticket 3`,
  `node ${PKG}/dispatch/dist/api/bin.js`,
  "gaffer approve 3",
  "gaffer merge 3",
  // Planning a build and ratifying lore are the human's (README "What still needs
  // you"): an agent can neither pay for a planner turn, create an epic, nor approve or
  // reject a lore draft from the front door, however it is spelled.
  'gaffer plan "a task app" --yes',
  "gaffer plan --yes",
  'gaffer plan --answer "web" --yes',
  "gaffer plan --now",
  'gaffer plan "a task app"',
  "gaffer lore approve 7vk3qm9b",
  'gaffer lore reject 7vk3qm9b --reason "noise"',
  "gaffer lore review",
  `${R}/gaffer plan --yes`,
  `bash ${R}/gaffer lore approve 7vk3qm9b`,
  `cd ${R} && ./gaffer lore approve 7vk3qm9b`,
  "bash runner/gaffer plan --yes",
  "sh ./gaffer lore approve 7vk3qm9b",
  `node ${R}/bin/plan-run.mjs --yes`,
  "node bin/plan-run.mjs --yes",
  "cd runner/bin && node plan-run.mjs --now --yes",
  `MEMORY_DB=x node ${PKG}/memory/dist/bin/memory.js approve 7vk3qm9b`,
  "node ../gaffer/runner/bin/merge-ticket.mjs --ticket 3",
  // A path-qualified wrapper or interpreter, an option's value before the script,
  // `builtin`, and launchers that run the script for you.
  `/usr/bin/env ${R}/gaffer approve 3`,
  `bash -o pipefail ${R}/gaffer approve 3`,
  `/bin/bash ${R}/tick.sh`,
  `/bin/bash ${R}/loop.sh`,
  `/bin/bash ${R}/worker.sh`,
  `/usr/bin/env bash ${R}/tick.sh`,
  `cd ${R} && /bin/bash ./tick.sh`,
  `builtin source ${R}/factory.config.sh`,
  `builtin . ${R}/factory.config.sh`,
  `timeout -s KILL 900 ${R}/tick.sh`,
  `exec -a worker ${R}/tick.sh`,
  `find . -maxdepth 0 -exec ${R}/tick.sh {} +`,
  `find . -maxdepth 0 -execdir ${R}/tick.sh {} \\;`,
  `echo 3 | xargs -n 1 ${R}/gaffer approve`,
  `echo 3 | xargs -I{} /bin/bash ${R}/tick.sh {}`,
  `watch -n 60 ${R}/tick.sh`,
  `perl -e 'system("${R}/gaffer approve 3")'`,
  `node -e "require('child_process').execSync('${R}/tick.sh')"`,
  `python3 -c 'import os; os.system("${R}/loop.sh")'`,
]) {
  t.deny(`front door: ${cmd}`, bash(cmd), opts);
}

for (const cmd of [
  "git merge gaffer/ticket-5-add-run-flag",
  'git commit -m "gaffer: run tests"',
  "git checkout -b gaffer/ticket-7-approve-flow",
  'grep -rn "gaffer approve" docs',
  'grep -rn "gaffer plan --yes" README.md',
  'git commit -m "gaffer: plan the lore docs"',
  "git checkout -b gaffer/ticket-9-lore-approve",
  "node runner/test/x.test.mjs",
  "bash runner/test/x.test.sh",
  "node scripts/build.mjs",
  "bash -o pipefail runner/test/x.test.sh",
  "/bin/bash scripts/x.sh",
  "/usr/bin/env node scripts/build.mjs",
  "find . -name '*.ts' -exec grep -l foo {} +",
  "echo a | xargs -n 1 echo",
  'node -e "console.log(process.version)"',
  "timeout -s KILL 60 node runner/test/x.test.mjs",
]) {
  t.allow(`not the front door: ${cmd}`, bash(cmd), opts);
}

// The default install puts the factory under HOME (`~/gaffer`), so `cd ~/gaffer/runner
// && bash tick.sh` must resolve exactly like the absolute form. HOME here is the
// factory's parent dir, as on an operator's machine.
const FACTORY = dirname(R);
const homeOpts = {
  env: { HOME: dirname(FACTORY), GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" },
  cwd: ROOT,
};
const TR = `~/${basename(FACTORY)}/runner`;
for (const cmd of [
  `cd ${TR} && bash tick.sh`,
  `cd ${TR} && ./loop.sh`,
  `cd ${TR}/bin && node merge-ticket.mjs --ticket 3`,
  `cd ~/${basename(FACTORY)}/packages/dispatch && node dist/cli/index.js review approve 3`,
  `cd ~/${basename(FACTORY)} && ./runner/gaffer approve 3`,
  `bash ${TR}/tick.sh`,
]) {
  t.deny(`front door under HOME: ${cmd}`, bash(cmd), homeOpts);
}

// Indirection in the same command: a shell variable holding the path is filled in,
// and when the command names factory code at all, an execution the hook cannot
// resolve (an fd, stdin, eval, xargs, a still-unknown `$X`) fails closed.
for (const cmd of [
  `G=${R}/gaffer; $G approve 3`,
  `G=${R}/gaffer && "\${G}" approve 3`,
  `export G=${R}/gaffer; $G approve 3`,
  `D=${R}; bash $D/tick.sh`,
  `G=${R}/gaffer; sh -c "$G approve 3"`,
  `G=${R}/gaffer; X=$G; $X approve 3`,
  `exec 3<${R}/gaffer; bash /dev/fd/3 approve 3`,
  `busybox sh ${R}/gaffer approve 3`,
  `cat ${R}/gaffer | bash -s approve 3`,
  `cat ${R}/tick.sh | sh`,
  `eval "${R}/gaffer approve 3"`,
  `echo ${R}/gaffer | xargs -I{} bash {} approve 3`,
  `G=$(ls ${R}/gaffer); $G approve 3`,
  `bash<${R}/tick.sh`,
]) {
  t.deny(`front door via indirection: ${cmd}`, bash(cmd), opts);
}
for (const cmd of [
  "G=runner/test/x.test.sh; bash $G",
  "S=scripts/build.mjs; node $S",
  "cat runner/test/x.sh | bash",
  `cat ${R}/README.md`,
  `grep -n approve ${R}/gaffer`,
]) {
  t.allow(`indirection without the factory's code: ${cmd}`, bash(cmd), {
    env: { GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: R },
    cwd: ROOT,
  });
}

t.done();
