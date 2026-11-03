/**
 * ADAPTIVE TESTER LANE on the facade: the GAFFER_TESTING mode this instance acts on, the
 * lane decision per ticket, the runner's recorded lane and its Health view, and the
 * TESTER FIRST routing of in_review tickets to the tester.
 */
import { type Actor, type Ticket, isActiveTicketRepoRelation } from "../domain/types.js";
import {
  recordRunnerTesterLane as writeRunnerTesterLane,
  runnerLaneNotice,
  type RunnerTesterLane,
} from "../health/runnerTesterLane.js";
import { type TesterRoute } from "./reviewGateService.js";
import type { DispatchInternals } from "./dispatchInternals.js";
import {
  testerLaneFor,
  testerOffNotice,
  testingLaneMode,
  type TesterLaneDecision,
  type TestingLaneMode,
} from "../util/testingLane.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type TesterLaneHost = Pick<
  Dispatch,
  | "db"
  | "repos"
  | "resolveTicket"
  | "reviewGateSvc"
  | "runnerTesterLane"
  | "testerLane"
  | "testerLaneMode"
  | "tickets"
>;
/** The facade's private state these functions read. */
export type TesterLaneInternals = Pick<DispatchInternals, "testingEnabledOverride">;

/**
 * The GAFFER_TESTING setting this instance acts on: the constructor's `testingEnabled`
 * pins it on or off (tests); otherwise the env (`auto` when unset).
 */
export function testerLaneMode(internals: TesterLaneInternals): TestingLaneMode {
  if (internals.testingEnabledOverride !== undefined) {
    return internals.testingEnabledOverride ? "on" : "off";
  }
  return testingLaneMode();
}

/**
 * ADAPTIVE TESTER LANE: is the independent tester lane on for this ticket's
 * repositories, and which write repos have no registered test command? An explicit
 * GAFFER_TESTING wins; the `auto` default is on when every write repo has one.
 */
export function testerLane(
  host: TesterLaneHost,
  ref: string | Ticket,
  mode: TestingLaneMode = host.testerLaneMode(),
): TesterLaneDecision {
  const ticket = typeof ref === "string" ? host.resolveTicket(ref) : ref;
  const writes = host.repos
    .accessLinksForTicket(ticket.id)
    .filter((l) => isActiveTicketRepoRelation(l.relation) && l.access === "write")
    .map((l) => ({ name: l.name, test_command: l.test_command }));
  return testerLaneFor(mode, writes);
}

/**
 * LANE-SETTING CONSISTENCY: record the GAFFER_TESTING mode this process decides under as
 * the runner's (its CLI's tester-route calls, see health/runnerTesterLane.ts). Fail-soft.
 */
export function recordRunnerTesterLane(host: TesterLaneHost): boolean {
  return writeRunnerTesterLane(host.db, host.testerLaneMode());
}

/**
 * The runner's recorded lane for one ticket, when it differs from this process's mode:
 * the mode, when it was recorded, and whether the tester gates the ticket under it (the
 * same rule as laneApplies: acceptance always, a testable ticket when its lane is on).
 * Null when the runner recorded nothing or reads the same mode.
 */
export function runnerTesterLaneFor(
  host: TesterLaneHost,
  ref: string | Ticket,
): (RunnerTesterLane & { on: boolean; gates: boolean }) | null {
  const runner = host.runnerTesterLane();
  if (!runner || runner.mode === host.testerLaneMode()) return null;
  const ticket = typeof ref === "string" ? host.resolveTicket(ref) : ref;
  const on = host.testerLane(ticket, runner.mode).on;
  const gates = ticket.acceptance === 1 || (ticket.can_be_tested === 1 && on);
  return { ...runner, on, gates };
}

/**
 * ADAPTIVE TESTER LANE on Health: the setting, and under the `auto` default each
 * registered (visible) repository with no test command, with the one-line notice
 * that says the tester is off there and why.
 */
export function testerLaneHealth(host: TesterLaneHost): {
  mode: TestingLaneMode;
  repos_without_test_command: string[];
  notices: string[];
  runner: RunnerTesterLane | null;
  runner_differs: boolean;
} {
  const mode = host.testerLaneMode();
  const missing =
    mode === "auto"
      ? host.repos
          .list(false)
          .filter((r) => !(r.test_command ?? "").trim())
          .map((r) => r.name)
      : [];
  // LANE-SETTING CONSISTENCY: the runner's recorded mode, and a notice when it differs.
  const runner = host.runnerTesterLane();
  const differs = runner !== null && runner.mode !== mode;
  return {
    mode,
    repos_without_test_command: missing,
    notices: [
      ...(differs && runner ? [runnerLaneNotice(mode, runner)] : []),
      ...missing.map(testerOffNotice),
    ],
    runner,
    runner_differs: differs,
  };
}

/**
 * TESTER FIRST: how many in_review tickets the runner's tester pass would send to the
 * tester now (the same decision as routeToTester: the tester gates them, no PASS covers
 * their head, their heads read and any required CI passed): a push after a PASS, a
 * conflict reopen, a delivery the runner could not route. Poll for work counts them so
 * a tick runs the sweep, and never counts one the sweep would leave. Reads git per
 * ticket the tester gates.
 */
export function pendingTesterRoutes(host: TesterLaneHost): number {
  let n = 0;
  for (const t of host.tickets.list("in_review")) {
    try {
      if (host.reviewGateSvc.laneApplies(t) && host.reviewGateSvc.testerRoutePlan(t).route) n++;
    } catch {
      /* a ticket that cannot be read is not counted */
    }
  }
  return n;
}

/**
 * TESTER FIRST: send in_review tickets the tester gates (and has not passed on their
 * head) to it before a person reviews them: one ticket, or every in_review ticket. The
 * runner's call (system) or an admin's.
 */
export function routeToTester(
  host: TesterLaneHost,
  ref: string | null,
  actor: Actor,
): TesterRoute[] {
  return ref === null
    ? host.reviewGateSvc.routeAllToTester(actor)
    : [host.reviewGateSvc.routeToTester(ref, actor)];
}
