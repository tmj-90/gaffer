import { spawnSync } from "node:child_process";
import { platform } from "node:os";

import type { CommandResult, CommandRunner, NotifyEvent, NotifySink } from "../types.js";

/**
 * Desktop notification sink — a native banner on the operator's machine. Uses:
 *   - macOS:  `terminal-notifier` if present, else `osascript` (always present)
 *   - Linux:  `notify-send`
 *
 * The command is run through an injectable {@link CommandRunner} so tests assert
 * the spawned argv without a real binary. If the chosen binary is absent the
 * runner throws (ENOENT) or returns non-zero; the sink degrades gracefully by
 * surfacing a clear error which the {@link CompositeNotifier} swallows-with-log —
 * a missing notifier binary must never break a transition.
 */
export class DesktopSink implements NotifySink {
  readonly name = "desktop";

  constructor(
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly os: NodeJS.Platform = platform(),
  ) {}

  async deliver(event: NotifyEvent): Promise<void> {
    const { command, args } = this.commandFor(event);
    const result = this.runner(command, args);
    if (result.status !== 0) {
      throw new Error(
        `desktop notifier '${command}' exited ${result.status ?? "null"}: ${result.stderr.trim()}`,
      );
    }
  }

  /** Resolve the platform notifier command + args for an event. */
  private commandFor(event: NotifyEvent): { command: string; args: string[] } {
    const title = renderTitle(event);
    const body = renderBody(event);
    if (this.os === "darwin") {
      // Prefer terminal-notifier (richer); fall back to the always-present
      // osascript so macOS never silently no-ops when the brew tool is absent.
      if (hasBinary("terminal-notifier")) {
        return { command: "terminal-notifier", args: ["-title", title, "-message", body] };
      }
      const script = `display notification ${quoteAppleScript(body)} with title ${quoteAppleScript(title)}`;
      return { command: "osascript", args: ["-e", script] };
    }
    // Linux (and anything else with notify-send installed).
    return { command: "notify-send", args: [title, body] };
  }
}

/** True iff `bin` resolves on PATH (best-effort `command -v`). */
function hasBinary(bin: string): boolean {
  const res = spawnSync("command", ["-v", bin], { shell: true });
  return res.status === 0;
}

/** Default runner: a synchronous spawn. Throws on ENOENT (missing binary). */
const defaultCommandRunner: CommandRunner = (command, args): CommandResult => {
  const res = spawnSync(command, [...args], { encoding: "utf8" });
  if (res.error) throw res.error;
  return { status: res.status, stderr: res.stderr ?? "" };
};

/** One-line banner title. */
export function renderTitle(event: NotifyEvent): string {
  const num = event.ticket_number !== undefined ? ` #${event.ticket_number}` : "";
  return `Gaffer: ${HEADINGS[event.kind]}${num}`;
}

/** Banner body. */
export function renderBody(event: NotifyEvent): string {
  const parts = [event.title, event.detail].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" — ") : (event.status ?? event.kind);
}

const HEADINGS: Record<NotifyEvent["kind"], string> = {
  review_needed: "review needed",
  ticket_blocked: "ticket blocked",
  ticket_parked: "ticket parked",
  decision_pending: "decision pending",
};

/** Escape a string for safe embedding in an AppleScript double-quoted literal. */
function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
