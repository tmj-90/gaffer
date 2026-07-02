import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { readAuditTail } from "../audit/auditTail.js";
import {
  aggregateCosts,
  readLedgerRows,
  resolveLedgerPath,
  todaySpend,
} from "../cost/costAggregator.js";
import { deliveryFlow, type FlowTicket } from "../health/deliveryFlow.js";
import { aggregateHealth, type ReworkResolver } from "../health/healthAggregator.js";
import { buildRunDetail } from "./runDetail.js";
import { hasValidBearer, isRequestAuthorized } from "./auth.js";
import { readIdleLoops, resolveCrewConfigPath, writeIdleLoops } from "./idleLoops.js";
import { createMemoryReader, type MemoryReader } from "./memoryReader.js";
import { createMergeRunner, type MergeRunner } from "./mergeRunner.js";
import { createOnboardRunner, type OnboardRunner } from "./onboard.js";
import { createPlanBuildRunner, type PlanBuildRunner } from "./planBuild.js";
import { createSpecAuthorRunner, type SpecAuthorRunner } from "./specAuthor.js";
import { createPollWorkRunner, type PollWorkRunner } from "./pollWork.js";
import {
  createProductOwnerRunner,
  type ProductOwnerRunner,
  type ProductOwnerRunResult,
} from "./productOwner.js";
import { listSettings, writeSettings } from "./settings.js";
import type { Dispatch } from "../core.js";
import type { Actor } from "../domain/types.js";
import { DispatchError } from "../util/errors.js";
import {
  activityQuery,
  addAcBody,
  addTicketDependencyBody,
  assignReviewerBody,
  createDecisionBody,
  createEpicBody,
  createScopeEdgeBody,
  createScopeNodeBody,
  createScopeRepoBody,
  createTicketBody,
  linkTicketScopeBody,
  continuePausedBody,
  humanClaimBody,
  moveTicketBody,
  planBuildBody,
  planSessionArchiveBody,
  planSessionListQuery,
  planSessionTurnBody,
  recordDeliveryArtifactBody,
  recordRepoDeliveryBody,
  rejectReviewBody,
  reopenForReviewBody,
  reopenWontDoBody,
  resolveDecisionBody,
  idleLoopsBody,
  onboardRepoBody,
  runProductOwnerBody,
  runsQuery,
  settingsBody,
  setRepoHiddenBody,
  setPrimaryScopeBody,
  setRequiredCapabilitiesBody,
  setTestableBody,
  setTestContractBody,
  setTicketRepoAccessBody,
  createSpecBody,
  specBuildBody,
  updateSpecClausesBody,
  specListQuery,
  stopPausedBody,
  suggestReposBody,
  testerVerdictBody,
  ticketListQuery,
  updateScopeNodeBody,
  updateScopeRepoBody,
  wontDoBody,
} from "./schemas.js";

/**
 * Human REST API for Dispatch — a thin HTTP control surface over the facade.
 *
 * AUTH: a bearer token (`DISPATCH_API_TOKEN`) gates the control plane. The
 * `dispatch-api` entrypoint auto-provisions one at startup when the operator has
 * not set it (see {@link ensureApiToken}), so a token is present by default.
 * Enforcement is method-aware (see {@link isRequestAuthorized}): EVERY mutating /
 * state-changing request (review approve/reject, merge, board moves, every write)
 * must present the token, while read-only GET/HEAD requests stay open on a
 * loopback bind to preserve local dashboard UX — for the AUTO-provisioned token
 * only; an operator-SET `DISPATCH_API_TOKEN` gates every request, loopback reads
 * included (see auth.ts isOperatorSetToken). This is what structurally stops
 * the delivery agent — whose child env the runner scrubs of the token — from
 * self-approving its own work over REST. What is NOT here yet is *role*
 * enforcement: per-role RBAC is deferred, so an authenticated caller acts as a
 * single human actor with full rights.
 */

/** Default port; overridden by DISPATCH_API_PORT / --port at the bin layer. */
export const DEFAULT_API_PORT = 8787;

/**
 * Loopback hosts the API may bind to with no opt-in. Anything else exposes the
 * unauthenticated API to other machines, so it requires {@link assertSafeBind}'s
 * explicit override. `0.0.0.0` / `::` (wildcard binds) are deliberately absent.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/** Normalise a host for loopback comparison: trim, lowercase, strip `[]` and a `%zone`. */
function normaliseHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
}

/** True when `host` is a loopback address the API may bind to without opt-in. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normaliseHost(host));
}

/**
 * Extract the hostname from a `Host` (`host[:port]`) or `Origin`
 * (`scheme://host[:port]`) header value, normalised for comparison. Returns
 * `undefined` for an empty or unparseable value so the caller can treat it as
 * disallowed.
 */
function headerHostname(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Origin carries a scheme; a bare Host does not — synthesise one so the URL
  // parser can split host from port (and reject a garbage value).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return normaliseHost(new URL(withScheme).hostname);
  } catch {
    return undefined;
  }
}

/**
 * Extra hostnames the Host/Origin check accepts, from `DISPATCH_ALLOWED_HOSTS`
 * (comma-separated). For deployments fronted by a reverse proxy or a DNS name,
 * where the original `Host` the client sent never byte-equals the bind host.
 * Parsed defensively: entries are trimmed, normalised via {@link normaliseHost}
 * (lowercase, `[]`/`%zone` stripped, a `:port` suffix dropped via
 * {@link headerHostname}), and empties ignored. Read per request — consistent
 * with how the bearer token is resolved — so tests and embedders can adjust it
 * without rebuilding the handler.
 */
function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = (env.DISPATCH_ALLOWED_HOSTS ?? "").trim();
  if (raw === "") return new Set();
  const hosts = raw
    .split(",")
    .map((entry) => headerHostname(entry) ?? "")
    .filter((h) => h !== "");
  return new Set(hosts);
}

/**
 * DNS-rebinding defense for TOKENLESS requests. A browser page served from an
 * attacker origin that has rebound its DNS to 127.0.0.1 can reach the local
 * API, but the browser still sends the attacker's own `Host`/`Origin`. We
 * refuse any request whose `Host` (or, when present, `Origin`) names a host
 * other than the bound host, a loopback alias, or an operator-allowlisted
 * hostname (`DISPATCH_ALLOWED_HOSTS`, for proxy/DNS fronting) — so a rebound
 * foreign page can't read local control state on the tokenless loopback read
 * path. Non-browser clients (curl, the runner) that omit both headers are
 * unaffected.
 *
 * The route layer only consults this check for requests WITHOUT a valid bearer
 * token, and exempts `/healthz`: a browser cannot attach the bearer token
 * cross-origin, so a valid token proves the caller is legitimate (and health
 * probes carry arbitrary `Host` headers and expose no state). The bearer token
 * remains the real auth mechanism; this only closes the browser-rebinding hole.
 */
function isHostHeaderAllowed(req: IncomingMessage, bindHost: string): boolean {
  const boundHostNormalised = normaliseHost(bindHost);
  const extraAllowed = allowedHostsFromEnv();
  const allowed = (host: string | undefined): boolean =>
    host !== undefined &&
    (isLoopbackHost(host) || host === boundHostNormalised || extraAllowed.has(host));

  const rawHost = req.headers.host;
  if (rawHost !== undefined) {
    const hostValue = Array.isArray(rawHost) ? (rawHost[0] ?? "") : rawHost;
    if (!allowed(headerHostname(hostValue))) return false;
  }

  const rawOrigin = req.headers.origin;
  // A literal "null" Origin (sandboxed iframe, file://) carries no usable host —
  // reject it like any other non-matching origin.
  if (rawOrigin !== undefined) {
    const originValue = Array.isArray(rawOrigin) ? (rawOrigin[0] ?? "") : rawOrigin;
    if (!allowed(headerHostname(originValue))) return false;
  }

  return true;
}

/**
 * Guard against silently exposing the unauthenticated API on a public interface.
 *
 * The REST API has no authentication unless `DISPATCH_API_TOKEN` is set, and no
 * per-role RBAC yet (see the module note above), so binding to a non-loopback host
 * can put the whole control plane on the network for any reachable client when no
 * token is configured. This refuses such binds unless the operator explicitly
 * opts in via `--unsafe-bind` / `DISPATCH_UNSAFE_BIND=1`. Loopback binds
 * (127.0.0.1 / ::1 / localhost) are always allowed.
 *
 * Pure check — it never opens a socket. Throws {@link DispatchError} so callers
 * get a stable `UNSAFE_BIND` code and a message that explains the risk + override.
 *
 * @throws {DispatchError} code `UNSAFE_BIND` when binding a non-loopback host
 *   without the opt-in.
 */
export function assertSafeBind(
  host: string,
  unsafeBindOptIn: boolean,
  authConfigured = false,
): void {
  // A configured bearer token makes the API safe to expose: every non-public
  // request must then authenticate, so a non-loopback bind no longer hands the
  // control plane to anyone who can reach the interface.
  if (isLoopbackHost(host) || unsafeBindOptIn || authConfigured) return;
  throw new DispatchError(
    "UNSAFE_BIND",
    `Refusing to bind the Dispatch API to non-loopback host "${host}": the REST API ` +
      `has no authentication configured, so this would expose the full control plane ` +
      `to any client that can reach this interface. Bind to a loopback address ` +
      `(127.0.0.1, ::1, or localhost), set DISPATCH_API_TOKEN to require a bearer ` +
      `token, or, if you accept the risk, re-run with --unsafe-bind ` +
      `(DISPATCH_UNSAFE_BIND=1).`,
    { host },
  );
}

/** The human actor on whose behalf the API mutates state (auth deferred). */
const API_ACTOR: Actor = { type: "human", id: "dispatch-api" };

// --- Security response headers (P1-C) --------------------------------------

/**
 * Content-Security-Policy for the dashboard. Scripts are `'self'` ONLY — the SPA
 * loads a single external module (`/app.js`), so no inline-script allowance is
 * needed (and none is granted: an injected inline `<script>` is refused).
 *
 * `style-src` permits `'unsafe-inline'` + the Google Fonts stylesheet origin
 * because the shell uses an inline `style=""` attribute (the hidden SVG sprite)
 * and `app.js` sets element styles via innerHTML; `font-src` allows the Google
 * Fonts file origin. These style/font origins are a deliberate, reviewed
 * deviation from a bare `default-src 'self'` policy so the SPA's typography
 * keeps working — they do NOT relax `script-src`.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Apply baseline security headers to every response. Called once at the top of
 * the request handler so it covers static assets, JSON API responses, and error
 * paths alike. HSTS is emitted ONLY for a non-loopback bind: on plain-HTTP
 * loopback (the default dev posture) a `Strict-Transport-Security` header would
 * wrongly pin the browser to HTTPS for `localhost`.
 *
 * `loopbackBind` is resolved once at server-construction time from the bind host,
 * not per request, so a spoofed `Host:` header can't toggle HSTS.
 */
function applySecurityHeaders(res: ServerResponse, loopbackBind: boolean): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (!loopbackBind) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

/** Map a stable DispatchError code to an HTTP status. */
function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_ERROR":
      return 422;
    case "POLICY_DENIED":
      return 400;
    case "STATE_CONFLICT":
    case "CONCURRENCY_CONFLICT":
    case "ILLEGAL_TRANSITION":
    case "NO_OP":
    case "DUPLICATE":
    case "CLAIM_INVALID":
    case "CLAIM_REQUIRED":
    case "TICKET_NOT_CLAIMABLE":
    case "TICKET_NOT_HUMAN_OWNED":
    case "DEPENDENCY_BLOCKED":
    case "AGENT_NOT_ELIGIBLE":
    case "SCOPE_NODE_IN_USE":
    case "REPO_NOT_LINKED":
      return 409;
    case "INVALID_EDGE":
    case "INVALID_DEPENDENCY":
    case "ADVANCED_RELATION_REQUIRED":
      return 422;
    case "ACTOR_NOT_PERMITTED":
      return 403;
    case "NOT_CONFIGURED":
      return 503;
    default:
      return 500;
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function errorBody(code: string, message: string, details?: Record<string, unknown>): ErrorBody {
  return details && Object.keys(details).length > 0
    ? { error: { code, message, details } }
    : { error: { code, message } };
}

// --- Static SPA assets -----------------------------------------------------

/** Directory holding the bundled SPA (index.html, app.js, styles.css). */
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

/**
 * Static GET routes for the human SPA, mapping URL path → file + content-type.
 * `/` serves the SPA shell. These are the ONLY non-API GET paths the server
 * answers; every other unknown path still falls through to a JSON 404 so the
 * SPA fallback never swallows a genuine API 404 (e.g. GET /tickets/missing).
 */
const STATIC_ROUTES: ReadonlyMap<string, { file: string; type: string }> = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/gaffer-logo.svg", { file: "gaffer-logo.svg", type: "image/svg+xml" }],
  ["/gaffer-icon.svg", { file: "gaffer-icon.svg", type: "image/svg+xml" }],
  ["/gaffer-favicon.svg", { file: "gaffer-favicon.svg", type: "image/svg+xml" }],
]);

/** Serve a known static asset. Returns true if the path was handled. */
function serveStatic(pathname: string, res: ServerResponse): boolean {
  const match = STATIC_ROUTES.get(pathname);
  if (!match) return false;
  try {
    const body = readFileSync(join(WEB_DIR, match.file));
    res.writeHead(200, {
      "content-type": match.type,
      "content-length": body.length,
      // Dev dashboard: never serve a stale SPA — assets change on every build.
      "cache-control": "no-store, must-revalidate",
    });
    res.end(body);
  } catch {
    sendJson(res, 500, errorBody("INTERNAL_ERROR", `Static asset missing: ${match.file}`));
  }
  return true;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read and JSON-parse a request body. Empty bodies resolve to `{}`. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BYTES = 1_000_000;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BYTES) {
      throw new DispatchError("VALIDATION_ERROR", "Request body too large.");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DispatchError("VALIDATION_ERROR", "Request body is not valid JSON.");
  }
}

/** Translate a thrown error into a structured JSON response. */
function handleError(res: ServerResponse, err: unknown): void {
  if (err instanceof z.ZodError) {
    sendJson(
      res,
      422,
      errorBody("VALIDATION_ERROR", "Invalid request payload.", { issues: err.issues }),
    );
    return;
  }
  if (err instanceof DispatchError) {
    sendJson(
      res,
      statusForCode(err.code),
      errorBody(err.code, err.message, err.details as Record<string, unknown>),
    );
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  sendJson(res, 500, errorBody("INTERNAL_ERROR", message));
}

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
      loopbackBind,
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
 * Upper bound on the number of per-repo product-owner runs a single node-level
 * "Suggest work" can fan out (Feature B). Bounds the spawn count so one click on
 * a broad scope node can't launch an unbounded number of headless processes;
 * repos beyond the limit are reported via `truncated` in the response.
 */
const PRODUCT_OWNER_NODE_REPO_LIMIT = 10;

const TICKET_SUB = {
  ACCEPTANCE_CRITERIA: "acceptance-criteria",
  READY: "ready",
  MOVE: "move",
  // TRACK-2b: "I'll do this by hand" (human-claim a ready ticket) + hand-back.
  HUMAN_CLAIM: "human-claim",
  HUMAN_RELEASE: "human-release",
  READY_APPROVAL: "ready-approval",
  EVENTS: "events",
  // FAILURE-DIAGNOSIS: the ordered "why did #N fail" rework trail.
  REWORK_TRAIL: "rework-trail",
  REVIEW: "review",
  MARK_MERGED: "mark-merged",
  DIFF: "diff",
  REOPEN_FOR_REVIEW: "reopen-for-review",
  WONT_DO: "wont-do",
  REOPEN: "reopen",
  // PAUSE-ON-CAP: one-click Continue / Stop for a paused (cap-hit) delivery.
  CONTINUE: "continue",
  STOP: "stop",
  DELIVERY_ARTIFACT: "delivery-artifact",
  REQUIRED_CAPABILITIES: "required-capabilities",
  REVIEWER: "reviewer",
  SCOPES: "scopes",
  PRIMARY_SCOPE: "primary-scope",
  REPO_ACCESS: "repo-access",
  WORK_REPOS: "work-repos",
  MONO_FALLBACK: "mono-fallback",
  REPO_DELIVERIES: "repo-deliveries",
  REPO_SUGGESTIONS: "repo-suggestions",
  CLAIMABILITY: "claimability",
  DEPENDENCIES: "dependencies",
  // BBT-001: independent black-box testing handover + tester verdict.
  TESTABLE: "testable",
  TEST_CONTRACT: "test-contract",
  TESTER: "tester",
} as const;

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
  // Resolved once from the bind host (see createApiHandler). Controls whether an
  // unauthenticated READ may pass: reads stay open on a loopback bind for the
  // local dashboard, but mutations always require the token.
  loopbackBind: boolean,
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

    // DNS-rebinding defense (before static assets + the API router): a TOKENLESS
    // request whose Host/Origin names a foreign host is refused outright, so a
    // rebound attacker page can't reach the tokenless loopback read path. A
    // VALID bearer token bypasses the check — a browser can't attach the token
    // cross-origin, so holding it proves the caller is legitimate (this is what
    // lets a tokened client reach a `--host 0.0.0.0` or proxy-fronted deploy
    // whose Host header never matches the bind host). NOTE: hasValidBearer, not
    // header presence — a wrong token gets no bypass.
    if (!hasValidBearer(req) && !isHostHeaderAllowed(req, bindHost)) {
      sendJson(res, 403, {
        error: { code: "FORBIDDEN_HOST", message: "Host or Origin not permitted." },
      });
      return;
    }

    // SPA static assets: only specific non-API GET paths. Everything else falls
    // through to the API router (and its JSON 404), so API 404s stay intact.
    if (method === "GET" && serveStatic(url.pathname, res)) {
      return;
    }

    // Auth gate: static assets + /healthz above are public. The control-plane
    // API requires a bearer token (DISPATCH_API_TOKEN — auto-provisioned at
    // startup by the dispatch-api entrypoint, so a token is present by default).
    // Read-only requests stay open on a loopback bind to preserve local dashboard
    // UX — auto-provisioned token only; an operator-SET token gates everything.
    // EVERY mutating/state-changing request must present the token, as must a
    // read of a privileged secret-bearing path (e.g. /api/settings) even on
    // loopback. No-op only when auth is fully disabled (no token configured —
    // embedder/test posture).
    if (!isRequestAuthorized(req, loopbackBind, url.pathname)) {
      sendJson(res, 401, {
        error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token." },
      });
      return;
    }

    if (segments[0] === "tickets") {
      await routeTickets(wg, mergeRunner, method, segments, url, req, res);
      return;
    }
    if (segments[0] === "decisions") {
      await routeDecisions(wg, method, segments, req, res);
      return;
    }
    if (segments[0] === "claims") {
      await routeClaims(wg, method, segments, res);
      return;
    }
    // POST /epics — create an epic (scope node + dependency-ordered draft tickets)
    // atomically (EP-001). The body is the create_epic plan shape.
    if (segments.length === 1 && segments[0] === "epics") {
      if (method !== "POST") return methodNotAllowed(res);
      const body = createEpicBody.parse(await readJsonBody(req));
      const result = wg.createEpic(body, API_ACTOR);
      sendJson(res, 201, { epic_node_id: result.epicNodeId, ticket_numbers: result.ticketNumbers });
      return;
    }
    // --- Specs (Spec-Driven Development, Phase 1a) -------------------------
    // POST /specs        — create a draft spec (title, brief, clauses).
    // GET  /specs         — list specs newest-first (?status= filter).
    if (segments.length === 1 && segments[0] === "specs") {
      if (method === "POST") {
        const body = createSpecBody.parse(await readJsonBody(req));
        const spec = wg.createSpec(body, API_ACTOR);
        sendJson(res, 201, { spec });
        return;
      }
      if (method === "GET") {
        const query = specListQuery.parse(Object.fromEntries(url.searchParams));
        const specs = query.status !== undefined ? wg.listSpecs(query.status) : wg.listSpecs();
        sendJson(res, 200, { specs });
        return;
      }
      return methodNotAllowed(res);
    }
    // POST /specs/:id/freeze — freeze a draft spec (draft→frozen; immutable after).
    if (
      segments.length === 3 &&
      segments[0] === "specs" &&
      segments[2] === "freeze"
    ) {
      if (method !== "POST") return methodNotAllowed(res);
      const spec = wg.freezeSpec(segments[1] as string, API_ACTOR);
      sendJson(res, 200, { spec });
      return;
    }
    // GET /specs/:id/coverage — the Phase-3 traceability read model: per clause,
    // its covering ACs (satisfied vs open), covered / satisfied / orphan (the gap
    // report), and the bounce count; plus a spec-level rollup. Pure read.
    if (
      segments.length === 3 &&
      segments[0] === "specs" &&
      segments[2] === "coverage"
    ) {
      if (method !== "GET") return methodNotAllowed(res);
      const coverage = wg.specCoverage(segments[1] as string);
      sendJson(res, 200, { coverage });
      return;
    }
    // GET   /specs/:id  — fetch one spec.
    // PATCH /specs/:id  — replace a DRAFT spec's clauses (rejected once frozen).
    if (segments.length === 2 && segments[0] === "specs") {
      if (method === "GET") {
        const spec = wg.getSpec(segments[1] as string);
        sendJson(res, 200, { spec });
        return;
      }
      if (method === "PATCH") {
        const body = updateSpecClausesBody.parse(await readJsonBody(req));
        const spec = wg.updateSpecClauses(segments[1] as string, body, API_ACTOR);
        sendJson(res, 200, { spec });
        return;
      }
      return methodNotAllowed(res);
    }
    if (segments.length === 1 && segments[0] === "agents" && method === "GET") {
      sendJson(res, 200, { agents: wg.listAgents() });
      return;
    }
    if (segments.length === 1 && segments[0] === "repositories" && method === "GET") {
      // WG-006: hidden repos are excluded by default. ?hidden=1 returns the full
      // set; ?hidden=only returns just the hidden ones (the "Hidden repos" page).
      const hiddenParam = url.searchParams.get("hidden");
      if (hiddenParam === "only") {
        sendJson(res, 200, { repositories: wg.listHiddenRepos() });
        return;
      }
      const includeHidden = hiddenParam === "1" || hiddenParam === "true";
      sendJson(res, 200, { repositories: wg.listRepositories(includeHidden) });
      return;
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
      if (method !== "POST") return methodNotAllowed(res);
      const body = onboardRepoBody.parse(await readJsonBody(req));
      const result = onboardRunner.run({ repo: body.repo });
      sendJson(res, 202, { onboarding: true, repo: body.repo, run: result });
      return;
    }
    // GET /repos/:id/scopes — scope nodes a repo belongs to (with access).
    if (segments[0] === "repos" && segments.length === 3 && segments[2] === "scopes") {
      if (method !== "GET") return methodNotAllowed(res);
      sendJson(res, 200, { scopes: wg.scopesForRepo(segments[1] as string) });
      return;
    }
    // POST /repos/:id/hidden — WG-006 hide/un-hide a repo (reversible). Behind the
    // same bearer-token gate as the rest of the control plane (checked above).
    if (segments[0] === "repos" && segments.length === 3 && segments[2] === "hidden") {
      if (method !== "POST") return methodNotAllowed(res);
      const body = setRepoHiddenBody.parse(await readJsonBody(req));
      const repo = wg.setRepoHidden(segments[1] as string, body.hidden, API_ACTOR);
      sendJson(res, 200, { repository: repo });
      return;
    }
    if (segments[0] === "scope") {
      await routeScope(wg, method, segments, req, res);
      return;
    }
    // POST /product-owner/runs — kick off a headless product-owner run whose
    // draft tickets surface on the board (the "Suggest work" button's backend).
    //
    // Feature B: the run targets EITHER a single repo (repo-level) OR a scope
    // node (node-level). Node-level resolves the node → its repos via
    // reposForScope and fans out the existing per-repo runner once per repo
    // (bounded by PRODUCT_OWNER_NODE_REPO_LIMIT); no runner change needed.
    if (segments[0] === "product-owner" && segments[1] === "runs" && segments.length === 2) {
      if (method !== "POST") return methodNotAllowed(res);
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
        return;
      }
      const result = runner.run(body.repo !== undefined ? { repo: body.repo } : {});
      sendJson(res, 202, {
        target: body.repo !== undefined ? { level: "repo", repo: body.repo } : { level: "none" },
        run: result,
      });
      return;
    }
    // POST /plan-build — one turn of the "Plan a build" decomposer. Spawns the
    // runner decompose helper with {brief,history} on stdin and returns its
    // {phase:"clarify"|"plan"|"error"} JSON. It PROPOSES ONLY — nothing is created
    // here; the frontend confirms a plan via POST /epics (draft tickets). Behind
    // the same bearer-token gate as the rest of the control plane (checked above).
    if (segments.length === 1 && segments[0] === "plan-build") {
      if (method !== "POST") return methodNotAllowed(res);
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
      return;
    }
    // POST /spec-build — one turn of the "Author a spec" step (Phase 1c). Spawns
    // the runner spec-author helper with {brief,history,context?,forcePlan?} on
    // stdin and returns its {phase:"clarify"|"spec"|"error"} JSON. It PROPOSES ONLY
    // — nothing is created here; the frontend edits the draft clauses and confirms
    // via POST /specs (create_spec) then POST /specs/:id/freeze. Behind the same
    // bearer-token gate as plan-build (checked above).
    if (segments.length === 1 && segments[0] === "spec-build") {
      if (method !== "POST") return methodNotAllowed(res);
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
      return;
    }

    // ── Plan sessions (H9 — durable async plan-build chat) ─────────────────
    //
    // POST /plan-sessions            — create a new session (archives current active)
    // GET  /plan-sessions            — list sessions (most-recent first, capped)
    // GET  /plan-sessions/active     — the most-recently-created active session
    // GET  /plan-sessions/:id        — fetch one session by id
    // POST /plan-sessions/:id/turns  — append a message + optional brief/plan update
    // POST /plan-sessions/:id/archive — transition to confirmed or abandoned
    //
    // All are behind the same bearer-token gate as the rest of the control plane.
    if (segments[0] === "plan-sessions") {
      // POST /plan-sessions — create a fresh session (current active is archived).
      if (segments.length === 1) {
        if (method === "POST") {
          const session = wg.createPlanSession();
          sendJson(res, 201, { session });
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
        return methodNotAllowed(res);
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
      return sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: "Unknown plan-sessions path." },
      });
    }

    // POST /poll-work — fire a single factory tick on demand (the Work/board
    // view's "Poll for work" button). Spawns the configured DISPATCH_TICK_CMD
    // using the SAME safe pattern as the merge/product-owner runners (no shell,
    // argv array, bearer token stripped, fire-and-gaffert). Returns 503
    // NOT_CONFIGURED when the command is unset, like the product-owner runner.
    // Behind the same bearer-token gate as the rest of the control plane.
    if (segments.length === 1 && segments[0] === "poll-work") {
      if (method !== "POST") return methodNotAllowed(res);
      // Only fire a tick when there's actually ready work; otherwise the poll silently
      // does nothing and feels broken. Tell the caller plainly when nothing's ready.
      const readyCount = wg.listTickets({ status: "ready" }).length;
      if (readyCount === 0) {
        sendJson(res, 200, { polled: false, reason: "no_ready_work", readyCount: 0 });
        return;
      }
      const result = pollWorkRunner.run();
      sendJson(res, 202, { polled: true, readyCount, run: result });
      return;
    }
    // GET/POST /api/settings — the UI-editable factory config layer. GET reports
    // every known setting (file value + envLocked + group); POST merges + writes
    // settings.json atomically, refusing env-locked keys (env always wins) and
    // dropping anything outside the known allow-list. Behind the same bearer
    // gate + security headers as the rest of the control plane (checked above).
    if (segments.length === 2 && segments[0] === "api" && segments[1] === "settings") {
      if (method === "GET") {
        sendJson(res, 200, { settings: listSettings() });
        return;
      }
      if (method === "POST") {
        const body = settingsBody.parse(await readJsonBody(req));
        const result = writeSettings(body.settings);
        sendJson(res, 200, {
          settings: listSettings(),
          written: result.written,
          rejected: result.rejected,
          ignored: result.ignored,
        });
        return;
      }
      return methodNotAllowed(res);
    }
    // GET/PUT /api/idle-loops — dashboard control for the crew idle scan loops.
    // GET reads the `loops.idle_<key>.{enabled,repos}` slice of crew.yaml (a
    // missing file is a clean "not configured" shape, never a 500). PUT validates
    // the requested keys + repo NAMES (cross-checked against the registered repos)
    // and writes the slice back, preserving the rest of the YAML. Privileged: same
    // bearer gate as the rest of the control plane (checked above). The crew runner
    // re-reads crew.yaml each tick, so changes apply on its NEXT tick.
    if (segments.length === 2 && segments[0] === "api" && segments[1] === "idle-loops") {
      const crewPath = resolveCrewConfigPath();
      if (method === "GET") {
        sendJson(res, 200, { idle_loops: readIdleLoops(crewPath) });
        return;
      }
      if (method === "PUT") {
        const body = idleLoopsBody.parse(await readJsonBody(req));
        const repoNames = wg.listRepositories(true).map((r) => r.name);
        const view = writeIdleLoops(crewPath, body.loops, repoNames);
        sendJson(res, 200, { idle_loops: view });
        return;
      }
      return methodNotAllowed(res);
    }
    if (segments[0] === "api") {
      routeReadModels(wg, memoryReader, method, segments, url, res);
      return;
    }

    sendJson(res, 404, errorBody("NOT_FOUND", `No route for ${method} ${url.pathname}.`));
  } catch (err) {
    handleError(res, err);
  }
}

async function routeTickets(
  wg: Dispatch,
  mergeRunner: MergeRunner,
  method: string,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // /tickets
  if (segments.length === 1) {
    if (method === "GET") {
      const q = ticketListQuery.parse({
        status: url.searchParams.get("status") ?? undefined,
        repo: url.searchParams.get("repo") ?? undefined,
        risk: url.searchParams.get("risk") ?? undefined,
      });
      sendJson(res, 200, { tickets: wg.listTickets(q) });
      return;
    }
    if (method === "POST") {
      const body = createTicketBody.parse(await readJsonBody(req));
      // Feature A invariant: when repos are attached, at least one must be a
      // write target — otherwise the ticket is un-deliverable. The create form
      // enforces this client-side too, but it's a real business rule so the API
      // holds it for every caller. Checked BEFORE createTicket so a violation
      // never leaves an orphaned ticket. A repo-less create is still allowed
      // (legacy / draft path); the absence of repoIds is not a violation.
      if (
        body.repoIds &&
        body.repoIds.length > 0 &&
        !body.repoIds.some((r) => r.access === "write")
      ) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "At least one attached repo must have write access — the ticket needs a delivery target.",
        );
      }
      const ticket = wg.createTicket(
        {
          title: body.title,
          description: body.description ?? "",
          priority: body.priority,
          risk_level: body.risk_level,
          policy_pack: body.policy_pack,
          source: body.source,
        },
        API_ACTOR,
      );
      // Legacy single-repo link (older callers / mono-fallback flows).
      if (body.repo) wg.linkRepository(ticket.id, body.repo, "primary", API_ACTOR);
      // Feature A: link the chosen scope node(s) — the first is primary so the
      // ticket lives under a product scope, the rest are secondary context.
      if (body.scopeNodeIds) {
        body.scopeNodeIds.forEach((scopeNodeId, i) => {
          wg.linkTicketScope(
            {
              ticket_id: ticket.id,
              scope_node_id: scopeNodeId,
              relation: i === 0 ? "primary" : "secondary",
            },
            API_ACTOR,
          );
        });
      }
      // Feature A: confirm each repo's access boundary so the ticket is
      // immediately deliverable (a write target exists) rather than repo-less.
      if (body.repoIds) {
        for (const r of body.repoIds) {
          wg.setTicketRepoAccess(
            { ticket_id: ticket.id, repo_id: r.repo_id, access: r.access, relation: "confirmed" },
            API_ACTOR,
          );
        }
      }
      sendJson(res, 201, { ticket });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  const id = segments[1] as string;

  // /tickets/:id
  if (segments.length === 2) {
    if (method === "GET") {
      const view = wg.view(id);
      sendJson(res, 200, {
        ticket: view.ticket,
        acceptance_criteria: view.acceptanceCriteria,
        repositories: view.repositories,
        // `scopes` carries the ticket↔scope links (incl. its containing `epic`
        // node), so the Epics view can group tickets under their epic without a
        // new endpoint. The data is already computed by `view()`.
        scopes: view.scopes,
        blocking_decisions: view.blockingDecisions,
        dependencies: view.dependencies,
        evidence: view.evidence,
        events: view.events,
        // FAILURE-DIAGNOSIS: the full ordered "why did #N fail" trail.
        rework_trail: view.reworkTrail,
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  const sub = segments[2] as string;

  // /tickets/:id/acceptance-criteria
  if (segments.length === 3 && sub === TICKET_SUB.ACCEPTANCE_CRITERIA && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = addAcBody.parse(await readJsonBody(req));
    const { ac, eventId } = wg.addAcceptanceCriterion(
      {
        ticket_id: ticket.id,
        text: body.text,
        verification_method: body.verification_method,
        evidence_required: body.evidence_required ?? false,
      },
      API_ACTOR,
    );
    sendJson(res, 201, { acceptance_criterion: ac, event_id: eventId });
    return;
  }

  // /tickets/:id/ready
  if (segments.length === 3 && sub === TICKET_SUB.READY && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const result = wg.markReady(ticket.id, API_ACTOR);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/move — human/admin board move (drag a card to a status column,
  // e.g. un-ready: ready -> draft). Guarded by the state machine + policy gates;
  // an illegal drop comes back as ILLEGAL_TRANSITION (409), a no-op as NO_OP.
  if (segments.length === 3 && sub === TICKET_SUB.MOVE && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = moveTicketBody.parse(await readJsonBody(req));
    const result = wg.moveTicket(ticket.id, body.to, API_ACTOR);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // TRACK-2b: /tickets/:id/human-claim — the operator takes a ready ticket "by
  // hand" ("I'll do this myself"). Moves it ready -> in_progress owned by the human;
  // the agent selection loop structurally skips it thereafter. 409 when the ticket
  // isn't a claimable `ready` ticket.
  if (segments.length === 3 && sub === TICKET_SUB.HUMAN_CLAIM && method === "POST") {
    humanClaimBody.parse(await readJsonBody(req));
    const ticket = wg.resolveTicket(id);
    const result = wg.humanClaimTicket(ticket.id, API_ACTOR);
    sendJson(res, 200, { ticket_id: result.ticketId, number: result.number, human_owned: true });
    return;
  }

  // TRACK-2b: /tickets/:id/human-release — the operator hands a by-hand ticket back
  // to the queue (in_progress -> ready, clearing the ownership marker). 409 when the
  // ticket isn't human-owned in-flight work.
  if (segments.length === 3 && sub === TICKET_SUB.HUMAN_RELEASE && method === "POST") {
    humanClaimBody.parse(await readJsonBody(req));
    const ticket = wg.resolveTicket(id);
    const result = wg.humanReleaseTicket(ticket.id, API_ACTOR);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      status: result.status,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/events
  if (segments.length === 3 && sub === TICKET_SUB.EVENTS && method === "GET") {
    sendJson(res, 200, { events: wg.listTicketEvents(id) });
    return;
  }

  // FAILURE-DIAGNOSIS: /tickets/:id/rework-trail — the full ordered "why did #N
  // fail" history (attempt 1 → 2 → …), each with the distilled failing test +
  // assertion. Distinct from the board's latest-only rework chip.
  if (segments.length === 3 && sub === TICKET_SUB.REWORK_TRAIL && method === "GET") {
    sendJson(res, 200, { rework_trail: wg.reworkTrail(id) });
    return;
  }

  // /tickets/:id/review/(approve|reject)
  if (segments.length === 4 && sub === TICKET_SUB.REVIEW && method === "POST") {
    const action = segments[3] as string;
    if (action === "approve") {
      const result = wg.approveReview(id, API_ACTOR);
      // The ticket has reached `ready_for_merge` via the review-approve path (NOT
      // `done` — `done` means the merge actually landed). Fire the configured
      // auto-merge command (fire-and-gaffert; logged, never fatal): it does the git
      // merge and then calls `wg ticket mark-merged <n> --as system`
      // (ready_for_merge -> done). Skips silently when unconfigured.
      let merge: { triggered: boolean; pid: number | null; skipped?: string } | undefined;
      const number = result.ticket.number;
      if (number !== null) {
        merge = mergeRunner.trigger({ ticketNumber: number });
      }
      sendJson(res, 200, {
        ticket: result.ticket,
        event_id: result.eventId,
        ...(merge ? { merge } : {}),
      });
      return;
    }
    if (action === "reject") {
      const body = rejectReviewBody.parse(await readJsonBody(req));
      const result = wg.rejectReview(id, body.to, API_ACTOR, body.reason);
      sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
      return;
    }
  }

  // /tickets/:id/mark-merged — MERGE-COMPLETE callback (ready_for_merge -> done).
  // The merge runner calls this once the git merge of the delivery branch lands,
  // so `done` means actually merged. System/admin only (the REST surface acts as
  // the system actor); a user/board-drag can never reach this.
  if (segments.length === 3 && sub === TICKET_SUB.MARK_MERGED && method === "POST") {
    const result = wg.markMerged(id, { type: "system", id: "dispatch-api" });
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // BBT-001: /tickets/:id/testable — set the independent-testing eligibility flag.
  if (segments.length === 3 && sub === TICKET_SUB.TESTABLE && method === "POST") {
    const body = setTestableBody.parse(await readJsonBody(req));
    const result = wg.setTestable(id, body.can_be_tested, API_ACTOR);
    sendJson(res, 200, result);
    return;
  }

  // BBT-001: /tickets/:id/test-contract — record the testing handover artifact.
  if (segments.length === 3 && sub === TICKET_SUB.TEST_CONTRACT && method === "POST") {
    const body = setTestContractBody.parse(await readJsonBody(req));
    const contract = wg.setTestContract(id, body, API_ACTOR);
    sendJson(res, 200, { test_contract: contract });
    return;
  }

  // BBT-001: /tickets/:id/tester — record a tester verdict (pass → ready_for_merge,
  // fail → refining). The REST surface acts as the system actor here, recording the
  // tester's reported result; the actual merge stays the guarded mark-merged path.
  if (segments.length === 3 && sub === TICKET_SUB.TESTER && method === "POST") {
    const body = testerVerdictBody.parse(await readJsonBody(req));
    const testerActor = { type: "system" as const, id: "dispatch-api" };
    const verdictInput = { summary: body.summary, ...(body.uri ? { uri: body.uri } : {}) };
    const result =
      body.verdict === "pass"
        ? wg.testerPass(id, verdictInput, testerActor)
        : wg.testerFail(id, verdictInput, testerActor);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/diff — diff-in-review: the real git diff per WRITE repo
  // (default-branch...delivery-branch) so a reviewer reads the change before
  // approving (and the resolved diff after a reopen-for-review).
  if (segments.length === 3 && sub === TICKET_SUB.DIFF && method === "GET") {
    sendJson(res, 200, wg.ticketDiff(id));
    return;
  }

  // /tickets/:id/reopen-for-review — auto-merge re-approval callback
  // (done -> in_review). System/admin only; records the resolver's resolution.
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN_FOR_REVIEW && method === "POST") {
    const body = reopenForReviewBody.parse(await readJsonBody(req));
    const result = wg.reopenForReview(
      id,
      { reason: body.reason, resolution: body.resolution },
      // The REST surface acts as the system actor for this machine-driven path.
      { type: "system", id: "dispatch-api" },
    );
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      status: result.status,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/wont-do — mark a ticket terminal "won't do" (-> cancelled
  // bucket). Guarded: rejected for in-flight/claimed tickets and resets the ACs.
  if (segments.length === 3 && sub === TICKET_SUB.WONT_DO && method === "POST") {
    const body = wontDoBody.parse(await readJsonBody(req));
    const result = wg.wontDo(id, API_ACTOR, body.reason);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/reopen — pull a won't-do (cancelled) ticket back into the
  // pipeline (-> refining by default, or draft).
  if (segments.length === 3 && sub === TICKET_SUB.REOPEN && method === "POST") {
    const body = reopenWontDoBody.parse(await readJsonBody(req));
    const result = wg.reopenFromWontDo(id, body.to, API_ACTOR);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // PAUSE-ON-CAP: /tickets/:id/continue — one-click Continue a paused (cap-hit)
  // delivery. Marks the paused ticket resume-requested so the factory loop re-enters
  // delivery in the existing worktree. 409 if the ticket isn't paused.
  if (segments.length === 3 && sub === TICKET_SUB.CONTINUE && method === "POST") {
    continuePausedBody.parse(await readJsonBody(req));
    const result = wg.continuePaused(id, API_ACTOR);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      event_id: result.eventId,
      resume_requested: true,
    });
    return;
  }

  // PAUSE-ON-CAP: /tickets/:id/stop — abandon a paused delivery (-> cancelled),
  // dropping the resume context; the runner reaps the worktree. 409 if not paused.
  if (segments.length === 3 && sub === TICKET_SUB.STOP && method === "POST") {
    const body = stopPausedBody.parse(await readJsonBody(req));
    const result = wg.stopPaused(id, API_ACTOR, body.reason);
    sendJson(res, 200, { ticket: result.ticket, event_id: result.eventId });
    return;
  }

  // /tickets/:id/ready-approval — grant the regulated-pack human ready-approval.
  if (segments.length === 3 && sub === TICKET_SUB.READY_APPROVAL && method === "POST") {
    const result = wg.grantReadyApproval(id, API_ACTOR);
    sendJson(res, 200, { ticket_id: result.ticketId, event_id: result.eventId });
    return;
  }

  // /tickets/:id/delivery-artifact — record where the ticket was delivered.
  if (segments.length === 3 && sub === TICKET_SUB.DELIVERY_ARTIFACT && method === "POST") {
    const ticket = wg.resolveTicket(id);
    const body = recordDeliveryArtifactBody.parse(await readJsonBody(req));
    const result = wg.recordDeliveryArtifact(
      {
        ticket_id: ticket.id,
        branch_name: body.branch_name,
        pr_url: body.pr_url,
        commit: body.commit,
        diff_summary: body.diff_summary,
      },
      API_ACTOR,
    );
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      branch_name: result.branchName,
      pr_url: result.prUrl,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/reviewer — assign the reviewer the strict packs gate on.
  if (segments.length === 3 && sub === TICKET_SUB.REVIEWER && method === "PUT") {
    const body = assignReviewerBody.parse(await readJsonBody(req));
    const result = wg.assignReviewer(id, body.reviewer, API_ACTOR);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      reviewer: result.reviewer,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/required-capabilities — GET the set, or PUT to replace it.
  if (segments.length === 3 && sub === TICKET_SUB.REQUIRED_CAPABILITIES) {
    if (method === "GET") {
      sendJson(res, 200, { capabilities: wg.listRequiredCapabilities(id) });
      return;
    }
    if (method === "PUT") {
      const ticket = wg.resolveTicket(id);
      const body = setRequiredCapabilitiesBody.parse(await readJsonBody(req));
      const result = wg.setRequiredCapabilities(
        { ticket_id: ticket.id, capabilities: body.capabilities },
        API_ACTOR,
      );
      sendJson(res, 200, { capabilities: result.capabilities, event_id: result.eventId });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- WG-001: ticket scope links ------------------------------------------

  // /tickets/:id/scopes — GET links, POST to link a scope node.
  if (segments.length === 3 && sub === TICKET_SUB.SCOPES) {
    if (method === "GET") {
      sendJson(res, 200, { scopes: wg.listTicketScopes(id) });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = linkTicketScopeBody.parse(await readJsonBody(req));
      const link = wg.linkTicketScope({ ticket_id: ticket.id, ...body }, API_ACTOR);
      sendJson(res, 201, { scope: link });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/scopes/:nodeId — DELETE a ticket↔scope link.
  if (segments.length === 4 && sub === TICKET_SUB.SCOPES && method === "DELETE") {
    const result = wg.removeTicketScope(id, segments[3] as string, API_ACTOR);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      scope_node_id: result.scopeNodeId,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/dependencies — GET this ticket's dependencies, POST to add one.
  if (segments.length === 3 && sub === TICKET_SUB.DEPENDENCIES) {
    if (method === "GET") {
      sendJson(res, 200, { dependencies: wg.listDependencies(id) });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = addTicketDependencyBody.parse(await readJsonBody(req));
      const result = wg.addDependency(
        { ticket: ticket.id, depends_on: body.depends_on },
        API_ACTOR,
      );
      sendJson(res, 201, {
        ticket_id: result.ticketId,
        depends_on_ticket_id: result.dependsOnTicketId,
        event_id: result.eventId,
      });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // /tickets/:id/dependencies/:dependsOnRef — DELETE one dependency edge.
  if (segments.length === 4 && sub === TICKET_SUB.DEPENDENCIES && method === "DELETE") {
    const result = wg.removeDependency(id, segments[3] as string, API_ACTOR);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      depends_on_ticket_id: result.dependsOnTicketId,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/primary-scope — PUT to mark a scope node primary.
  if (segments.length === 3 && sub === TICKET_SUB.PRIMARY_SCOPE && method === "PUT") {
    const body = setPrimaryScopeBody.parse(await readJsonBody(req));
    const link = wg.setPrimaryScope(id, body.scope_node_id, API_ACTOR);
    sendJson(res, 200, { scope: link });
    return;
  }

  // --- WG-002: ticket↔repo access boundaries -------------------------------

  // /tickets/:id/repo-access — PUT to set a repo's access boundary.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_ACCESS && method === "PUT") {
    const ticket = wg.resolveTicket(id);
    const body = setTicketRepoAccessBody.parse(await readJsonBody(req));
    const result = wg.setTicketRepoAccess({ ticket_id: ticket.id, ...body }, API_ACTOR);
    sendJson(res, 200, {
      ticket_id: result.ticketId,
      repo_id: result.repoId,
      access: result.access,
      relation: result.relation,
      event_id: result.eventId,
    });
    return;
  }

  // /tickets/:id/work-repos — GET the partitioned execution boundary.
  if (segments.length === 3 && sub === TICKET_SUB.WORK_REPOS && method === "GET") {
    sendJson(res, 200, { work_repos: wg.workPacketRepos(id) });
    return;
  }

  // /tickets/:id/mono-fallback — POST to promote a single unmapped repo to write.
  if (segments.length === 3 && sub === TICKET_SUB.MONO_FALLBACK && method === "POST") {
    const result = wg.applyMonoFallback(id, API_ACTOR);
    sendJson(res, 200, result);
    return;
  }

  // --- FG-005: scope→repo suggestions --------------------------------------

  // /tickets/:id/repo-suggestions — GET advisory repo suggestions for the ticket.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_SUGGESTIONS && method === "GET") {
    const ticket = wg.resolveTicket(id);
    const suggestions = wg.suggestReposForTicket({ ticketId: ticket.id }, API_ACTOR);
    sendJson(res, 200, { suggestions });
    return;
  }

  // --- WG-004: claimability (readiness preview) ----------------------------

  // /tickets/:id/claimability — GET {ready, blockers, warnings} from the gate.
  if (segments.length === 3 && sub === TICKET_SUB.CLAIMABILITY && method === "GET") {
    sendJson(res, 200, wg.claimability(id));
    return;
  }

  // --- WG-005: per-repo delivery artifacts ---------------------------------

  // /tickets/:id/repo-deliveries — GET the per-repo delivery list, POST to record one.
  if (segments.length === 3 && sub === TICKET_SUB.REPO_DELIVERIES) {
    if (method === "GET") {
      sendJson(res, 200, { deliveries: wg.listRepoDeliveries(id) });
      return;
    }
    if (method === "POST") {
      const ticket = wg.resolveTicket(id);
      const body = recordRepoDeliveryBody.parse(await readJsonBody(req));
      const result = wg.recordRepoDelivery({ ticket_id: ticket.id, ...body }, API_ACTOR);
      sendJson(res, 201, { delivery: result.delivery, event_id: result.eventId });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No ticket route for ${method} /${segments.join("/")}.`),
  );
}

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
async function routeScope(
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
        sendJson(res, 201, { node });
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
        sendJson(res, 201, { edge });
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
        sendJson(res, 201, { association: link });
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

async function routeDecisions(
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
      sendJson(res, 201, { decision });
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

async function routeClaims(
  wg: Dispatch,
  method: string,
  segments: string[],
  res: ServerResponse,
): Promise<void> {
  // /claims
  if (segments.length === 1 && method === "GET") {
    sendJson(res, 200, { claims: wg.listActiveClaims() });
    return;
  }

  // /claims/:id/revoke
  if (segments.length === 3 && segments[2] === "revoke" && method === "POST") {
    const result = wg.revokeClaim(segments[1] as string, API_ACTOR);
    sendJson(res, 200, { claim_id: result.claimId, ticket_id: result.ticketId });
    return;
  }

  sendJson(
    res,
    404,
    errorBody("NOT_FOUND", `No claim route for ${method} /${segments.join("/")}.`),
  );
}

/** Default number of audit lines surfaced by GET /api/audit. */
const AUDIT_TAIL_DEFAULT = 50;

/**
 * Read-only "showcase" surfaces under /api: the kanban board, the factory
 * dashboard summary, the cross-ticket activity feed, and the optional tool-audit
 * tail. All GET-only — none of these mutate state.
 */
function routeReadModels(
  wg: Dispatch,
  memoryReader: MemoryReader,
  method: string,
  segments: string[],
  url: URL,
  res: ServerResponse,
): void {
  // --- Memory product read surfaces (memory digest / features / lore) ----
  //
  // These read the SEPARATE memory store SERVER-SIDE (via the configured memory
  // CLI) so the SPA hits ONE origin. Every one degrades gracefully: when the
  // memory product is unavailable they answer 200 with `{ available:false,
  // reason }`, NEVER a 500 — an unconfigured/unbuilt memory store must never
  // break the dashboard.
  if (segments.length === 4 && segments[1] === "memory" && segments[2] === "digest") {
    if (method !== "GET") return methodNotAllowed(res);
    const repo = safeDecode(segments[3] as string);
    if (repo === null)
      return sendJson(res, 422, errorBody("VALIDATION_ERROR", "Malformed repo path segment."));
    sendJson(res, 200, memoryReader.digest(repo));
    return;
  }
  if (segments.length === 4 && segments[1] === "memory" && segments[2] === "features") {
    if (method !== "GET") return methodNotAllowed(res);
    const repo = safeDecode(segments[3] as string);
    if (repo === null)
      return sendJson(res, 422, errorBody("VALIDATION_ERROR", "Malformed repo path segment."));
    const status = url.searchParams.get("status") ?? undefined;
    const node = url.searchParams.get("node") ?? undefined;
    sendJson(
      res,
      200,
      memoryReader.features(repo, {
        ...(status !== undefined ? { status } : {}),
        ...(node !== undefined ? { node } : {}),
      }),
    );
    return;
  }
  if (segments.length === 3 && segments[1] === "memory" && segments[2] === "lore") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, memoryReader.lore());
    return;
  }

  // /api/board — tickets grouped into kanban columns (+ closed area).
  // Accepts optional ?repo= to restrict the board to one repository.
  if (segments.length === 2 && segments[1] === "board") {
    if (method !== "GET") return methodNotAllowed(res);
    const repoFilter = url.searchParams.get("repo") ?? undefined;
    sendJson(res, 200, wg.board(repoFilter));
    return;
  }

  // /api/dashboard — summary tiles for the factory activity dashboard.
  if (segments.length === 2 && segments[1] === "dashboard") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { summary: wg.dashboard() });
    return;
  }

  // /api/human-queue — Track 2a "What I own": the HUMAN-owned queue (pending
  // decisions with reasons, review sign-offs, regulated ready-approvals/reviewer
  // assignments), each with what/which-ticket/why/how-long. Read-only.
  if (segments.length === 2 && segments[1] === "human-queue") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, wg.humanQueue());
    return;
  }

  // /api/activity?limit=&offset= — newest-first cross-ticket event feed.
  if (segments.length === 2 && segments[1] === "activity") {
    if (method !== "GET") return methodNotAllowed(res);
    const q = activityQuery.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    const page = wg.activity(q);
    sendJson(res, 200, {
      events: page.events,
      total: page.total,
      limit: q.limit,
      offset: q.offset,
    });
    return;
  }

  // FAILURE-DIAGNOSIS: GET /api/rework/bouncing?min=&limit= — the cross-ticket
  // "these keep bouncing" signal: tickets with a rework trail, ranked worst-first
  // (repeated same-gate failures lead). The operator's key quality signal.
  if (segments.length === 3 && segments[1] === "rework" && segments[2] === "bouncing") {
    if (method !== "GET") return methodNotAllowed(res);
    const parseCap = (raw: string | null, fallback: number): number => {
      if (raw === null) return fallback;
      const n = Number.parseInt(raw, 10);
      return Number.isInteger(n) && n > 0 ? n : fallback;
    };
    const bouncing = wg.bouncingTickets({
      minReworks: parseCap(url.searchParams.get("min"), 2),
      limit: parseCap(url.searchParams.get("limit"), 20),
    });
    sendJson(res, 200, { bouncing });
    return;
  }

  // /api/audit?limit= — optional redacted tool-audit tail (hidden when absent).
  if (segments.length === 2 && segments[1] === "audit") {
    if (method !== "GET") return methodNotAllowed(res);
    const raw = url.searchParams.get("limit");
    const parsed = raw === null ? AUDIT_TAIL_DEFAULT : Number.parseInt(raw, 10);
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : AUDIT_TAIL_DEFAULT;
    sendJson(res, 200, readAuditTail(limit));
    return;
  }

  // RUN-ACTIVITY: GET /api/runs?active=1&limit=N — the in-flight + recent runs
  // that power the dashboard's "Running now" panel. Returns BOTH the active runs
  // and the most-recent finished runs so the panel renders in one fetch.
  if (segments.length === 2 && segments[1] === "runs") {
    if (method !== "GET") return methodNotAllowed(res);
    const q = runsQuery.parse({
      active: url.searchParams.get("active") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    // Active list is hard-capped (a wedged factory could leak many running rows);
    // surface truncation so the panel can show "showing N of many" rather than
    // silently dropping in-flight runs.
    const activeResult = wg.listRunsResult({ active: true });
    // The recent list is the most-recent N of any status; drop the still-running
    // ones so `recent` reads as the finished tail (active are shown separately).
    const recent = wg
      .listRuns({ limit: q.limit })
      .filter((r) => r.status !== "running")
      .slice(0, q.limit);
    sendJson(res, 200, {
      active: activeResult.runs,
      active_truncated: activeResult.truncated,
      recent,
    });
    return;
  }

  // GET /api/cost — factory-wide cost summary from the usage ledger.
  // Defensive: returns a zero-state envelope when the ledger is absent or
  // unreadable. Lists are capped so a large ledger never bloats the response.
  // Behind the same bearer gate as the rest of /api (checked in route()).
  if (segments.length === 2 && segments[1] === "cost") {
    if (method !== "GET") return methodNotAllowed(res);
    const TOP_N = 25;
    // Build a ticket-number→repo-name resolver from the dispatch state.
    const resolver = (ticketNumber: number): string | null => {
      try {
        const ticket = wg.tickets.findByNumber(ticketNumber);
        if (!ticket) return null;
        const links = wg.repos.accessLinksForTicket(ticket.id);
        return links[0]?.name ?? null;
      } catch {
        return null;
      }
    };
    const agg = aggregateCosts(process.env, resolver);
    // Compute today's spend separately for the dashboard tile.
    const ledgerPath = resolveLedgerPath(process.env);
    const rows = ledgerPath ? readLedgerRows(ledgerPath) : [];
    const today_usd = todaySpend(rows);
    sendJson(res, 200, {
      total_usd: agg.total_usd,
      today_usd,
      ticket_count: agg.ticket_count,
      last_record_at: agg.last_record_at,
      by_repo: agg.by_repo.slice(0, TOP_N),
      top_tickets: agg.by_ticket.slice(0, TOP_N),
    });
    return;
  }

  // GET /api/health — factory-health / ROI synthesis. Two authoritative reads in
  // one envelope, mirroring /api/cost's compose pattern:
  //   1. ledger ROI (aggregateHealth) — cost-per-shipped, spend-by-kind, token
  //      mix, measured-vs-unknown coverage, daily spend, cost-of-rework, latency;
  //   2. delivery flow (deliveryFlow) — the ONE server-side cycle-time/throughput
  //      definition the Overview now reads (was recomputed client-side).
  // Defensive: zero-state safe when the ledger is absent; lists capped so a large
  // ledger never bloats the response. Read-only, behind the same posture as /api.
  if (segments.length === 2 && segments[1] === "health") {
    if (method !== "GET") return methodNotAllowed(res);
    const TOP_N = 25;

    // Shipped divisor + ticket list for delivery flow come from one ticket read.
    const allTickets = wg.tickets.listFiltered({});
    const shippedCount = allTickets.filter((t) => t.status === "done").length;
    const flowTickets: FlowTicket[] = allTickets.map((t) => ({
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    // Rework resolver: ticket-number → rework-attempt count, one grouped query.
    const reworkRows = wg.db
      .prepare(
        `SELECT t.number AS number, COUNT(*) AS c
           FROM rework_attempts ra
           JOIN tickets t ON t.id = ra.ticket_id
          WHERE t.number IS NOT NULL
          GROUP BY t.number`,
      )
      .all() as Array<{ number: number; c: number }>;
    const reworkByNumber = new Map(reworkRows.map((r) => [r.number, r.c]));
    const resolveRework: ReworkResolver = (n) => reworkByNumber.get(n) ?? 0;

    const health = aggregateHealth(process.env, { shippedCount, resolveRework });
    const flow = deliveryFlow(flowTickets, Date.parse(wg.clock.now()) || Date.now());

    sendJson(res, 200, {
      total_usd: health.total_usd,
      ticket_count: health.ticket_count,
      shipped_count: health.shipped_count,
      cost_per_shipped_usd: health.cost_per_shipped_usd,
      coverage: health.coverage,
      by_kind: health.by_kind.slice(0, TOP_N),
      by_model: health.by_model.slice(0, TOP_N),
      daily_spend: health.daily_spend,
      rework: {
        total_rework_cost_usd: health.rework.total_rework_cost_usd,
        rework_cost_share_pct: health.rework.rework_cost_share_pct,
        by_ticket: health.rework.by_ticket.slice(0, TOP_N),
      },
      duration: health.duration,
      cycle_time: flow.cycle_time,
      throughput: flow.throughput,
      last_record_at: health.last_record_at,
    });
    return;
  }

  // RUN-ACTIVITY: GET /api/runs/:id — enriched run detail (phase · model · turns
  // · cost · log tail · outcome) assembled from the run row + its log file +
  // the usage ledger. Zero-state safe: missing log or absent ledger returns
  // null/zero fields rather than a 5xx. 404 for unknown run ids.
  if (segments.length === 3 && segments[1] === "runs") {
    if (method !== "GET") return methodNotAllowed(res);
    const run = wg.runs.findById(segments[2] as string);
    if (!run) {
      sendJson(res, 404, errorBody("NOT_FOUND", "Run not found."));
      return;
    }
    // Read the byte-capped raw tail (same reader as the /log endpoint); the
    // detail builder then applies the line cap on top.
    const logText = run.log_path ? readLogTail(run.log_path, RUN_LOG_TAIL_BYTES) : null;
    const detail = buildRunDetail(run, logText, process.env);
    sendJson(res, 200, { detail });
    return;
  }

  // RUN-ACTIVITY: GET /api/runs/:id/log — the tail (last RUN_LOG_TAIL_BYTES) of a
  // run's captured output, as text/plain. 404 when the run or its log is missing.
  // Privileged read like the rest of /api (behind the bearer gate in route()).
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "log") {
    if (method !== "GET") return methodNotAllowed(res);
    const run = wg.runs.findById(segments[2] as string);
    if (!run || !run.log_path) {
      sendJson(res, 404, errorBody("NOT_FOUND", "No log for that run."));
      return;
    }
    const tail = readLogTail(run.log_path, RUN_LOG_TAIL_BYTES);
    if (tail === null) {
      sendJson(res, 404, errorBody("NOT_FOUND", "Run log file is missing."));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(tail);
    return;
  }

  sendJson(res, 404, errorBody("NOT_FOUND", `No route for ${method} ${url.pathname}.`));
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, errorBody("METHOD_NOT_ALLOWED", "Method not allowed for this route."));
}

/** Percent-decode a path segment, returning null on a malformed sequence. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Cap on the run-log tail returned by GET /api/runs/:id/log (last 64KB). */
const RUN_LOG_TAIL_BYTES = 64 * 1024;

/**
 * Read the last `maxBytes` of a run log file as UTF-8 text. Returns null when the
 * file is missing/unreadable (the route maps that to a 404). Reading only the
 * tail (via stat + a positioned read) bounds memory regardless of log size — a
 * long-running, chatty run never balloons the response.
 */
function readLogTail(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = Math.min(size, maxBytes);
    if (length === 0) return "";
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed / invalid — nothing to do.
      }
    }
  }
}
