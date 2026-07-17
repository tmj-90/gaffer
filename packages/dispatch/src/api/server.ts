import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Dispatch } from "../core.js";
import { hasValidBearer, isRequestAuthorized } from "./auth.js";
import { errorBody, handleError, sendJson } from "./http.js";
import { createMemoryReader, type MemoryReader } from "./memoryReader.js";
import { createMergeRunner, type MergeRunner } from "./mergeRunner.js";
import { createOnboardRunner, type OnboardRunner } from "./onboard.js";
import { createPlanBuildRunner, type PlanBuildRunner } from "./planBuild.js";
import { createPollWorkRunner, type PollWorkRunner } from "./pollWork.js";
import { createProductOwnerRunner, type ProductOwnerRunner } from "./productOwner.js";
import { routeApi } from "./routes/api.js";
import { routeClaims } from "./routes/claims.js";
import { routeDecisions } from "./routes/decisions.js";
import { routeEpics } from "./routes/epics.js";
import { routePlanSessions } from "./routes/planSessions.js";
import { routeRepos } from "./routes/repos.js";
import { routeScope } from "./routes/scope.js";
import { routeSpecs } from "./routes/specs.js";
import { routeTickets } from "./routes/tickets.js";
import { routeWork } from "./routes/work.js";
import { applySecurityHeaders, isHostHeaderAllowed, isLoopbackHost } from "./security.js";
import { createSpecAuthorRunner, type SpecAuthorRunner } from "./specAuthor.js";
import { serveStatic } from "./static.js";

/**
 * Human REST API for Dispatch — a thin HTTP control surface over the facade.
 *
 * This module is now a slim entrypoint: it wires the runners, applies the
 * bootstrap ordering (public static shell + `/healthz`, then the DNS-rebinding
 * guard, then the bearer-token auth gate), and dispatches each authorised
 * request to a per-resource router under ./routes. The HTTP primitives live in
 * ./http, the bind-safety + security headers in ./security, and static-asset
 * serving in ./static.
 *
 * AUTH: a bearer token (`DISPATCH_API_TOKEN`) gates the control plane. The
 * `dispatch-api` entrypoint auto-provisions one at startup when the operator has
 * not set it (see {@link ensureApiToken}), so a token is present by default.
 * S-M1: EVERY control-plane request (reads AND writes — board/tickets/claims,
 * review approve/reject, merge, board moves) must present the token, loopback
 * included. Only the public bootstrap surface (the static SPA shell + `/healthz`,
 * served before the auth gate) is tokenless. This is what structurally stops the
 * delivery agent — whose child env the runner scrubs of the token — from reading
 * the backlog or self-approving its own work over REST. What is NOT here yet is
 * *role* enforcement: per-role RBAC is deferred, so an authenticated caller acts
 * as a single human actor with full rights.
 */

// Re-exported for the bin layer and the bind-guard tests, which import these
// from the public server entrypoint. The definitions live in ./security.
export { DEFAULT_API_PORT, assertSafeBind, isLoopbackHost } from "./security.js";

/**
 * Build the request handler. Exposed separately from {@link createApiServer} so
 * tests can mount it without binding a socket if they prefer.
 */
export function createApiHandler(
  wg: Dispatch,
  // RUN-ACTIVITY: the default runners are wired with `wg` as the run tracker, so
  // each detached spawn records a `runs` row and captures its output to a per-run
  // log (earlier params are in scope for later default expressions). A caller that
  // passes its own runner opts out of tracking unless it wires a tracker itself.
  runner: ProductOwnerRunner = createProductOwnerRunner(process.env, wg),
  planBuildRunner: PlanBuildRunner = createPlanBuildRunner(),
  mergeRunner: MergeRunner = createMergeRunner(process.env, undefined, wg),
  pollWorkRunner: PollWorkRunner = createPollWorkRunner(process.env, wg),
  bindHost = "127.0.0.1",
  memoryReader: MemoryReader = createMemoryReader(),
  onboardRunner: OnboardRunner = createOnboardRunner(process.env, wg),
  // SPEC-DRIVEN (Phase 1c): the spec-author seam. Spawns runner/bin/spec-author.mjs
  // exactly the way planBuildRunner spawns decompose.mjs. Appended last so existing
  // positional callers of createApiHandler/createApiServer keep their argument slots.
  specAuthorRunner: SpecAuthorRunner = createSpecAuthorRunner(),
): (req: IncomingMessage, res: ServerResponse) => void {
  // Resolve the HSTS posture ONCE from the bind host (not per request), so a
  // spoofed Host header can't toggle Strict-Transport-Security on/off.
  const loopbackBind = isLoopbackHost(bindHost);
  return (req, res) => {
    // Baseline security headers on EVERY response (static assets, JSON, errors).
    applySecurityHeaders(res, loopbackBind);
    void route(
      wg,
      runner,
      planBuildRunner,
      mergeRunner,
      pollWorkRunner,
      memoryReader,
      onboardRunner,
      specAuthorRunner,
      bindHost,
      req,
      res,
    ).catch((err: unknown) => {
      // Final safety net: any error escaping a route becomes a structured 500.
      try {
        handleError(res, err);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  };
}

/** Construct an http.Server wrapping the Dispatch facade. */
export function createApiServer(
  wg: Dispatch,
  // RUN-ACTIVITY: default runners track via `wg` (see createApiHandler).
  runner: ProductOwnerRunner = createProductOwnerRunner(process.env, wg),
  planBuildRunner: PlanBuildRunner = createPlanBuildRunner(),
  mergeRunner: MergeRunner = createMergeRunner(process.env, undefined, wg),
  pollWorkRunner: PollWorkRunner = createPollWorkRunner(process.env, wg),
  bindHost = "127.0.0.1",
  memoryReader: MemoryReader = createMemoryReader(),
  onboardRunner: OnboardRunner = createOnboardRunner(process.env, wg),
  // SPEC-DRIVEN (Phase 1c): appended last (see createApiHandler) so positional
  // callers of createApiServer keep their argument slots unchanged.
  specAuthorRunner: SpecAuthorRunner = createSpecAuthorRunner(),
): Server {
  return createServer(
    createApiHandler(
      wg,
      runner,
      planBuildRunner,
      mergeRunner,
      pollWorkRunner,
      bindHost,
      memoryReader,
      onboardRunner,
      specAuthorRunner,
    ),
  );
}

// --- Routing ---------------------------------------------------------------

/**
 * Thin dispatcher: apply the tokenless bootstrap (static shell + `/healthz`),
 * then the DNS-rebinding guard, then the bearer-token auth gate, and finally
 * delegate to the per-resource router keyed by the first path segment. The
 * ordering here is security-critical and preserved exactly from the original
 * monolithic handler — see the inline notes.
 */
async function route(
  wg: Dispatch,
  runner: ProductOwnerRunner,
  planBuildRunner: PlanBuildRunner,
  mergeRunner: MergeRunner,
  pollWorkRunner: PollWorkRunner,
  memoryReader: MemoryReader,
  onboardRunner: OnboardRunner,
  // SPEC-DRIVEN (Phase 1c): the spec-author seam behind POST /spec-build.
  specAuthorRunner: SpecAuthorRunner,
  // The host the server is bound to — used for the Host/Origin DNS-rebinding
  // check so a rebound foreign page can't read local control state.
  bindHost: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  try {
    // /healthz is exempt from the Host/Origin check below: health probes (load
    // balancers, k8s, uptime monitors) legitimately arrive with arbitrary Host
    // headers, and the response carries no control-plane state to protect.
    if (segments.length === 1 && segments[0] === "healthz" && method === "GET") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // SPA static SHELL first — served to ANY Host, tokenless (C2 / LAN-QR fix).
    // index.html + app.js + styles.css + /assets are PUBLIC static files with NO
    // data: a phone loading the dashboard over the LAN (Host = the LAN IP, which
    // need not match the bind host) MUST get the shell, which then prompts for the
    // token. Safe because it exposes nothing — the DNS-rebinding defense and the auth
    // gate below still guard EVERY API/data request, so a rebound attacker page gets
    // only the empty shell and its subsequent API calls are refused (wrong Host, and
    // it cannot attach the bearer token cross-origin). serveStatic only matches the
    // known shell paths + traversal-safe /assets; everything else falls through.
    if (method === "GET" && serveStatic(url.pathname, res)) {
      return;
    }

    // DNS-rebinding defense (before the API router): a TOKENLESS request whose
    // Host/Origin names a foreign host is refused outright, so a rebound attacker page
    // can't reach the tokenless loopback read path. A VALID bearer token bypasses the
    // check — a browser can't attach the token cross-origin, so holding it proves the
    // caller is legitimate (this lets a tokened client reach a `--host 0.0.0.0` or
    // proxy-fronted deploy whose Host header never matches the bind host). NOTE:
    // hasValidBearer, not header presence — a wrong token gets no bypass.
    if (!hasValidBearer(req) && !isHostHeaderAllowed(req, bindHost)) {
      sendJson(res, 403, {
        error: { code: "FORBIDDEN_HOST", message: "Host or Origin not permitted." },
      });
      return;
    }

    // Auth gate: static assets + /healthz above are public. The control-plane
    // API requires a bearer token (DISPATCH_API_TOKEN — auto-provisioned at
    // startup by the dispatch-api entrypoint, so a token is present by default).
    // S-M1: EVERY request reaching this gate is a DATA-returning endpoint and must
    // present the token — loopback reads included. There is no tokenless loopback
    // read path (the SPA sends the bearer on every call). No-op only when auth is
    // fully disabled (no token configured — embedder/test posture).
    if (!isRequestAuthorized(req)) {
      sendJson(res, 401, {
        error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token." },
      });
      return;
    }

    // Resource dispatch by first path segment. Routers that always own their
    // segment (their own 404) return void; the rest return `true` when they
    // handled the request and `false` to let an unmatched sub-path fall through
    // to the global 404 below — preserving the original flat-if behaviour.
    switch (segments[0]) {
      case "tickets":
        await routeTickets(wg, mergeRunner, memoryReader, method, segments, url, req, res);
        return;
      case "decisions":
        await routeDecisions(wg, method, segments, req, res);
        return;
      case "claims":
        await routeClaims(wg, method, segments, res);
        return;
      case "scope":
        await routeScope(wg, method, segments, req, res);
        return;
      case "plan-sessions":
        await routePlanSessions(wg, method, segments, req, res);
        return;
      case "api":
        await routeApi(wg, memoryReader, method, segments, url, req, res);
        return;
      case "epics":
        if (await routeEpics(wg, method, segments, req, res)) return;
        break;
      case "specs":
        if (await routeSpecs(wg, method, segments, url, req, res)) return;
        break;
      case "agents":
      case "repositories":
      case "repos":
        if (await routeRepos(wg, onboardRunner, method, segments, url, req, res)) return;
        break;
      case "product-owner":
      case "plan-build":
      case "spec-build":
      case "poll-work":
        if (
          await routeWork(
            wg,
            runner,
            planBuildRunner,
            specAuthorRunner,
            pollWorkRunner,
            method,
            segments,
            req,
            res,
          )
        )
          return;
        break;
      default:
        break;
    }

    sendJson(res, 404, errorBody("NOT_FOUND", `No route for ${method} ${url.pathname}.`));
  } catch (err) {
    handleError(res, err);
  }
}
