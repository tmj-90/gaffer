#!/usr/bin/env node
// The inline-interpreter boundary judged by capability (63C, lib/hook/interpreters.mjs,
// lib/hook/inline-programs.mjs, lib/hook/inline-lex.mjs). An independent review found
// write spellings the old list missed (`os.open(p, 65)`, `open(p, mode="a")`, escaped
// quotes in a double-quoted program, `f.writeSync(f.openSync(p, 1))`); the hook now
// refuses any inline program that can write, start a process, reach the network or run
// code built at run time, unless its only capability is a write to a literal path in a
// write root.
//
// The two corpora live in test/fixtures/safety-hook-inline-corpus.json: every harmless
// one-liner must be allowed (the false-refusal rate matters: agents use these all the
// time), every hostile one refused. The hostile programs are only ever handed to the
// hook as text. The cases below pin the reasons and the shapes the corpora do not show.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bash, RUNNER_DIR, runHook, scratchDir, suite } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-inline");
const corpus = JSON.parse(
  readFileSync(resolve(RUNNER_DIR, "test", "fixtures", "safety-hook-inline-corpus.json"), "utf8"),
);

const base = scratchDir("gaffer-hook-inline-");
t.cleanup(base);
const work = resolve(base, "work");
const readRoot = resolve(base, "read");
for (const d of [work, readRoot, resolve(work, "src")]) {
  try {
    (await import("node:fs")).mkdirSync(d, { recursive: true });
  } catch {
    /* exists */
  }
}
writeFileSync(resolve(work, "src", "a.js"), "export const a = 1;\n");
const env = {
  GAFFER_WRITE_ROOTS: work,
  GAFFER_READ_ROOTS: readRoot,
  GAFFER_DATA: resolve(base, "data"),
};
const opts = { env, cwd: work };

if (corpus.harmless.length < 60)
  t.assert(`harmless corpus has ${corpus.harmless.length} < 60`, false);
if (corpus.hostile.length < 80) t.assert(`hostile corpus has ${corpus.hostile.length} < 80`, false);
for (const cmd of corpus.harmless) t.allow(`harmless: ${cmd.slice(0, 120)}`, bash(cmd), opts);
for (const cmd of corpus.hostile) t.deny(`hostile: ${cmd.slice(0, 120)}`, bash(cmd), opts);

// The reviewer's four, with the reason the agent sees (it says what to do instead).
const why = (cmd) => runHook(bash(cmd), opts).stderr;
for (const cmd of [
  `python3 -c 'import os;os.write(os.open("/etc/zz",65),b"x")'`,
  `python3 -c 'open("/etc/zz", mode="a").write("x")'`,
  `python3 -c "open(\\"/etc/zz\\",\\"w\\").write(1)"`,
  `node -e 'const f=require("fs");f.writeSync(f.openSync("/etc/zz",1),"x")'`,
]) {
  const reason = why(cmd);
  t.assert(
    `the refusal of ${cmd} names the way out: ${reason.slice(0, 300)}`,
    /use the Write\/Edit tools/i.test(reason) &&
      /put the program in a file inside the worktree/.test(reason),
  );
}

// The allowed write: a literal path inside the write root, also as an absolute path and
// after a `cd` that stays inside it; refused once the cd leaves it or cannot be followed.
t.allow(
  "literal absolute path in the write root",
  bash(`python3 -c 'open("${work}/o.txt","w").write("x")'`),
  opts,
);
t.allow(
  "cd inside the root, then a relative write",
  bash(`cd src && python3 -c 'open("o.txt","w").write("x")'`),
  opts,
);
t.deny(
  "a write into the read root",
  bash(`python3 -c 'open("${readRoot}/o.txt","w").write("x")'`),
  opts,
);
t.deny(
  "cd to the read root, then a relative write",
  bash(`cd ${readRoot} && node -e 'require("fs").writeFileSync("o.txt","x")'`),
  opts,
);
t.deny(
  "cd $X, then a relative write",
  bash(`cd "$X" && python3 -c 'open("o.txt","w").write("x")'`),
  opts,
);
t.deny(
  "pushd, then a relative write",
  bash(`pushd /tmp && python3 -c 'open("o.txt","w").write("x")'`),
  opts,
);
t.deny("ruby -C, then a relative write", bash(`ruby -C /etc -e 'File.write("x", "y")'`), opts);
t.deny(
  "a write path with a shell variable",
  bash(`python3 -c "open('$HOME/x','w').write('y')"`),
  opts,
);

// Reads keep their rules, now also over the normalised text: an escaped secret name.
t.deny(
  "a secret path spelled with escapes",
  bash(`python3 -c 'print(open("\\x2eenv").read())'`),
  opts,
);
t.deny(
  "a literal read outside the roots, double-quoted",
  bash(`python3 -c "print(open(\\"/etc/hostname\\").read())"`),
  opts,
);
t.allow(
  "a literal read inside the write root",
  bash(`python3 -c 'print(open("src/a.js").read())'`),
  opts,
);

// The control-plane verb gap: a verb from stdin or xargs, and inline programs that start one.
t.deny("echo approve | xargs wg ticket", bash("echo approve | xargs wg ticket"), opts);
t.deny(
  "an inline program building the verb",
  bash(`node -e 'require("child_process").execSync("w"+"g ticket approve 3")'`),
  opts,
);
t.deny("a shell reading a verb from stdin", bash("echo 'wg ticket approve 3' | bash -s"), opts);
t.allow("a read-only CLI verb with xargs-fed ids", bash("echo 3 | xargs wg ticket show"), opts);

// A text mention is not a program: a commit message or a grep pattern stays allowed.
t.allow("a grep for an inline program", bash(`grep -rn "python3 -c" src`), opts);
t.allow(
  "a commit message naming os.system",
  bash(`git commit -m "drop the os.system call from the build"`),
  opts,
);

t.done();
