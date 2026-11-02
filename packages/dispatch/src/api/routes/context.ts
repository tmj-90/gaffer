import { AsyncLocalStorage } from "node:async_hooks";

import type { Dispatch } from "../../core.js";
import type { Actor } from "../../domain/types.js";
import type { PrincipalView } from "../../repositories/principalRepository.js";
import type { MemoryReader } from "../memoryReader.js";
import type { MergeRunner } from "../mergeRunner.js";
import type { OnboardRunner } from "../onboard.js";
import type { PlanBuildRunner } from "../planBuild.js";
import type { PollWorkRunner } from "../pollWork.js";
import type { ProductOwnerRunner } from "../productOwner.js";
import type { SpecAuthorRunner } from "../specAuthor.js";
import { DispatchError } from "../../util/errors.js";

/**
 * The actor the API mutates state as when the request carries no per-principal
 * credential: the shared token's single operator identity.
 */
export const API_ACTOR: Actor = { type: "human", id: "dispatch-api" };

/**
 * PER-PRINCIPAL CREDENTIALS: the request-scoped actor. The dispatcher resolves the
 * bearer credential once (server.ts) and runs the route under {@link runWithActor};
 * every route reads {@link apiActor} so an event or evidence row it writes names
 * the principal that acted. Outside a request (tests calling a route directly)
 * it falls back to {@link API_ACTOR}.
 */
interface RequestContext {
  actor: Actor;
  /** The principal the request authenticated as (null: the shared token). */
  principal: PrincipalView | null;
}
const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithActor<T>(
  actor: Actor,
  fn: () => Promise<T>,
  principal: PrincipalView | null = null,
): Promise<T> {
  return requestContext.run({ actor, principal }, fn);
}

export function apiActor(): Actor {
  return requestContext.getStore()?.actor ?? API_ACTOR;
}

/** The principal this request authenticated as, or null (the shared token, or no request). */
export function apiPrincipal(): PrincipalView | null {
  return requestContext.getStore()?.principal ?? null;
}

/**
 * True when the request runs as the shared operator token (or outside any request), not
 * as a named principal. Decided by identity, not by id: a principal whose actor id
 * happens to be the operator's ("dispatch-api") is still that principal.
 */
export function isSharedOperator(): boolean {
  const a = requestContext.getStore()?.actor;
  return a === undefined || a === API_ACTOR;
}

/**
 * The actor for the system/admin-only machine callbacks a full-capability REST caller
 * may drive (mark-merged, reopen-for-review). These are admin acts, one rule for REST
 * and the CLI (whose `--as admin` is refused to a human principal):
 *   - the shared token's operator acts as ADMIN under its own id (`dispatch-api`), as
 *     the tokenless CLI's operator may pass `--as admin`;
 *   - a named principal needs actor type `admin` (a CI bot that records merges is
 *     minted with `principal create <name> --admin`) and acts under its own id; a
 *     `human` principal is refused (403 ACTOR_NOT_PERMITTED), nothing written;
 *   - an agent passes through unchanged and is refused by the service (agents never
 *     merge); a system actor keeps its type.
 */
export function operatorActor(what = "this"): Actor {
  const a = apiActor();
  if (a.type !== "human") return a;
  if (!isSharedOperator()) {
    const p = apiPrincipal();
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      `${what} is an admin act: principal '${p?.name ?? a.id ?? "?"}' is a human principal; use an admin principal (principal create <name> --admin) or the operator token.`,
      { actor_type: a.type, ...(p ? { principal: p.name } : {}) },
    );
  }
  return a.id !== undefined ? { type: "admin", id: a.id } : { type: "admin" };
}

/**
 * The dependency bundle every route module receives. Assembled once per request
 * by the top-level dispatcher (from the handler's captured runners) so the
 * per-resource modules take one typed context instead of a long positional list.
 */
export interface RouteDeps {
  wg: Dispatch;
  runner: ProductOwnerRunner;
  planBuildRunner: PlanBuildRunner;
  mergeRunner: MergeRunner;
  pollWorkRunner: PollWorkRunner;
  memoryReader: MemoryReader;
  onboardRunner: OnboardRunner;
  specAuthorRunner: SpecAuthorRunner;
  bindHost: string;
}
