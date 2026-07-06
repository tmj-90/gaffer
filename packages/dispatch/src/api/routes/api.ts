import type { IncomingMessage, ServerResponse } from "node:http";

import type { Dispatch } from "../../core.js";
import { methodNotAllowed, readJsonBody, sendJson } from "../http.js";
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

  routeReadModels(wg, memoryReader, method, segments, url, res);
}
