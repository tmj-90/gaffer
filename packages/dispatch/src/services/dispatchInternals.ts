import type { Notifier } from "../notify/types.js";
import type { CodeIndexReader } from "./codeIndexReader.js";
import type { GitRunner } from "./diffService.js";

/**
 * The private state of a {@link Dispatch} instance that the core services read: the
 * facade (core.ts) holds one of these and hands it, beside the instance itself, to the
 * service functions whose bodies used to be its private members. Nothing outside the
 * facade and those functions sees it.
 */
export interface DispatchInternals {
  /**
   * Git runner used to compute diff-in-review. Injectable so tests can drive the
   * diff endpoint without a real repo on disk; undefined means the real `git` spawn.
   */
  readonly gitRunner: GitRunner | undefined;
  /** CHANGE IMPACT: the code index (memory CLI), or null when Memory is not configured. */
  readonly codeIndex: CodeIndexReader | null;
  /**
   * The callers row each ticket's last impact read produced: recorded on the
   * next `ticket.review_opened` so Health can count the reviews that saw callers. A read
   * measurement only (never gating); in-process, so a restart forgets it (the event then
   * records null, "not known").
   */
  readonly lastCallersRow: Map<string, { status: string; round: string | null }>;
  /**
   * H2 human-gate notifier: the opt-in seam that pings the operator when a ticket needs
   * them (enters `in_review`, is parked/`blocked`, or a decision becomes pending).
   * Injectable via the constructor option so tests can pass a fake; defaults to the
   * env-built notifier (a no-op when nothing is configured). Every emit is best-effort
   * and non-blocking (see gateNotifications.emitGate).
   */
  readonly notifier: Notifier;
  /**
   * BBT-001: per-instance override for the `GAFFER_TESTING` toggle. `undefined` (the
   * default) means "read the env"; a boolean pins it for tests so the testing lane can
   * be exercised without touching the process env.
   */
  readonly testingEnabledOverride: boolean | undefined;
}
