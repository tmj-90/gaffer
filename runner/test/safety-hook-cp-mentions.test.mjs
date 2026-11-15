#!/usr/bin/env node
// The control-plane rule and plain mentions (F2 of the 2026-11 hook audit). The rule
// matched `wg|dispatch|fg|crew` and a control-plane verb anywhere on a line, so a commit
// message, a grep pattern or a note that only named them was refused. A command proven to
// be data only (lib/hook/control-plane.mjs controlPlaneDataOnly) is now judged by the
// rule's command-position form; every other command, every evasion included, by the full
// rule. Running stored text as a command (`$(git log -1 --format=%s)`) is refused, since a
// commit message may now hold a CLI's words.
// Run: node test/safety-hook-cp-mentions.test.mjs
import { bash, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-cp-mentions");
const ROOT = scratchDir("gaffer-cp-mentions-");
const DATA = scratchDir("gaffer-cp-mentions-data-");
t.cleanup(ROOT);
t.cleanup(DATA);
const PROFILES = {
  roots: { GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "", GAFFER_DATA: DATA },
  bootstrap: {
    GAFFER_WRITE_ROOTS: ROOT,
    GAFFER_READ_ROOTS: "",
    GAFFER_DATA: DATA,
    GAFFER_BOOTSTRAP_INSTALL: "1",
    GAFFER_BOOTSTRAP_DIR: ROOT,
  },
  open: { GAFFER_WRITE_ROOTS: "", GAFFER_READ_ROOTS: "", GAFFER_DATA: DATA },
};
const each = (kind, cmd) => {
  for (const [p, env] of Object.entries(PROFILES)) {
    t[kind](`[${p}] ${cmd}`, bash(cmd), { env, cwd: ROOT });
  }
};

// Plain mentions: data only, allowed.
for (const cmd of [
  'git commit -m "dispatch: reject bad events"',
  'grep -rn "dispatch.*approve" src',
  'echo "fg then approve" > notes.txt',
  "git commit -m 'fix: the crew lane renders'",
  'git commit -am "dispatch: approve path keeps its pin"',
  "rg -n 'wg ticket approve' docs",
  'grep -rn "wg approve" docs && git status',
  'printf "%s" "dispatch then reject" >> notes.txt',
  "echo 'wg approve' >> notes.txt",
]) {
  each("allow", cmd);
}

// Evasions: every one stays denied in every profile.
const V = "approve";
for (const cmd of [
  // the brief's list
  "echo 'wg approve 1' | sh",
  'sh <<< "wg approve 1"',
  'eval "$(echo wg approve 1)"',
  "git commit -m x; wg approve 1",
  "git -c alias.x='!wg approve 1' x",
  "echo wg approve 1 > run.sh && sh run.sh",
  'git commit -m "x\nwg approve 1"',
  "git commit -m x\nwg approve 1",
  "$(git log -1 --format=%s)",
  "`git log -1 --format=%s`",
  "echo approve 1 | xargs wg ticket",
  "echo 'wg approve 1' | xargs -I{} sh -c {}",
  // stored text run another way
  "git log -1 --format=%s | sh",
  "git log -1 --format=%s | bash -s",
  'eval "$(git log -1 --format=%s)"',
  'sh <<< "$(git log -1 --format=%s)"',
  'bash -c "$(git log -1 --format=%s)"',
  "git log --format=%s | xargs -I{} sh -c {}",
  "git log --format=%s | xargs -I{} {}",
  "git notes show | source /dev/stdin",
  "git show -s --format=%B HEAD | sh",
  "X=1 $(cat cmd.txt)",
  // spellings and quoting
  `wg ticket ${V} 1`,
  `w\\g ticket ${V} 1`,
  `'wg' ticket ${V} 1`,
  `"wg" ticket ${V} 1`,
  `w''g ticket ${V} 1`,
  `wg ticket ap''prove 1`,
  `wg ticket "approve" 1`,
  `wg ticket a\\pprove 1`,
  `/usr/local/bin/wg ticket ${V} 1`,
  `./bin/wg ticket ${V} 1`,
  `dispatch ticket ${V} 1`,
  `fg ticket ${V} 1`,
  `crew review comment 1`,
  // variables and IFS
  `X=wg; $X ticket ${V} 1`,
  `X=wg && $X ticket ${V} 1`,
  `export X=wg; $X ticket ${V} 1`,
  `V=approve; wg ticket $V 1`,
  `wg\${IFS}ticket\${IFS}${V}\${IFS}1`,
  `$CLI ticket ${V} 1`,
  `\${CLI} ticket ${V} 1`,
  // wrappers
  `command wg ticket ${V} 1`,
  `env wg ticket ${V} 1`,
  `env -i wg ticket ${V} 1`,
  `nice -n 5 wg ticket ${V} 1`,
  `timeout 5 wg ticket ${V} 1`,
  `nohup wg ticket ${V} 1`,
  `npx wg ticket ${V} 1`,
  `pnpm exec wg ticket ${V} 1`,
  `xargs wg ticket ${V} 1 < /dev/null`,
  `find . -maxdepth 0 -exec wg ticket ${V} 1 \\;`,
  `exec wg ticket ${V} 1`,
  // nested shells and substitutions
  `sh -c "wg ticket ${V} 1"`,
  `bash -lc 'wg ticket ${V} 1'`,
  `bash -c "bash -c 'wg ticket ${V} 1'"`,
  `eval "wg ticket ${V} 1"`,
  `eval wg ticket ${V} 1`,
  `echo $(wg ticket ${V} 1)`,
  `x=$(wg ticket ${V} 1)`,
  `wg ticket $(printf approve) 1`,
  `wg ticket \`printf approve\` 1`,
  `$(printf wg) ticket ${V} 1`,
  `echd=1; true && wg ticket ${V} 1`,
  `if true; then wg ticket ${V} 1; fi`,
  `(wg ticket ${V} 1)`,
  `{ wg ticket ${V} 1; }`,
  // decoded payloads into a shell
  "echo d2cgdGlja2V0IGFwcHJvdmUgMQ== | base64 -d | sh",
  "printf 'wg ticket approve 1' | bash",
  // after a data-only looking prefix
  `git commit -m ok && wg ticket ${V} 1`,
  `echo ok; dispatch ticket mark-merged 1`,
  `grep -rn x src || crew review comment 1`,
  `git commit -m "dispatch: x" | wg ticket ${V} 1`,
  `echo "x; wg ticket ${V} 1"`,
  // the credential
  "GAFFER_PRINCIPAL_TOKEN=x git status",
  'echo "GAFFER_PRINCIPAL_TOKEN=x"',
  // block verbs
  "wg block 1 --reason x",
  "dispatch unblock 1",
  // memory and gaffer front doors stay as they were
  "gaffer approve 1",
  "memory approve 3",
  // git's stored text run through a variable (a commit message may now hold the CLI)
  'a=$(git log -1 --pretty=%B); eval "$a"',
  "a=$(git log -1 --pretty=%B); eval $a",
  'a=$(git log -1 --pretty=%B); bash -c "$a"',
  'a=$(git log -1 --pretty=%B); sh -c "$a"',
  'a=`git log -1 --format=%s`; eval "$a"',
  'export a=$(git log -1 --format=%s); eval "$a"',
  'a=$(git tag -l --format="%(contents)"); eval "$a"',
  'a=$(git notes show); eval "${a}"',
  'msg=$(git log -1 --pretty=%B); echo "$msg" | sh',
  'msg=$(git log -1 --pretty=%B); printf %s "$msg" | bash',
  'msg=$(git log -1 --pretty=%B); bash <<< "$msg"',
  'read -r c < <(git log -1 --pretty=%B); eval "$c"',
  'read -r c <<< "$(git log -1 --pretty=%B)"; eval "$c"',
  'a=$(git log -1 --pretty=%B) && if true; then eval "$a"; fi',
]) {
  each("deny", cmd);
}

// Running what only finds a path, or only printing git's text, stays allowed.
for (const cmd of [
  'a=$(which node); eval "$a --version"',
  'msg=$(git log -1 --pretty=%B); echo "$msg"',
  'msg=$(git log -1 --pretty=%B); printf "%s\\n" "$msg" > notes.txt',
]) {
  each("allow", cmd);
}

t.done();
