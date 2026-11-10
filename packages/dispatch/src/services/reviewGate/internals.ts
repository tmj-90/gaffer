/**
 * The private state of the ReviewGateService facade, handed to the modules under
 * services/reviewGate/ that hold its method bodies. Built once in the facade's
 * constructor from ReviewGateServiceDeps; nothing outside the review gate sees it.
 */
import type { Db } from "../../db/connection.js";
import type { AcRepository } from "../../repositories/acRepository.js";
import type { EvidenceRepository } from "../../repositories/evidenceRepository.js";
import type { TicketRepository } from "../../repositories/ticketRepository.js";
import type { AgentRepository } from "../../repositories/agentRepository.js";
import type { TransitionService } from "../transitionService.js";
import type { TicketService } from "../ticketService.js";
import type { Clock } from "../../util/clock.js";
import type { Ticket } from "../../domain/types.js";
import type { ObservedRisk } from "../observedRisk.js";
import type { ApprovalShaResolver, ReviewGateServiceDeps } from "../reviewGateService.js";

export interface ReviewGateInternals {
  readonly db: Db;
  readonly clock: Clock;
  readonly tickets: TicketRepository;
  readonly acs: AcRepository;
  readonly evidence: EvidenceRepository;
  readonly transitions: TransitionService;
  readonly ticketSvc: TicketService;
  readonly maxAttemptsOf: () => number;
  /** The reject cap now: `maxAttemptsOf()` read per use, never cached. */
  readonly maxAttempts: number;
  readonly testerLaneAppliesFn: ((ticket: Ticket) => boolean) | undefined;
  readonly runnerTesterLaneFn: ReviewGateServiceDeps["runnerTesterLane"];
  readonly agents: AgentRepository | undefined;
  readonly requireRegisteredAgentApprover: boolean;
  readonly onTicketParked: ((ticket: Ticket, detail: string) => void) | undefined;
  readonly approvalShaResolver: ApprovalShaResolver | undefined;
  readonly reviewedHeadsResolver: ReviewGateServiceDeps["reviewedHeadsResolver"];
  readonly unavailableWriteReposResolver: ReviewGateServiceDeps["unavailableWriteReposResolver"];
  readonly landedOnDefaultResolver: ReviewGateServiceDeps["landedOnDefaultResolver"];
  readonly changeOnRefsResolver: ReviewGateServiceDeps["changeOnRefsResolver"];
  readonly policyAllowsAgentApprove: ((ticket: Ticket) => boolean) | undefined;
  readonly observedRiskResolver: ((ticket: Ticket) => ObservedRisk | null) | undefined;
  /** A person's waiver records the factory's isolation ("none" or the provider). */
  readonly isolationFn: (() => string) | undefined;
}
