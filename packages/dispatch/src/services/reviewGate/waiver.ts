/**
 * A PERSON'S TESTER VERDICT (package H1): who may record one, what a waiver is bound to,
 * and how it is shown.
 *
 * A person's verdict on the tester lane (a PASS that waives the independent tester, or a
 * FAIL) is accepted only from an ACTIVE principal of actor type human or admin with full
 * capability: the CLI with `GAFFER_PRINCIPAL_TOKEN` / `--as-principal`, the REST API (and
 * so the dashboard) with that principal's bearer token. The tokenless operator CLI, the
 * shared API token, `--as human|admin` without a principal, a revoked principal and any
 * row that is not a human or admin principal are refused: a flag that anyone who can run
 * the CLI may pass (an agent's shell included, were the safety hook to miss a spelling) is
 * not a person. The principal is re-read from the database by id inside the verdict's
 * transaction, so a revocation committed first refuses it, and the actor recorded is the
 * principal's own.
 *
 * A WAIVER records what dispatch computed, never the caller's word: the delivery head of
 * every write repo (the waiver covers those commits and no other), the contract hash, the
 * criteria it waives (every criterion of the ticket, or the ones named), the summary of
 * what the person checked, who waived (the principal) and whether the factory's agents run
 * without OS isolation (the runner's own isolation probe: then a human verdict is guarded
 * by the safety hook only, and the waiver says so). testerCoverage voids it on a new commit
 * in any covered repo or a contract change, exactly as it voids a tester PASS.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "../../db/connection.js";
import type { Actor } from "../../domain/types.js";
import type { PrincipalView } from "../../repositories/principalRepository.js";
import { DispatchError } from "../../util/errors.js";

/** The principal a person's verdict is recorded for (only the id is trusted; it is re-read). */
export type VerdictPrincipal = Pick<PrincipalView, "id"> & Partial<PrincipalView>;

/** How a person records a verdict, for every refusal below (one text, every surface). */
export function principalHowTo(ticketNumber: number | null, verb: "pass" | "fail"): string {
  const n = ticketNumber ?? "<n>";
  return (
    "Create a principal for yourself as the operator: `gaffer wg principal create <your-name>` " +
    "(add --admin for an admin) prints its token once. Then record the verdict with it: " +
    `\`GAFFER_PRINCIPAL_TOKEN=<token> gaffer wg ticket tester-${verb} ${n} --summary "<what you checked>"\`` +
    " (or --as-principal <token>), or sign in to the dashboard with that token and use Record tester PASS or FAIL."
  );
}

/**
 * Refuse a person's tester verdict without an active human or admin principal behind it;
 * returns the principal as stored now. An agent or system verdict returns null (the
 * runner's tester: its PASS needs the replay proof, checked elsewhere). A verdict whose
 * actor is human or admin is a person's, whatever surface sent it.
 */
export function assertVerdictPrincipal(
  db: Db,
  actor: Actor,
  principal: VerdictPrincipal | null | undefined,
  ticketNumber: number | null,
  verb: "pass" | "fail",
): PrincipalView | null {
  if (actor.type !== "human" && actor.type !== "admin") return null;
  const refuse = (why: string): never => {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      `A person's tester verdict (a PASS that waives the independent tester, or a FAIL) is recorded only for an active human or admin principal, and ${why}. Nothing was recorded. ${principalHowTo(ticketNumber, verb)}`,
      { reason: "principal_required", actor_type: actor.type },
    );
  };
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    refuse(
      "this call carries no principal (the tokenless CLI, `--as human|admin`, and the shared API token are not one)",
    );
  }
  const row = db
    .prepare(
      `SELECT id, name, capability, actor_type, actor_id, revoked_at FROM api_principals WHERE id = ?`,
    )
    .get(principal!.id) as
    | {
        id: string;
        name: string;
        capability: string;
        actor_type: string;
        actor_id: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return refuse("the principal is unknown");
  if (row.revoked_at) return refuse(`principal '${row.name}' is revoked`);
  if (row.actor_type !== "human" && row.actor_type !== "admin") {
    return refuse(`principal '${row.name}' is not a human or admin principal`);
  }
  if (row.capability !== "full") return refuse(`principal '${row.name}' is read-only`);
  if (row.actor_type !== actor.type || row.actor_id !== actor.id) {
    return refuse(
      `the actor (${actor.type}:${actor.id ?? ""}) is not principal '${row.name}' (${row.actor_type}:${row.actor_id})`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    capability: row.capability as PrincipalView["capability"],
    actor_type: row.actor_type as PrincipalView["actor_type"],
    actor_id: row.actor_id,
    created_by: null,
    created_at: "",
    last_used_at: null,
    revoked_at: null,
    scope: null,
  };
}

/** One criterion a waiver covers: its position (1 = the first), id and text. */
export interface WaivedCriterion {
  n: number;
  id: string;
  text: string;
}

/** What a waiver is bound to (the `waiver` object on its evidence payload). */
export interface WaiverBinding {
  principal: { id: string; name: string };
  actor: { type: string; id: string };
  /** Every write repo's delivery head when it was recorded (the commits it covers). */
  heads: Array<{ repo_id: string; repo: string; sha: string }>;
  contract_hash: string | null;
  criteria: WaivedCriterion[];
  summary: string;
  /** "none" when the factory's agents run without an OS sandbox, else the provider. */
  isolation: string;
  /** The tester FAIL this waiver overrides (a FAIL on the unchanged head), if any. */
  waives_fail?: string | undefined;
}

/**
 * The criteria a waiver covers: every criterion of the ticket (the tester proved none of
 * them for this head: a PASS would make the waiver unnecessary), or the ones named by
 * position or id. An unknown name is refused, never dropped.
 */
export function waivedCriteria(
  acs: ReadonlyArray<{ id: string; text: string }>,
  named: readonly string[] | undefined,
): WaivedCriterion[] {
  const all = acs.map((a, i) => ({ n: i + 1, id: a.id, text: a.text.slice(0, 300) }));
  if (!named || named.length === 0) return all;
  const out: WaivedCriterion[] = [];
  for (const raw of named) {
    const ref = String(raw).trim();
    const hit = /^\d+$/.test(ref)
      ? all.find((c) => c.n === Number(ref))
      : all.find((c) => c.id === ref);
    if (!hit) {
      throw new DispatchError(
        "VALIDATION_ERROR",
        `--criterion ${ref} is not a criterion of this ticket (it has ${all.length}: name one by its position, 1 = the first, or its id).`,
        { criterion: ref, criteria: all.length },
      );
    }
    if (!out.some((c) => c.id === hit.id)) out.push(hit);
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The criteria part of the label: "1, 3" / "all (none recorded)". */
function criteriaWords(w: Pick<WaiverBinding, "criteria">): string {
  if (!Array.isArray(w.criteria) || w.criteria.length === 0) return "(the ticket has none)";
  return w.criteria.map((c) => String(c.n)).join(", ");
}

/**
 * The one sentence every surface shows for a waiver: "tester verdict waived by <principal>
 * for criteria <...> on <sha>: <summary>", plus "recorded without OS isolation" when the
 * agents ran without an OS sandbox.
 */
export function waiverLabel(w: WaiverBinding): string {
  const shas = (Array.isArray(w.heads) ? w.heads : []).map((h) =>
    w.heads.length > 1 ? `${h.repo}@${String(h.sha).slice(0, 12)}` : String(h.sha).slice(0, 12),
  );
  const on = shas.length > 0 ? shas.join(", ") : "no commit (the ticket has no write repository)";
  return (
    `tester verdict waived by ${w.principal?.name ?? "an unknown principal"} for criteria ${criteriaWords(w)} on ${on}: ${String(w.summary ?? "").slice(0, 500)}` +
    (w.isolation === "none" ? " (recorded without OS isolation)" : "")
  );
}

/** A waiver binding read back from an evidence payload, or null when it carries none. */
export function parseWaiver(payload: unknown): WaiverBinding | null {
  if (!payload || typeof payload !== "object") return null;
  const w = (payload as { waiver?: unknown }).waiver;
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  const principal = o.principal as { id?: unknown; name?: unknown } | undefined;
  if (!principal || typeof principal.id !== "string" || typeof principal.name !== "string") {
    return null;
  }
  return {
    principal: { id: principal.id, name: principal.name },
    actor: (o.actor as WaiverBinding["actor"]) ?? { type: "", id: "" },
    heads: Array.isArray(o.heads)
      ? (o.heads as WaiverBinding["heads"]).filter(
          (h) => h && typeof h.sha === "string" && typeof h.repo_id === "string",
        )
      : [],
    contract_hash: typeof o.contract_hash === "string" ? o.contract_hash : null,
    criteria: Array.isArray(o.criteria) ? (o.criteria as WaivedCriterion[]) : [],
    summary: typeof o.summary === "string" ? o.summary : "",
    isolation: typeof o.isolation === "string" ? o.isolation : "none",
    ...(typeof o.waives_fail === "string" ? { waives_fail: o.waives_fail } : {}),
  };
}

/**
 * The ticket's latest tester PASS (the row a `ticket.tester_passed` event names) when it
 * is a person's waiver: its binding, evidence id and time; null otherwise. Fail-soft.
 */
export function readLatestWaiver(
  db: Db,
  ticketId: string,
): (WaiverBinding & { evidence_id: string; at: string; label: string }) | null {
  try {
    const row = db
      .prepare(
        `SELECT e.id AS id, e.payload_json AS payload_json, e.created_at AS at FROM evidence e
          WHERE e.ticket_id = ? AND e.evidence_type = 'test_output'
            AND EXISTS (SELECT 1 FROM work_events w WHERE w.entity_type = 'ticket'
                         AND w.entity_id = e.ticket_id
                         AND w.event_type IN ('ticket.tester_passed', 'ticket.tester_failed')
                         AND json_extract(w.payload_json, '$.evidence_id') = e.id)
          ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
      )
      .get(ticketId) as { id: string; payload_json: string | null; at: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>;
    if (p.verdict !== "pass") return null;
    const w = parseWaiver(p);
    return w ? { ...w, evidence_id: row.id, at: row.at, label: waiverLabel(w) } : null;
  } catch {
    return null;
  }
}

/** Env var naming the isolation probe as a JSON argv (the dashboard's Settings seam too). */
const STATUS_CMD_ENV = "GAFFER_SANDBOX_STATUS_CMD";

let cached: { at: number; value: string } | null = null;

/**
 * FACTORY ISOLATION, as the runner itself reports it (`runner/gaffer sandbox-status`, the
 * probe the dashboard's Settings line shows): the OS sandbox provider when an agent
 * launch is wrapped in it now (`wrapped`: the provider is available and the launch asks
 * for it), else "none" (no provider available, the operator opted out with
 * GAFFER_STRICT_REQUIRE=0 and STRICT_MODE is off, or the probe could not answer: fail
 * toward the loud label). Read synchronously and kept for a minute (a person's verdict is
 * rare).
 */
export function factoryIsolation(env: NodeJS.ProcessEnv = process.env): string {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let argv: string[] = [
    "bash",
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "runner", "gaffer"),
    "sandbox-status",
  ];
  const raw = (env[STATUS_CMD_ENV] ?? "").trim();
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
        argv = v as string[];
      }
    } catch {
      /* the default probe */
    }
  }
  let value = "none";
  try {
    const out = execFileSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();
    const v = line ? (JSON.parse(line) as Record<string, unknown>) : null;
    // `wrapped` (an agent launch is wrapped now) when the probe reports it, else available.
    const wrapped = v && typeof v.wrapped === "boolean" ? v.wrapped : v?.available === true;
    if (v && wrapped && typeof v.provider === "string" && v.provider !== "none") {
      value = /^[A-Za-z0-9._-]{1,32}$/.test(v.provider) ? v.provider : "none";
    }
  } catch {
    value = "none";
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Tests: forget the cached probe answer. */
export function resetFactoryIsolationCache(): void {
  cached = null;
}
