import type { AcceptanceCriterion, Decision, PolicyPack, Ticket } from "../domain/types.js";

/** What policy is being evaluated for. */
export type PolicyGate = "ready" | "claim" | "done";

export interface PolicyFailure {
  code: string;
  message: string;
}

export interface PolicyResult {
  allowed: boolean;
  policy_pack: PolicyPack;
  gate: PolicyGate;
  failures: PolicyFailure[];
  warnings: PolicyFailure[];
}

/**
 * Scope/repo confirmation state for the readiness gate (WG-003). Derived once by
 * the transition service from the ticket's scope links + repo access boundaries.
 */
export interface ScopeRepoContext {
  /** Any ticket_repos row at all, regardless of access/relation. */
  hasAnyRepo: boolean;
  /** Active write repos: relation∈{confirmed,implicit_single_repo} AND access='write'. */
  writeRepoCount: number;
  /** A scope link with relation='primary' exists. */
  hasPrimaryScope: boolean;
  /**
   * The mono-fallback condition: exactly one directly-selected repo and NO
   * scope-graph mapping for it (so no primary scope is expected). When true, a
   * strict pack may pass readiness without a primary scope.
   */
  monoFallbackApplies: boolean;
  /** Repo links still relation='suggested' — must be accepted or rejected first. */
  unresolvedSuggestedRepoCount: number;
}

export interface PolicyContext {
  ticket: Ticket;
  acceptanceCriteria: AcceptanceCriterion[];
  repoCount: number;
  blockingDecisions: Decision[];
  hasUnresolvedHumanRequired: boolean;
  /** ac_id -> count of linked evidence rows (for done evaluation). */
  evidenceCountByAc: Map<string, number>;
  hasPrOrDiff: boolean;
  hasReviewer: boolean;
  humanApprovedReady: boolean;
  /** Scope/repo confirmation state for the WG-003 readiness gate. */
  scopeRepo: ScopeRepoContext;
  /** Per-repo delivery evidence for the WG-005 strict done-gate. */
  repoDelivery: RepoDeliveryContext;
}

/**
 * Per-repo delivery evidence the strict done-gate (WG-005) consults. For each
 * ACTIVE write repo on the ticket, `writeReposWithoutDelivery` lists those that
 * have no delivery evidence yet (no review_ready/done status and no recorded
 * branch/PR). factory_strict / regulated require this list to be empty before a
 * ticket may reach `done`; looser packs ignore it entirely.
 */
export interface RepoDeliveryContext {
  /** Names of active write repos lacking per-repo delivery evidence. */
  writeReposWithoutDelivery: string[];
}

function fail(code: string, message: string): PolicyFailure {
  return { code, message };
}

/**
 * Evaluate the active policy pack for a gated transition. Packs are layered:
 * team_light extends solo_loose, factory_strict extends team_light, regulated
 * extends factory_strict. Returns structured failures/warnings — the caller
 * decides whether warnings block (they don't).
 */
export function evaluatePolicy(
  pack: PolicyPack,
  gate: PolicyGate,
  ctx: PolicyContext,
): PolicyResult {
  const failures: PolicyFailure[] = [];
  const warnings: PolicyFailure[] = [];
  const ac = ctx.acceptanceCriteria;

  // ---- Readiness ----------------------------------------------------------
  if (gate === "ready") {
    if (ctx.ticket.title.trim().length === 0) {
      failures.push(fail("TITLE_REQUIRED", "Ticket title is required."));
    }
    // ---- Scope/repo confirmation (WG-003) ---------------------------------
    // Layered per pack:
    //   solo_loose     scope optional; a scope-less ticket can be ready.
    //   team_light     ≥1 confirmed write repo (mono_fallback counts); block
    //                  tickets with no repo at all.
    //   factory_strict primary scope required UNLESS mono_fallback applies;
    //                  block unresolved 'suggested' repos.
    //   regulated      = factory_strict + human ready approval.
    const sr = ctx.scopeRepo;
    // ≥1 acceptance criterion is required for EVERY delivery-bound policy,
    // solo_loose included. A 0-AC ticket can never be delivered safely: it has
    // nothing to verify and nothing the done-gate can hold the work to. Catching
    // it free at the `ready` transition stops a 0-AC ticket from ever reaching a
    // paid delivery (the ticket #64 waste failure).
    if (ac.length === 0) {
      failures.push(fail("AC_REQUIRED", "At least one acceptance criterion is required."));
    }
    if (pack === "solo_loose") {
      if (ctx.ticket.description.trim().length === 0) {
        warnings.push(fail("DESCRIPTION_RECOMMENDED", "A description is recommended."));
      }
      if (!sr.hasAnyRepo) {
        warnings.push(fail("REPO_RECOMMENDED", "No repository linked to this ticket."));
      }
    }
    if (pack === "team_light" || pack === "factory_strict" || pack === "regulated") {
      if (ctx.ticket.description.trim().length === 0) {
        failures.push(fail("DESCRIPTION_REQUIRED", "Description is required."));
      }
      if (!sr.hasAnyRepo) {
        failures.push(
          fail(
            "REPO_REQUIRED",
            "At least one repository must be linked before this ticket is ready.",
          ),
        );
      } else if (sr.writeRepoCount === 0) {
        failures.push(
          fail(
            "WRITE_REPO_REQUIRED",
            "At least one confirmed write repo is required. Confirm a repo with access='write' " +
              "(an unmapped single repo can be promoted via mono_fallback), or accept a suggested repo.",
          ),
        );
      }
      if (ctx.hasUnresolvedHumanRequired) {
        failures.push(
          fail("HUMAN_BLOCKER_OPEN", "An unresolved human-required blocker prevents readiness."),
        );
      }
    }
    if (pack === "factory_strict" || pack === "regulated") {
      // A primary scope is required UNLESS the ticket is a mono_fallback (exactly
      // one directly-selected repo with no scope-graph mapping).
      if (!sr.hasPrimaryScope && !sr.monoFallbackApplies) {
        failures.push(
          fail(
            "PRIMARY_SCOPE_REQUIRED",
            "A primary scope is required. Set one with setPrimaryScope, or — for a single " +
              "unmapped repo — apply mono_fallback to execute in single-repo mode.",
          ),
        );
      }
      // Unresolved 'suggested' repos must be accepted (→confirmed) or rejected.
      if (sr.unresolvedSuggestedRepoCount > 0) {
        failures.push(
          fail(
            "SUGGESTED_REPO_UNRESOLVED",
            `${sr.unresolvedSuggestedRepoCount} suggested repo(s) are unresolved. Accept them ` +
              "(confirm write/read/test access) or reject them before this ticket can be ready.",
          ),
        );
      }
      for (const c of ac) {
        if (!c.verification_method || c.verification_method.trim().length === 0) {
          failures.push(
            fail("AC_VERIFICATION_REQUIRED", `AC "${c.text}" needs a verification method.`),
          );
        }
      }
      if (!ctx.hasReviewer) {
        failures.push(fail("REVIEWER_REQUIRED", "A reviewer must be set."));
      }
      if (ctx.blockingDecisions.length > 0) {
        failures.push(fail("BLOCKING_DECISION_OPEN", "An unresolved blocking decision exists."));
      }
    }
    if (pack === "regulated" && !ctx.humanApprovedReady) {
      failures.push(fail("HUMAN_APPROVAL_REQUIRED", "Human approval is required before ready."));
    }
  }

  // ---- Claim --------------------------------------------------------------
  if (gate === "claim") {
    // The atomic claim insert enforces "no active claim"; policy covers the rest.
    if (ctx.hasUnresolvedHumanRequired) {
      failures.push(fail("HUMAN_BLOCKER_OPEN", "A human-required blocker prevents claiming."));
    }
    if ((pack === "factory_strict" || pack === "regulated") && ctx.blockingDecisions.length > 0) {
      failures.push(fail("BLOCKING_DECISION_OPEN", "An unresolved blocking decision exists."));
    }
  }

  // ---- Review → done ------------------------------------------------------
  if (gate === "done") {
    // Recomputed-diff verification applies to EVERY delivery-bound pack —
    // solo_loose (the DEFAULT pack) included. `done` must correspond to a REAL,
    // server-recomputed `git diff base...delivery-branch` on the recorded branch
    // (see transitionService.hasRealDeliveryDiff); agent prose (a `diff_summary`
    // row) or an unvalidated `pr_url` never satisfies it. Previously solo_loose
    // ran an EMPTY done-gate, so this check never fired for the default pack and
    // agent-authored review evidence could satisfy sign-off with no real change.
    if (!ctx.hasPrOrDiff) {
      failures.push(fail("PR_OR_DIFF_REQUIRED", "A PR or diff summary is required."));
    }
    if (pack === "team_light" || pack === "factory_strict" || pack === "regulated") {
      const unresolved = ac.filter((c) => c.status === "pending" || c.status === "failed");
      if (unresolved.length > 0) {
        failures.push(
          fail("AC_UNRESOLVED", `${unresolved.length} acceptance criteria are unresolved.`),
        );
      }
    }
    if (pack === "factory_strict" || pack === "regulated") {
      for (const c of ac) {
        if (c.status === "waived") continue;
        if ((ctx.evidenceCountByAc.get(c.id) ?? 0) === 0) {
          failures.push(fail("AC_EVIDENCE_MISSING", `AC "${c.text}" requires evidence.`));
        }
      }
      if (!ctx.ticket.branch_name) {
        failures.push(fail("BRANCH_REQUIRED", "A branch must be recorded."));
      }
      // WG-005: every active write repo must carry per-repo delivery evidence —
      // a status of review_ready/done, or a recorded branch/PR — before done.
      const missing = ctx.repoDelivery.writeReposWithoutDelivery;
      if (missing.length > 0) {
        failures.push(
          fail(
            "REPO_DELIVERY_REQUIRED",
            `${missing.length} write repo(s) lack per-repo delivery evidence: ${missing.join(", ")}. ` +
              "Record a delivery (a branch/PR, or status review_ready/done) for each write repo " +
              "with recordRepoDelivery before this ticket can be done.",
          ),
        );
      }
    }
  }

  return { allowed: failures.length === 0, policy_pack: pack, gate, failures, warnings };
}
