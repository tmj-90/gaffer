import type { ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { requestTicketFilter } from "../scopeGate.js";
import { errorBody, sendJson } from "../http.js";
import { apiActor } from "./context.js";

export async function routeClaims(
  wg: Dispatch,
  method: string,
  segments: string[],
  res: ServerResponse,
): Promise<void> {
  // /claims
  if (segments.length === 1 && method === "GET") {
    // PRINCIPAL SCOPES: a scoped principal sees the claims on its tickets only.
    const visible = requestTicketFilter(wg);
    const claims = wg.listActiveClaims();
    sendJson(res, 200, { claims: visible ? claims.filter((c) => visible(c.ticket_id)) : claims });
    return;
  }

  // /claims/:id/revoke
  if (segments.length === 3 && segments[2] === "revoke" && method === "POST") {
    const result = wg.revokeClaim(segments[1] as string, apiActor());
    sendJson(res, 200, { claim_id: result.claimId, ticket_id: result.ticketId });
    return;
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No claim route for ${method} /${segments.join("/")}.`),
  );
}
