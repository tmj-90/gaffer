import type { IncomingMessage } from "node:http";

import type { Dispatch } from "../core.js";
import type { PrincipalView } from "../repositories/principalRepository.js";
import { type AccessAction, isScoped } from "../services/accessScope.js";
import { principalScope } from "../services/principalService.js";
import { readJsonBody } from "./http.js";
import { apiPrincipal } from "./routes/context.js";

/**
 * PRINCIPAL SCOPES — the dispatch API's authorisation layer for named principals.
 *
 * Runs after authentication and the read-only gate (server.ts), for every request a
 * named principal sends (the shared operator token is the operator and skips it).
 * It maps the request to one {@link AccessAction} and asks the facade
 * ({@link Dispatch.assertPrincipalAccess}, which asks services/accessScope.ts, the
 * evaluation the CLI and the factory MCP mount share). A refusal is 403 SCOPE_DENIED
 * with details naming the scope.
 *
 * WRITES (every non-GET):
 *   - `/tickets/:ref/…`                  → a write to that ticket;
 *   - `/tickets/:ref/repo-access|work-repos|mono-fallback` → also a repo link (admin);
 *   - `/tickets/:ref/dependencies[/:other]` → also a read of the other ticket;
 *   - `/tickets/:ref/scopes|primary-scope` → also factory-wide when scoped (epic wiring);
 *   - `POST /tickets`                     → a new ticket on every repo its body names
 *                                           (read or write); with scope nodes, as above;
 *   - `/claims/:id/…`                     → a write to the claim's ticket;
 *   - `POST /decisions` with a ticket, `/decisions/:id/…` → a write to its ticket(s);
 *   - `/repos/:id/…`                      → a repo-level write to that repo (admin);
 *   - `POST /repos/onboard`, `/api/settings`, `/api/idle-loops`, `/api/autonomy/…`
 *                                         → a factory-wide repo-level write (admin);
 *   - everything else                     → a factory-wide write.
 * READS (GET/HEAD) — only for a SCOPED principal (an unscoped one reads what it reads today):
 *   - `/tickets/:ref/…`                   → a read of that ticket;
 *   - `/tickets`, `/tickets/details`, `/api/board`, `/api/human-queue`, `/claims`,
 *     `/decisions`, `/api/events/stream`  → filtered to its tickets by the route;
 *   - `/scope/repos?all=1`                → filtered to the repos it reaches by the route;
 *   - `/decisions/:id`                    → a read of its ticket(s);
 *   - `/api/whoami`, `/api/squad`, `/api/club`, `/api/openapi.json`, `/repositories`,
 *     `/agents`                           → no ticket content: open;
 *   - everything else                     → a factory-wide read (refused).
 */
export async function authorizePrincipalRequest(
  wg: Dispatch,
  principal: PrincipalView,
  method: string,
  segments: readonly string[],
  req: IncomingMessage,
): Promise<void> {
  const check = (action: AccessAction): void => wg.assertPrincipalAccess(principal, action);
  const ticket = (ref: string, kind: "read_ticket" | "write_ticket"): void =>
    check({ kind, ticket: wg.scopeTicket(ref) });
  const [head, second, third] = segments;
  const read = method === "GET" || method === "HEAD";
  const scopeLink = (): void => {
    if (isScoped(principalScope(principal))) check({ kind: "write_factory" });
  };

  if (read) {
    if (!isScoped(principalScope(principal))) return;
    switch (head) {
      case "tickets":
        // The batched detail read is filtered to its tickets by the route.
        if (second === "details" && segments.length === 2) return;
        if (second !== undefined) ticket(second, "read_ticket");
        return;
      case "scope":
        // Every repo's grounds in one read: filtered to the repos it reaches by the route.
        if (
          second === "repos" &&
          segments.length === 2 &&
          new URL(req.url ?? "/", "http://localhost").searchParams.get("all") === "1"
        ) {
          return;
        }
        break;
      case "claims":
        if (second === undefined) return;
        break;
      case "decisions":
        if (second === undefined) return;
        if (segments.length === 2) return decision(wg, second, "read_ticket", check);
        break;
      case "repositories":
      case "agents":
        if (segments.length === 1) return;
        break;
      case "api":
        if (
          segments.length === 2 &&
          ["whoami", "squad", "club", "openapi.json", "board", "human-queue"].includes(second ?? "")
        ) {
          return;
        }
        // The live feed: filtered to its tickets' events by the route.
        if (segments.length === 3 && second === "events" && third === "stream") return;
        break;
      default:
        break;
    }
    return check({ kind: "read_factory" });
  }

  switch (head) {
    case "tickets": {
      if (second === undefined) {
        // A new ticket: the repos it would deliver to. Read from the body the route
        // parses next (readJsonBody reads a request once and caches it).
        const body = (await readJsonBody(req)) as {
          repo?: unknown;
          repoIds?: Array<{ repo_id?: unknown; access?: unknown }>;
          scopeNodeIds?: unknown;
        };
        // Every repo it names, read access included: the delivery agent reads a read
        // repo, so a ticket on an in-scope repo that reads another would carry that
        // repo's code to a principal that may not see it.
        const names: string[] = [];
        if (typeof body.repo === "string") names.push(body.repo);
        if (Array.isArray(body.repoIds)) {
          for (const r of body.repoIds) {
            if (r && typeof r.repo_id === "string") names.push(r.repo_id);
          }
        }
        check({ kind: "create_ticket", repos: names.map((n) => repoId(wg, n)) });
        // Placing it on the map or in an epic is the operator's (see scope links below).
        if (Array.isArray(body.scopeNodeIds) && body.scopeNodeIds.length > 0) {
          return scopeLink();
        }
        return;
      }
      ticket(second, "write_ticket");
      // A ticket's place on the map and in an epic: joining or leaving an epic rewires
      // its acceptance ticket's dependencies (another ticket), so it is a factory-wide
      // change for a scoped principal (an unscoped one is unaffected).
      if (third === "scopes" || third === "primary-scope") return scopeLink();
      // A dependency names a second ticket: it must be one the principal may see, or an
      // edge would read another ticket's title and status by number (and removing the
      // operator's edge would let its ticket start before one it cannot see).
      if (third === "dependencies") {
        const other =
          segments[3] ??
          (((await readJsonBody(req)) as { depends_on?: unknown }).depends_on as unknown);
        if (typeof other === "string" || typeof other === "number") {
          ticket(String(other), "read_ticket");
        }
        return;
      }
      if (third === "repo-access" || third === "work-repos" || third === "mono-fallback") {
        const body = (await readJsonBody(req)) as { repo_id?: unknown; repos?: unknown };
        const named: string[] = [];
        if (typeof body.repo_id === "string") named.push(body.repo_id);
        if (Array.isArray(body.repos)) {
          for (const r of body.repos as unknown[]) {
            if (typeof r === "string") named.push(r);
            else if (r && typeof (r as { repo_id?: unknown }).repo_id === "string") {
              named.push((r as { repo_id: string }).repo_id);
            }
          }
        }
        const repos =
          named.length > 0 ? named.map((n) => repoId(wg, n)) : wg.scopeTicket(second).repos;
        return check({ kind: "write_repo", repos });
      }
      return;
    }
    case "claims": {
      if (second !== undefined) {
        const claim = wg.claimsRepo.findById(second);
        if (claim) return ticket(claim.ticket_id, "write_ticket");
      }
      return check({ kind: "write_factory" });
    }
    case "decisions": {
      if (second === undefined) {
        const body = (await readJsonBody(req)) as { ticket_id?: unknown };
        if (typeof body.ticket_id === "string") return ticket(body.ticket_id, "write_ticket");
        return check({ kind: "write_factory" });
      }
      return decision(wg, second, "write_ticket", check);
    }
    case "repos": {
      if (second === "onboard") return check({ kind: "write_repo" });
      if (second !== undefined) return check({ kind: "write_repo", repos: [repoId(wg, second)] });
      return check({ kind: "write_factory" });
    }
    case "api": {
      if (second === "settings" || second === "idle-loops" || second === "autonomy") {
        return check({ kind: "write_repo" });
      }
      // Principals are managed by the shared operator token only (refused in the route).
      if (second === "principals") return;
      return check({ kind: "write_factory" });
    }
    default:
      return check({ kind: "write_factory" });
  }
}

/** A repo name or id → its id (an unknown one is kept: it can never be inside a scope). */
function repoId(wg: Dispatch, ref: string): string {
  return (wg.repos.findById(ref) ?? wg.repos.findByName(ref))?.id ?? ref;
}

/** A decision's tickets: every linked ticket must pass; none linked ⇒ factory-wide. */
function decision(
  wg: Dispatch,
  decisionId: string,
  kind: "read_ticket" | "write_ticket",
  check: (a: AccessAction) => void,
): void {
  const ids = wg.decisionTicketIds(decisionId);
  if (ids.length === 0)
    return check({ kind: kind === "read_ticket" ? "read_factory" : "write_factory" });
  for (const id of ids) check({ kind, ticket: wg.scopeTicket(id) });
}

/**
 * The ticket filter for the current request: null when the caller is not a scoped
 * principal (no filtering), else a predicate the list routes apply.
 */
export function requestTicketFilter(wg: Dispatch): ((ticketId: string) => boolean) | null {
  const p = apiPrincipal();
  return p ? wg.ticketVisibility(p) : null;
}

/**
 * The repositories a scoped principal reaches: its repo scope, plus every repo linked
 * to a ticket in its ticket scope. Null when the caller is not a scoped principal.
 */
export function requestRepoFilter(wg: Dispatch): ((repoId: string) => boolean) | null {
  const p = apiPrincipal();
  const scope = p ? principalScope(p) : null;
  if (!p || !isScoped(scope)) return null;
  const ids = new Set<string>(scope.repos ?? []);
  for (const t of scope.tickets ?? []) for (const r of wg.repos.listForTicket(t)) ids.add(r.id);
  return (repoId: string) => ids.has(repoId);
}
