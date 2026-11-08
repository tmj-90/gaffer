import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent ISOLATION POSTURE the Settings page shows as a read-only line in its
 * Sandbox group: which OS sandbox provider is in force, whether this host can supply
 * it, whether it is required (the default for every agent launch) or opted out
 * (GAFFER_STRICT_REQUIRE=0 in the environment), and the fix when it is missing.
 *
 * The runner owns the probe (runner/lib/sandbox.sh gaffer_sandbox_probe, printed as
 * JSON by `runner/gaffer sandbox-status`); this module only runs it and keeps the last
 * answer. Read at startup and again on each settings load, so starting the docker
 * daemon or building the images shows up on the next visit without a restart.
 */
export interface IsolationStatus {
  /** The provider in force: SANDBOX_PROVIDER, or the one the runner auto-detected. */
  readonly provider: string;
  /** True when this host can wrap an agent in it right now. */
  readonly available: boolean;
  /** True when every agent launch needs it (the default). */
  readonly required: boolean;
  /** True when the operator opted out with GAFFER_STRICT_REQUIRE=0 in the environment. */
  readonly optedOut: boolean;
  /** What this host lacks, in words ("" when available). */
  readonly missing: string;
  /** The fix for it ("" when available). */
  readonly fix: string;
  /** Set when the probe itself could not be run or read. */
  readonly error?: string;
}

/** Env var overriding the probe command as a JSON argv (tests point it at a stub). */
export const GAFFER_SANDBOX_STATUS_CMD_ENV = "GAFFER_SANDBOX_STATUS_CMD";

/**
 * Default probe: `bash <monorepo>/runner/gaffer sandbox-status`, resolved relative to
 * this compiled module (packages/dispatch/dist/api → four levels up), the same way
 * planBuild finds decompose.mjs.
 */
export const DEFAULT_SANDBOX_STATUS_ARGV: readonly string[] = [
  "bash",
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "runner", "gaffer"),
  "sandbox-status",
];

/** The probe asks `docker info`; a hung daemon must not hang the Settings page. */
const PROBE_TIMEOUT_MS = 15_000;

/** The probe's argv: the env override when it parses as a non-empty string[], else the default. */
export function sandboxStatusArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env[GAFFER_SANDBOX_STATUS_CMD_ENV] ?? "").trim();
  if (raw !== "") {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"))
        return v as string[];
    } catch {
      /* fall through to the default */
    }
  }
  return [...DEFAULT_SANDBOX_STATUS_ARGV];
}

/** Parse the probe's stdout (its last JSON line) into a status, or null when it is not one. */
export function parseIsolationStatus(text: string): IsolationStatus | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || typeof v["provider"] !== "string") return null;
  return {
    provider: v["provider"],
    available: v["available"] === true,
    required: v["required"] === true,
    optedOut: v["optedOut"] === true,
    missing: typeof v["missing"] === "string" ? v["missing"] : "",
    fix: typeof v["fix"] === "string" ? v["fix"] : "",
  };
}

/** What the Settings line shows when the probe could not answer. */
function unknownStatus(error: string): IsolationStatus {
  return {
    provider: "unknown",
    available: false,
    required: true,
    optedOut: false,
    missing: "",
    fix: "",
    error,
  };
}

let last: IsolationStatus | null = null;
let inflight: Promise<IsolationStatus> | null = null;

/**
 * How long a settings load waits for a probe that has not answered yet. The probe can
 * take seconds on a host whose docker CLI is slow to answer `docker info`; a request
 * that waited the probe's full 15 s timed out the API's own clients (a 5 s test
 * timeout on a loaded CI runner). Past this the load answers with the posture it has,
 * or "still probing", and the finished probe shows on the next load.
 */
const SETTINGS_PROBE_WAIT_MS = 1_500;

/** What the Settings line shows while the first probe is still running. */
const PROBING = "the isolation probe is still running; reload in a moment";

/** The last probe answer (null before the first one finished). */
export function lastIsolationStatus(): IsolationStatus | null {
  return last;
}

/**
 * Run the probe once (never rejects) and remember its answer. Concurrent callers share
 * one run: a settings load during the startup probe does not start a second docker
 * probe beside it.
 */
export function refreshIsolationStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IsolationStatus> {
  if (inflight) return inflight;
  const [bin, ...args] = sandboxStatusArgv(env);
  inflight = new Promise((resolve) => {
    execFile(
      bin!,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8" },
      (err, stdout) => {
        const parsed = parseIsolationStatus(String(stdout ?? ""));
        last =
          parsed ??
          unknownStatus(
            err
              ? `the isolation probe failed: ${err.message.split("\n")[0]}`
              : "the isolation probe printed no status",
          );
        inflight = null;
        resolve(last);
      },
    );
  });
  return inflight;
}

/**
 * The posture a settings load reports, never waiting longer than `waitMs` for the
 * probe. A probe is always started (or joined) so the answer is fresh on the next load;
 * when it does not finish in time the load answers with the last answer, or, before
 * any probe has finished, with "still probing" (`error` set, provider "unknown").
 * `fresh` (after a settings write that can change the posture) ignores the last answer
 * and waits for the new probe up to `waitMs`.
 */
export function isolationStatusForRequest(
  env: NodeJS.ProcessEnv = process.env,
  opts: { waitMs?: number; fresh?: boolean } = {},
): Promise<IsolationStatus> {
  const waitMs = opts.waitMs ?? SETTINGS_PROBE_WAIT_MS;
  const probe = refreshIsolationStatus(env);
  const fallback = (): IsolationStatus =>
    (opts.fresh ? null : last) ?? last ?? unknownStatus(PROBING);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback());
    }, waitMs);
    void probe.then((status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(status);
    });
  });
}

/** Test seam: forget the remembered answer. */
export function resetIsolationStatus(): void {
  last = null;
  inflight = null;
}
