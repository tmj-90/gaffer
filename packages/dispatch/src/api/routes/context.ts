import { AsyncLocalStorage } from "node:async_hooks";

import type { Dispatch } from "../../core.js";
import type { Actor } from "../../domain/types.js";
import type { MemoryReader } from "../memoryReader.js";
import type { MergeRunner } from "../mergeRunner.js";
import type { OnboardRunner } from "../onboard.js";
import type { PlanBuildRunner } from "../planBuild.js";
import type { PollWorkRunner } from "../pollWork.js";
import type { ProductOwnerRunner } from "../productOwner.js";
import type { SpecAuthorRunner } from "../specAuthor.js";

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
const requestActor = new AsyncLocalStorage<Actor>();

export function runWithActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  return requestActor.run(actor, fn);
}

export function apiActor(): Actor {
  return requestActor.getStore() ?? API_ACTOR;
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
