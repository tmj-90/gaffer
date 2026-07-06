import type { Dispatch } from "../../core.js";
import type { Actor } from "../../domain/types.js";
import type { MemoryReader } from "../memoryReader.js";
import type { MergeRunner } from "../mergeRunner.js";
import type { OnboardRunner } from "../onboard.js";
import type { PlanBuildRunner } from "../planBuild.js";
import type { PollWorkRunner } from "../pollWork.js";
import type { ProductOwnerRunner } from "../productOwner.js";
import type { SpecAuthorRunner } from "../specAuthor.js";

/** The human actor on whose behalf the API mutates state (auth deferred). */
export const API_ACTOR: Actor = { type: "human", id: "dispatch-api" };

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
