/**
 * H2 human-gate notifications: the best-effort pings the operator gets when a ticket
 * needs them (review needed, parked, blocked) or a decision becomes pending. The Dispatch
 * facade calls these after the triggering transaction commits.
 */
import { type Decision, type Ticket } from "../domain/types.js";
import type { NotifyEvent, NotifyKind } from "../notify/types.js";
import type { DispatchInternals } from "./dispatchInternals.js";
import type { Dispatch } from "../core.js";

/** What these functions read from the {@link Dispatch} facade they are handed. */
export type GateHost = Pick<Dispatch, "clock" | "repos">;
/** The facade's private state these functions read. */
export type GateInternals = Pick<DispatchInternals, "notifier">;

/**
 * Fire a human-gate notification, best-effort. Called AFTER the triggering
 * transaction has committed (the transition is already durable), so the emit
 * can never roll the transition back. The {@link Notifier} itself swallows any
 * sink failure with a log, but we also guard the event-building here so a stray
 * read error (e.g. resolving the repo name) can never bubble into the caller.
 *
 * When nothing is configured the notifier is a no-op and `enabled` is false, so
 * we skip building the event entirely (zero overhead on the hot path).
 */
export function emitGate(
  host: GateHost,
  internals: GateInternals,
  kind: NotifyKind,
  ticket: Ticket,
  extra: { detail?: string | undefined; status?: string | undefined } = {},
): void {
  if (!internals.notifier.enabled) return;
  try {
    internals.notifier.notify(buildTicketEvent(host, kind, ticket, extra));
  } catch {
    // Defence in depth: the notifier is contracted not to throw, but a bug in
    // event-building must never break a transition. Swallow — the gate already
    // committed and the dashboard remains the source of truth.
  }
}

/** Fire a decision-pending gate for a raised decision, best-effort. */
export function emitDecisionGate(
  host: Pick<GateHost, "clock">,
  internals: GateInternals,
  decision: Decision,
): void {
  if (!internals.notifier.enabled) return;
  try {
    const url = decisionUrl(decision);
    internals.notifier.notify({
      kind: "decision_pending",
      title: decision.title,
      status: decision.status,
      at: host.clock.now(),
      ...(decision.question ? { detail: decision.question } : {}),
      // AFK-LOOP P1: mirror ticketUrl so a decision ping is one-tap actionable.
      ...(url !== undefined ? { url } : {}),
    });
  } catch {
    // See emitGate — never let a notification break the caller.
  }
}

/** Build the structured {@link NotifyEvent} for a ticket-scoped gate. */
export function buildTicketEvent(
  host: GateHost,
  kind: NotifyKind,
  ticket: Ticket,
  extra: { detail?: string | undefined; status?: string | undefined },
): NotifyEvent {
  const repo = primaryRepoName(host, ticket.id);
  const url = ticketUrl(ticket);
  return {
    kind,
    title: ticket.title,
    status: extra.status ?? ticket.status,
    at: host.clock.now(),
    ...(ticket.number !== null ? { ticket_number: ticket.number } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
  };
}

/** Best-effort primary/first repo name for a ticket, or undefined. */
export function primaryRepoName(
  host: Pick<GateHost, "repos">,
  ticketId: string,
): string | undefined {
  const links = host.repos.accessLinksForTicket(ticketId);
  return links[0]?.name;
}

/**
 * Build a clickable dashboard link for a ticket when `GAFFER_DASHBOARD_URL` is
 * set, so the operator can jump straight to it. Optional — undefined when the
 * base is unconfigured.
 */
export function ticketUrl(ticket: Ticket): string | undefined {
  const base = (process.env.GAFFER_DASHBOARD_URL ?? "").trim();
  if (base === "" || ticket.number === null) return undefined;
  return `${base.replace(/\/+$/, "")}/tickets/${ticket.number}`;
}

/**
 * Build a clickable dashboard link for a raised decision when
 * `GAFFER_DASHBOARD_URL` is set — the decision-gate analogue of
 * {@link ticketUrl}. Decisions surface on the overview, so the link deep-links
 * to the decision by id there. Optional — undefined when the base is
 * unconfigured (degrades gracefully to a URL-less notification).
 */
export function decisionUrl(decision: Decision): string | undefined {
  const base = (process.env.GAFFER_DASHBOARD_URL ?? "").trim();
  if (base === "") return undefined;
  return `${base.replace(/\/+$/, "")}/decisions/${decision.id}`;
}
