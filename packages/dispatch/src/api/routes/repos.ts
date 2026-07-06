import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendJson } from "../http.js";
import type { OnboardRunner } from "../onboard.js";
import { onboardRepoBody, setRepoHiddenBody } from "../schemas.js";
import { API_ACTOR } from "./context.js";

/**
 * The agents / repositories / repos read + management surface. Returns true when
 * the request matched one of these routes (dispatcher stops); false lets an
 * unmatched path fall through to the global 404 — preserving the original inline
 * blocks' behaviour exactly (e.g. a non-GET /agents falls to the global 404, not
 * a 405).
 */
export async function routeRepos(
  wg: Dispatch,
  onboardRunner: OnboardRunner,
  method: string,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (segments.length === 1 && segments[0] === "agents" && method === "GET") {
    sendJson(res, 200, { agents: wg.listAgents() });
    return true;
  }

  if (segments.length === 1 && segments[0] === "repositories" && method === "GET") {
    // WG-006: hidden repos are excluded by default. ?hidden=1 returns the full
    // set; ?hidden=only returns just the hidden ones (the "Hidden repos" page).
    const hiddenParam = url.searchParams.get("hidden");
    if (hiddenParam === "only") {
      sendJson(res, 200, { repositories: wg.listHiddenRepos() });
      return true;
    }
    const includeHidden = hiddenParam === "1" || hiddenParam === "true";
    sendJson(res, 200, { repositories: wg.listRepositories(includeHidden) });
    return true;
  }

  // POST /repos/onboard — kick off onboarding for a repo (the Memory view's
  // "Onboard a repo" button). Onboarding scans the repo, registers it in
  // Dispatch, and (via the onboard producer) builds the repo's digest +
  // inventories its shipped features into the SAME Memory store the Memory views
  // read. Spawns the configured DISPATCH_ONBOARD_CMD using the SAME safe pattern
  // as /poll-work + /product-owner/runs (no shell, argv array, repo passed via the
  // child env, bearer token stripped, fire-and-gaffert). Returns 503 NOT_CONFIGURED
  // when the command is unset — a clean "onboarding not configured" envelope, never
  // a 500. Behind the same bearer-token gate as the rest of the control plane.
  if (segments[0] === "repos" && segments.length === 2 && segments[1] === "onboard") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const body = onboardRepoBody.parse(await readJsonBody(req));
    const result = onboardRunner.run({ repo: body.repo });
    sendJson(res, 202, { onboarding: true, repo: body.repo, run: result });
    return true;
  }

  // GET /repos/:id/scopes — scope nodes a repo belongs to (with access).
  if (segments[0] === "repos" && segments.length === 3 && segments[2] === "scopes") {
    if (method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    sendJson(res, 200, { scopes: wg.scopesForRepo(segments[1] as string) });
    return true;
  }

  // POST /repos/:id/hidden — WG-006 hide/un-hide a repo (reversible). Behind the
  // same bearer-token gate as the rest of the control plane (checked above).
  if (segments[0] === "repos" && segments.length === 3 && segments[2] === "hidden") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const body = setRepoHiddenBody.parse(await readJsonBody(req));
    const repo = wg.setRepoHidden(segments[1] as string, body.hidden, API_ACTOR);
    sendJson(res, 200, { repository: repo });
    return true;
  }

  return false;
}
