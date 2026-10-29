#!/usr/bin/env node
// Tilde-operand boundary: bash expands an UNQUOTED leading `~` to $HOME before the
// command runs, so the hook must resolve `~/x` as $HOME/x — not <cwd>/~/x, which sat
// inside the write-root and let home-directory writes, deletes and credential reads
// through. Quoted tildes stay literal (bash does not expand them).
// Run: node test/safety-hook-tilde.test.mjs
import { mkdirSync } from "node:fs";
import { bash, read, scratchDir, suite, write } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-tilde");
const ROOT = scratchDir("gaffer-tilde-root-");
const HOME = scratchDir("gaffer-tilde-home-");
t.cleanup(ROOT);
t.cleanup(HOME);
mkdirSync(`${ROOT}/sub`, { recursive: true });
const opts = { env: { HOME, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" }, cwd: ROOT };

// Home-directory writes / deletes through a tilde operand → DENY.
for (const cmd of [
  "printf x >> ~/.zshrc",
  "rm -r -f ~",
  "rm -r ~/projects",
  "touch ~/x",
  "mkdir -p ~/.config/systemd/user",
  "mv payload ~/.config/autostart/x.desktop",
  "cp p ~/.bashrc",
  "tee ~/.profile",
  "sed -i s/a/b/ ~/.bashrc",
  "dd if=/dev/zero of=~/x",
  "git worktree add ~/wt",
]) {
  t.deny(`tilde write: ${cmd}`, bash(cmd), opts);
}
// `~user` and `~-` cannot be resolved by a stateless hook → fail closed.
t.deny("~user write fails closed", bash("echo x > ~root/.bashrc"), opts);
t.deny("~- write fails closed", bash("echo x > ~-/x"), opts);
// Branch creation in $HOME (git -C ~) is outside the write-roots.
t.deny("git -C ~ checkout -b", bash("git -C ~ checkout -b x"), opts);

// Credential reads outside the roots through a tilde operand → DENY.
t.deny("cat ~/.config/gh/hosts.yml", bash("cat ~/.config/gh/hosts.yml"), opts);
t.deny("head ~/.docker/config.json", bash("head ~/.docker/config.json"), opts);
t.deny("dd if=~/x reads home", bash("dd if=~/x of=out"), opts);
t.deny("cat ~root/x fails closed", bash("cat ~root/x"), opts);

// The file tools expand `~` too.
t.deny("Write ~/.zshrc", write("~/.zshrc"), opts);
t.deny("Read ~/.config/gh/hosts.yml", read("~/.config/gh/hosts.yml"), opts);
t.deny("Read ~root/x fails closed", read("~root/x"), opts);

// Controls: a QUOTED tilde is a literal in-worktree path; ~+ is the cwd.
t.allow('echo x > "~/x" (quoted: literal ./~/x)', bash('echo x > "~/x"'), opts);
t.allow("echo x > '~/y' (quoted: literal ./~/y)", bash("echo x > '~/y'"), opts);
t.allow("echo x > ~+/z (~+ is the cwd)", bash("echo x > ~+/z"), opts);
t.allow("plain relative write still allowed", bash("echo x > sub/out.txt"), opts);
t.allow("Write inside root still allowed", write(`${ROOT}/sub/a.ts`), opts);
// A worktree that lives UNDER $HOME is still writable through ~/… .
t.allow("tilde path that lands inside a write-root", bash("touch ~/sub/x"), {
  env: { HOME: ROOT, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" },
  cwd: ROOT,
});

t.done();
