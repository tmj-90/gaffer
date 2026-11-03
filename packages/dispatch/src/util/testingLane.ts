import type { Actor } from "../domain/types.js";

/**
 * BBT-001 global toggle, as the operator set it. `GAFFER_TESTING` is read the same
 * env-driven way as the other autonomy/idle flags:
 *   on    "1" / "true" / "yes" / "on" (case-insensitive): every testable ticket is tested.
 *   off   "0" / "false" / "no" / "off", or any other value: only an epic's acceptance
 *         ticket is tested (acceptance is a gate, not an option).
 *   auto  unset, empty or "auto" (the default): the lane is on for a ticket when every
 *         write repository it delivers to has a registered test command, and off where
 *         one has none. A tester PASS without a clean replay of the repository's own test
 *         command is held as unverified, so the lane only runs where a PASS can stand.
 */
export type TestingLaneMode = "on" | "off" | "auto";

export function testingLaneMode(env: NodeJS.ProcessEnv = process.env): TestingLaneMode {
  const raw = (env.GAFFER_TESTING ?? "").trim().toLowerCase();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return "on";
  return "off";
}

/**
 * Is the testing lane switched ON explicitly (GAFFER_TESTING on)? False for `off` and for
 * the `auto` default; callers that decide for one ticket use {@link testerLaneFor}.
 */
export function isTestingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return testingLaneMode(env) === "on";
}

/** The write repos of a ticket, as {@link testerLaneFor} reads them. */
export interface LaneRepo {
  readonly name: string;
  readonly test_command: string | null;
}

/** Whether the tester lane is on for one ticket, and why it is off when it is. */
export interface TesterLaneDecision {
  readonly mode: TestingLaneMode;
  /** The lane is on for this ticket's repositories. */
  readonly on: boolean;
  /** Write repos with no registered test command (the reason an `auto` lane is off). */
  readonly missing_test_command: readonly string[];
}

/**
 * The lane for one ticket: an explicit `on`/`off` (or a per-instance override) wins;
 * `auto` is on when the ticket has at least one write repo and every one has a
 * non-empty registered test command.
 */
export function testerLaneFor(
  mode: TestingLaneMode,
  writeRepos: readonly LaneRepo[],
): TesterLaneDecision {
  const missing = writeRepos.filter((r) => !(r.test_command ?? "").trim()).map((r) => r.name);
  if (mode !== "auto") return { mode, on: mode === "on", missing_test_command: missing };
  return {
    mode,
    on: writeRepos.length > 0 && missing.length === 0,
    missing_test_command: missing,
  };
}

/** The one-line notice a Review packet and Health show when `auto` leaves the lane off. */
export function testerOffNotice(repo: string): string {
  return `independent tester off: no test command registered for ${repo}`;
}

/**
 * BBT-001: derive the PROVENANCE of a tester verdict from the recording actor's
 * type, so the dashboard can attribute a pass/fail ("by agent | human | system")
 * instead of surfacing an unattributed verdict. `admin` collapses to `human` (a
 * person), `agent` is the factory tester, `system` is an automated/seam recording.
 */
export function testerProvenance(actor: Actor): "agent" | "human" | "system" {
  switch (actor.type) {
    case "agent":
      return "agent";
    case "system":
      return "system";
    case "human":
    case "admin":
      return "human";
  }
}
