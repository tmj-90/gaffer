#!/usr/bin/env node
// SIGNED GATE EVENTS (package H2): the safety hook refuses any tool call or command that
// reads or writes under the factory keys directory, ${XDG_CONFIG_HOME:-$HOME/.config}/
// gaffer/keys, where the key approvals and tester verdicts are signed with lives. Under
// SANDBOX_PROVIDER=none the hook is the only guard between an agent and that file, so
// every vector is pinned: the file tools (Read, Write, Edit, Grep, Glob), the plain
// readers and copiers, an interpreter opening the file, a glob, a redirect, and a path
// assembled from variables in the same command. Ordinary work stays allowed.
// Run: node test/safety-hook-factory-key.test.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bash, read, scratchDir, suite, tool, write } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-factory-key");
const ROOT = scratchDir("gaffer-fk-root-");
const HOME = scratchDir("gaffer-fk-home-");
for (const d of [ROOT, HOME]) t.cleanup(d);
const KEYS = join(HOME, ".config", "gaffer", "keys");
mkdirSync(KEYS, { recursive: true });
writeFileSync(join(KEYS, "0123abcd.key"), Buffer.alloc(32, 7), { mode: 0o600 });
writeFileSync(join(ROOT, "README.md"), "hello\n");
const opts = { env: { HOME, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };
const KEY = join(KEYS, "0123abcd.key");

// The file tools.
t.deny("Read the key", read(KEY), opts);
t.deny("Read through ~", read("~/.config/gaffer/keys/0123abcd.key"), opts);
t.deny("Read under a moved XDG_CONFIG_HOME", read("/srv/xdg/gaffer/keys/0123abcd.key"), opts);
t.deny("Write a key", write(KEY), opts);
t.deny("Edit a key", tool("Edit", { file_path: KEY, old_string: "a", new_string: "b" }), opts);
t.deny("Grep the keys directory", tool("Grep", { pattern: ".", path: KEYS }), opts);
t.deny("Glob the keys directory", tool("Glob", { pattern: "*", path: KEYS }), opts);
t.deny(
  "Glob .config/gaffer",
  tool("Glob", { pattern: "**/*", path: join(HOME, ".config", "gaffer") }),
  opts,
);

// Bash: readers, copiers, listings, redirects.
for (const cmd of [
  `cat ${KEY}`,
  "cat ~/.config/gaffer/keys/0123abcd.key",
  'cat "$HOME/.config/gaffer/keys/0123abcd.key"',
  "xxd ~/.config/gaffer/keys/*.key",
  "cp ~/.config/gaffer/keys/0123abcd.key ./stolen",
  "cp -r ~/.config/gaffer /tmp/stolen",
  "tar czf out.tgz -C ~/.config gaffer/keys",
  "ls $HOME/.config/gaffer/keys",
  "base64 < ~/.config/gaffer/keys/0123abcd.key",
  "echo x > ~/.config/gaffer/keys/0123abcd.key",
  "rm -rf ~/.config/gaffer/keys",
  'cat "${XDG_CONFIG_HOME}/gaffer/keys/0123abcd.key"',
]) {
  t.deny(`bash: ${cmd}`, bash(cmd), opts);
}
// An interpreter opening it.
for (const cmd of [
  `python3 -c "print(open('${KEY}','rb').read().hex())"`,
  `node -e "console.log(require('fs').readFileSync(process.env.HOME + '/.config/gaffer/keys/0123abcd.key'))"`,
  `perl -e 'open(F, "$ENV{HOME}/.config/gaffer/keys/0123abcd.key"); print <F>'`,
  `ruby -e 'puts File.read(Dir.home + "/.config/gaffer/keys/0123abcd.key")'`,
]) {
  t.deny(`interpreter: ${cmd.slice(0, 60)}`, bash(cmd), opts);
}
// A path assembled from variables, a glob, a nested shell.
for (const cmd of [
  "d=gaffer; cat ~/.config/$d/keys/0123abcd.key",
  'k=keys; cat "$HOME/.config/gaffer/$k/0123abcd.key"',
  "c=.config; g=gaffer; k=keys; cat $HOME/$c/$g/$k/*",
  "cat ~/.config/gaff*/k*/*",
  "cat ~/.config/g?ffer/keys/*",
  "bash -c 'cat ~/.config/gaffer/keys/0123abcd.key'",
  "f=$HOME/.config/gaffer/keys/0123abcd.key; od -An -tx1 $f",
]) {
  t.deny(`assembled: ${cmd}`, bash(cmd), opts);
}
// The key's own CLI is the host's.
t.deny("wg gate-key ensure", bash("wg gate-key ensure"), opts);
t.deny(
  "node dispatch gate-key",
  bash("node packages/dispatch/dist/cli/index.js gate-key ensure"),
  opts,
);

// Ordinary work stays allowed.
t.allow("cat README.md", bash("cat README.md"), opts);
t.allow("Read README.md", read(join(ROOT, "README.md")), opts);
t.allow("ls", bash("ls -la"), opts);
t.allow("a source file named keys.ts", bash("cat src/gaffer/keys.ts"), opts);

t.done();
