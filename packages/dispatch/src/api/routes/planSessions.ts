import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendCreated, sendJson } from "../http.js";
import { planSessionArchiveBody, planSessionListQuery, planSessionTurnBody } from "../schemas.js";

/**
 * Plan sessions (H9 — durable async plan-build chat).
 *
 *   POST /plan-sessions             — create a new session (archives current active)
 *   GET  /plan-sessions             — list sessions (most-recent first, capped)
 *   GET  /plan-sessions/active      — the most-recently-created active session
 *   GET  /plan-sessions/:id         — fetch one session by id
 *   POST /plan-sessions/:id/turns   — append a message + optional brief/plan update
 *   POST /plan-sessions/:id/archive — transition to confirmed or abandoned
 *
 * Always terminal for the `plan-sessions` segment (its own 404 for an unknown
 * sub-path), so the dispatcher returns after calling it.
 */
export async function routePlanSessions(
  wg: Dispatch,
  method: string,
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // POST /plan-sessions — create a fresh session (current active is archived).
  if (segments.length === 1) {
    if (method === "POST") {
      const session = wg.createPlanSession();
      sendCreated(res, `/plan-sessions/${session.id}`, { session });
      return;
    }
    if (method === "GET") {
      const q = planSessionListQuery.parse(
        Object.fromEntries(new URL(req.url ?? "/", "http://x").searchParams),
      );
      const sessions = wg.listPlanSessions({
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      sendJson(res, 200, { sessions });
      return;
    }
    methodNotAllowed(res);
    return;
  }
  // GET /plan-sessions/active — most-recently-created active session or null.
  if (segments.length === 2 && segments[1] === "active") {
    if (method !== "GET") return methodNotAllowed(res);
    const session = wg.getActivePlanSession();
    sendJson(res, 200, { session });
    return;
  }
  // /plan-sessions/:id — fetch by id.
  if (segments.length === 2) {
    const id = segments[1]!;
    if (method !== "GET") return methodNotAllowed(res);
    const session = wg.getPlanSession(id);
    if (!session) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Plan session not found." } });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }
  // /plan-sessions/:id/turns — append a message to the session.
  if (segments.length === 3 && segments[2] === "turns") {
    const id = segments[1]!;
    if (method !== "POST") return methodNotAllowed(res);
    const body = planSessionTurnBody.parse(await readJsonBody(req));
    const session = wg.appendPlanMessage(
      id,
      { role: body.role, content: body.content },
      {
        ...(body.brief !== undefined ? { brief: body.brief } : {}),
        ...(body.plan !== undefined ? { plan: body.plan } : {}),
      },
    );
    if (!session) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Plan session not found." } });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }
  // /plan-sessions/:id/archive — transition to confirmed or abandoned.
  if (segments.length === 3 && segments[2] === "archive") {
    const id = segments[1]!;
    if (method !== "POST") return methodNotAllowed(res);
    const body = planSessionArchiveBody.parse(await readJsonBody(req));
    const existing = wg.getPlanSession(id);
    if (!existing) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Plan session not found." } });
      return;
    }
    wg.archivePlanSession(id, body.status);
    const updated = wg.getPlanSession(id)!;
    sendJson(res, 200, { session: updated });
    return;
  }
  sendJson(res, 404, {
    error: { code: "NOT_FOUND", message: "Unknown plan-sessions path." },
  });
}
