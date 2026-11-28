import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { DispatchError } from "../../util/errors.js";
import { methodNotAllowed, readJsonBody, sendCreated, sendJson } from "../http.js";
import type { MemoryReader } from "../memoryReader.js";
import { launchResearch, reapStaleResearch, researchUnavailableReason } from "../research.js";
import { apiActor } from "./context.js";

/**
 * Research runs (backlog 69). Every write is a person's act: the service refuses an
 * agent or system actor; the read-only gate (server.ts) refuses a read token; the
 * principal scope gate (scopeGate.ts) refuses a SCOPED principal (a research run is a
 * factory-wide planning object: write_factory, and reads are read_factory). No MCP tool
 * reaches any of this.
 *
 *   GET   /research                    runs newest first (?plan_session=<id> for one session's)
 *   GET   /research/availability       { available, reason } (the checkbox's state)
 *   POST  /research                    start a run: { idea, repo?, share_overview?, plan_session_id? }
 *   GET   /research/:id                one run, marks recomputed
 *   PATCH /research/:id                edit: { features?: [...], open_questions?: [...] }
 *   POST  /research/:id/draft-spec     the kept items become a DRAFT spec (no model call)
 *   POST  /research/:id/discard        discard the run
 */
export async function routeResearch(
  wg: Dispatch,
  memoryReader: MemoryReader,
  method: string,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (segments[0] !== "research") return false;

  if (segments.length === 1) {
    if (method === "GET") {
      const session = url.searchParams.get("plan_session");
      const runs = wg.researchSvc
        .listRuns(session ? { planSessionId: session } : {})
        .map((r) => reapStaleResearch(wg, r));
      sendJson(res, 200, { research: runs });
      return true;
    }
    if (method === "POST") {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const actor = apiActor();
      // One run per plan session: an existing one is returned, never a second paid run.
      if (typeof body.plan_session_id === "string" && body.plan_session_id.trim()) {
        const existing = wg.researchSvc.listRuns({
          planSessionId: body.plan_session_id.trim(),
          includeDiscarded: true,
        });
        if (existing.length > 0) {
          sendJson(res, 200, { research: reapStaleResearch(wg, existing[0]!), started: false });
          return true;
        }
      }
      // A person's act, checked before anything else is asked or created.
      if (actor.type !== "human" && actor.type !== "admin") {
        throw new DispatchError(
          "ACTOR_NOT_PERMITTED",
          "Starting a research run is a person's act.",
          {
            actor_type: actor.type,
          },
        );
      }
      const why = await researchUnavailableReason(process.env);
      if (why !== null) {
        throw new DispatchError("STATE_CONFLICT", why, { reason: "research_unavailable" });
      }
      const { run, started } = wg.researchSvc.startRun(body, actor);
      if (started) {
        let overview: string | undefined;
        if (run.repo && run.share_overview) {
          try {
            const d = memoryReader.digest(run.repo);
            if (d.available && d.digest?.overview) overview = d.digest.overview;
          } catch {
            overview = undefined;
          }
        }
        void launchResearch(wg, run, overview !== undefined ? { overview } : {});
      }
      sendJson(res, started ? 202 : 200, { research: run, started });
      return true;
    }
    methodNotAllowed(res);
    return true;
  }

  if (segments.length === 2 && segments[1] === "availability") {
    if (method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    const why = await researchUnavailableReason(process.env);
    sendJson(res, 200, { available: why === null, reason: why });
    return true;
  }

  const id = segments[1] as string;
  if (segments.length === 2) {
    if (method === "GET") {
      sendJson(res, 200, { research: reapStaleResearch(wg, wg.researchSvc.getRun(id)) });
      return true;
    }
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { research: wg.researchSvc.editRun(id, body, apiActor()) });
      return true;
    }
    methodNotAllowed(res);
    return true;
  }

  if (segments.length === 3 && segments[2] === "draft-spec") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const out = wg.researchSvc.draftSpec(id, apiActor());
    sendCreated(res, `/specs/${out.spec.id}`, out);
    return true;
  }

  if (segments.length === 3 && segments[2] === "discard") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    sendJson(res, 200, { research: wg.researchSvc.discardRun(id, apiActor()) });
    return true;
  }

  return false;
}
