import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendJson } from "../http.js";
import { readIdleLoops, resolveCrewConfigPath } from "../idleLoops.js";
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
    // Only fire a tick when it has something to do. The tick works through more
    // than the ready queue, and before it: a paused delivery a human pressed
    // Continue on (re-entered first), and — when the operator turned the lanes on —
    // an agent review of an in_review ticket and a black-box test of an in_testing
    // one. An EMPTY queue still has work when the idle maintenance lane is switched
    // on in crew.yaml (the tick then runs one scheduler-chosen scan lane, which may
    // draft and promote its own ticket). Otherwise the poll would silently do
    // nothing and feel broken — tell the caller plainly. Counting only `ready` made
    // Continue + Poll a no-op whenever no daemon was running.
    const pending = pollablePending(wg, process.env);
    const readyCount = pending.ready;
    const otherWork =
      pending.resume + pending.review + pending.testing + pending.clarify + pending.merge;
    const maintenanceOn = readIdleLoops(resolveCrewConfigPath()).maintenance.enabled;
    if (readyCount === 0 && otherWork === 0 && !maintenanceOn) {
      sendJson(res, 200, { polled: false, reason: "no_ready_work", readyCount: 0, pending });
      return true;
    }
    const result = pollWorkRunner.run();
    sendJson(res, 202, {
      polled: true,
      readyCount,
      pending,
      ...(readyCount === 0 && otherWork === 0 ? { idle: "maintenance" } : {}),
      run: result,
    });
    return true;
  }

  return false;
}

/** True for the runner's truthy flag spellings (factory.config.sh _gaffer_flag_on). */
function flagOn(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

/** What one tick (runner/tick.sh) could work on right now, by lane. */
export interface PollablePending {
  /** Tickets in `ready` (the delivery queue). */
  ready: number;
  /** Paused deliveries a human pressed Continue on (re-entered before any claim). */
  resume: number;
  /** in_review tickets the reviewer agent takes (REVIEW_MODE agent | both). */
  review: number;
  /** in_testing tickets the black-box tester takes (GAFFER_TESTING on). */
  testing: number;
  /**
   * Drafts the intake clarify pass would take (CLARIFY_DRAFTS_WHEN_IDLE on): those
   * linked to a repo with a local checkout — the pass skips a repo-less draft.
   */
  clarify: number;
  /**
   * Approved (ready_for_merge) tickets the merge lane lands at the start of a tick:
   * counted when the lane is on (GAFFER_MERGE_LANE, default on) and AUTO_MERGE is on —
   * the operator's standing instruction to land what was approved. A PARTLY LANDED ticket
   * (some write repos landed, some pending) counts under the SAME rule: the lane lands its
   * remaining repos only when the policy that let it land the first still holds; with
   * AUTO_MERGE off it stays partly landed for a human's Merge now (external review #7).
   */
  merge: number;
}

/**
 * Count the work a tick would pick up, with the same switches the runner reads:
 * resumes need GAFFER_PAUSE_ON_CAP (default on), agent review REVIEW_MODE=agent|both
 * (default human), the tester lane GAFFER_TESTING (default off), the intake clarify
 * pass CLARIFY_DRAFTS_WHEN_IDLE (default off; it runs only when nothing is ready), the
 * merge lane AUTO_MERGE (default off; GAFFER_MERGE_LANE=0 turns the lane off), partly
 * landed tickets included. The dashboard's env
 * carries the operator's real overrides plus settings.json and the mode preset
 * (applySettingsToEnv), so these agree with what the spawned tick will see.
 */
export function pollablePending(wg: Dispatch, env: NodeJS.ProcessEnv): PollablePending {
  const ready = wg.listTickets({ status: "ready" }).length;
  const pauseOnCap = (env["GAFFER_PAUSE_ON_CAP"] ?? "1").trim();
  const resume = pauseOnCap === "1" ? wg.listResumeRequested().length : 0;
  const reviewMode = (env["REVIEW_MODE"] ?? "human").trim().toLowerCase();
  const review =
    reviewMode === "agent" || reviewMode === "both"
      ? wg.listTickets({ status: "in_review" }).length
      : 0;
  const testing = flagOn(env["GAFFER_TESTING"])
    ? wg.listTickets({ status: "in_testing" }).length
    : 0;
  const clarify =
    flagOn(env["CLARIFY_DRAFTS_WHEN_IDLE"]) && ready === 0
      ? wg
          .listTickets({ status: "draft" })
          .filter((t) => wg.view(t.id).repositories.some((r) => Boolean(r.local_path))).length
      : 0;
  const laneOn = !["0", "false", "no", "off"].includes(
    (env["GAFFER_MERGE_LANE"] ?? "1").trim().toLowerCase(),
  );
  const merge =
    laneOn && flagOn(env["AUTO_MERGE"]) ? wg.listTickets({ status: "ready_for_merge" }).length : 0;
  return { ready, resume, review, testing, clarify, merge };
}
