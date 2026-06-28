import { type Db, inTransaction } from "../db/connection.js";
import { type Actor, type Decision, type DecisionSeverity } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { DecisionRepository } from "../repositories/decisionRepository.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import type { Notifier } from "../notify/types.js";

/** Input for resolving a decision via the human surface. */
export interface ResolveDecisionInput {
  decisionId: string;
  status: "accepted" | "rejected";
  answer?: string | undefined;
  rationale?: string | undefined;
}

export interface DecisionServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly decisions: DecisionRepository;
  readonly notifier: Notifier;
  /** Called after a decision is created so the facade can emit a gate notification. */
  readonly onDecisionCreated?: (decision: Decision) => void;
}

export class DecisionService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly decisions: DecisionRepository;
  private readonly notifier: Notifier;
  private readonly onDecisionCreated: ((decision: Decision) => void) | undefined;

  constructor(deps: DecisionServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.decisions = deps.decisions;
    this.notifier = deps.notifier;
    this.onDecisionCreated = deps.onDecisionCreated;
  }

  createDecision(
    input: { title: string; question: string; severity?: DecisionSeverity; ticketId?: string },
    actor: Actor,
  ): Decision {
    const now = this.clock.now();
    const decision = inTransaction(this.db, () => {
      const created: Decision = {
        id: newId(),
        title: input.title,
        question: input.question,
        rationale: null,
        status: input.severity === "human_required" ? "human_required" : "requested",
        decision_type: "product",
        severity: input.severity ?? "human_preferred",
        proposed_answer: null,
        proposed_by: null,
        confidence: null,
        resolved_answer: null,
        resolved_by: null,
        resolved_at: null,
        memory_record_id: null,
        created_at: now,
        updated_at: now,
      };
      this.decisions.insert(created);
      if (input.ticketId) {
        this.decisions.link(input.ticketId, created.id, "blocks", now);
      }
      writeEvent(this.db, {
        entity_type: "decision",
        entity_id: created.id,
        actor,
        event_type: "decision.created",
        payload: { title: created.title, severity: created.severity },
      });
      return created;
    });
    // H2: a freshly raised decision is a human gate (clarification/decision pending
    // a human answer). Emit after the transaction commits, best-effort.
    this.onDecisionCreated?.(decision);
    return decision;
  }

  listPendingDecisions(): Decision[] {
    return this.decisions.listPending();
  }

  /**
   * Resolve a decision (human surface): set its terminal status + resolved_*,
   * record the answer/rationale and append an event. Refuses to re-resolve an
   * already-terminal decision.
   */
  resolveDecision(input: ResolveDecisionInput, actor: Actor): Decision {
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const decision = this.decisions.findById(input.decisionId);
      if (!decision) throw notFound("decision", input.decisionId);
      if (
        decision.status === "accepted" ||
        decision.status === "rejected" ||
        decision.status === "superseded"
      ) {
        throw new DispatchError(
          "STATE_CONFLICT",
          `Decision is already '${decision.status}' and cannot be resolved again.`,
          { status: decision.status },
        );
      }
      const ok = this.decisions.resolve(
        decision.id,
        input.status,
        input.answer ?? null,
        input.rationale ?? null,
        actor.id ?? actor.type,
        now,
      );
      if (!ok) {
        throw new DispatchError("CONCURRENCY_CONFLICT", "Decision changed concurrently; retry.");
      }
      writeEvent(this.db, {
        entity_type: "decision",
        entity_id: decision.id,
        actor,
        event_type: "decision.resolved",
        payload: { status: input.status, answer: input.answer ?? null },
      });
      return this.decisions.findById(decision.id)!;
    });
  }
}
