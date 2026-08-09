import type { Db } from "../db/connection.js";
import { listEvents } from "../events/eventWriter.js";
import type {
  AcStatus,
  Evidence,
  EvidenceType,
  PolicyPack,
  RiskLevel,
  Ticket,
  TicketStatus,
  WorkEvent,
} from "../domain/types.js";
import type { AcRepository } from "../repositories/acRepository.js";
import type { EvidenceRepository } from "../repositories/evidenceRepository.js";
import type { TicketRepoDeliveryRepository } from "../repositories/ticketRepoDeliveryRepository.js";
import { canonicalHash } from "../util/canonicalJson.js";
import type { Clock } from "../util/clock.js";

/**
 * DELIVERY-DOSSIER (flagship trust artifact). Assembles EVERYTHING Dispatch already
 * records about a delivered ticket into ONE exportable, tamper-evident evidence
 * object. It is a faithful reflection of recorded facts — it invents NOTHING: a datum
 * that is not already recorded is OMITTED or explicitly marked `unknown` and noted in
 * `warnings`. See {@link DossierService}.
 */

/** The schema tag on the hashed subject — bumped only on a breaking shape change. */
export const DOSSIER_SCHEMA = "dossier.v1" as const;

/** The event kind recording a dossier hash against the control plane. */
export const DOSSIER_EVENT_TYPE = "ticket.dossier_recorded" as const;

/**
 * Evidence types that count as DoD / test-gate proof (test output, coverage, CI,
 * static analysis, PR, diff summary). Rendered in the dossier's DoD section.
 */
const DOD_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  "test_output",
  "coverage_report",
  "ci_run",
  "static_analysis",
  "pull_request",
  "diff_summary",
]);

/** Transition reasons that mark a review APPROVAL (mirrors governanceRoi / reviewGate). */
const APPROVE_REASONS: ReadonlySet<string> = new Set([
  "review_approved",
  "review_approved_to_testing",
]);

/** A single evidence row reduced to the fields the dossier surfaces. */
export interface DossierEvidence {
  evidence_type: EvidenceType;
  summary: string;
  uri: string | null;
  created_by: string;
  created_at: string;
}

/** One acceptance criterion with its satisfied/evidence status + linked evidence. */
export interface DossierAcceptanceCriterion {
  text: string;
  status: AcStatus;
  verification_method: string | null;
  evidence_required: boolean;
  verified_by: string | null;
  verified_at: string | null;
  spec_clause_id: string | null;
  evidence: DossierEvidence[];
}

/** The recorded delivery artifacts for the ticket (top-level + event + per-repo). */
export interface DossierDelivery {
  /** Top-level ticket branch/PR (the ticket row). */
  branch_name: string | null;
  pr_url: string | null;
  /** The latest `ticket.delivery_recorded` event payload, or null if never recorded. */
  recorded: {
    branch_name: string | null;
    pr_url: string | null;
    commit: string | null;
    diff_summary: string | null;
  } | null;
  /**
   * A server-computed CONTENT diff hash is NOT recorded anywhere in Dispatch state
   * (no such column/field exists), so it is always null and marked unknown — never
   * fabricated. The recorded diff facts are `recorded.diff_summary` + per-repo
   * `commit_sha`. The live on-demand `git diff` is nondeterministic and deliberately
   * excluded from the dossier (it would break the deterministic hash).
   */
  diff_hash: null;
  diff_hash_status: "unknown";
  /** Per-repo delivery rows (WG-005), sorted by repo_name for determinism. */
  per_repo: Array<{
    repo_name: string;
    branch_name: string | null;
    commit_sha: string | null;
    pr_url: string | null;
    status: string;
  }>;
}

/** The review verdict: WHO approved, WHEN, and the recorded transition detail. */
export interface DossierReviewVerdict {
  approved: boolean;
  actor_type: string;
  actor_id: string | null;
  at: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  /** GRADUATED-AUTONOMY signal recorded on the approve transition (may be null). */
  approved_unchanged: boolean | null;
}

/** The gate/autonomy configuration in force, as recorded (ticket-scoped only). */
export interface DossierGateConfig {
  policy_pack: PolicyPack;
  risk_level: RiskLevel;
  reviewer: string | null;
  /** Presence of a `ticket.ready_approved` event (regulated-pack human sign-off). */
  ready_approved: boolean;
  /** The approve transition's `approved_unchanged` (null when unknown / no approval). */
  approved_unchanged: boolean | null;
}

/**
 * The HASHED subject: the recorded-facts payload. Everything here is an immutable
 * recorded fact (or an explicitly-marked unknown). NOTHING outside this object is
 * hashed — see {@link Dossier.generated_at}.
 */
export interface DossierSubject {
  schema: typeof DOSSIER_SCHEMA;
  identity: {
    id: string;
    number: number | null;
    title: string;
    status: TicketStatus;
    risk_level: RiskLevel;
    policy_pack: PolicyPack;
    created_at: string;
  };
  acceptance_criteria: DossierAcceptanceCriterion[];
  delivery: DossierDelivery;
  dod_evidence: DossierEvidence[];
  review_verdict: DossierReviewVerdict | null;
  gate_config: DossierGateConfig;
}

/** The full dossier: the hashed subject + the hash + generation metadata + warnings. */
export interface Dossier {
  schema: typeof DOSSIER_SCHEMA;
  hash_algo: "sha256";
  /** SHA-256 of the canonical JSON of {@link subject}. Deterministic per ticket state. */
  hash: string;
  /**
   * When THIS dossier was generated. Deliberately OUTSIDE {@link subject} so it is
   * NOT part of the hashed payload — regenerating for unchanged state yields the same
   * hash even though this differs.
   */
  generated_at: string;
  subject: DossierSubject;
  /** Human-readable notes on data that was omitted or marked unknown (never fabricated). */
  warnings: string[];
}

export interface DossierServiceDeps {
  db: Db;
  clock: Clock;
  acs: AcRepository;
  evidence: EvidenceRepository;
  repoDeliveries: TicketRepoDeliveryRepository;
}

/** Stable comparator for evidence rows: created_at, then id (both immutable). */
function byCreatedThenId(a: Evidence, b: Evidence): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toDossierEvidence(e: Evidence): DossierEvidence {
  return {
    evidence_type: e.evidence_type,
    summary: e.summary,
    uri: e.uri,
    created_by: e.created_by,
    created_at: e.created_at,
  };
}

function parsePayload(ev: WorkEvent): Record<string, unknown> {
  if (ev.payload_json === null) return {};
  try {
    const v = JSON.parse(ev.payload_json) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export class DossierService {
  constructor(private readonly deps: DossierServiceDeps) {}

  /**
   * Assemble the dossier for `ticket` from EXISTING recorded state only. Pure read:
   * no write, no side effect. Deterministic — the same recorded state always yields
   * the same {@link Dossier.hash} (the only varying field, `generated_at`, sits
   * outside the hashed subject).
   */
  assemble(ticket: Ticket): Dossier {
    const warnings: string[] = [];

    // Events (excluding our own dossier events, so the hash is stable across
    // recordings — folding a prior dossier event back in would drift the hash).
    const events = listEvents(this.deps.db, "ticket", ticket.id).filter(
      (e) => e.event_type !== DOSSIER_EVENT_TYPE,
    );

    // --- Acceptance criteria + per-AC evidence -------------------------------
    const acs = this.deps.acs.listForTicket(ticket.id); // already sort_order ASC
    const allEvidence = [...this.deps.evidence.listForTicket(ticket.id)].sort(byCreatedThenId);
    const acceptance_criteria: DossierAcceptanceCriterion[] = acs.map((ac) => ({
      text: ac.text,
      status: ac.status,
      verification_method: ac.verification_method,
      evidence_required: ac.evidence_required === 1,
      verified_by: ac.verified_by,
      verified_at: ac.verified_at,
      spec_clause_id: ac.spec_clause_id,
      evidence: allEvidence.filter((e) => e.ac_id === ac.id).map(toDossierEvidence),
    }));

    // --- DoD / test-gate evidence (test/coverage/ci/static/pr/diff) ----------
    const dod_evidence = allEvidence
      .filter((e) => DOD_EVIDENCE_TYPES.has(e.evidence_type))
      .map(toDossierEvidence);
    if (dod_evidence.length === 0) {
      warnings.push("dod_evidence: no test-gate evidence recorded");
    }

    // --- Delivery artifacts --------------------------------------------------
    const deliveryEvent = [...events]
      .reverse()
      .find((e) => e.event_type === "ticket.delivery_recorded");
    const recorded = deliveryEvent
      ? (() => {
          const p = parsePayload(deliveryEvent);
          return {
            branch_name: asStringOrNull(p.branch_name),
            pr_url: asStringOrNull(p.pr_url),
            commit: asStringOrNull(p.commit),
            diff_summary: asStringOrNull(p.diff_summary),
          };
        })()
      : null;
    const perRepoRows = [...this.deps.repoDeliveries.listForTicket(ticket.id)].sort((a, b) =>
      a.repo_name < b.repo_name ? -1 : a.repo_name > b.repo_name ? 1 : 0,
    );
    const per_repo = perRepoRows.map((d) => ({
      repo_name: d.repo_name,
      branch_name: d.branch_name,
      commit_sha: d.commit_sha,
      pr_url: d.pr_url,
      status: d.status,
    }));
    if (recorded === null && per_repo.length === 0 && ticket.branch_name === null) {
      warnings.push("delivery: no delivery artifact recorded yet");
    }
    warnings.push("diff_hash: not recorded (no server-computed content diff hash exists)");
    const delivery: DossierDelivery = {
      branch_name: ticket.branch_name,
      pr_url: ticket.pr_url,
      recorded,
      diff_hash: null,
      diff_hash_status: "unknown",
      per_repo,
    };

    // --- Review verdict (latest approve transition) --------------------------
    const approveEvent = [...events]
      .reverse()
      .find(
        (e) =>
          e.event_type === "ticket.transitioned" &&
          APPROVE_REASONS.has(asStringOrNull(parsePayload(e).reason) ?? ""),
      );
    let review_verdict: DossierReviewVerdict | null = null;
    let approvedUnchanged: boolean | null = null;
    if (approveEvent) {
      const p = parsePayload(approveEvent);
      approvedUnchanged = asBoolOrNull(p.approved_unchanged);
      review_verdict = {
        approved: true,
        actor_type: approveEvent.actor_type,
        actor_id: approveEvent.actor_id,
        at: approveEvent.created_at,
        from: asStringOrNull(p.from),
        to: asStringOrNull(p.to),
        reason: asStringOrNull(p.reason),
        approved_unchanged: approvedUnchanged,
      };
    } else {
      warnings.push("review_verdict: no recorded approval (ticket not approved yet)");
    }

    // --- Gate / autonomy config (ticket-scoped recorded facts only) ----------
    const ready_approved = events.some((e) => e.event_type === "ticket.ready_approved");
    const gate_config: DossierGateConfig = {
      policy_pack: ticket.policy_pack,
      risk_level: ticket.risk_level,
      reviewer: ticket.reviewer,
      ready_approved,
      approved_unchanged: approvedUnchanged,
    };
    if (ticket.reviewer === null) {
      warnings.push("gate_config.reviewer: not assigned");
    }

    const subject: DossierSubject = {
      schema: DOSSIER_SCHEMA,
      identity: {
        id: ticket.id,
        number: ticket.number,
        title: ticket.title,
        status: ticket.status,
        risk_level: ticket.risk_level,
        policy_pack: ticket.policy_pack,
        created_at: ticket.created_at,
      },
      acceptance_criteria,
      delivery,
      dod_evidence,
      review_verdict,
      gate_config,
    };

    return {
      schema: DOSSIER_SCHEMA,
      hash_algo: "sha256",
      hash: canonicalHash(subject),
      generated_at: this.deps.clock.now(),
      subject,
      warnings,
    };
  }

  /**
   * A faithful human-readable Markdown view of the SAME data. The Markdown is a
   * VIEW of {@link Dossier.subject}; it is never itself hashed. Unknown / omitted
   * data renders literally as `_unknown (not recorded)_` — never blank-filled.
   */
  renderMarkdown(dossier: Dossier): string {
    const s = dossier.subject;
    const out: string[] = [];
    const unknown = "_unknown (not recorded)_";
    const orUnknown = (v: string | null | undefined): string =>
      v === null || v === undefined || v === "" ? unknown : v;

    const numberLabel = s.identity.number === null ? s.identity.id : `#${s.identity.number}`;
    out.push(`# Delivery Dossier — ${numberLabel} ${s.identity.title}`);
    out.push("");

    // Integrity block.
    out.push("## Integrity");
    out.push("");
    out.push(`- Hash (${dossier.hash_algo}): \`${dossier.hash}\``);
    out.push(`- Schema: \`${s.schema}\``);
    out.push(`- Generated at: ${dossier.generated_at}`);
    out.push(
      "- Verifiable against the control plane once recorded as a " +
        "`ticket.dossier_recorded` event.",
    );
    out.push("");

    // Identity.
    out.push("## Identity");
    out.push("");
    out.push(`- Ticket: ${numberLabel}`);
    out.push(`- Title: ${s.identity.title}`);
    out.push(`- Status: ${s.identity.status}`);
    out.push(`- Risk: ${s.identity.risk_level}`);
    out.push(`- Policy pack: ${s.identity.policy_pack}`);
    out.push(`- Created: ${s.identity.created_at}`);
    out.push("");

    // Acceptance criteria.
    out.push("## Acceptance Criteria");
    out.push("");
    if (s.acceptance_criteria.length === 0) {
      out.push("_No acceptance criteria recorded._");
    } else {
      const mark: Record<AcStatus, string> = {
        satisfied: "satisfied",
        pending: "pending",
        failed: "failed",
        waived: "waived",
      };
      out.push("| Status | Criterion | Verified by | Verified at | Evidence |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const ac of s.acceptance_criteria) {
        out.push(
          `| ${mark[ac.status]} | ${ac.text.replace(/\|/g, "\\|")} | ${orUnknown(
            ac.verified_by,
          )} | ${orUnknown(ac.verified_at)} | ${ac.evidence.length} |`,
        );
      }
    }
    out.push("");

    // Delivery artifacts.
    out.push("## Delivery Artifacts");
    out.push("");
    out.push(`- Branch: ${orUnknown(s.delivery.branch_name)}`);
    out.push(`- PR: ${orUnknown(s.delivery.pr_url)}`);
    out.push(`- Commit: ${orUnknown(s.delivery.recorded?.commit ?? null)}`);
    out.push(`- Diff summary: ${orUnknown(s.delivery.recorded?.diff_summary ?? null)}`);
    out.push(`- Content diff hash: ${unknown} (no server-computed diff hash is recorded)`);
    out.push("");
    if (s.delivery.per_repo.length > 0) {
      out.push("| Repo | Branch | Commit | PR | Status |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const r of s.delivery.per_repo) {
        out.push(
          `| ${r.repo_name} | ${orUnknown(r.branch_name)} | ${orUnknown(
            r.commit_sha,
          )} | ${orUnknown(r.pr_url)} | ${r.status} |`,
        );
      }
      out.push("");
    }

    // Review verdict.
    out.push("## Review Verdict");
    out.push("");
    if (s.review_verdict === null) {
      out.push("_No review verdict recorded (ticket not approved yet)._");
    } else {
      const v = s.review_verdict;
      const who = v.actor_id === null ? v.actor_type : `${v.actor_type}:${v.actor_id}`;
      out.push(`- Approved by: ${who}`);
      out.push(`- When: ${v.at}`);
      out.push(`- Transition: ${orUnknown(v.from)} -> ${orUnknown(v.to)}`);
      out.push(`- Reason: ${orUnknown(v.reason)}`);
      out.push(
        `- Approved unchanged: ${
          v.approved_unchanged === null ? unknown : String(v.approved_unchanged)
        }`,
      );
    }
    out.push("");

    // DoD / test-gate evidence.
    out.push("## DoD / Test-Gate Evidence");
    out.push("");
    if (s.dod_evidence.length === 0) {
      out.push("_No DoD / test-gate evidence recorded._");
    } else {
      out.push("| Type | Summary | URI | Recorded by | At |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const e of s.dod_evidence) {
        out.push(
          `| ${e.evidence_type} | ${e.summary.replace(/\|/g, "\\|")} | ${orUnknown(
            e.uri,
          )} | ${e.created_by} | ${e.created_at} |`,
        );
      }
    }
    out.push("");

    // Gate config.
    out.push("## Gate Configuration");
    out.push("");
    out.push(`- Policy pack: ${s.gate_config.policy_pack}`);
    out.push(`- Risk level: ${s.gate_config.risk_level}`);
    out.push(`- Reviewer: ${orUnknown(s.gate_config.reviewer)}`);
    out.push(`- Ready-approved: ${s.gate_config.ready_approved ? "yes" : "no"}`);
    out.push(
      `- Approved unchanged: ${
        s.gate_config.approved_unchanged === null
          ? unknown
          : String(s.gate_config.approved_unchanged)
      }`,
    );
    out.push("");

    // Warnings.
    if (dossier.warnings.length > 0) {
      out.push("## Notes (omitted / unknown)");
      out.push("");
      for (const w of dossier.warnings) out.push(`- ${w}`);
      out.push("");
    }

    return out.join("\n");
  }
}
