/**
 * USAGE-WINDOW PAUSE — the dashboard's read of the runner's pause file.
 *
 * When a model call is refused by the plan's usage window or a rate limit, the
 * runner (runner/lib/usage-pause.mjs, the one WRITER) records
 * `$GAFFER_DATA/usage-pause.json` and every admission point waits until it ends.
 * The Health view shows "Paused until <time>: usage limit" from this read so an
 * operator can see why the factory went quiet.
 *
 * The rules mirror usage-pause.mjs readPause exactly:
 *   - path: GAFFER_USAGE_PAUSE_FILE, else `$GAFFER_DATA/usage-pause.json`;
 *   - absent file, or a pause whose end has passed → `{ active: false }`;
 *   - a file that exists but does not parse is ACTIVE until its mtime + the default
 *     pause (GAFFER_USAGE_PAUSE_DEFAULT_MIN, floor 10, default 60), flagged
 *     `unreadable` — fail closed, never a silent "running" over a broken file.
 * Read-only and never throws.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type UsagePauseKind = "usage_limit" | "rate_limit";

export interface UsagePauseView {
  active: boolean;
  paused_until?: string;
  kind?: UsagePauseKind;
  /** "reset" = the CLI printed a reset time; "default" = the configured default wait. */
  basis?: "reset" | "default";
  /** What the CLI said (≤300 chars). */
  message?: string;
  ticket?: number | null;
  unreadable?: boolean;
}

/** Kept in step with usage-pause.mjs (PAUSE_FLOOR_MIN / PAUSE_DEFAULT_MIN / PAUSE_MAX_MIN). */
const FLOOR_MIN = 10;
const DEFAULT_MIN = 60;
const MAX_MIN = 8 * 24 * 60;

export function resolveUsagePausePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.GAFFER_USAGE_PAUSE_FILE ?? "").trim();
  if (explicit) return explicit;
  const dir = (env.GAFFER_DATA ?? "").trim();
  return dir ? join(dir, "usage-pause.json") : null;
}

function defaultMin(env: NodeJS.ProcessEnv): number {
  const raw = (env.GAFFER_USAGE_PAUSE_DEFAULT_MIN ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return DEFAULT_MIN;
  return Math.min(MAX_MIN, Math.max(FLOOR_MIN, Number.parseInt(raw, 10)));
}

export function readUsagePause(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): UsagePauseView {
  const f = resolveUsagePausePath(env);
  if (!f) return { active: false };
  let text: string;
  try {
    text = readFileSync(f, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { active: false };
    text = "";
  }
  let view: UsagePauseView | null = null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const until =
      typeof j.until_ms === "number" && Number.isFinite(j.until_ms)
        ? j.until_ms
        : Date.parse(String(j.paused_until));
    if (Number.isFinite(until)) {
      view = {
        active: until > nowMs,
        paused_until: new Date(until).toISOString(),
        kind: j.kind === "rate_limit" ? "rate_limit" : "usage_limit",
        basis: j.basis === "reset" ? "reset" : "default",
        message: typeof j.message === "string" ? j.message.slice(0, 300) : "",
        ticket: Number.isInteger(j.ticket) ? (j.ticket as number) : null,
      };
    }
  } catch {
    /* unreadable — handled below */
  }
  if (!view) {
    let mtime = nowMs;
    try {
      mtime = statSync(f).mtimeMs;
    } catch {
      /* gone between the read and the stat */
    }
    const until = mtime + defaultMin(env) * 60_000;
    view = {
      active: until > nowMs,
      paused_until: new Date(until).toISOString(),
      kind: "usage_limit",
      basis: "default",
      message: "the pause file could not be read; holding for the default pause",
      ticket: null,
      unreadable: true,
    };
  }
  return view.active ? view : { active: false };
}
