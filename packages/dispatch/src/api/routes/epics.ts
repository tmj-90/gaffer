import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import {
  brownfieldEpicRepo,
  createEpicFeatureRunner,
  type EpicFeatureRunner,
} from "../epicFeature.js";
import { methodNotAllowed, readJsonBody, sendCreated } from "../http.js";
import { createEpicBody } from "../schemas.js";
import { apiActor } from "./context.js";

/**
 * POST /epics — create an epic (scope node + dependency-ordered draft tickets)
 * atomically (EP-001). The body is the create_epic plan shape. Returns true when
 * the request was for this resource (so the dispatcher stops); false lets an
 * unmatched `/epics/...` sub-path fall through to the global 404, exactly as the
 * original inline block did.
 */
export async function routeEpics(
  wg: Dispatch,
  method: string,
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  // The brownfield epic → feature(`building`) hook (DISPATCH_EPIC_FEATURE_CMD),
  // resolved from the live env per request; tests inject their own.
  epicFeatureRunner: EpicFeatureRunner = createEpicFeatureRunner(process.env, wg),
): Promise<boolean> {
  if (!(segments.length === 1 && segments[0] === "epics")) return false;
  if (method !== "POST") {
    methodNotAllowed(res);
    return true;
  }
  const body = createEpicBody.parse(await readJsonBody(req));
  const result = wg.createEpic(body, apiActor());
  // BROWNFIELD: every ticket targets ONE existing registered repo, so this epic is a
  // feature of that repo whose work has now started — move the memory feature ledger
  // to `building` (runner/bin/epic-feature.mjs, epic ref as provenance). Best-effort
  // and fire-and-forget: the epic is already created, and an unconfigured or failed
  // hook only leaves the ledger as it was.
  const featureRepo = brownfieldEpicRepo(wg, body, result);
  if (featureRepo !== null) {
    epicFeatureRunner.trigger({
      repo: featureRepo,
      epic: result.epicNodeId,
      name: body.epic.name,
      summary: (body.epic.description ?? "").trim().slice(0, 300),
    });
  }
  // An epic IS a scope node — its canonical URL is /scope/nodes/:id (M5).
  sendCreated(res, `/scope/nodes/${result.epicNodeId}`, {
    epic_node_id: result.epicNodeId,
    ticket_numbers: result.ticketNumbers,
    // Greenfield: tickets naming a repo that is not registered yet carry the name on
    // `source`; the link is deferred to the bootstrap onboard. Count of such tickets.
    deferred_repo_links: result.deferredRepoLinks,
  });
  return true;
}
