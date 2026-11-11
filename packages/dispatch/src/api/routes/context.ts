import { AsyncLocalStorage } from "node:async_hooks";

import type { Dispatch } from "../../core.js";
import type { Actor } from "../../domain/types.js";
import type { PrincipalView } from "../../repositories/principalRepository.js";
import type { RequestAuth } from "../auth.js";
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
 * PER-PRINCIPAL CREDENTIALS: the request-scoped identity. The dispatcher resolves the
 * bearer credential ONCE (server.ts, auth.ts `resolveRequestAuth`) and runs the route
 * under {@link runWithAuth}; every later decision in the request reads that frozen
 * context ({@link apiAuth}, {@link apiActor}, {@link apiPrincipal},
 * {@link isSharedOperator}) and never looks the credential up again. Outside a request
 * (tests or internal callers invoking a route directly) there is no credential at all
 * and the operator's {@link API_ACTOR} applies.
 */
interface RequestContext {
  readonly auth: RequestAuth;
  readonly actor: Actor;
}
const requestContext = new AsyncLocalStorage<RequestContext>();

/** Run `fn` as the request whose credential resolved to `auth` (server.ts, once). */
export function runWithAuth<T>(auth: RequestAuth, fn: () => Promise<T>): Promise<T> {
  if (auth.via === "principal" && !auth.principal) {
    // Unreachable by construction (auth.ts); refuse rather than widen if it ever is.
    throw new DispatchError("UNAUTHORIZED", "The credential's principal could not be resolved.");
  }
  const actor = auth.principal ? auth.principal.actor : API_ACTOR;
  return requestContext.run(Object.freeze({ auth, actor }), fn);
}

/** The identity this request authenticated with, or null outside any request. */
export function apiAuth(): RequestAuth | null {
  return requestContext.getStore()?.auth ?? null;
}

export function apiActor(): Actor {
  return requestContext.getStore()?.actor ?? API_ACTOR;
}

/** The principal this request authenticated as, or null (the shared token, or no request). */
export function apiPrincipal(): PrincipalView | null {
  return requestContext.getStore()?.auth.principal?.principal ?? null;
}

/**
 * True when the request runs as the shared operator token (or auth is disabled, or
 * outside any request), not as a named principal. Decided by HOW the request
 * authenticated, never by a principal being absent: a request that authenticated with a
 * principal token is that principal for its whole life, and one whose principal token
 * did not resolve never got here (401).
 */
export function isSharedOperator(): boolean {
  const ctx = requestContext.getStore();
  return ctx === undefined || ctx.auth.via !== "principal";
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
