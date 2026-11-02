#!/usr/bin/env node
// Spelling normalisation: the deny list matches command NAMES, and a shell runs the
// same program whatever the spelling. Every refusal here was found by a code review
// slipping past rules that matched the raw text only; each must now be refused,
// while text that only mentions a command (a commit message, a grep pattern, an echo
// argument, a file name) stays allowed. Run: node test/safety-hook-spelling.test.mjs
import { mkdirSync } from "node:fs";
import { bash, RUNNER_DIR, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-spelling");
const ROOT = scratchDir("gaffer-spelling-");
t.cleanup(ROOT);
mkdirSync(`${ROOT}/docs`, { recursive: true });
const opts = { env: { GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };
const R = RUNNER_DIR;

// (a) a program or verb name split or escaped with quotes and backslashes
for (const cmd of [
  "wg 'principal' create bot",
  'wg "principal" "create" bot',
  "wg principal cr''eate bot",
  "wg princip\\al create bot",
  "w\\g principal create bot",
  "'wg' ticket approve 3",
  'wg ticket "eval"-score 3 --file r.json',
  "wg ticket ci-res''ult 3 --commit abc --status pass",
  "wg decisions 'resolve' 2 --answer yes",
  "wg agent re\\name a1 --name Striker",
  "wg club 'set' --name Rovers",
  "\\gaffer plan --yes",
  "'gaffer' lore approve 7vk3qm9b",
  "gaffer appro\\ve 3",
  "memory 'approve' 7vk3qm9b",
]) {
  t.deny(`quoted or escaped spelling: ${cmd}`, bash(cmd), opts);
}

// (b) the program name through a variable the same command assigns
for (const cmd of [
  "x=wg; $x principal create bot",
  "W=wg; $W ticket approve 3",
  "export G=gaffer; $G plan --yes",
  "M=memory; ${M} approve 7vk3qm9b",
  "C=wg; A=approve; $C ticket $A 3",
]) {
  t.deny(`same-command variable: ${cmd}`, bash(cmd), opts);
}

// (c) wrappers, xargs and nested shells
for (const cmd of [
  "xargs wg < args.txt",
  "printf 'principal create x' | xargs wg",
  "echo 3 | xargs -n 1 wg ticket approve",
  "env A=1 command wg principal create bot",
  "nice -n 5 wg ticket wont-do 3 --reason dup",
  "eval 'wg ticket approve 3'",
  "eval w''g\\ ticket\\ approve\\ 3",
  "bash -c \"w''g ticket approve 3\"",
  "sh -c 'x=wg; $x principal revoke alice'",
  "echo d2cgcHJpbmNpcGFsIGNyZWF0ZSB4 | base64 -d | sh",
  "echo d2cgcHJpbmNpcGFsIGNyZWF0ZSB4 | base64 --decode | bash",
  "printf x | xxd -r -p | sh",
]) {
  t.deny(`wrapper or nested shell: ${cmd}`, bash(cmd), opts);
}

// (d) inline interpreters whose body runs a privileged CLI
for (const cmd of [
  "node -e \"require('child_process').execSync('wg ticket approve 3')\"",
  "node -e \"require('child_process').execSync('gaffer plan --yes')\"",
  "python3 -c \"import subprocess; subprocess.run(['wg','ticket','approve','3'])\"",
  "python3 -c 'import os; os.system(\"memory approve 7vk3qm9b\")'",
  'perl -e \'system("wg", "ticket", "mark-merged", "3")\'',
  "ruby -e 'system(\"gaffer lore approve 7vk3qm9b\")'",
]) {
  t.deny(`inline interpreter body: ${cmd}`, bash(cmd), opts);
}

// (e) a privileged CLI reached by path, or a name the hook cannot see
for (const cmd of [
  "node packages/dispatch/dist/cli/index.js ticket wont-do 3",
  "node ../packages/dispatch/dist/cli/index.js principal create bot",
  "$(which wg) ticket approve 3",
  "$(echo wg) principal create bot",
  "`echo wg` ticket approve 3",
  "$CMD ticket approve 3",
  "${TOOLS[0]} ticket ci-result 3 --status pass",
  `$(command -v ${R}/gaffer) approve 3`,
]) {
  t.deny(`path or runtime-built name: ${cmd}`, bash(cmd), opts);
}

// (f) wont-do is a person's call, like approve
for (const cmd of [
  "wg ticket wont-do 3 --reason dup",
  "dispatch ticket wont-do 3",
  "fg ticket wont-do 3",
]) {
  t.deny(`wont-do: ${cmd}`, bash(cmd), opts);
}

// Text that only mentions a command is not a command. Nothing here may be refused.
// (A quoted "wg … approve" in one segment was already refused by the raw rule before
// this file existed; that is unchanged and not pinned here.)
for (const cmd of [
  'git commit -m "fix: the principal create form"',
  "git log --grep approve",
  "git checkout -b gaffer/ticket-12-approve-copy",
  'grep -rn "principal create" docs/',
  "cat docs/approve.md",
  "node test/approve.test.js",
  'echo "approve"',
  'eval "$(ssh-agent -s)"',
  "eval 'echo gaffer plan'",
  "X=docs; cat $X/approve.md",
  "V=approve; echo $V",
  "echo a | xargs -n 1 echo",
  "find . -name '*.ts' -exec grep -l approve {} +",
  "node -e \"console.log('approve')\"",
  "python3 -c 'print(\"approve\")'",
  "wg ticket show 3",
  "wg ticket list --json",
  "memory show 7vk3qm9b",
  "memory search approve",
  "echo aGk= | base64 -d > note.txt",
  "echo aGk= | base64 -d",
  "cat note.txt.gz | gunzip | grep approve",
  'grep -E "base64|sh" notes.txt',
  "rg 'zcat|bash' scripts/",
  "grep -c 'xz|zsh' notes.txt",
  "$EDITOR docs/approve.md",
  "$(which node) test/approve.test.js",
]) {
  t.allow(`a mention, not a command: ${cmd}`, bash(cmd), opts);
}

t.done();
