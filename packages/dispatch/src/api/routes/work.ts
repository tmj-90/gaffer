import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendJson } from "../http.js";
import type { PlanBuildRunner } from "../planBuild.js";
import type { PollWorkRunner } from "../pollWork.js";
import type { ProductOwnerRunner, ProductOwnerRunResult } from "../productOwner.js";
import { planBuildBody, runProductOwnerBody, specBuildBody } from "../schemas.js";
import type { SpecAuthorRunner } from "../specAuthor.js";

/**
 * Upper bound on the number of per-repo product-owner runs a single node-level
 * "Suggest work" can fan out (Feature B). Bounds the spawn count so one click on
 * a broad scope node can't launch an unbounded number of headless processes;
 * repos beyond the limit are reported via `truncated` in the response.
 */
const PRODUCT_OWNER_NODE_REPO_LIMIT = 10;

/**
 * The headless "spawn a helper" routes: product-owner runs, plan-build /
 * spec-build decompose turns, and the on-demand poll-work tick. Returns true
 * when the request matched one of these (dispatcher stops); false lets an
 * unmatched path fall through to the global 404, exactly as the original inline
 * blocks did.
 */
export async function routeWork(
  wg: Dispatch,
  runner: ProductOwnerRunner,
  planBuildRunner: PlanBuildRunner,
  specAuthorRunner: SpecAuthorRunner,
  pollWorkRunner: PollWorkRunner,
  method: string,
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // POST /product-owner/runs — kick off a headless product-owner run whose
  // draft tickets surface on the board (the "Suggest work" button's backend).
  //
  // Feature B: the run targets EITHER a single repo (repo-level) OR a scope
  // node (node-level). Node-level resolves the node → its repos via
  // reposForScope and fans out the existing per-repo runner once per repo
  // (bounded by PRODUCT_OWNER_NODE_REPO_LIMIT); no runner change needed.
  if (segments[0] === "product-owner" && segments[1] === "runs" && segments.length === 2) {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const body = runProductOwnerBody.parse(await readJsonBody(req));
    if (body.scopeNodeId !== undefined) {
      // Resolve the node (404s on an unknown id); getScopeNode returns its
      // repos (relation + default access) alongside.
      const node = wg.getScopeNode(body.scopeNodeId);
      const repos = node.repos;
      const bounded = repos.slice(0, PRODUCT_OWNER_NODE_REPO_LIMIT);
      // Fan the per-repo runner out, one repo at a time. The FIRST run is
      // allowed to throw (nothing has started yet, so a config/spawn error
      // surfaces honestly as a 503/5xx). Once any run has started we must not
      // abort the whole batch — a later spawn failure would orphan the
      // already-detached children with no coherent response — so subsequent
      // failures are captured per-repo and reported in `runs`.
      const runs: Array<{
        repo_id: string;
        repo_name: string;
        run?: ProductOwnerRunResult;
        error?: string;
      }> = [];
      let started = 0;
      for (const repo of bounded) {
        try {
          const run = runner.run({ repo: repo.name });
          runs.push({ repo_id: repo.id, repo_name: repo.name, run });
          started += 1;
        } catch (err) {
          if (started === 0) throw err; // nothing detached yet — fail cleanly.
          runs.push({
            repo_id: repo.id,
            repo_name: repo.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      sendJson(res, 202, {
        target: { level: "node", scope_node_id: node.node.id, scope_node_name: node.node.name },
        repo_count: repos.length,
        ran: started,
        truncated: repos.length > bounded.length,
        runs,
      });
      return true;
    }
    const result = runner.run(body.repo !== undefined ? { repo: body.repo } : {});
    sendJson(res, 202, {
      target: body.repo !== undefined ? { level: "repo", repo: body.repo } : { level: "none" },
      run: result,
    });
    return true;
  }

  // POST /plan-build — one turn of the "Plan a build" decomposer. Spawns the
  // runner decompose helper with {brief,history} on stdin and returns its
  // {phase:"clarify"|"plan"|"error"} JSON. It PROPOSES ONLY — nothing is created
  // here; the frontend confirms a plan via POST /epics (draft tickets). Behind
  // the same bearer-token gate as the rest of the control plane (checked above).
  if (segments.length === 1 && segments[0] === "plan-build") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const body = planBuildBody.parse(await readJsonBody(req));
    const result = await planBuildRunner.run({
      brief: body.brief,
      history: body.history,
      // Extend-existing: when the panel starts in "Extend existing" mode it
      // passes the target scope node / epic as `context` so the decomposer
      // proposes tickets that EXTEND it rather than rebuild from scratch. Only
      // forwarded when present so greenfield ("New app") stays unchanged.
      ...(body.context !== undefined ? { context: body.context } : {}),
      // "Build the tickets now": the panel can force a plan at any point so the
      // user is never stuck clarifying. Forwarded only when set so a normal turn
      // is unchanged; the decomposer then returns a plan (never a clarify).
      ...(body.forcePlan === true ? { forcePlan: true } : {}),
      // Spec-Driven Development (Phase 2a): a FROZEN spec drives the decompose.
      // Forwarded only when present so a non-spec-driven turn is unchanged; the
      // decomposer quarantines the clauses, defaults to force-plan, and threads
      // each clause id onto the acceptance criteria it satisfies.
      ...(body.spec !== undefined ? { spec: body.spec } : {}),
    });
    // The helper's own `error` phase is a normal, expected turn (bad brief,
    // refusal, etc.), so it rides back as a 200 envelope the chat can render.
    sendJson(res, 200, result);
    return true;
  }

  // POST /spec-build — one turn of the "Author a spec" step (Phase 1c). Spawns
  // the runner spec-author helper with {brief,history,context?,forcePlan?} on
  // stdin and returns its {phase:"clarify"|"spec"|"error"} JSON. It PROPOSES ONLY
  // — nothing is created here; the frontend edits the draft clauses and confirms
  // via POST /specs (create_spec) then POST /specs/:id/freeze. Behind the same
  // bearer-token gate as plan-build (checked above).
  if (segments.length === 1 && segments[0] === "spec-build") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    const body = specBuildBody.parse(await readJsonBody(req));
    const result = await specAuthorRunner.run({
      brief: body.brief,
      history: body.history,
      // Optional free-text grounding — forwarded only when present so a request
      // without context has a byte-for-byte unchanged stdin shape.
      ...(body.context !== undefined ? { context: body.context } : {}),
      // "Draft the spec now": force a spec at any point so the user is never
      // stuck clarifying. Forwarded only when set so a normal turn is unchanged.
      ...(body.forcePlan === true ? { forcePlan: true } : {}),
    });
    // The helper's own `error` phase is a normal, expected turn (bad brief,
    // refusal, etc.), so it rides back as a 200 envelope the chat can render.
    sendJson(res, 200, result);
    return true;
  }

  // POST /poll-work — fire a single factory tick on demand (the Work/board
  // view's "Poll for work" button). Spawns the configured DISPATCH_TICK_CMD
  // using the SAME safe pattern as the merge/product-owner runners (no shell,
  // argv array, bearer token stripped, fire-and-gaffert). Returns 503
  // NOT_CONFIGURED when the command is unset, like the product-owner runner.
  // Behind the same bearer-token gate as the rest of the control plane.
  if (segments.length === 1 && segments[0] === "poll-work") {
    if (method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    // Only fire a tick when there's actually ready work; otherwise the poll silently
    // does nothing and feels broken. Tell the caller plainly when nothing's ready.
    const readyCount = wg.listTickets({ status: "ready" }).length;
    if (readyCount === 0) {
      sendJson(res, 200, { polled: false, reason: "no_ready_work", readyCount: 0 });
      return true;
    }
    const result = pollWorkRunner.run();
    sendJson(res, 202, { polled: true, readyCount, run: result });
    return true;
  }

  return false;
}
