import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendCreated, sendJson } from "../http.js";
import { createSpecBody, specListQuery, updateSpecClausesBody } from "../schemas.js";
import { API_ACTOR } from "./context.js";

/**
 * Specs (Spec-Driven Development, Phase 1a). Returns true when the request
 * targeted a spec route (the dispatcher then stops); false lets an unmatched
 * `/specs/...` sub-path fall through to the global 404, matching the original
 * inline blocks exactly.
 *
 *   POST  /specs               — create a draft spec (title, brief, clauses).
 *   GET   /specs               — list specs newest-first (?status= filter).
 *   POST  /specs/:id/freeze    — freeze a draft spec (draft→frozen; immutable).
 *   GET   /specs/:id/coverage  — Phase-3 traceability read model.
 *   GET   /specs/:id           — fetch one spec.
 *   PATCH /specs/:id           — replace a DRAFT spec's clauses.
 */
export async function routeSpecs(
  wg: Dispatch,
  method: string,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (segments[0] !== "specs") return false;

  // POST /specs / GET /specs
  if (segments.length === 1) {
    if (method === "POST") {
      const body = createSpecBody.parse(await readJsonBody(req));
      const spec = wg.createSpec(body, API_ACTOR);
      sendCreated(res, `/specs/${spec.id}`, { spec });
      return true;
    }
    if (method === "GET") {
      const query = specListQuery.parse(Object.fromEntries(url.searchParams));
      const specs = query.status !== undefined ? wg.listSpecs(query.status) : wg.listSpecs();
      sendJson(res, 200, { specs });
      return true;
    }
    methodNotAllowed(res);
    return true;
  }

  // POST /specs/:id/freeze — freeze a draft spec (draft→frozen; immutable after).
  if (segments.length === 3 && segments[2] === "freeze") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const spec = wg.freezeSpec(segments[1] as string, API_ACTOR);
    sendJson(res, 200, { spec });
    return true;
  }

  // GET /specs/:id/coverage — the Phase-3 traceability read model: per clause,
  // its covering ACs (satisfied vs open), covered / satisfied / orphan (the gap
  // report), and the bounce count; plus a spec-level rollup. Pure read.
  if (segments.length === 3 && segments[2] === "coverage") {
    if (method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    const coverage = wg.specCoverage(segments[1] as string);
    sendJson(res, 200, { coverage });
    return true;
  }

  // GET   /specs/:id  — fetch one spec.
  // PATCH /specs/:id  — replace a DRAFT spec's clauses (rejected once frozen).
  if (segments.length === 2) {
    if (method === "GET") {
      const spec = wg.getSpec(segments[1] as string);
      sendJson(res, 200, { spec });
      return true;
    }
    if (method === "PATCH") {
      const body = updateSpecClausesBody.parse(await readJsonBody(req));
      const spec = wg.updateSpecClauses(segments[1] as string, body, API_ACTOR);
      sendJson(res, 200, { spec });
      return true;
    }
    methodNotAllowed(res);
    return true;
  }

  return false;
}
