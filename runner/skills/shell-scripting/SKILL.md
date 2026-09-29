---
name: shell-scripting
description: Use when a ticket adds or changes shell scripts — bash automation, CI steps, install or release scripts, git hooks, Makefile recipes — and they must follow the Google Shell Style Guide, be safe under set -euo pipefail (knowing its caveats), quote every expansion, clean up temp files and locks, stay portable across GNU and BSD/macOS tools, and be clean under shellcheck. Invoke for "write a script that…", "fix the bash", "this only works on Linux", or as the language pack for any .sh change or shell review.
stack: [bash, shell, sh, zsh]
area: language
---

# Write safe, portable shell

Shell is where quiet failures live: an unset variable expands to nothing, a failed
command inside a condition is ignored, a filename with a space becomes two arguments, and
two runs share one temp file. For the builder and the reviewer of a shell diff; the repo's existing scripts win over it.

## Procedure

1. **Discover the repo's conventions first.** Call `search_lore` and read the existing
   scripts: the shebang (`#!/usr/bin/env bash` vs POSIX `#!/bin/sh`), the strict-mode
   line, sourced helper libraries, logging helpers, `.shellcheckrc`, `.editorconfig`
   (shfmt reads indentation from it), the test harness (bats, or the repo's
   `test/*.test.sh` pattern) and which OSes CI runs. macOS ships bash 3.2: no associative
   arrays, `mapfile`, `${var,,}`, and `"${arr[@]}"` on an empty array fails under `set -u`
   before bash 4.4. Match the repo; do not introduce a second style.
2. **Decide it should be shell at all.** Google's guide: past ~100 lines, or with
   non-trivial data structures, write it in the repo's main language instead.
3. **Write the change with the idioms below**, then walk the failure section for every
   pipeline, condition, temp file and background job.
4. **Test each acceptance criterion's own behaviour.** Run the script against a fixture
   directory and assert exit code, output and side effects, including one failure case
   (missing input, failing dependency) that must exit non-zero. If the script can run
   concurrently (CI jobs, cron, hooks), start two copies at once and assert neither
   corrupts the other's output.
5. **Verify, then stop.** Done when: `bash -n` passes, `shellcheck -x` is clean at the
   repo's severity (each disable has a code and reason), shfmt shows no diff if the repo
   uses it, the tests pass, and every AC has a test. Record the output with the
   `record-evidence` skill; the runner submits the work.

## Commands

- Syntax: `bash -n script.sh` (`sh -n` for POSIX scripts).
- Lint: `shellcheck -x script.sh` (add `-S warning` or the repo's severity; `-s sh` for
  POSIX).
- Format: `shfmt -d .` when the repo uses shfmt.
- Tests: `bats test/` or the repo's `bash runner/test/x.test.sh` pattern.
- In your own Bash tool calls (not the script), the safety hook blocks `$(…)` or
  backticks combined with a read tool (`grep`, `cat`, `sort`, `head`, `cp`…) and any
  `rm -rf`: put such logic inside the script or its test file and run that.

## Idioms that matter

- **Header**: shebang, then `set -euo pipefail` (or the repo's line), then resolve your own
  directory: `HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`. Put logic in
  functions and end with `main "$@"`.
- **Quote every expansion**: `"$var"`, `"$@"`, `"${arr[@]}"`. Argument lists are arrays,
  never a space-joined string you later word-split. `$(…)`, not backticks.
- **Tests and output**: `[[ … ]]` in bash; `printf '%s\n' "$x"` for data (`echo` mangles
  `-n`/`-e` and backslashes); errors go to stderr (`>&2`) with a non-zero exit.
- **Names** (Google style): `lower_snake_case` functions and locals, `UPPER_CASE`
  constants/exports; `local` in functions.
- **Safe defaults**: `${1:-}` for optional arguments under `set -u`; `${DIR:?}` before
  `rm -rf "${DIR:?}/"` so an empty variable cannot become `rm -rf /`; `read -r`;
  `cd "$dir" || exit`; `curl -fsSL` so HTTP errors fail.
- **Untrusted text is data**: ticket titles, filenames and API responses go through arrays
  and `--` separators, never `eval` or a `sh -c` string; iterate files with
  `find … -print0 | xargs -0` or `while IFS= read -r -d ''`, never `for f in $(ls)`.

## Failure handling, temp files and concurrency

- **`set -e` caveats** (BashFAQ/105): it is ignored inside `if`/`while` conditions, in any
  command of an `&&`/`||` list except the last, after `!`, and in the whole body of a
  function called from those contexts. `local v=$(cmd)` masks `cmd`'s failure (SC2155):
  declare, then assign. Command substitutions do not inherit `errexit` unless
  `shopt -s inherit_errexit` (bash 4.4+). `((i++))` returns 1 when `i` was 0 and exits the
  script. Check critical commands explicitly: `if ! out="$(cmd)"; then … fi`.
- **`pipefail` caveats**: `producer | head -1` or `| grep -q` can kill the producer with
  SIGPIPE (status 141) and fail the pipeline; `grep` exits 1 on no match. Handle those
  statuses deliberately (`|| [[ $? -eq 1 ]]`, `PIPESTATUS`).
- **Temp files and dirs** come from `mktemp`/`mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX"`,
  never a fixed path like `/tmp/out.txt` (two runs collide; another user can pre-create
  it). Remove them in `trap cleanup EXIT` (idempotent; `INT`/`TERM` too).
- **Atomic writes**: write to `tmp="$(mktemp "${target}.XXXXXX")"` in the target's
  directory, then `mv -f "$tmp" "$target"`.
- **Concurrent runs**: guard with `flock` (Linux; not on stock macOS) or an atomic
  `mkdir "$lockdir"`. A lock deemed stale only by its age lets a paused holder carry on
  writing after another run took over; record the owner PID and re-check ownership before
  the final write.
- **Background jobs**: keep each `$!`, `wait "$pid"` individually and check its status;
  plain `wait` discards failures.
- **Portability**: no `sed -i` without a suffix (`sed -i.bak … && rm -f file.bak`), and no
  `readlink -f`, `realpath`, `date -d`, `grep -P`, `stat -c` or GNU-only `mktemp` flags
  without a fallback when CI runs macOS.

## Review checklist — flag as defects

Walk this against the diff. An item is grounds for CHANGES only when, in changed code, it
causes a concrete failure (wrong result, crash, lost or corrupted data, security hole) or
leaves an AC's own behaviour untested: cite the line and that failure. Otherwise it is an
`(optional)` note. Formatting shfmt would fix, and preferences the repo does
not enforce, are not findings. Do not patch the code under review.

- [ ] No strict mode, or a critical command whose failure is swallowed by an
      `if`/`&&`/`local` context or a pipeline.
- [ ] An unquoted expansion or a word-split argument string where values can contain
      spaces or globs.
- [ ] A fixed temp path; temp files or locks not cleaned up on every exit path.
- [ ] A non-atomic overwrite of a file other processes read; concurrent runs unguarded, or
      a lock broken by age alone.
- [ ] `eval`, `sh -c "$var"` or unquoted interpolation of untrusted text.
- [ ] `rm -rf` on a variable that can be empty; `cd` without a failure check.
- [ ] `curl` without `-f`; background jobs whose exit status is never checked.
- [ ] GNU-only or bash 4+ idioms on a path that CI runs on macOS.
- [ ] A new `# shellcheck disable=` without a code and reason.
- [ ] An AC has no test, or the test checks only the exit code and not the effect.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**While making a script portable you hit the BSD/GNU and runner differences that bite every later script author in this repo.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
