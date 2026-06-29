import type { RunArgsOptions } from "../../adapters/commandRunner.js";

/**
 * Bounded-run defaults shared by every oracle. A tool that overruns the wall
 * clock or floods stdout is killed by `execFileSync` and surfaces as a non-zero
 * exit, which the adapters treat as "no findings" rather than a crash.
 */
export const ORACLE_RUN_OPTIONS: RunArgsOptions = {
  // Generous but finite: a typecheck/lint over a large repo can be slow, but it
  // must never wedge an idle tick forever.
  timeoutMs: 120_000,
  // 32 MiB of JSON is far more than any sane finding set; beyond it we'd rather
  // error (→ fallback) than buffer unbounded.
  maxBuffer: 32 * 1024 * 1024,
};

/**
 * Parse JSON defensively. Tools sometimes prefix JSON with a banner line or emit
 * nothing on a clean run; this returns `undefined` (never throws) when the text
 * is not parseable as JSON, and tolerates a single leading non-JSON line by
 * slicing from the first `{`/`[`.
 */
export function safeJsonParse<T = unknown>(text: string): T | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const direct = tryParse<T>(trimmed);
  if (direct !== undefined) return direct;

  // Some tools print a warning/banner before the JSON payload. Retry from the
  // first opening bracket/brace.
  const start = firstJsonStart(trimmed);
  if (start > 0) return tryParse<T>(trimmed.slice(start));
  return undefined;
}

function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function firstJsonStart(text: string): number {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}
