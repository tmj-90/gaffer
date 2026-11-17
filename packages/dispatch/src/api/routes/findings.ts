/**
 * POST-MERGE FINDINGS (backlog 59) on /tickets/:id/findings:
 *
 *   GET  /tickets/:id/findings                  the ticket's findings (a read)
 *   POST /tickets/:id/findings                  {text, category?, paths?, criteria?}
 *   POST /tickets/:id/findings/:fid/withdraw    {reason}
 *   POST /tickets/:id/findings/:fid/lesson      propose it as a lesson (a lore draft)
 *   GET  /tickets/:id/findings/:fid/fix-ticket  what opening a fix ticket would do (the confirm)
 *   POST /tickets/:id/findings/:fid/fix-ticket  open a fix ticket linked as a regression
 *
 * Writes are a person's act: the service refuses an agent, the runner and the server, a
 * read-only token never reaches a POST, and the scope gate (scopeGate.ts) checked the
 * ticket for a scoped principal. Nothing here gates a delivery.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import type { MemoryReader } from "../memoryReader.js";
import { methodNotAllowed, readJsonBody, readNoBody, sendCreated, sendJson } from "../http.js";
import { addFindingBody, withdrawFindingBody } from "../schemas.js";
import { apiActor } from "./context.js";

export const FINDINGS_SUB = "findings";

/** Handle /tickets/:id/findings[...]; returns false when the path is not one of them. */
export async function routeFindings(
  wg: Dispatch,
  id: string,
  method: string,
  segments: readonly string[],
  req: IncomingMessage,
  res: ServerResponse,
  memoryReader: MemoryReader,
  after?: { added?: () => void; lessonFiled?: () => void },
): Promise<boolean> {
  if (segments[2] !== FINDINGS_SUB) return false;
  if (segments.length === 3) {
    if (method === "GET") {
      const ticket = wg.resolveTicket(id);
      sendJson(res, 200, { ticket_id: ticket.id, findings: wg.findingsOf(ticket.id) });
      return true;
    }
    if (method === "POST") {
      const body = addFindingBody.parse(await readJsonBody(req));
      const r = wg.addFinding(id, body, apiActor());
      after?.added?.();
      sendCreated(res, `/tickets/${r.finding.ticket_id}/findings`, {
        finding: r.finding,
        event_id: r.eventId,
      });
      return true;
    }
    methodNotAllowed(res);
    return true;
  }
  if (segments.length === 5 && segments[4] === "withdraw") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const body = withdrawFindingBody.parse(await readJsonBody(req));
    const r = wg.withdrawFinding(id, segments[3] as string, body.reason, apiActor());
    sendJson(res, 200, { finding: r.finding, event_id: r.eventId });
    return true;
  }
  if (segments.length === 5 && segments[4] === "lesson") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    await readNoBody(req);
    const r = wg.proposeLesson(id, segments[3] as string, apiActor(), (d) => {
      const filed = memoryReader.proposeLesson(d);
      return filed.available ? { ok: true, id: filed.id } : { ok: false, reason: filed.reason };
    });
    after?.lessonFiled?.();
    sendJson(res, 200, { finding: r.finding, lore_id: r.loreId, event_id: r.eventId });
    return true;
  }
  if (segments.length === 5 && segments[4] === "fix-ticket") {
    // The confirm asks first (a person's read: the service refuses an agent), then acts.
    if (method === "GET") {
      sendJson(res, 200, wg.fixTicketPreview(id, segments[3] as string, apiActor()));
      return true;
    }
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    await readNoBody(req);
    const r = wg.openFixTicket(id, segments[3] as string, apiActor());
    sendCreated(res, `/tickets/${r.ticket.id}`, {
      finding: r.finding,
      ticket: r.ticket,
      stepped_down: r.stepped_down,
      event_id: r.eventId,
    });
    return true;
  }
  return false;
}
