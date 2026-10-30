#!/usr/bin/env node
// Factory front door: a delivery agent must not run the factory's own entry points —
// `runner/gaffer approve` records a HUMAN approval, `gaffer merge` /
// `bin/merge-ticket.mjs` land a branch, tick/loop spawn agents. The hook refuses
// executing or sourcing any file inside its own RUNNER_DIR (and package dist/), and
// the path-less forms are deny-listed. Branch names and commit messages that merely
// contain the word `gaffer` stay allowed.
// Run: node test/safety-hook-front-door.test.mjs
import { mkdirSync } from "node:fs";
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

t.done();
