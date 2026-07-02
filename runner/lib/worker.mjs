// Gaffer worker seam (mjs) — the ONE headless `claude` spawn for the Node runners.
// =====================================================================
// WHAT THIS IS (Spec 3 / Phase 1 — consolidate the invocation, zero behaviour change)
// ---------------------------------------------------------------------
// decompose.mjs (`runClaudeTurn`) and product-owner-run.mjs (`main`) both spawned a
// headless `claude` the SAME way: `spawnSync(bin, argv, { encoding:"utf8", timeout,
// maxBuffer, env })`, where `env` is a credential-stripped copy of the parent env.
// `deliver` encapsulates that ONE spawn boundary so both `.mjs` share a single place
// that performs the invocation.
//
// BYTE-IDENTICAL CONTRACT
// -----------------------
// The seam changes only WHERE the spawn lives, never WHAT is spawned. Each caller
// still builds its OWN argv (they diverge — decompose puts `--mcp-config` first and
// appends `--max-turns`; the product-owner appends `--allowedTools`; product-owner-
// run.test.mjs pins that argv exactly) and its OWN credential-stripped `env` (the two
// `agentChildEnv` allowlists differ — the product-owner also drops outbound-endpoint
// vars), then hands them here. Those genuine per-site differences stay behind the
// `argv` / `env` / `maxBuffer` parameters — they are NOT unified.
//
// Phase 1 returns the RAW spawn result (rc via `.status`, `.stdout`, `.error`) — the
// caller keeps its existing usage-ledger parse of the JSON envelope. Phase 2 (a
// follow-on) moves the Claude-JSON result PARSER behind this same seam, at which
// point `deliver` can return {resultText, usage, capHit, stopReason, rc}.
//
// INTERFACE  {prompt, model, env, mcpConfig, cwd, timeout, maxTurns}
//   The semantic inputs prompt/model/mcpConfig/maxTurns are baked into `argv` by the
//   caller (the two sites' argv shapes are irreconcilable byte-for-byte, so argv is
//   the parameter that carries them). env / cwd / timeout map directly.
//     bin       — the claude binary (CLAUDE_BIN)
//     argv      — the fully-built argv (carries prompt/model/mcpConfig/maxTurns)
//     cwd       interface: cwd
//     timeoutMs interface: timeout
//     maxBuffer — per-site stdout ceiling (16MiB decompose / 32MiB product-owner)
//     env       interface: env — the credential-stripped child env
//   Returns the Node `SpawnSyncReturns` verbatim ({ status, stdout, stderr, error, … }).

import { spawnSync } from "node:child_process";

export function deliver({ bin, argv, cwd, timeoutMs, maxBuffer, env }) {
  return spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer,
    env,
  });
}

export const Worker = { deliver };
