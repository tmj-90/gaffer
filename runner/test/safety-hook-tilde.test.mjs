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

// `cd ~/…` relocates later RELATIVE operands under $HOME. It used to read as an
// unknown cwd, so the relative read after it was skipped and `cd ~/.config/gh && cat
// hosts.yml` printed the gh token while the absolute form was refused.
const unconfigured = { env: { HOME, GAFFER_WRITE_ROOTS: "", GAFFER_READ_ROOTS: "" }, cwd: ROOT };
for (const cmd of [
  "cd ~/.config/gh && cat hosts.yml",
  "cd ~/.config && cat gh/hosts.yml",
  "cd ~/.config; cat gh/hosts.yml",
  "cd ~/.config && head -c 9999 gh/hosts.yml",
  "cd ~/.docker && cat config.json",
  "cd ~/.kube && cat config",
  "cd ~/.azure && cat msal_token_cache.json",
  "cd ~/.config/gh && cp hosts.yml sub/x",
  "cd ~/.config/gh && tar c hosts.yml",
  "cd ~ && cat .zsh_history",
  "cd && cat .config/gh/hosts.yml",
  "pushd ~/.kube && cat config",
]) {
  t.deny(`tilde cd then relative read: ${cmd}`, bash(cmd), opts);
}
// The credential stores stay unreadable under the unconfigured fallback too, where
// reads are otherwise not root-restricted: the resolved target IS a secret file.
for (const cmd of [
  "cd ~/.config/gh && cat hosts.yml",
  "cd ~/.kube && cat config",
  "cd ~/.docker && cat config.json",
  "cd ~/.config/gh && cp hosts.yml sub/x",
]) {
  t.deny(`tilde cd then secret read (fallback roots): ${cmd}`, bash(cmd), unconfigured);
}
// …and a tilde cd into the worktree still works, as does a relative read there.
t.allow("cd ~/sub inside the write-root, then a relative read", bash("cd ~/sub && cat a.ts"), {
  env: { HOME: ROOT, GAFFER_WRITE_ROOTS: ROOT, GAFFER_READ_ROOTS: "" },
  cwd: ROOT,
});
t.allow("cd sub && cat a.ts (fallback roots)", bash("cd sub && cat a.ts"), unconfigured);

t.done();
