import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { errorBody, methodNotAllowed, readJsonBody, sendCreated, sendJson } from "../http.js";
import { createDecisionBody, resolveDecisionBody } from "../schemas.js";
import { API_ACTOR } from "./context.js";

export async function routeDecisions(
  wg: Dispatch,
  method: string,
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // /decisions
  if (segments.length === 1) {
    if (method === "GET") {
      sendJson(res, 200, { decisions: wg.listPendingDecisions() });
      return;
    }
    if (method === "POST") {
      const body = createDecisionBody.parse(await readJsonBody(req));
      const decision = wg.createDecision(
        {
          title: body.title,
          question: body.question,
          ...(body.severity !== undefined ? { severity: body.severity } : {}),
          ...(body.ticket_id !== undefined ? { ticketId: body.ticket_id } : {}),
        },
        API_ACTOR,
      );
      sendCreated(res, `/decisions/${decision.id}`, { decision });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /decisions/:id/resolve
  if (segments.length === 3 && segments[2] === "resolve" && method === "POST") {
    const body = resolveDecisionBody.parse(await readJsonBody(req));
    const decision = wg.resolveDecision(
      {
        decisionId: segments[1] as string,
        status: body.status,
        answer: body.answer,
        rationale: body.rationale,
      },
      API_ACTOR,
    );
    sendJson(res, 200, { decision });
    return;
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No decision route for ${method} /${segments.join("/")}.`),
  );
}
