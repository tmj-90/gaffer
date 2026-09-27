---
name: shell-scripting
description: Use when a ticket adds or changes shell scripts — bash automation, CI steps, install or release scripts, git hooks, Makefile recipes — and they must be safe under set -euo pipefail, portable across GNU and BSD tools, and clean under shellcheck. Invoke for "write a script that…", "fix the bash", "this only works on Linux", or as the language pack for any .sh change.
stack: [bash, shell, sh, zsh]
area: language
---

# Write safe, portable shell

Shell is where quiet failures live: an unset variable expands to nothing, a failed
command in a pipeline is ignored, a filename with a space becomes two arguments. Write
scripts that fail loudly, quote everything, and behave the same on macOS and Linux.

## Steps

1. **Read the repo's conventions.** Check `search_lore` and the existing scripts: the
   shebang they use (`#!/usr/bin/env bash`), the strict mode line, helper libraries
   they source, and how they log. Match them; do not introduce a second style.
2. **Start every script the same way.** `#!/usr/bin/env bash`, then `set -euo pipefail`
   (or the repo's equivalent), then resolve your own directory
   (`HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`) instead of assuming the cwd.
3. **Quote every expansion.** `"$var"`, `"$@"`, `"${arr[@]}"`. Use arrays for argument
   lists, never a space-joined string you later word-split. Use `[[ ]]` for tests in
   bash, `printf '%s\n'` over `echo` for data.
4. **Handle failure explicitly.** Under `set -e` a command you expect may fail needs
   `|| true` or an `if`; capture status with `rc=$?` immediately. Trap `EXIT`/`INT`/`TERM`
   to clean up temp files and worktrees, and make the trap idempotent.
5. **Stay portable.** No `sed -i` without a suffix argument (`sed -i.bak … && rm -f
   *.bak`), no `readlink -f` / `realpath` / `date -d` / `grep -P` / `stat -c` without a
   fallback, no GNU-only `mktemp` flags. Prefer `mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX"`.
   If the repo's CI runs macOS, test the exact idiom there or use the documented
   portable one.
6. **Never build commands from untrusted text.** Ticket titles, file names, and API
   responses go through arrays or `--` argument separators, never `eval`, never
   interpolated into a `sh -c` string. Treat any text you did not write as data.
7. **Run shellcheck** (`shellcheck -x` with the repo's severity) on every file you
   touched and fix each finding or justify the disable inline with the code and a
   reason. `bash -n` for syntax before you run anything.
8. **Test the script like code.** A test that runs it against a fixture directory and
   asserts its exit code and effects (files created, lines logged) — the repo's
   `runner/test/*.test.sh` pattern if you are in the factory. Evidence the shellcheck and
   test runs with the `record-evidence` skill.

## Review checklist (a shell reviewer must check)

- Strict mode present; failures cannot pass silently through pipelines.
- Every expansion quoted; argument lists are arrays.
- Traps clean up on all exit paths; temp dirs use `mktemp` with a template.
- No GNU-only idioms without a portable form when CI runs on macOS.
- No `eval` or shell-string interpolation of untrusted text.
- `shellcheck -x` clean at the repo's severity; disables are justified.

## Rules

- `set -euo pipefail`, quoted expansions, arrays for arguments: non-negotiable.
- Portable idioms or an explicit fallback; the macOS runner is a real target.
- Untrusted text is data; it never becomes code.
- shellcheck and `bash -n` before you call it done.
- Run on the ticket branch (the `create-branch` skill verifies), never a protected branch.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While making a script portable you hit the BSD/GNU and runner differences that bite every later script author in this repo.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
