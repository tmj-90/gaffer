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
  "$G merge 3",
  "$X principal create bot",
  "$P plan --yes",
  "declare -x W=wg; $W ticket approve 3",
  "readonly W=wg; $W ticket approve 3",
  "node --eval \"require('child_process').execSync('wg ticket approve 3')\"",
  "perl -le 'system(\"wg ticket approve 3\")'",
  "xargs --max-args 1 wg ticket approve < ids.txt",
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

// (g) the review-comment verbs (review comments A1/A2): a delivery agent never writes,
// resolves, reopens or withdraws its reviewer's comments, and never sends a change back
// with them. A bare `wg` in an agent shell acts as the person running the factory, so the
// hook is what keeps a "resolved" from being the agent's own word.
for (const cmd of [
  "wg review comment 3 --body 'looks fine' --must-fix",
  "wg review comments 3",
  "wg review resolve 1a2b3c4d",
  "wg review reopen-comment 1a2b3c4d",
  "wg review withdraw-comment 1a2b3c4d",
  "wg review fix 3",
  "dispatch review resolve 1a2b3c4d",
  "node packages/dispatch/dist/cli/index.js review resolve 1a2b3c4d",
  "wg 'review' res''olve 1a2b3c4d",
  "W=wg; $W review resolve 1a2b3c4d",
  "$X review resolve 1a2b3c4d",
  "$(which wg) review fix 3",
  "${TOOLS[0]} review comment 3 --body ok",
  "$CMD review withdraw-comment 1a2b3c4d",
  "eval 'wg review resolve 1a2b3c4d'",
]) {
  t.deny(`review-comment verb: ${cmd}`, bash(cmd), opts);
}

// (h) the escaped-defect link (MF5) and the review-rule proposal (D6): a person's acts.
for (const cmd of [
  "wg ticket regression-of 7 --of 5",
  "wg ticket regression-of 7 --of 5 --withdraw",
  "dispatch ticket regression-of 7 --of 5",
  "node packages/dispatch/dist/cli/index.js ticket regression-of 7 --of 5",
  "wg ticket 'regression-of' 7 --of 5",
  "wg ticket regr''ession-of 7 --of 5",
  "wg ticket regression\\-of 7 --of 5",
  "W=wg; $W ticket regression-of 7 --of 5",
  "$X ticket regression-of 7 --of 5",
  "$(which wg) ticket regression-of 7 --of 5 --withdraw",
  "eval 'wg ticket regression-of 7 --of 5'",
  "bash -c 'wg ticket regression-of 7 --of 5'",
  "wg --db x.sqlite ticket regression-of 7 --of 5",
  "wg review-rules propose",
  "wg 'review-rules' prop''ose",
  "$X review-rules propose",
  "dispatch review-rules propose --repo app",
]) {
  t.deny(`human-only measure verb: ${cmd}`, bash(cmd), opts);
}

// (i) a verb the command text does not show (lane-hook R2): built at run time in the
// verb slot of a privileged CLI, or handed to it by xargs, parallel or find from their
// input. The verb cannot be read, so the hook refuses it, for every control-plane verb.
for (const verb of [
  "approve",
  "tester-pass",
  "tester-route",
  "lane-verdict",
  "regression-of",
  "wont-do",
  "mark-merged",
]) {
  const half = verb.slice(0, 3);
  const tail = verb.slice(3);
  for (const cmd of [
    `echo ${verb} | xargs wg ticket`,
    `echo ${verb} 5 | xargs dispatch ticket`,
    `echo ${verb} | xargs -I{} wg ticket {} 5`,
    `echo ${verb} | xargs -I % wg ticket % 5`,
    `echo ${verb} | xargs -i wg ticket {} 5`,
    `echo ${verb} | xargs --replace=VB wg ticket VB 5`,
    `echo ${verb} | xargs -I{} sh -c "wg ticket {} 5"`,
    `echo ${verb} | xargs sh -c 'wg ticket "$0" 5'`,
    `echo ${verb} | xargs /usr/local/bin/wg ticket`,
    `echo ${verb} | while read v; do wg ticket $v 5; done`,
    `wg ticket ${half}$(printf %s ${tail}) 5`,
    `wg ticket ${half}\`printf %s ${tail}\` 5`,
    `wg ticket "$VERB" 5`,
    `npx wg ticket ${half}$(echo ${tail}) 5`,
    `find ${verb} -maxdepth 0 -exec wg ticket {} 5 \\;`,
    `parallel wg ticket {} 5 ::: ${verb}`,
  ]) {
    t.deny(`verb not in the text: ${cmd}`, bash(cmd), opts);
  }
}
for (const cmd of [
  "echo comment | xargs wg review",
  "echo resolve | xargs -I{} wg review {} 1a2b3c4d",
  "wg review $(printf fix) 3",
  "echo create | xargs wg principal",
  "gaffer $(printf approve) 3",
  "memory $(printf approve) 7vk3qm9b",
  "wg ticket {appr,x}ove 5",
  "wg ticket appr?ve 5",
  "(wg ticket $V 5)",
]) {
  t.deny(`verb not in the text: ${cmd}`, bash(cmd), opts);
}
// Read verbs through xargs, and a runtime word after the verb, stay allowed.
for (const cmd of [
  "cat ids | xargs -n1 wg ticket show",
  "cat ids | xargs wg ticket show",
  "cat ids | xargs -I{} wg ticket show {}",
  "wg ticket show $T",
  'wg --db "$DISPATCH_DB" ticket show 3',
  "for t in 1 2; do wg ticket show $t; done",
  "memory show $ID",
  'git commit -m "wg ticket $V"',
  "grep -rn wg $FILE",
  "fg %1",
]) {
  t.allow(`a read or a runtime operand: ${cmd}`, bash(cmd), opts);
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
  // An unknown program before a common word is not a control-plane command.
  "$GIT merge origin/main",
  "${GIT:-git} merge main",
  "$TF plan",
  "$EDITOR plan",
  "$(npm bin)/prisma migrate resolve",
  "$(which python3) -m pytest -k approve",
  // An unknown program before "resolve" alone (no "review" verb) stays allowed.
  "$PKG resolve lodash",
  'git commit -m "review resolve: comment threads"',
  'git log --grep "regression-of"',
  "grep -rn regression-of docs/",
  "$PKG regression-of lodash",
  // Quoted text keeps its quotes' meaning: no separator inside it starts a command.
  'echo "a | xargs wg"',
  'echo "printenv"',
  'grep -rn "printenv" docs/',
  'echo "env | grep -i token"',
  'eval "$(fnm env)"',
  'eval "$(direnv hook bash)"',
]) {
  t.allow(`a mention, not a command: ${cmd}`, bash(cmd), opts);
}

t.done();
