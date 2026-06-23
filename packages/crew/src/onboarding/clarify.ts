import type { LoreSuggestionInput } from "../memory/client.js";
import type { DispatchClient } from "../dispatch/client.js";
import type { OnboardingScanResult } from "./onboardScan.js";

/**
 * Agent-authored onboarding clarifying questions (Ticket #9).
 *
 * A newly-registered repo carries non-inferable context — conventions, deploy,
 * deprecated patterns, cross-repo boundaries, auth — the factory would otherwise
 * guess. This module lets the agent AUTHOR those questions (grounded in the
 * onboarding scan), ASK them as `human_required` decisions (the human answers in
 * the UI/CLI, never the agent), and CAPTURE each answer as a DRAFT Memory
 * suggestion for human ratification. Nothing here auto-promotes lore.
 */

/** A clarifying question the agent authors about a newly-registered repo. */
export interface ClarifyingQuestion {
  /** Stable topic slug — used as the lore tag and the answer's dedup key. */
  topic: string;
  title: string;
  question: string;
}

/** A clarifying question that has been raised as a `human_required` decision. */
export interface RaisedClarification extends ClarifyingQuestion {
  decisionId: string;
}

/** A human's answer to a previously-raised clarifying question. */
export interface AnsweredClarification {
  topic: string;
  question: string;
  answer: string;
}

/** The repo identity a clarification round is authored against. */
export interface ClarifyContext {
  repoId: string;
  name: string;
}

/**
 * Author clarifying questions for a newly-scanned repo. Each question targets a
 * distinct bucket of non-inferable context and is woven with the concrete scan
 * signals (stack, infra/risk signals, remote) so a human can answer it without
 * re-deriving the context — the framing Dispatch decisions ask for.
 */
export function authorOnboardingQuestions(
  scan: OnboardingScanResult,
  ctx: ClarifyContext,
): ClarifyingQuestion[] {
  const stack = scan.stack ?? "an unknown stack";
  const infra =
    scan.riskSignals.length > 0 ? scan.riskSignals.join(", ") : "no infra signals detected";
  const origin = scan.remoteUrl ?? "no remote (local-only)";

  return [
    {
      topic: "conventions",
      title: `Conventions for '${ctx.name}'`,
      question:
        `'${ctx.name}' was detected as ${stack}. What code conventions should agents follow ` +
        `here that are NOT obvious from the code (naming, error handling, module layout, testing style)?`,
    },
    {
      topic: "deploy",
      title: `Deploy/release for '${ctx.name}'`,
      question:
        `How is '${ctx.name}' built, released and deployed? (Detected infra: ${infra}.) ` +
        `Name the pipeline, environments, and anything an agent must never touch.`,
    },
    {
      topic: "deprecated-patterns",
      title: `Deprecated patterns in '${ctx.name}'`,
      question:
        `Are there deprecated patterns, libraries or in-flight migrations in '${ctx.name}' ` +
        `that agents should steer away from? If so, what replaces them?`,
    },
    {
      topic: "cross-repo-boundaries",
      title: `Cross-repo boundaries for '${ctx.name}'`,
      question:
        `Does '${ctx.name}' (origin: ${origin}) depend on or expose APIs to other repos/services? ` +
        `Describe the boundaries an agent must respect.`,
    },
    {
      topic: "auth",
      title: `Auth/permissions for '${ctx.name}'`,
      question:
        `How does '${ctx.name}' handle authentication and authorization? Note any ownership/tenant ` +
        `scoping or permission rules that are not visible in the code.`,
    },
  ];
}

/**
 * Raise each authored question as a `human_required` Dispatch decision — the
 * ask half of the onboarding loop (AC1). HARD-blocks on the human; the agent
 * never answers. Returns the raised clarifications (question + its decision id).
 */
export function requestOnboardingClarifications(
  questions: readonly ClarifyingQuestion[],
  deps: { dispatch: DispatchClient },
  opts: { ticketId?: string } = {},
): RaisedClarification[] {
  return questions.map((q) => {
    const decision = deps.dispatch.requestDecision({
      title: q.title,
      question: q.question,
      severity: "human_required",
      ...(opts.ticketId ? { ticketId: opts.ticketId } : {}),
    });
    return { ...q, decisionId: decision.decisionId };
  });
}

/**
 * Onboarding's clarifying-question policy — DELIBERATELY DISABLED.
 *
 * Onboarding used to auto-author + raise the full {@link authorOnboardingQuestions}
 * batch as `human_required` decisions on every onboard. That meant five generic
 * decisions per repo ("how does X handle auth?", "what conventions…?") — the exact
 * "floods the review queue" anti-pattern the memory-onboard skill calls out. The
 * grounded, model-backed onboarding analysis now READS the repo and proposes CITED
 * DRAFT lore in place of that flood, so onboarding raises NO clarifying-question
 * decisions: this helper returns an empty list and never touches Dispatch.
 *
 * It is the single seam the onboard command uses, so the "flood is off" contract is
 * testable in one place. The underlying {@link authorOnboardingQuestions} /
 * {@link requestOnboardingClarifications} primitives remain for the human-driven
 * `clarify-capture` flow, where a person deliberately authors + answers questions.
 */
export function onboardClarifications(
  _scan: OnboardingScanResult,
  _ctx: ClarifyContext,
  _deps: { dispatch: DispatchClient },
): RaisedClarification[] {
  // No generic decision batch on onboard. The grounded analysis replaces it.
  return [];
}

/**
 * Turn answered clarifying questions into DRAFT Memory suggestions for human
 * ratification — the capture half of the onboarding loop (AC2). Blank answers
 * are skipped. Returned suggestions are flushed via the async Memory bridge
 * (`flushSuggestions` → `suggest_lore`); they are NEVER auto-promoted.
 */
export function buildClarificationSuggestions(
  repoId: string,
  answers: readonly AnsweredClarification[],
): LoreSuggestionInput[] {
  return answers
    .filter((a) => a.answer.trim().length > 0)
    .map((a) => ({
      title: `Repo '${repoId}' onboarding: ${a.topic}`,
      summary:
        `Onboarding clarification for '${repoId}' (drafted for ratification; not auto-promoted):\n` +
        `Q: ${a.question}\nA: ${a.answer.trim()}`,
      tags: ["onboarding", "repo-context", a.topic],
    }));
}
