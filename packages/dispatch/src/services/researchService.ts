import { z } from "zod";

import "../util/zod3Compat.js";
import { type Db, inTransaction } from "../db/connection.js";
import type { Actor, Spec } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";
import { checkResearchUrl } from "../util/researchUrl.js";
import type { SpecsService } from "./specsService.js";

/**
 * Research runs (backlog 69): a research step IN FRONT OF the spec step.
 *
 * A person starts a run from an idea; the runner's research launcher
 * (runner/bin/research-run.mjs) does one web-only agent turn and returns findings with
 * sources and a ranked feature list, which this service stores. The person then edits
 * the feature list (keep or drop, reword, re-rank, add their own) and keeps or drops
 * each open question; {@link draftSpec} turns what was KEPT into a draft spec with no
 * model call. The existing spec editor, Freeze and planner take it from there.
 *
 * WHO MAY ACT. Starting a run, editing it, drafting the spec and discarding it are a
 * PERSON's acts: an agent or the system actor is refused here (ACTOR_NOT_PERMITTED),
 * whatever surface it came through; the REST routes also refuse scoped and read-only
 * credentials, no MCP tool writes research, and the safety hook refuses the wg research
 * write verbs to an agent's shell. Only the runner's completion callback
 * ({@link completeRun} / {@link failRun}) writes as the system, and only to a run that
 * is still running.
 *
 * WHAT IS TRUSTED. Nothing the agent wrote. The launcher validated the result (schema,
 * caps, cleaned text, computed marks); this service parses it again with its own schema,
 * re-checks every URL with the URL rules (util/researchUrl.ts) and recomputes the
 * "fetched", "opinion" and "unsupported" marks from the stored log, so a result that
 * reached the database some other way carries no mark the model set.
 */

export const RESEARCH_STATUSES = ["running", "ready", "failed", "discarded"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];
export const RESEARCH_PRIORITIES = ["must", "should", "could", "wont"] as const;
export type ResearchPriority = (typeof RESEARCH_PRIORITIES)[number];

/** The caps the launcher holds a result to (runner/lib/research-result.mjs). */
export const RESEARCH_CAPS = {
  idea: 4000,
  summary: 1200,
  findings: 30,
  claim: 400,
  why: 400,
  sources: 5,
  comparables: 15,
  name: 120,
  note: 300,
  features: 40,
  title: 120,
  description: 400,
  questions: 15,
  risks: 15,
  item: 300,
  error: 500,
  log: 200,
} as const;
/** The longest clause text a drafted spec gets (title, a colon and the description). */
export const RESEARCH_CLAUSE_MAX = 600;

// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
/** Remove control, bidi and zero-width characters; fold line breaks to spaces. */
export function cleanResearchText(v: unknown): string {
  return String(v ?? "")
    .replace(STRIP, "")
    .replace(/[\t\n\r]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
const text = (max: number) =>
  z
    .string()
    .transform(cleanResearchText)
    .refine((s) => [...s].length <= max, { message: `at most ${max} characters` });

const sourceIn = z.object({ url: z.string().max(600), host: z.string().optional(), fetched: z.boolean().optional() });
const launcherResult = z.object({
  summary: text(RESEARCH_CAPS.summary).default(""),
  findings: z
    .array(
      z.object({
        id: z.string().max(20),
        claim: text(RESEARCH_CAPS.claim),
        why: text(RESEARCH_CAPS.why).default(""),
        sources: z.array(sourceIn).max(RESEARCH_CAPS.sources).default([]),
      }),
    )
    .max(RESEARCH_CAPS.findings)
    .default([]),
  comparables: z
    .array(
      z.object({
        name: text(RESEARCH_CAPS.name),
        note: text(RESEARCH_CAPS.note).default(""),
        source: sourceIn.optional(),
      }),
    )
    .max(RESEARCH_CAPS.comparables)
    .default([]),
  features: z
    .array(
      z.object({
        id: z.string().max(20),
        title: text(RESEARCH_CAPS.title),
        description: text(RESEARCH_CAPS.description).default(""),
        priority: z.enum(RESEARCH_PRIORITIES),
        backed_by: z.array(z.string().max(20)).max(RESEARCH_CAPS.findings).default([]),
      }),
    )
    .max(RESEARCH_CAPS.features)
    .default([]),
  open_questions: z
    .array(z.object({ id: z.string().max(20), text: text(RESEARCH_CAPS.item) }))
    .max(RESEARCH_CAPS.questions)
    .default([]),
  risks: z
    .array(z.object({ id: z.string().max(20), text: text(RESEARCH_CAPS.item) }))
    .max(RESEARCH_CAPS.risks)
    .default([]),
  dropped_urls: z.number().int().min(0).max(1000).default(0),
});
const launcherLog = z.object({
  fetches: z
    .array(z.object({ url: z.string().max(600), host: z.string().max(260), ts: z.string().max(40) }))
    .max(RESEARCH_CAPS.log)
    .default([]),
  searches: z
    .array(z.object({ query: z.string().max(400), ts: z.string().max(40) }))
    .max(RESEARCH_CAPS.log)
    .default([]),
});

/** What the person sends to start a run. */
export const startResearchInput = z.object({
  idea: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: "an idea is required" })
    .refine((s) => [...s].length <= RESEARCH_CAPS.idea, {
      message: `the idea is at most ${RESEARCH_CAPS.idea} characters`,
    }),
  repo: z.string().trim().min(1).max(120).optional(),
  share_overview: z.boolean().optional(),
  plan_session_id: z.string().trim().min(1).max(100).optional(),
});

/** A person's edit of the feature list and the open questions (the whole list each time). */
export const editResearchInput = z
  .object({
    features: z
      .array(
        z.object({
          id: z.string().max(20).optional(),
          title: text(RESEARCH_CAPS.title).refine((s) => s.length > 0, { message: "a feature needs a title" }),
          description: text(RESEARCH_CAPS.description).default(""),
          priority: z.enum(RESEARCH_PRIORITIES),
          kept: z.boolean(),
        }),
      )
      .max(RESEARCH_CAPS.features)
      .optional(),
    open_questions: z
      .array(z.object({ id: z.string().max(20), kept: z.boolean() }))
      .max(RESEARCH_CAPS.questions)
      .optional(),
  })
  .refine((v) => v.features !== undefined || v.open_questions !== undefined, {
    message: "send features, open_questions or both",
  });

export interface ResearchSource {
  readonly url: string;
  readonly host: string;
  /** The run's hook allowed a fetch of exactly this URL (computed, never the model's). */
  readonly fetched: boolean;
}
export interface ResearchFinding {
  readonly id: string;
  readonly claim: string;
  readonly why: string;
  readonly sources: readonly ResearchSource[];
  /** No source was fetched by the run: the agent's own view (computed). */
  readonly opinion: boolean;
}
export interface ResearchFeature {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly priority: ResearchPriority;
  readonly backed_by: readonly string[];
  /** Every backing finding is an opinion (or there is none): computed. */
  readonly unsupported: boolean;
  /** "agent" (from the run) or "person" (added by a person). */
  readonly origin: "agent" | "person";
  readonly kept: boolean;
}
export interface ResearchQuestion {
  readonly id: string;
  readonly text: string;
  readonly kept: boolean;
}
export interface ResearchRun {
  readonly id: string;
  readonly idea: string;
  readonly repo: string | null;
  readonly share_overview: boolean;
  readonly plan_session_id: string | null;
  readonly status: ResearchStatus;
  readonly error: string | null;
  readonly summary: string;
  readonly findings: readonly ResearchFinding[];
  readonly comparables: ReadonlyArray<{ name: string; note: string; source?: ResearchSource }>;
  readonly features: readonly ResearchFeature[];
  readonly open_questions: readonly ResearchQuestion[];
  readonly risks: ReadonlyArray<{ id: string; text: string }>;
  readonly log: { fetches: ReadonlyArray<{ url: string; host: string; ts: string }>; searches: ReadonlyArray<{ query: string; ts: string }> };
  readonly dropped_urls: number;
  readonly spec_id: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
}

interface Row {
  id: string;
  idea: string;
  repo: string | null;
  share_overview: number;
  plan_session_id: string | null;
  status: ResearchStatus;
  error: string | null;
  summary: string;
  findings_json: string;
  comparables_json: string;
  features_json: string;
  questions_json: string;
  risks_json: string;
  log_json: string;
  dropped_urls: number;
  spec_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** A source URL that passes the rules, marked against the fetch log; else null. */
function checkedSource(url: string, fetched: ReadonlySet<string>): ResearchSource | null {
  const c = checkResearchUrl(cleanResearchText(url));
  if (!c.ok) return null;
  return { url: c.url, host: c.host, fetched: fetched.has(c.url) };
}

/** Recompute every mark from the stored items and log (what the read model returns). */
function withMarks(row: Row): ResearchRun {
  const log = parseJson<ResearchRun["log"]>(row.log_json, { fetches: [], searches: [] });
  const fetched = new Set((log.fetches ?? []).map((f) => f.url));
  const findings = parseJson<Array<{ id: string; claim: string; why: string; sources: Array<{ url: string }> }>>(
    row.findings_json,
    [],
  ).map((f) => {
    const sources = (f.sources ?? [])
      .map((s) => checkedSource(String(s?.url ?? ""), fetched))
      .filter((s): s is ResearchSource => s !== null);
    return { id: f.id, claim: f.claim, why: f.why ?? "", sources, opinion: !sources.some((s) => s.fetched) };
  });
  const byId = new Map(findings.map((f) => [f.id, f]));
  const features = parseJson<Array<Omit<ResearchFeature, "unsupported">>>(row.features_json, []).map((f) => ({
    ...f,
    backed_by: (f.backed_by ?? []).filter((b) => byId.has(b)),
    unsupported: !(f.backed_by ?? []).some((b) => byId.get(b) && !byId.get(b)!.opinion),
  }));
  const comparables = parseJson<Array<{ name: string; note: string; source?: { url: string } }>>(
    row.comparables_json,
    [],
  ).map((c) => {
    const s = c.source ? checkedSource(String(c.source.url ?? ""), fetched) : null;
    return { name: c.name, note: c.note ?? "", ...(s ? { source: s } : {}) };
  });
  return {
    id: row.id,
    idea: row.idea,
    repo: row.repo,
    share_overview: row.share_overview === 1,
    plan_session_id: row.plan_session_id,
    status: row.status,
    error: row.error,
    summary: row.summary,
    findings,
    comparables,
    features,
    open_questions: parseJson<ResearchQuestion[]>(row.questions_json, []),
    risks: parseJson<Array<{ id: string; text: string }>>(row.risks_json, []),
    log,
    dropped_urls: row.dropped_urls,
    spec_id: row.spec_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

/** Refuse anything but a person (a human or an admin actor). */
function assertPerson(actor: Actor, what: string): void {
  if (actor.type !== "human" && actor.type !== "admin") {
    throw new DispatchError(
      "ACTOR_NOT_PERMITTED",
      `${what} is a person's act: an ${actor.type} cannot do it. Agents only read research a person kept.`,
      { actor_type: actor.type },
    );
  }
}

export interface ResearchServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly specs: SpecsService;
}

export class ResearchService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly specs: SpecsService;

  constructor(deps: ResearchServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.specs = deps.specs;
  }

  private row(id: string): Row {
    const r = this.db.prepare("SELECT * FROM research_runs WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("research", id);
    return r;
  }

  /** One run, every mark recomputed. */
  getRun(id: string): ResearchRun {
    return withMarks(this.row(id));
  }

  /** Runs newest first (discarded ones only when asked), or the one for a plan session. */
  listRuns(opts: { planSessionId?: string; includeDiscarded?: boolean } = {}): ResearchRun[] {
    const rows = (
      opts.planSessionId !== undefined
        ? this.db
            .prepare("SELECT * FROM research_runs WHERE plan_session_id = ? ORDER BY created_at DESC")
            .all(opts.planSessionId)
        : this.db.prepare("SELECT * FROM research_runs ORDER BY created_at DESC LIMIT 200").all()
    ) as Row[];
    return rows.filter((r) => opts.includeDiscarded || r.status !== "discarded").map(withMarks);
  }

  /**
   * Start a run (a person's act): the row is created `running`; the caller then spawns
   * the launcher and reports back with {@link completeRun} / {@link failRun}. With a
   * plan session that already has a run, that run is returned and `started` is false:
   * one paid run per plan session, whatever the browser does.
   */
  startRun(raw: unknown, actor: Actor): { run: ResearchRun; started: boolean } {
    assertPerson(actor, "Starting a research run");
    const input = startResearchInput.parse(raw);
    return inTransaction(this.db, () => {
      if (input.plan_session_id !== undefined) {
        const existing = this.db
          .prepare("SELECT * FROM research_runs WHERE plan_session_id = ?")
          .get(input.plan_session_id) as Row | undefined;
        if (existing) return { run: withMarks(existing), started: false };
      }
      const id = newId();
      const now = this.clock.now();
      this.db
        .prepare(
          `INSERT INTO research_runs (id, idea, repo, share_overview, plan_session_id, status,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          id,
          input.idea,
          input.repo ?? null,
          input.share_overview === true && input.repo !== undefined ? 1 : 0,
          input.plan_session_id ?? null,
          actor.id ?? actor.type,
          now,
          now,
        );
      writeEvent(this.db, {
        entity_type: "research",
        entity_id: id,
        actor,
        event_type: "research.started",
        payload: { repo: input.repo ?? null, share_overview: input.share_overview === true },
      });
      return { run: this.getRun(id), started: true };
    });
  }

  /**
   * Store the launcher's output (the runner's completion callback, as the system).
   * Parsed again with this service's schema; every URL re-checked; marks recomputed on
   * read. Only a `running` run accepts a result.
   */
  completeRun(id: string, output: unknown): ResearchRun {
    const o = (output ?? {}) as { result?: unknown; log?: unknown };
    const parsed = launcherResult.safeParse(o.result);
    if (!parsed.success) {
      return this.failRun(id, `the research result did not match the stored schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const logParsed = launcherLog.safeParse(o.log ?? {});
    const log = logParsed.success ? logParsed.data : { fetches: [], searches: [] };
    // Keep only log entries whose URL passes the rules (the hook already required it).
    const fetches = log.fetches
      .map((f) => {
        const c = checkResearchUrl(f.url);
        return c.ok ? { url: c.url, host: c.host, ts: f.ts } : null;
      })
      .filter((f): f is { url: string; host: string; ts: string } => f !== null);
    const r = parsed.data;
    let dropped = r.dropped_urls;
    const keepUrl = (u: string): { url: string } | null => {
      const c = checkResearchUrl(cleanResearchText(u));
      if (!c.ok) {
        dropped += 1;
        return null;
      }
      return { url: c.url };
    };
    const findings = r.findings.map((f) => ({
      id: f.id,
      claim: f.claim,
      why: f.why,
      sources: f.sources.map((s) => keepUrl(s.url)).filter((s): s is { url: string } => s !== null),
    }));
    const ids = new Set(findings.map((f) => f.id));
    const features = r.features.map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
      priority: f.priority,
      backed_by: f.backed_by.filter((b) => ids.has(b)),
      origin: "agent" as const,
      kept: true,
    }));
    const comparables = r.comparables.map((c) => {
      const s = c.source ? keepUrl(c.source.url) : null;
      return { name: c.name, note: c.note, ...(s ? { source: s } : {}) };
    });
    const questions = r.open_questions.map((q) => ({ id: q.id, text: q.text, kept: true }));
    return inTransaction(this.db, () => {
      const row = this.row(id);
      if (row.status !== "running") {
        throw new DispatchError("STATE_CONFLICT", `research ${id} is '${row.status}', not running`, {
          research_id: id,
          status: row.status,
        });
      }
      const now = this.clock.now();
      this.db
        .prepare(
          `UPDATE research_runs SET status = 'ready', summary = ?, findings_json = ?,
             comparables_json = ?, features_json = ?, questions_json = ?, risks_json = ?,
             log_json = ?, dropped_urls = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
        )
        .run(
          r.summary,
          JSON.stringify(findings),
          JSON.stringify(comparables),
          JSON.stringify(features),
          JSON.stringify(questions),
          JSON.stringify(r.risks),
          JSON.stringify({ fetches, searches: log.searches }),
          dropped,
          now,
          now,
          id,
        );
      writeEvent(this.db, {
        entity_type: "research",
        entity_id: id,
        actor: { type: "system", id: "research-run" },
        event_type: "research.completed",
        payload: {
          findings: findings.length,
          features: features.length,
          fetches: fetches.length,
          searches: log.searches.length,
        },
      });
      return this.getRun(id);
    });
  }

  /** Record that a run failed (the runner's callback). Only a running run. */
  failRun(id: string, error: string): ResearchRun {
    return inTransaction(this.db, () => {
      const row = this.row(id);
      if (row.status !== "running") return withMarks(row);
      const now = this.clock.now();
      const msg = cleanResearchText(error).slice(0, RESEARCH_CAPS.error) || "the research run failed";
      this.db
        .prepare(
          "UPDATE research_runs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?",
        )
        .run(msg, now, now, id);
      writeEvent(this.db, {
        entity_type: "research",
        entity_id: id,
        actor: { type: "system", id: "research-run" },
        event_type: "research.failed",
        payload: { error_chars: msg.length },
      });
      return this.getRun(id);
    });
  }

  /**
   * A person's edit: the whole feature list (keep / drop, reword, re-rank, add their
   * own: a feature with no known id is the person's) and/or which open questions are
   * kept. Only a `ready` run, and not once a spec was drafted from it.
   */
  editRun(id: string, raw: unknown, actor: Actor): ResearchRun {
    assertPerson(actor, "Editing research");
    const input = editResearchInput.parse(raw);
    return inTransaction(this.db, () => {
      const row = this.row(id);
      this.assertEditable(row);
      const current = parseJson<Array<Omit<ResearchFeature, "unsupported">>>(row.features_json, []);
      const byId = new Map(current.map((f) => [f.id, f]));
      let features = current;
      if (input.features !== undefined) {
        let n = 0;
        const used = new Set<string>();
        features = input.features.map((f) => {
          const known = f.id !== undefined ? byId.get(f.id) : undefined;
          if (known && !used.has(known.id)) {
            used.add(known.id);
            return { ...known, title: f.title, description: f.description, priority: f.priority, kept: f.kept };
          }
          let pid = `p${(n += 1)}`;
          while (byId.has(pid) || used.has(pid)) pid = `p${(n += 1)}`;
          used.add(pid);
          return {
            id: pid,
            title: f.title,
            description: f.description,
            priority: f.priority,
            backed_by: [],
            origin: "person" as const,
            kept: f.kept,
          };
        });
      }
      let questions = parseJson<ResearchQuestion[]>(row.questions_json, []);
      if (input.open_questions !== undefined) {
        const keep = new Map(input.open_questions.map((q) => [q.id, q.kept]));
        questions = questions.map((q) => (keep.has(q.id) ? { ...q, kept: keep.get(q.id) === true } : q));
      }
      this.db
        .prepare("UPDATE research_runs SET features_json = ?, questions_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(features), JSON.stringify(questions), this.clock.now(), id);
      writeEvent(this.db, {
        entity_type: "research",
        entity_id: id,
        actor,
        event_type: "research.edited",
        payload: {
          features: features.length,
          kept: features.filter((f) => f.kept).length,
          questions_kept: questions.filter((q) => q.kept).length,
        },
      });
      return this.getRun(id);
    });
  }

  /** Discard a run (a person's act). Its row stays, marked discarded. */
  discardRun(id: string, actor: Actor): ResearchRun {
    assertPerson(actor, "Discarding research");
    return inTransaction(this.db, () => {
      const row = this.row(id);
      if (row.status === "discarded") return withMarks(row);
      this.db
        .prepare("UPDATE research_runs SET status = 'discarded', updated_at = ? WHERE id = ?")
        .run(this.clock.now(), id);
      writeEvent(this.db, { entity_type: "research", entity_id: id, actor, event_type: "research.discarded", payload: {} });
      return this.getRun(id);
    });
  }

  /**
   * "Draft the spec from this": the KEPT items become a DRAFT spec, deterministically,
   * with no model call. Kept must and should features become requirement clauses, a
   * kept wont becomes a non-goal, a kept open question becomes a decision clause to
   * settle; could features are not carried (nice to have is not a requirement), nor is
   * anything dropped. Each clause's text is the feature's title and description
   * (capped at RESEARCH_CLAUSE_MAX), its id names the research item it came from
   * (`research-<item>`, namespaced under the spec like every clause id), and its
   * rationale says so. Findings, sources, comparables and risks never reach the spec:
   * a spec is what agents read; research is what a person reads.
   */
  draftSpec(id: string, actor: Actor): { spec: Spec; research: ResearchRun } {
    assertPerson(actor, "Drafting a spec from research");
    const run = this.getRun(id);
    this.assertEditable(this.row(id));
    const clause = (base: string, kind: "requirement" | "non-goal" | "decision", body: string, why: string) => ({
      clause_id: `research-${base}`,
      kind,
      text: [...body].slice(0, RESEARCH_CLAUSE_MAX).join(""),
      rationale: why,
    });
    const featureText = (f: ResearchFeature) => (f.description ? `${f.title}: ${f.description}` : f.title);
    const clauses = [
      ...run.features
        .filter((f) => f.kept && (f.priority === "must" || f.priority === "should"))
        .map((f) =>
          clause(f.id, "requirement", featureText(f), `From research ${run.id}, feature ${f.id} (${f.priority}${f.origin === "person" ? ", added by a person" : ""}).`),
        ),
      ...run.features
        .filter((f) => f.kept && f.priority === "wont")
        .map((f) => clause(f.id, "non-goal", featureText(f), `From research ${run.id}, feature ${f.id} (wont).`)),
      ...run.open_questions
        .filter((q) => q.kept)
        .map((q) => clause(q.id, "decision", `To decide: ${q.text}`, `From research ${run.id}, open question ${q.id}.`)),
    ];
    if (clauses.length === 0) {
      throw new DispatchError(
        "STATE_CONFLICT",
        "Nothing is kept that a spec can carry: keep at least one must, should or wont feature, or an open question.",
        { research_id: id },
      );
    }
    const title = [...run.idea.replace(/\s+/g, " ").trim()].slice(0, 120).join("");
    const spec = this.specs.createSpec(
      { title, brief: run.idea, clauses, ...(run.repo ? { target_repo: run.repo } : {}) },
      actor,
    );
    inTransaction(this.db, () => {
      this.db
        .prepare("UPDATE research_runs SET spec_id = ?, updated_at = ? WHERE id = ?")
        .run(spec.id, this.clock.now(), id);
      writeEvent(this.db, {
        entity_type: "research",
        entity_id: id,
        actor,
        event_type: "research.spec_drafted",
        payload: { spec_id: spec.id, clauses: clauses.length },
      });
    });
    return { spec, research: this.getRun(id) };
  }

  private assertEditable(row: Row): void {
    if (row.status !== "ready") {
      throw new DispatchError("STATE_CONFLICT", `research ${row.id} is '${row.status}': only a finished run can be edited or drafted from`, {
        research_id: row.id,
        status: row.status,
      });
    }
    if (row.spec_id) {
      throw new DispatchError(
        "STATE_CONFLICT",
        `research ${row.id} already drafted spec ${row.spec_id}: edit that spec instead`,
        { research_id: row.id, spec_id: row.spec_id },
      );
    }
  }
}
