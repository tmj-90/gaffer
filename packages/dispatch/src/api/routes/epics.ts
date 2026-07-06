import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendCreated } from "../http.js";
import { createEpicBody } from "../schemas.js";
import { API_ACTOR } from "./context.js";

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
): Promise<boolean> {
  if (!(segments.length === 1 && segments[0] === "epics")) return false;
  if (method !== "POST") {
    methodNotAllowed(res);
    return true;
  }
  const body = createEpicBody.parse(await readJsonBody(req));
  const result = wg.createEpic(body, API_ACTOR);
  // An epic IS a scope node — its canonical URL is /scope/nodes/:id (M5).
  sendCreated(res, `/scope/nodes/${result.epicNodeId}`, {
    epic_node_id: result.epicNodeId,
    ticket_numbers: result.ticketNumbers,
  });
  return true;
}
