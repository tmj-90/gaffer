#!/usr/bin/env node
// =====================================================================
// Node entrypoint for the worktree-leaf derivation (P4 orchestration).
// The runner's ONLY implementation: tick.sh's WT_ROWS loop derives every
// per-repo leaf through this CLI (the former `tr | sed` twin was deleted;
// runner/test/worktree-key-golden.test.sh pins the output).
//
//   node worktreeKeyCli.js --id <repoId> --name <repoName> --index <n>
//
// Prints the leaf to STDOUT with NO trailing byte (process.stdout.write, NOT
// console.log) so it is byte-identical to the bash `$( … )` capture. Imports
// ONLY ./worktreeKey.js — no CLI framework — so startup stays fast.
//
// FAIL-SOFT: a bad/missing index or any thrown error prints nothing and exits 0;
// the bash caller keeps its `[ -n "$__wt_key" ] || __wt_key="repo$idx"` backstop,
// so a determinism-preserving leaf is always produced.
// =====================================================================

import { worktreeKey } from "./worktreeKey.js";

function flag(argv: string[], name: string): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] ?? "";
  }
  return "";
}

try {
  const argv = process.argv.slice(2);
  const id = flag(argv, "--id");
  const name = flag(argv, "--name");
  const idxRaw = flag(argv, "--index");
  const index = Number.parseInt(idxRaw, 10);
  // A non-numeric index would make "repo<NaN>" — refuse (print nothing, exit 0) so
  // the bash backstop supplies the correct "repo<idx>" instead.
  if (!Number.isInteger(index)) process.exit(0);
  process.stdout.write(worktreeKey(id, name, index));
} catch {
  // FAIL-SOFT — the bash backstop covers a missing leaf.
}
