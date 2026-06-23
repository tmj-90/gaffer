/**
 * Claude Code hook integration.
 *
 * `memory hooks review-nudge` is invoked as a `Stop` hook: when
 * Claude is about to end the session, this checks whether there are
 * pending drafts and — if so, and we haven't already nudged this
 * session — returns a `{ decision: "block", reason: ... }` JSON
 * payload on stdout. Claude Code interprets that as "don't stop yet,
 * tell the user to consider X first."
 *
 * Closes the dogfood feedback loop the maker called out: drafts get
 * suggested mid-session and then rot because nobody remembers to run
 * `memory review`. The hook nudges exactly once per session
 * (marker file under ~/.memory/hooks/), so it doesn't become a
 * nag loop and Claude can stop cleanly on the second attempt.
 *
 * Pure decision logic lives in `decideNudge` for unit-testability;
 * I/O (stdin parse, marker file, db query) is in `cmdHooksReviewNudge`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NudgeInput {
  readonly pendingDraftCount: number;
  readonly sessionAlreadyNudged: boolean;
  /**
   * When true, the per-session marker is ignored — the hook can nudge
   * any number of times for the same session. Off by default;
   * available for users who want a stricter loop. Wired via env
   * `MEMORY_REVIEW_NUDGE_EVERY_TIME=1`.
   */
  readonly nudgeEveryTime?: boolean;
}

export interface NudgeOutput {
  /** Present when we want Claude to NOT stop. Absent → silent pass. */
  readonly decision?: "block";
  /** Required when `decision === 'block'`. Plain text Claude shows. */
  readonly reason?: string;
}

/**
 * Pure decision function. Given a snapshot of state, returns the JSON
 * payload to emit on stdout. Empty object `{}` means "no nudge — let
 * Claude stop normally." A block returns the prompt text Claude will
 * surface to the user.
 *
 * Three outcomes:
 *   - no drafts                → `{}`                (silent pass)
 *   - drafts + already nudged  → `{}`                (don't loop)
 *   - drafts + first nudge      → `{ decision: 'block', reason: ... }`
 *
 * The reason text is deliberately soft: it asks the user to consider
 * review, doesn't demand it. A hard nag would push users to disable
 * the hook entirely.
 */
export function decideNudge(input: NudgeInput): NudgeOutput {
  if (input.pendingDraftCount === 0) return {};
  if (input.sessionAlreadyNudged && !input.nudgeEveryTime) return {};
  const plural =
    input.pendingDraftCount === 1
      ? "is 1 pending lore draft"
      : `are ${input.pendingDraftCount} pending lore drafts`;
  return {
    decision: "block",
    reason:
      `There ${plural} from this session. Ask the user if they want ` +
      "to run `memory review` now to triage them, or leave them " +
      "for later. Don't review without asking — the user is the gate.",
  };
}

/**
 * Filesystem location for per-session nudge markers. Zero-byte files —
 * the existence is the signal. We accept the dir growing over time
 * for v0.1; if it becomes a problem we add a sweep.
 */
export function nudgeMarkerPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, "_");
  return join(homedir(), ".memory", "hooks", `session-${safe}.nudged`);
}

export function sessionAlreadyNudged(sessionId: string): boolean {
  return existsSync(nudgeMarkerPath(sessionId));
}

export function markSessionNudged(sessionId: string): void {
  const path = nudgeMarkerPath(sessionId);
  mkdirSync(join(homedir(), ".memory", "hooks"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(path, "");
}

/**
 * Parse the Claude Code hook JSON from stdin. Tolerant of missing
 * fields — if we can't read a session id, the marker degrades to a
 * literal "unknown" string and we nudge once per "unknown" run
 * (better than spamming).
 */
export interface ParsedHookInput {
  readonly sessionId: string;
  readonly cwd: string | undefined;
}

export function parseHookInput(raw: string): ParsedHookInput {
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj === "object" && obj !== null) {
      const o = obj as Record<string, unknown>;
      const sessionId =
        typeof o["session_id"] === "string" ? (o["session_id"] as string) : "unknown";
      const cwd = typeof o["cwd"] === "string" ? (o["cwd"] as string) : undefined;
      return { sessionId, cwd };
    }
  } catch {
    // Fall through to default.
  }
  return { sessionId: "unknown", cwd: undefined };
}

/**
 * Render the `.claude/settings.json` snippet that wires this hook
 * into Claude Code. Returns the JSON string; caller writes it to
 * disk and handles idempotency.
 *
 * Project-local install lands at `.claude/settings.json`; the user
 * scope at `~/.claude/settings.json`. For v0.1 we ship the project
 * variant — users opt in per repo rather than globally.
 */
export function renderHookSettings(): string {
  return (
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "memory hooks review-nudge",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Merge our hook block into an existing settings.json if one exists;
 * otherwise return the fresh shape from `renderHookSettings`.
 *
 * Idempotent: if our exact hook command is already present, returns
 * the input string unchanged so the caller's "did we modify it?"
 * check works.
 */
export function mergeHookSettings(existing: string | null): string {
  if (!existing || existing.trim().length === 0) {
    return renderHookSettings();
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    // Malformed settings.json — refuse to corrupt it. Caller should
    // surface and let the user fix manually.
    throw new Error("memory hooks install: existing .claude/settings.json is not valid JSON");
  }
  const hooks = (parsed["hooks"] as Record<string, unknown> | undefined) ?? {};
  const stopArr = Array.isArray(hooks["Stop"]) ? (hooks["Stop"] as unknown[]) : [];
  // Already present?
  const alreadyPresent = stopArr.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const inner = (entry as Record<string, unknown>)["hooks"];
    if (!Array.isArray(inner)) return false;
    return inner.some((h) => {
      if (!h || typeof h !== "object") return false;
      const cmd = (h as Record<string, unknown>)["command"];
      return cmd === "memory hooks review-nudge";
    });
  });
  if (alreadyPresent) return existing;
  stopArr.push({
    hooks: [{ type: "command", command: "memory hooks review-nudge" }],
  });
  hooks["Stop"] = stopArr;
  parsed["hooks"] = hooks;
  return JSON.stringify(parsed, null, 2) + "\n";
}

export function projectHookSettingsPath(cwd: string = process.cwd()): string {
  return join(cwd, ".claude", "settings.json");
}

/**
 * Read the existing settings.json if present; otherwise return null.
 * Returns the raw text so caller can detect "no change needed".
 */
export function readSettingsFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
