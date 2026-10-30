import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Ask the LIVE safety hook (runner/safety-hook.mjs, the PreToolUse hook every
 * factory agent runs under) for its verdict on one tool call.
 *
 * Why: crew's own classifiers (`classifyCommand`, `checkFileWrite`,
 * `checkBranchPolicy`) evaluate `safety_policy.yaml`, which the live hook never
 * reads. They are ADVISORY. The two disagree in both directions — a raw
 * `sqlite3 dispatch.sqlite 'delete …'` is allowed by the policy yet blocked by
 * the hook, while a policy `needs_approval` (e.g. `docker compose down -v`) or a custom
 * `deny` entry is NOT enforced at runtime. Every `crew safety check` / MCP check
 * therefore reports the enforced verdict next to the advisory one.
 *
 * Read-only: the hook only decides. GAFFER_DATA is stripped from its env so the
 * check never writes the factory's safety-blocks / tool-metrics ledgers.
 */
export interface LiveHookVerdict {
  /** False when the hook script could not be found or run (no verdict). */
  available: boolean;
  /** True = the hook would BLOCK this call (exit 2); null when unavailable. */
  blocked: boolean | null;
  /** The hook's block reason (its stderr), or why no verdict was available. */
  reason: string | null;
  /** The hook script consulted. */
  hookPath: string;
}

export type LiveHookCall =
  { tool: "Bash"; command: string } | { tool: "Write"; filePath: string; writeRoots: string[] };

/**
 * The hook script path: `GAFFER_SAFETY_HOOK` when set, else the mono-repo's
 * runner/safety-hook.mjs (four levels up from both src/safety and dist/safety).
 */
export function liveHookPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GAFFER_SAFETY_HOOK?.trim();
  if (override) return override;
  return fileURLToPath(new URL("../../../../runner/safety-hook.mjs", import.meta.url));
}

export function checkWithLiveHook(
  call: LiveHookCall,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): LiveHookVerdict {
  const env = opts.env ?? process.env;
  const hookPath = liveHookPath(env);
  if (!existsSync(hookPath)) {
    return {
      available: false,
      blocked: null,
      reason: `live safety hook not found at ${hookPath} (set GAFFER_SAFETY_HOOK)`,
      hookPath,
    };
  }
  const payload =
    call.tool === "Bash"
      ? { tool_name: "Bash", tool_input: { command: call.command } }
      : { tool_name: "Write", tool_input: { file_path: call.filePath } };
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.GAFFER_DATA; // never append to the factory's block/metrics ledgers
  if (call.tool === "Write") childEnv.GAFFER_WRITE_ROOTS = call.writeRoots.join("\n");
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: childEnv,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeout: 15_000,
  });
  if (res.error || (res.status !== 0 && res.status !== 2)) {
    const why = res.error ? res.error.message : `exit ${String(res.status)}`;
    return {
      available: false,
      blocked: null,
      reason: `live safety hook failed (${why})`,
      hookPath,
    };
  }
  const blocked = res.status === 2;
  return {
    available: true,
    blocked,
    reason: blocked ? (res.stderr ?? "").trim().slice(0, 500) || "blocked" : null,
    hookPath,
  };
}

/**
 * Combine an advisory three-valued decision with the hook's binary verdict and
 * name the disagreement, if any. `needs_approval` / `denied` while the hook
 * allows is the dangerous direction: nothing gates approval at runtime.
 */
export function compareVerdicts(
  advisory: { outcome: "allowed" | "needs_approval" | "denied" },
  enforced: LiveHookVerdict,
): string | null {
  if (!enforced.available || enforced.blocked === null) return null;
  if (advisory.outcome === "allowed" && enforced.blocked) {
    return "the advisory policy allows this, but the live safety hook BLOCKS it";
  }
  if (advisory.outcome !== "allowed" && !enforced.blocked) {
    return `the advisory policy says ${advisory.outcome}, but the live safety hook ALLOWS it — nothing gates this at runtime`;
  }
  return null;
}
