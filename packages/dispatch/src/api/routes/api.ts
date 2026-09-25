import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { errorBody, methodNotAllowed, readJsonBody, sendJson } from "../http.js";
import { readIdleLoops, resolveCrewConfigPath, writeIdleLoops } from "../idleLoops.js";
import type { MemoryReader } from "../memoryReader.js";
import { autonomyPolicyBody, idleLoopsBody, settingsBody } from "../schemas.js";
import { listSettings, writeSettings } from "../settings.js";
import { API_ACTOR } from "./context.js";
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
      const view = writeIdleLoops(crewPath, body.loops, repoNames);
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
      API_ACTOR,
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
  routeReadModels(wg, memoryReader, method, segments, url, res);
}

/** Poll interval for tailing the event log (ms). */
const STREAM_POLL_MS = 1000;
/** Comment-frame heartbeat so proxies/browsers keep an idle stream open (ms). */
const STREAM_HEARTBEAT_MS = 15_000;
/** Max events flushed per tick — a burst is drained across ticks, never unbounded. */
const STREAM_BATCH = 200;
/** Concurrent stream cap: this is a single-operator control plane, not a broadcast bus. */
const STREAM_MAX_CLIENTS = 16;
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
    if (!res.writableEnded) res.end();
  };
  const tick = (): void => {
    if (closed) return;
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
    if (!closed) res.write(": ping\n\n");
  }, STREAM_HEARTBEAT_MS);
  // Timers must never keep the process alive on their own (tests, shutdown).
  poll.unref?.();
  beat.unref?.();
  req.on("close", stop);
  res.on("close", stop);
  res.on("error", stop);
  tick();
}
