import type { ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { errorBody, sendJson } from "../http.js";
import { API_ACTOR } from "./context.js";

export async function routeClaims(
  wg: Dispatch,
  method: string,
  segments: string[],
  res: ServerResponse,
): Promise<void> {
  // /claims
  if (segments.length === 1 && method === "GET") {
    sendJson(res, 200, { claims: wg.listActiveClaims() });
    return;
  }

  // /claims/:id/revoke
  if (segments.length === 3 && segments[2] === "revoke" && method === "POST") {
    const result = wg.revokeClaim(segments[1] as string, API_ACTOR);
    sendJson(res, 200, { claim_id: result.claimId, ticket_id: result.ticketId });
    return;
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No claim route for ${method} /${segments.join("/")}.`),
  );
}
