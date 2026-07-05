import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { errorBody, methodNotAllowed, readJsonBody, sendCreated, sendJson } from "../http.js";
import {
  createScopeEdgeBody,
  createScopeNodeBody,
  createScopeRepoBody,
  suggestReposBody,
  updateScopeNodeBody,
  updateScopeRepoBody,
} from "../schemas.js";
import { API_ACTOR } from "./context.js";

/**
 * Factory Map scope graph (FG-001 + FG-002). Routes:
 *   GET/POST          /scope/nodes
 *   GET/PATCH/DELETE  /scope/nodes/:id     (GET includes linked repos)
 *   GET/POST          /scope/edges         (GET ?node= to filter)
 *   DELETE            /scope/edges/:id
 *   GET/POST          /scope/repos         (GET ?node=|?repo= associations)
 *   PATCH/DELETE      /scope/repos/:id
 *   GET               /scope/unmapped-repos
 */
export async function routeScope(
  wg: Dispatch,
  method: string,
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const resource = segments[1];

  // /scope/repo-suggestions — FG-005 pre-create suggestions (title/desc/scopes).
  if (segments.length === 2 && resource === "repo-suggestions") {
    if (method !== "POST") return methodNotAllowed(res);
    const body = suggestReposBody.parse(await readJsonBody(req));
    const suggestions = wg.suggestReposForTicket(body, API_ACTOR);
    sendJson(res, 200, { suggestions });
    return;
  }

  // /scope/unmapped-repos
  if (segments.length === 2 && resource === "unmapped-repos") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { repositories: wg.listUnmappedRepos() });
    return;
  }

  // /scope/nodes ...
  if (resource === "nodes") {
    if (segments.length === 2) {
      if (method === "GET") {
        sendJson(res, 200, { nodes: wg.listScopeNodes() });
        return;
      }
      if (method === "POST") {
        const body = createScopeNodeBody.parse(await readJsonBody(req));
        const node = wg.createScopeNode(body, API_ACTOR);
        sendCreated(res, `/scope/nodes/${node.id}`, { node });
        return;
      }
      return methodNotAllowed(res);
    }
    if (segments.length === 3) {
      const nodeId = segments[2] as string;
      if (method === "GET") {
        const view = wg.getScopeNode(nodeId);
        sendJson(res, 200, { node: view.node, repos: view.repos });
        return;
      }
      if (method === "PATCH") {
        const body = updateScopeNodeBody.parse(await readJsonBody(req));
        const node = wg.updateScopeNode(nodeId, body, API_ACTOR);
        sendJson(res, 200, { node });
        return;
      }
      if (method === "DELETE") {
        const result = wg.deleteScopeNode(nodeId, API_ACTOR);
        sendJson(res, 200, { node_id: result.nodeId, event_id: result.eventId });
        return;
      }
      return methodNotAllowed(res);
    }
  }

  // /scope/edges ...
  if (resource === "edges") {
    if (segments.length === 2) {
      if (method === "GET") {
        const node = new URL(req.url ?? "/", "http://localhost").searchParams.get("node");
        sendJson(res, 200, { edges: wg.listScopeEdges(node ?? undefined) });
        return;
      }
      if (method === "POST") {
        const body = createScopeEdgeBody.parse(await readJsonBody(req));
        const edge = wg.createScopeEdge(body, API_ACTOR);
        sendCreated(res, `/scope/edges/${edge.id}`, { edge });
        return;
      }
      return methodNotAllowed(res);
    }
    if (segments.length === 3 && method === "DELETE") {
      const result = wg.deleteScopeEdge(segments[2] as string, API_ACTOR);
      sendJson(res, 200, { edge_id: result.edgeId, event_id: result.eventId });
      return;
    }
    if (segments.length === 3) return methodNotAllowed(res);
  }

  // /scope/repos ...
  if (resource === "repos") {
    if (segments.length === 2) {
      if (method === "GET") {
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const node = params.get("node");
        const repo = params.get("repo");
        if (node) {
          sendJson(res, 200, { repos: wg.reposForScope(node) });
          return;
        }
        if (repo) {
          sendJson(res, 200, { scopes: wg.scopesForRepo(repo) });
          return;
        }
        sendJson(
          res,
          422,
          errorBody("VALIDATION_ERROR", "GET /scope/repos requires a ?node= or ?repo= filter."),
        );
        return;
      }
      if (method === "POST") {
        const body = createScopeRepoBody.parse(await readJsonBody(req));
        const link = wg.linkScopeRepo(body, API_ACTOR);
        sendCreated(res, `/scope/repos/${link.id}`, { association: link });
        return;
      }
      return methodNotAllowed(res);
    }
    if (segments.length === 3) {
      const associationId = segments[2] as string;
      if (method === "PATCH") {
        const body = updateScopeRepoBody.parse(await readJsonBody(req));
        const link = wg.updateScopeRepo(associationId, body, API_ACTOR);
        sendJson(res, 200, { association: link });
        return;
      }
      if (method === "DELETE") {
        const result = wg.unlinkScopeRepo(associationId, API_ACTOR);
        sendJson(res, 200, { association_id: result.associationId, event_id: result.eventId });
        return;
      }
      return methodNotAllowed(res);
    }
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No scope route for ${method} /${segments.join("/")}.`),
  );
}
