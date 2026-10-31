import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import {
  errorBody,
  methodNotAllowed,
  readJsonBody,
  safeDecode,
  sendCreated,
  sendJson,
} from "../http.js";
import { readIdleLoops, resolveCrewConfigPath, writeIdleLoops } from "../idleLoops.js";
import { LORE_ID_RE, type MemoryReader } from "../memoryReader.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import { isAdminRequest, requestCapability, requestPrincipal } from "../auth.js";
import { DispatchError, notFound } from "../../util/errors.js";
import {
  autonomyPolicyBody,
  createPrincipalBody,
  idleLoopsBody,
  memoryLoreQuery,
  rejectLoreBody,
  settingsBody,
  updateClubBody,
  updateSquadAgentBody,
} from "../schemas.js";
import { listSettings, readSecretSetting, writeSettings } from "../settings.js";
import { apiActor } from "./context.js";
import { routeReadModels } from "./readModels.js";

/**
 * The `/api` control surface. The mutating config routes (settings, idle-loops,
 * autonomy policy) are handled here in the same order as the original inline
 * blocks; everything else under /api falls through to the read-only
 * {@link routeReadModels}, which owns its own 404. Always terminal for the `api`
 * segment, so the dispatcher returns after calling it.
 */
export async function routeApi(
  wg: Dispatch,
  memoryReader: MemoryReader,
  method: string,
  segments: string[],
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // GET/POST /api/settings — the UI-editable factory config layer. GET reports
  // every known setting (file value + envLocked + group); POST merges + writes
  // settings.json atomically, refusing env-locked keys (env always wins) and
  // dropping anything outside the known allow-list. Behind the same bearer
  // gate + security headers as the rest of the control plane (checked above).
  if (segments.length === 2 && segments[1] === "settings") {
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
        invalid: result.invalid,
      });
      return;
    }
    return methodNotAllowed(res);
  }
  // GET /api/settings/secret/:key — an ADMIN principal reads a secret-bearing setting
  // back (external review #5). Every other principal sees only configured + host in
  // GET /api/settings; a read token or a human principal gets 403 here.
  if (segments.length === 4 && segments[1] === "settings" && segments[2] === "secret") {
    if (method !== "GET") return methodNotAllowed(res);
    if (!isAdminRequest(req)) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only an admin principal may read a secret setting back; others see whether it is configured and its host.",
      );
    }
    const secret = readSecretSetting(safeDecode(segments[3] ?? "") ?? "");
    if (!secret) throw notFound("secret setting", segments[3] ?? "");
    sendJson(res, 200, secret);
    return;
  }
  // GET /api/openapi.json — the REST contract, generated from the same zod schemas
  // the routes parse with (api/openapi/spec.ts). Built once per process: the
  // document is a pure function of the code. Behind the read gate like every
  // other data route (it describes the control plane; the shell stays tokenless).
  if (segments.length === 2 && segments[1] === "openapi.json") {
    if (method !== "GET") return methodNotAllowed(res);
    openApiCache ??= JSON.stringify(buildOpenApiDocument());
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(openApiCache),
    });
    res.end(openApiCache);
    return;
  }
  // GET /api/whoami — how this request authenticated: capability tier, the actor
  // its writes are attributed to, and the principal (null for the shared token).
  if (segments.length === 2 && segments[1] === "whoami") {
    if (method !== "GET") return methodNotAllowed(res);
    const p = requestPrincipal(req);
    sendJson(res, 200, {
      capability: requestCapability(req) ?? "full",
      actor: apiActor(),
      principal: p ? { id: p.principal.id, name: p.principal.name } : null,
    });
    return;
  }
  // PER-PRINCIPAL CREDENTIALS — GET/POST /api/principals, DELETE /api/principals/:id.
  // Named bearer tokens bound to an actor identity + capability. Creation returns
  // the token ONCE; the list never carries hashes. Mutations need the full tier
  // (the capability gate upstream), so a read principal can see but not mint — AND
  // the operator's own credential: a principal token may not mint or revoke
  // principals at all. Otherwise a CI/bot credential could mint an admin identity
  // under any actor_id (forging attribution, including admin "ground truth" for the
  // autonomy recommendations) or revoke other people's tokens.
  if (segments.length === 2 && segments[1] === "principals") {
    if (method === "GET") {
      sendJson(res, 200, { principals: wg.listPrincipals() });
      return;
    }
    if (method === "POST") {
      if (refuseIfPrincipal(req, res)) return;
      const body = createPrincipalBody.parse(await readJsonBody(req));
      const { principal, token } = wg.createPrincipal(
        {
          name: body.name,
          capability: body.capability,
          actorType: body.actor_type,
          actorId: body.actor_id,
        },
        apiActor(),
      );
      sendCreated(res, `/api/principals/${principal.id}`, { principal, token });
      return;
    }
    return methodNotAllowed(res);
  }
  if (segments.length === 3 && segments[1] === "principals") {
    // GET one principal (id or name) — the Location POST /api/principals returns.
    if (method === "GET") {
      sendJson(res, 200, { principal: wg.getPrincipal(segments[2] ?? "") });
      return;
    }
    if (method !== "DELETE") return methodNotAllowed(res);
    if (refuseIfPrincipal(req, res)) return;
    const principal = wg.revokePrincipal(segments[2] ?? "", apiActor());
    sendJson(res, 200, { principal });
    return;
  }
  // SQUAD — the operator's team identity for the dashboard's Match Day view.
  //   GET   /api/club                — the club (name / short name / kit; "Gaffer" default).
  //   PATCH /api/club                — partial update; null or "" clears a field.
  //   GET   /api/squad               — the club + every agent's display name, shirt
  //                                    number, role and derived default name.
  //   PATCH /api/squad/agents/:id    — set an agent's display name / shirt number.
  // Presentation only: the agent id claims/events/audit record never changes.
  // Writes need the full capability (the non-GET gate upstream) and are recorded in
  // the tamper-evident event log (club.updated / agent.display_updated) as the
  // request's actor. No MCP tool writes these — an agent cannot rename itself.
  if (segments.length === 2 && segments[1] === "club") {
    if (method === "GET") {
      sendJson(res, 200, { club: wg.getClub() });
      return;
    }
    if (method === "PATCH") {
      const body = updateClubBody.parse(await readJsonBody(req));
      sendJson(res, 200, wg.updateClub(body, apiActor()));
      return;
    }
    return methodNotAllowed(res);
  }
  if (segments.length === 2 && segments[1] === "squad") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { club: wg.getClub(), agents: wg.listSquad() });
    return;
  }
  if (segments.length === 4 && segments[1] === "squad" && segments[2] === "agents") {
    if (method !== "PATCH") return methodNotAllowed(res);
    const ref = safeDecode(segments[3] as string);
    if (ref === null) {
      return sendJson(res, 422, errorBody("VALIDATION_ERROR", "Malformed agent id."));
    }
    const body = updateSquadAgentBody.parse(await readJsonBody(req));
    sendJson(res, 200, wg.updateAgentDisplay(ref, body, apiActor()));
    return;
  }
  // GET/PUT /api/idle-loops — dashboard control for the crew idle scan loops.
  // GET reads the `loops.idle_<key>.{enabled,repos}` slice of crew.yaml (a
  // missing file is a clean "not configured" shape, never a 500). PUT validates
  // the requested keys + repo NAMES (cross-checked against the registered repos)
  // and writes the slice back, preserving the rest of the YAML. Privileged: same
  // bearer gate as the rest of the control plane (checked above). The crew runner
  // re-reads crew.yaml each tick, so changes apply on its NEXT tick.
  if (segments.length === 2 && segments[1] === "idle-loops") {
    const crewPath = resolveCrewConfigPath();
    if (method === "GET") {
      sendJson(res, 200, { idle_loops: readIdleLoops(crewPath) });
      return;
    }
    if (method === "PUT") {
      const body = idleLoopsBody.parse(await readJsonBody(req));
      const repoNames = wg.listRepositories(true).map((r) => r.name);
      const view = writeIdleLoops(crewPath, body.loops, repoNames, {
        ...(body.maintenance ? { maintenance: body.maintenance } : {}),
        ...(body.self_improve
          ? {
              selfImprove: {
                enabled: body.self_improve.enabled,
                repos: body.self_improve.repos,
                maxRisk: body.self_improve.max_risk,
                maxReadyPerRun: body.self_improve.max_ready_per_run,
              },
            }
          : {}),
      });
      sendJson(res, 200, { idle_loops: view });
      return;
    }
    return methodNotAllowed(res);
  }
  // GRADUATED-AUTONOMY (Spec 2, Phase 3): the enablement control plane.
  //   GET  /api/autonomy/policies — the active policies (repo × risk × gate, mode,
  //        who enabled, evidence snapshot) for the Settings "active policies" surface.
  //   POST /api/autonomy/policy   — enable/disable a policy. Enabling (mode !== 'off')
  //        requires `confirm:true` (the explicit-confirm trust boundary) and snapshots
  //        the current recommendation evidence into the row. Mutation ⇒ token-gated
  //        (checked above). SECURITY: a policy is only ever an ADDITIONAL allow-path —
  //        the enforcement (reviewGateService / merge site) falls back to the env flag,
  //        so this endpoint can never loosen the default below today's posture.
  if (segments.length === 3 && segments[1] === "autonomy" && segments[2] === "policies") {
    if (method !== "GET") return methodNotAllowed(res);
    sendJson(res, 200, { policies: wg.listAutonomyPolicies() });
    return;
  }
  if (segments.length === 3 && segments[1] === "autonomy" && segments[2] === "policy") {
    if (method !== "POST") return methodNotAllowed(res);
    const body = autonomyPolicyBody.parse(await readJsonBody(req));
    const policy = wg.setAutonomyPolicy(
      {
        repoId: body.repo_id,
        riskLevel: body.risk_level,
        gate: body.gate,
        mode: body.mode,
        confirm: body.confirm,
      },
      apiActor(),
    );
    sendJson(res, 200, { policy });
    return;
  }

  // GET /api/events/stream?since=<seq> — LIVE PUSH of the work_events log as
  // Server-Sent Events, replacing the dashboard's blind 3-second polling. Metadata
  // only (the same safe shape as /api/activity — never payload_json). The log is
  // append-only SQLite with no change notification, so the server tails it by
  // rowid on a short interval (one cheap indexed read per tick per client) and
  // fans out; a client resumes from `id:` after a reconnect via ?since=. Behind the
  // same bearer gate as every data route — the SPA streams it with `fetch`, which
  // (unlike EventSource) can carry the Authorization header, so the token never
  // rides in a URL.
  if (segments.length === 3 && segments[1] === "events" && segments[2] === "stream") {
    if (method !== "GET") return methodNotAllowed(res);
    streamEvents(wg, url, req, res);
    return;
  }

  // --- Lore ratification: list by status/repo/kind + approve/reject a draft ---
  //
  // Drafts from the distiller, onboarding and agents used to be approvable ONLY
  // with `memory review` in a terminal, and the dashboard listed at most 50 records
  // across all repos. These routes give the Memory view the same power through the
  // memory CLI (the write boundary — dispatch never opens the memory DB): `list
  // --json` for a filtered, paged read; `approve` / `reject` for the decision. The
  // read degrades to 200 `{ available:false, reason }` like every memory surface;
  // the mutations are behind the full-token gate (every non-GET is) and answer 409
  // when the CLI refuses (unknown id / not a draft), 503 when Memory is unreachable.
  if (segments.length === 3 && segments[1] === "memory" && segments[2] === "lore") {
    if (method !== "GET") return methodNotAllowed(res);
    const q = memoryLoreQuery.parse(Object.fromEntries(url.searchParams));
    sendJson(
      res,
      200,
      memoryReader.listLore({
        ...(q.repo !== undefined ? { repo: q.repo } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.kind !== undefined ? { kind: q.kind } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      }),
    );
    return;
  }
  if (
    segments.length === 5 &&
    segments[1] === "memory" &&
    segments[2] === "lore" &&
    (segments[4] === "approve" || segments[4] === "reject")
  ) {
    if (method !== "POST") return methodNotAllowed(res);
    const id = safeDecode(segments[3] as string);
    if (id === null || !LORE_ID_RE.test(id)) {
      return sendJson(
        res,
        422,
        errorBody("VALIDATION_ERROR", "Malformed lore id (expected 8 chars of a-z2-9)."),
      );
    }
    let result;
    if (segments[4] === "approve") {
      result = memoryReader.approveLore(id);
    } else {
      const body = rejectLoreBody.parse((await readJsonBody(req)) ?? {});
      result = memoryReader.rejectLore(id, body.reason);
    }
    if (result.available) {
      sendJson(res, 200, { id: result.id, status: result.status });
      return;
    }
    // The CLI names a refused decision — `reject`: "cannot reject <id> (unknown id
    // or not a draft …)", `approve`: "<id> is not a pending draft (already active,
    // deprecated, or unknown)"; anything else is Memory being unreachable /
    // misconfigured.
    const refused = isMemoryRefusal(result.reason);
    sendJson(
      res,
      refused ? 409 : 503,
      errorBody(refused ? "CONFLICT" : "MEMORY_UNAVAILABLE", result.reason),
    );
    return;
  }

  routeReadModels(wg, memoryReader, method, segments, url, res);
}

/**
 * Whether a memory CLI failure reason is a REFUSED approve/reject (the record is not
 * a pending draft, or the id is unknown) — a 409 CONFLICT — rather than Memory
 * being unavailable (503). Matches the real CLI wording of both verbs
 * (packages/memory/src/cli/commands/lifecycle.ts cmdApprove / cmdReject).
 */
export function isMemoryRefusal(reason: string): boolean {
  return /cannot (approve|reject)|unknown id|not a (pending )?draft/i.test(reason);
}

/** The serialised OpenAPI document, built on first request. */
let openApiCache: string | undefined;

/** Poll interval for tailing the event log (ms). */
const STREAM_POLL_MS = 1000;
/** Comment-frame heartbeat so proxies/browsers keep an idle stream open (ms). */
const STREAM_HEARTBEAT_MS = 15_000;
/** Max events flushed per tick — a burst is drained across ticks, never unbounded. */
const STREAM_BATCH = 200;
/** Concurrent stream cap: this is a single-operator control plane, not a broadcast bus. */
const STREAM_MAX_CLIENTS = 16;
/**
 * Hard lifetime of one stream (ms). The credential is re-checked on every tick, so
 * this is the backstop that forces a periodic re-authentication; the dashboard
 * reconnects with ?since=<last seq> and loses nothing.
 */
const STREAM_MAX_LIFETIME_MS = 60 * 60 * 1000;
let streamClients = 0;

function streamEvents(wg: Dispatch, url: URL, req: IncomingMessage, res: ServerResponse): void {
  if (streamClients >= STREAM_MAX_CLIENTS) {
    sendJson(res, 503, errorBody("STREAM_BUSY", "Too many concurrent event streams."));
    return;
  }
  const rawSince = url.searchParams.get("since");
  const parsedSince = rawSince === null ? Number.NaN : Number.parseInt(rawSince, 10);
  // Default: start from NOW (only new events); ?since=0 replays the whole log.
  let cursor =
    Number.isFinite(parsedSince) && parsedSince >= 0 ? parsedSince : wg.events.latestSeq();

  streamClients += 1;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`retry: 3000\n: connected seq=${cursor}\n\n`);

  let closed = false;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    streamClients -= 1;
    clearInterval(poll);
    clearInterval(beat);
    clearTimeout(lifetime);
    if (!res.writableEnded) res.end();
  };
  // The bearer gate ran once, when the stream opened. Re-resolve the SAME request's
  // credential before every write, so revoking a principal (or rotating the token)
  // cuts off a live feed at once instead of when the connection happens to drop.
  // A named frame tells the client why, so it does not read it as a network blip.
  const stillAuthorised = (): boolean => {
    if (requestCapability(req) !== null) return true;
    if (!res.writableEnded) res.write("event: auth_revoked\ndata: {}\n\n");
    stop();
    return false;
  };
  const tick = (): void => {
    if (closed || !stillAuthorised()) return;
    let rows: ReturnType<typeof wg.events.listSince>;
    try {
      rows = wg.events.listSince(cursor, STREAM_BATCH);
    } catch {
      // A closed DB (server shutting down) ends the stream cleanly.
      stop();
      return;
    }
    for (const row of rows) {
      cursor = row.seq;
      res.write(`id: ${row.seq}\nevent: work_event\ndata: ${JSON.stringify(row)}\n\n`);
    }
  };
  const poll = setInterval(tick, STREAM_POLL_MS);
  const beat = setInterval(() => {
    if (!closed && stillAuthorised()) res.write(": ping\n\n");
  }, STREAM_HEARTBEAT_MS);
  const lifetime = setTimeout(stop, STREAM_MAX_LIFETIME_MS);
  // Timers must never keep the process alive on their own (tests, shutdown).
  poll.unref?.();
  beat.unref?.();
  lifetime.unref?.();
  req.on("close", stop);
  res.on("close", stop);
  res.on("error", stop);
  tick();
}

/**
 * Principal management is the operator's job: only the shared token (or a server
 * with auth disabled — no principal resolves then) may mint or revoke principals.
 * Writes the 403 and returns true when the caller authenticated with a principal.
 */
function refuseIfPrincipal(req: IncomingMessage, res: ServerResponse): boolean {
  if (requestPrincipal(req) === null) return false;
  sendJson(
    res,
    403,
    errorBody(
      "PRINCIPAL_ADMIN_REQUIRED",
      "Only the shared operator token (or the local CLI) may create or revoke principals.",
    ),
  );
  return true;
}
