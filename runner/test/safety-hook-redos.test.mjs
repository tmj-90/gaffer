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
//   • the ~100 KB deep path that took ~70s now blocks on the input-size cap in < 2s;
//   • the prefix still sees through real valued options (`nice -n 5 gh …`).
// Run: node test/safety-hook-redos.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { nodeInlineControlPlane } from "../lib/dangerous-commands.mjs";
import { dynamicNames } from "../lib/hook/expand.mjs";
import { inlineCapability, inlineProgramReadReason } from "../lib/hook/interpreters.mjs";
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
  // The decoded-payload rule scanned from every decoder word to the end of the line.
  "8000x base64 |": `${"base64 |".repeat(8000)}`,
  "9000x base64": `${"base64 ".repeat(9000)}`,
  // The inline-node control-plane rule retried every later `node`, flag and package word
  // (cubic: 10s for this input, past three minutes for the whole hook at 63 KB).
  "2048x node -e": `${"node -e ".repeat(2048)}`,
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

// The inline-node rule is a linear scan now; it answers as its expression did on small
// random commands (where the expression is still safe to run).
{
  const reference =
    /\bnode\b[^\n|;&]*(?:-e|--eval|-p|--print|-r|--require)\b[^\n]*(?:(?:dispatch|crew|memory)[^\n]*\/dist\/|\b(?:DISPATCH_DB|MEMORY_DB)\b|(?:dispatch|memory)[^\s'"\n]*\.sqlite)/i;
  const parts = ["node", "NODE", "nodejs", "xnode", " ", "-e", "-E", "--eval", "-p", "--print"];
  parts.push("-r", "--require", "-ex", "\n", "|", ";", "&", "dispatch", "Crew", "memory", "/dist/");
  parts.push("/DIST/", "/dist", "DISPATCH_DB", "memory_db", "XDISPATCH_DB", ".sqlite", "'", '"');
  parts.push("a", "/", "x.sqlite", "-", "\t");
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let differ = 0;
  let first = "";
  for (let i = 0; i < 100000; i += 1) {
    let s = "";
    for (let j = 0, n = 1 + Math.floor(rnd() * 10); j < n; j += 1) {
      s += parts[Math.floor(rnd() * parts.length)];
    }
    if (reference.test(s) !== nodeInlineControlPlane(s)) {
      differ += 1;
      if (!first) first = JSON.stringify(s);
    }
  }
  t.assert(
    `the inline-node rule answers as its expression did on 100000 commands (first difference: ${first})`,
    differ === 0,
  );
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

// The paren-less perl/ruby write forms and `git -C <dir>` write targets (the
// $GAFFER_DATA guard): their patterns are structured, not `[^,]*` scans, so a long run of
// repeated call names stays linear — ~45 KB of each is answered (denied: an inline write
// whose path cannot be read) well inside the budget.
for (const [label, command] of [
  ["perl paren-less open", `perl -e '${"open ".repeat(9000)}'`],
  ["ruby paren-less File.open", `ruby -e '${"File.open ".repeat(5000)}'`],
  ["ruby paren-less File.new", `ruby -e '${"File.new x ".repeat(4000)}'`],
]) {
  const { status, ms } = timed(command);
  t.assert(
    `hook answers ~45 KB of ${label} with exit 2 in < 1s over start-up (exit ${status}, ${ms}ms, start-up ${baseline}ms)`,
    status === 2 && ms - baseline < 1000,
  );
}
{
  const { status, ms } = timed(`git ${"-C . ".repeat(8000)}checkout -- x`);
  t.assert(
    `hook answers 8000 repeated git -C dirs in < 1s over start-up (exit ${status}, ${ms}ms, start-up ${baseline}ms)`,
    ms - baseline < 1000,
  );
}

// A write target can cost git lookups (lib/hook/git.mjs gitExecSurfaceReason): the same
// target named thousands of times took 40 s before each distinct target was judged once.
{
  const { status, ms } = timed(`awk '{${"print 1>x ".repeat(6000)}}'`);
  t.assert(
    `hook answers 6000 redirections to one awk target with exit 2 in < 2s over start-up (exit ${status}, ${ms}ms, start-up ${baseline}ms)`,
    status === 2 && ms - baseline < 2000,
  );
}

// The inline-program capability rule (63C: lib/hook/inline-programs.mjs reads the shell,
// lib/hook/inline-lex.mjs lexes the program, lib/hook/interpreters.mjs judges it) is one
// pass with bounded lookahead: each worst case below, near the 64 KiB field cap, is decided
// by the rule (both halves) in < 1s.
{
  const roots = { writeRoots: [ROOT], readRoots: [], configured: true };
  const K = 60000;
  const rep = (x) => x.repeat(Math.floor(K / x.length));
  const worst = {
    "python nested parens": `python3 -c '${"(".repeat(30000)}${")".repeat(30000)}'`,
    "python open(": `python3 -c '${rep("open(")}'`,
    "python f-string fields": `python3 -c 'f"${rep("{x}")}"'`,
    "python nested f-strings": `python3 -c '${rep('f"{')}'`,
    "python import chain": `python3 -c 'import ${rep("a.")}b'`,
    "python dunder strings": `python3 -c '"${rep("__a")}"'`,
    "python Path writes": `python3 -c '${rep('Path("x").write_text(1);')}'`,
    "python distinct writes": `python3 -c '${Array.from({ length: 2600 }, (_, i) => `open("f${i}","w");`).join("")}'`,
    "js computed members": `node -e '${rep("x[")}${rep("]")}'`.slice(0, K),
    "js string concat": `node -e '${rep('"a"+')}"a"'`,
    "js templates": `node -e '${rep("`${")}'`,
    "js regex literals": `node -e '${rep("(/a/)")}'`,
    "js destructuring": `node -e 'const {${rep("a,")}}=require("fs")'`,
    "ruby interpolation": `ruby -e '"${rep("#{")}'`,
    "ruby paren-less File.write": `ruby -e '${rep("File.write ")}'`,
    "perl subscripts": `perl -e '"${rep("$a{")}"'`,
    "perl quote-like": `perl -e '${rep("s{a}{b}")}'`,
    "perl paren-less unlink": `perl -e '${rep("unlink ")}'`,
    "php interpolation": `php -r '"${rep("{$a")}"'`,
    "php callable takers": `php -r '${rep("array_map(")}'`,
    "shell sh -c nesting": rep("sh -c "),
    "shell variables": `python3 -c "${rep("$a")}"`,
    "shell cd": rep("cd a; "),
    "shell interpreters": rep("python3 "),
    "shell runner words": `watch ${rep("'python3 -c x' ")}`,
    // Added by the review: substitutions, trap, python -m, awk, sed and long member chains.
    "js computed chain": `node -e 'x${rep("[k]")}'`,
    "shell command substitutions": rep("$(node -e 1) "),
    "shell backticks": rep("`node -e 1` "),
    "shell process substitutions": `cat ${rep("<(node -e 1) ")}`,
    "shell nested substitutions": `echo ${"$(".repeat(5000)}node -e 1${")".repeat(5000)}`,
    "shell here-document substitutions": `cat <<E\n${rep("$(node -e 1)")}\nE`,
    "shell trap": rep("trap 'node -e 1' EXIT; "),
    "python -m timeit": rep("python3 -m timeit 1; "),
    "python environ": `python3 -c 'import os;${rep("os.environ[1];")}'`,
    "python module chain": `python3 -c 'import tokenize; tokenize${rep(".io")}'`,
    "awk prints": `awk '{${rep("print 1>")}}'`,
    "awk regexes": `awk '${rep("/a/ ")}'`,
    "sed script": `sed '${rep("s/a/b/;")}' f`,
    "sed addresses": `sed '${rep("/a/,")}p' f`,
    // Added by the second review: long options, SQL comments, getline, make assignments and
    // the value-checked environment variables.
    "sed long options": `sed ${rep("--e ")}f`,
    "awk option clusters": `awk ${rep("-bbbbbbbb ")}1`,
    "awk getlines": `awk '${rep("getline x ")}'`,
    "sqlite comments": `sqlite3 :memory: '${rep("/*")}'`,
    "sqlite strings": `sqlite3 :memory: "${rep("'a")}"`,
    "sqlite vacuums": `sqlite3 :memory: '${rep("vacuum ")}'`,
    "sqlite dot-commands": `sqlite3 :memory: '${rep(" .s")}'`,
    "make assignments": `make ${rep("a=b ")}`,
    "make option clusters": `make ${rep("-sk ")}`,
    "PERLIO layers": `PERLIO='${rep("raw ")}x' perl -e 1`,
    "RUBYOPT switches": `RUBYOPT='${rep("-W ")}' ruby -e 1`,
    "NODE_OPTIONS imports": `NODE_OPTIONS='${rep("--import a ")}' npm test`,
    "PYTHONWARNINGS filters": `PYTHONWARNINGS='${rep("ignore::a,")}' pytest`,
  };
  for (const [label, command] of Object.entries(worst)) {
    const start = performance.now();
    inlineCapability(command, roots);
    inlineProgramReadReason(command, roots);
    const ms = Math.round(performance.now() - start);
    t.assert(
      `the inline capability rule decides ${label} (${command.length} B) in < 1s (took ${ms}ms)`,
      ms < 1000,
    );
  }
}

// A glob with many stars against ONE long file name. The component matcher was a RegExp
// (`*` as `.*`): 20 star-letter pairs against a name of eighty `a`s backtracked for
// longer than the hook's timeout, from a 49-byte command. The matcher is now bounded by
// name length times pattern length (test/hook-glob-matcher.test.mjs); the whole hook
// answers these in < 1s over start-up.
{
  mkdirSync(`${ROOT}/src`, { recursive: true });
  writeFileSync(`${ROOT}/src/${"a".repeat(80)}`, "");
  for (const [label, command, want] of [
    ["20 star-letter pairs + b (no match)", `cat src/${"*a".repeat(20)}b`, 0],
    ["20 star-letter pairs (a match)", `cat src/${"*a".repeat(20)}`, 0],
    ["400 star-letter pairs + b", `cat src/${"*a".repeat(400)}b`, 0],
    ["the same glob over the factory's data dir", `cat $GAFFER_DATA/${"*a".repeat(20)}b`, 2],
  ]) {
    const { status, ms } = timed(command);
    t.assert(
      `hook answers a glob of ${label} with exit ${want} in < 1s over start-up (exit ${status}, ${ms}ms, start-up ${baseline}ms)`,
      status === want && ms - baseline < 1000,
    );
  }
}

// The question "can this command set $NAME in a way the hook does not follow" (read,
// printf -v, declare -a, ...) was one regular expression per variable name, with nested
// runs that backtracked in the cube of the command's length: `declare -aaa...` of 6 KB
// and three variables, or 11000 `read` words and forty, kept the hook busy past its
// timeout. The names are now collected once per command by linear scans.
{
  // The same answers as the expression on small random commands (where it is still safe
  // to run): the scans are a faster form of it, not a different rule.
  const reference = (cmd, n) =>
    new RegExp(
      String.raw`\b(?:read|mapfile|readarray|getopts|select)\b[^\n;&|]*?(?<![\w$])${n}(?!\w)|\bprintf\b[^\n;&|]*-v[ \t]*["']?${n}\b|\(\([^)]*\b${n}\b|\blet\b[^\n;&|]*\b${n}\b|(?<![\w$])${n}(?:\[[^\]]*\])?\+?=\(|(?<![\w$])${n}\+=|(?<![\w$])${n}\[|\bdeclare\b[^\n;&|]*-\w*[naAi]\w*[^\n;&|]*\b${n}\b|\b(?:typeset|local)\b[^\n;&|]*-\w*[naAi]\w*[^\n;&|]*\b${n}\b|\bunset\b[^\n;&|]*-\w*n\w*[^\n;&|]*\b${n}\b`,
    ).test(cmd);
  const parts = [..."();&|$[]=+'\"-\n ", "read", "mapfile", "select", "printf", "-v", "let"];
  parts.push("declare", "typeset", "local", "unset", "-a", "-n", "-xn", "-bA", "-i", "((");
  parts.push("))", "=(", "+=", "ZZ", "ZZ", "Y", "aZZ", "ZZb", "x", "_1", "  ");
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let differ = 0;
  let first = "";
  for (let i = 0; i < 40000; i += 1) {
    let cmd = "";
    for (let j = 0, len = 1 + Math.floor(rnd() * 12); j < len; j += 1) {
      cmd += parts[Math.floor(rnd() * parts.length)];
    }
    const names = dynamicNames(cmd);
    for (const n of ["ZZ", "Y", "x", "_1"]) {
      if (names.has(n) !== reference(cmd, n)) {
        differ += 1;
        if (!first) first = `${JSON.stringify(cmd)} ${n}`;
      }
    }
  }
  t.assert(
    `the scans answer as the expression did on 160000 name checks (first difference: ${first})`,
    differ === 0,
  );
}
// These four are scans the hook does in-process (no git lookup), so the bound is on the
// hook's own CPU time when the clock misses it: on a shared CI runner the clock also
// measures the neighbours (one macOS run took 2117 ms of wall time for work that is
// linear and costs about a quarter of the bound). The clock still has to stay inside the
// hook's real budget. A super-linear scan burns CPU and fails either way.
const CPU_PRELOAD = new URL("./lib/cpu-report.mjs", import.meta.url).href;
const CPU_OUT = path.join(ROOT, "cpu-ms");
const timedCpu = (command) => {
  rmSync(CPU_OUT, { force: true });
  const start = Date.now();
  const res = spawnSync(process.execPath, ["--import", CPU_PRELOAD, HOOK], {
    input: JSON.stringify(bash(command)),
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, GAFFER_TEST_CPU_OUT: CPU_OUT },
    encoding: "utf8",
    timeout: 10_000,
  });
  const ms = Date.now() - start;
  let cpu = Infinity;
  try {
    const n = Number(readFileSync(CPU_OUT, "utf8"));
    if (Number.isFinite(n)) cpu = n;
  } catch {
    // killed before it could report: the clock alone decides
  }
  return { status: res.status, ms, cpu };
};
{
  const base = [1, 2, 3].map(() => timedCpu("echo hi"));
  const baseMs = Math.max(...base.map((b) => b.ms));
  const baseCpu = Math.max(...base.map((b) => b.cpu));
  const vars = (k) => Array.from({ length: k }, (_, i) => `src/$V${i}`).join(" ");
  for (const [label, command] of [
    ["declare -a...a (6000) and 3 variables", `declare -${"a".repeat(6000)}; cat ${vars(3)}`],
    ["11000 read words and 40 variables", `${"read ".repeat(11000)}; cat ${vars(40)}`],
    ["5500 printf -v and 40 variables", `${"printf -v ".repeat(5500)}; cat ${vars(40)}`],
    ["6000 unset -n and 40 variables", `${"unset -n ".repeat(6000)}; cat ${vars(40)}`],
  ]) {
    const { status, ms, cpu } = timedCpu(command);
    t.assert(
      `hook answers ${label} with exit 0 in < 2s over start-up, by the clock or by its own CPU time (exit ${status}, ${ms}ms, start-up ${baseMs}ms; CPU ${cpu}ms, start-up ${baseCpu}ms)`,
      status === 0 && ms < 8000 && (ms - baseMs < 2000 || cpu - baseCpu < 2000),
    );
  }
}

// Rules that rescan a long word at every command position inside it (`{` starts one)
// are quadratic in each of about fifty rules, over every resolved view: 63 KB of `${`
// took the whole hook about 100 s, past Claude Code's hook timeout (a version without
// onFailure: block then runs the tool). Past its rule budget (decide.mjs
// RULE_TIME_BUDGET_MS) the hook refuses the command as unverifiable, inside the timeout.
{
  const start = Date.now();
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(bash(`${"${".repeat(31500)}zz`)),
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 58_000,
  });
  const ms = Date.now() - start;
  t.assert(
    `63 KB of \${: refused as unverifiable before the hook's 60 s timeout (exit ${res.status}, ${ms}ms)`,
    res.status === 2 && /ran out of time/.test(res.stderr) && ms < 50_000,
  );
}

// The ~100 KB deep path (`echo x > /a/a/…`, and the same path as a Write) took ~60-70s
// to decide in the secret-path regexes, which are polynomial in the input length. The
// input-size cap now blocks it before any rule runs: the whole spawned hook answers
// exit 2 with the size reason in < 2s (start-up included), not by the 60s timeout.
const deepPath = "/" + "a/".repeat(50000) + "a";
for (const [label, payload] of [
  ["bash redirect", bash(`echo x > ${deepPath}`)],
  ["Write", { tool_name: "Write", tool_input: { file_path: deepPath } }],
]) {
  const start = Date.now();
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 10_000,
  });
  const ms = Date.now() - start;
  t.assert(
    `hook blocks the ~100 KB deep-path ${label} on the size cap in < 2s (exit ${res.status}, ${ms}ms)`,
    res.status === 2 &&
      (res.stderr || "").includes("unverifiable: tool input too large (") &&
      ms < 2000,
  );
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
