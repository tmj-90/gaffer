import type { LoreKind, LoreSuggestionInput } from "../memory/client.js";
import type { DispatchClient } from "../dispatch/client.js";
import type { OnboardingScanResult } from "./onboardScan.js";

/**
 * Agent-authored onboarding clarifying questions (Ticket #9, extended for
 * product-intent capture, Track 1c).
 *
 * A newly-registered repo carries non-inferable context the factory would
 * otherwise guess — split into two families:
 *   - PRODUCT INTENT (the "why"): why this exists (requirement), what's
 *     deliberately out of scope (non-goal), the key decisions + their rationale
 *     (decision). This intent is exactly what evaporates if never asked.
 *   - REPO CONTEXT (the "how"): conventions, deploy, deprecated patterns,
 *     cross-repo boundaries, auth (convention / gotcha).
 *
 * This module lets the agent AUTHOR those questions (grounded in the onboarding
 * scan), ASK them as `human_required` decisions (the human answers, never the
 * agent), and CAPTURE the answers as DRAFT Memory suggestions for ratification —
 * BATCHED by kind so a review queue gets a few grouped items, not one-per-answer.
 * Nothing here auto-promotes lore.
 */

/** A clarifying question the agent authors about a newly-registered repo. */
export interface ClarifyingQuestion {
  /** Stable topic slug — used as the lore tag and the answer's dedup key. */
  topic: string;
  title: string;
  question: string;
  /** The lore kind an answer to this question should be captured as. */
  kind: LoreKind;
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

/**
 * Map a question topic to the lore kind its answer captures. Used at CAPTURE
 * time, where answers arrive as `{topic, question, answer}` (from a JSON file
 * or the UI) without carrying the authored `kind`. Unknown topics fall back to
 * 'convention' — a non-inferable repo fact is the safe default.
 */
const KIND_BY_TOPIC: Readonly<Record<string, LoreKind>> = {
  "product-why": "requirement",
  "non-goals": "non-goal",
  "key-decisions": "decision",
  conventions: "convention",
  deploy: "convention",
  "cross-repo-boundaries": "convention",
  auth: "convention",
  "deprecated-patterns": "gotcha",
};

function kindForTopic(topic: string): LoreKind {
  return KIND_BY_TOPIC[topic] ?? "convention";
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
    // ── PRODUCT INTENT (the "why") — the context that evaporates if never asked.
    {
      topic: "product-why",
      title: `Why does '${ctx.name}' exist?`,
      question:
        `What problem does '${ctx.name}' solve, and for whom? Describe the core user/business ` +
        `need it serves — the "why" behind the code that isn't obvious from reading it.`,
      kind: "requirement",
    },
    {
      topic: "non-goals",
      title: `Non-goals for '${ctx.name}'`,
      question:
        `What is '${ctx.name}' deliberately NOT trying to do? List the non-goals / out-of-scope ` +
        `areas so an agent doesn't "helpfully" build something the product intentionally excludes.`,
      kind: "non-goal",
    },
    {
      topic: "key-decisions",
      title: `Key decisions behind '${ctx.name}'`,
      question:
        `What are the most important product/technical decisions already made for '${ctx.name}', ` +
        `and WHY? (e.g. a chosen approach, a rejected alternative, a hard constraint.) Capture the ` +
        `rationale so agents don't relitigate settled choices.`,
      kind: "decision",
    },
    // ── REPO CONTEXT (the "how") — non-inferable operating facts.
    {
      topic: "conventions",
      title: `Conventions for '${ctx.name}'`,
      question:
        `'${ctx.name}' was detected as ${stack}. What code conventions should agents follow ` +
        `here that are NOT obvious from the code (naming, error handling, module layout, testing style)?`,
      kind: "convention",
    },
    {
      topic: "deploy",
      title: `Deploy/release for '${ctx.name}'`,
      question:
        `How is '${ctx.name}' built, released and deployed? (Detected infra: ${infra}.) ` +
        `Name the pipeline, environments, and anything an agent must never touch.`,
      kind: "convention",
    },
    {
      topic: "deprecated-patterns",
      title: `Deprecated patterns in '${ctx.name}'`,
      question:
        `Are there deprecated patterns, libraries or in-flight migrations in '${ctx.name}' ` +
        `that agents should steer away from? If so, what replaces them?`,
      kind: "gotcha",
    },
    {
      topic: "cross-repo-boundaries",
      title: `Cross-repo boundaries for '${ctx.name}'`,
      question:
        `Does '${ctx.name}' (origin: ${origin}) depend on or expose APIs to other repos/services? ` +
        `Describe the boundaries an agent must respect.`,
      kind: "convention",
    },
    {
      topic: "auth",
      title: `Auth/permissions for '${ctx.name}'`,
      question:
        `How does '${ctx.name}' handle authentication and authorization? Note any ownership/tenant ` +
        `scoping or permission rules that are not visible in the code.`,
      kind: "convention",
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
 * Onboarding's clarifying-question policy — RE-ENABLED, BATCHED (Track 1c).
 *
 * Onboarding used to raise the full {@link authorOnboardingQuestions} batch as
 * ONE `human_required` decision PER question — five+ decisions per repo, the
 * "floods the review queue" anti-pattern the memory-onboard skill warns about.
 * The fix is not to capture ZERO intent (the previous state: this returned `[]`,
 * so the product's "why" evaporated); it's to BATCH. Onboarding now raises a
 * SINGLE bundled human-required decision listing every authored question, so the
 * review queue gains one item, not one-per-question — while every question is
 * still asked and can be answered + captured.
 *
 * The authored set includes the PRODUCT-WHY questions (why this exists, its
 * non-goals, its key decisions), not just the code-adjacent ones, so the durable
 * capture is aimed at intent. The answers land as DRAFT lore via
 * {@link buildClarificationSuggestions} (human-gated). Nothing here auto-promotes.
 */
export function onboardClarifications(
  scan: OnboardingScanResult,
  ctx: ClarifyContext,
  deps: { dispatch: DispatchClient },
  opts: { ticketId?: string } = {},
): RaisedClarification[] {
  const questions = authorOnboardingQuestions(scan, ctx);
  if (questions.length === 0) return [];

  // Batch: a SINGLE review item bundling every question, not one decision each.
  const bundledQuestion =
    `Onboarding intake for '${ctx.name}'. Please answer the following so the factory ` +
    `captures this repo's product intent + non-inferable context as durable lore ` +
    `(answers are drafted for review, never auto-applied):\n\n` +
    questions.map((q, i) => `${i + 1}. [${q.topic}] ${q.question}`).join("\n\n");

  const decision = deps.dispatch.requestDecision({
    title: `Onboarding intake for '${ctx.name}' (${questions.length} questions)`,
    question: bundledQuestion,
    severity: "human_required",
    ...(opts.ticketId ? { ticketId: opts.ticketId } : {}),
  });

  // Every authored question maps to the ONE bundled decision.
  return questions.map((q) => ({ ...q, decisionId: decision.decisionId }));
}

/** Human-facing label for a kind, used in the batched draft's title/tag. */
const KIND_LABEL: Readonly<Record<LoreKind, string>> = {
  decision: "key decisions",
  requirement: "product requirements",
  "non-goal": "non-goals",
  convention: "conventions",
  gotcha: "gotchas / deprecated patterns",
  other: "context",
};

/**
 * Turn answered clarifying questions into DRAFT Memory suggestions for human
 * ratification — the capture half of the onboarding loop (AC2), now BATCHED by
 * kind (Track 1c). Rather than one draft per answer (which floods the review
 * queue), answers are grouped by their lore {@link LoreKind} so a review sees a
 * FEW records — one per kind that got a real answer — each carrying the grouped
 * Q/A pairs and the matching product-intent `kind`. Blank answers are skipped.
 * Returned suggestions are flushed via the async Memory bridge
 * (`flushSuggestions` → `suggest_lore`) and are NEVER auto-promoted.
 */
export function buildClarificationSuggestions(
  repoId: string,
  answers: readonly AnsweredClarification[],
): LoreSuggestionInput[] {
  const answered = answers.filter((a) => a.answer.trim().length > 0);
  if (answered.length === 0) return [];

  // Group answers by the kind their topic maps to, preserving first-seen order
  // so the output is deterministic.
  const byKind = new Map<LoreKind, AnsweredClarification[]>();
  for (const a of answered) {
    const kind = kindForTopic(a.topic);
    const list = byKind.get(kind) ?? [];
    list.push(a);
    byKind.set(kind, list);
  }

  const suggestions: LoreSuggestionInput[] = [];
  for (const [kind, group] of byKind) {
    const label = KIND_LABEL[kind];
    const qa = group
      .map((a) => `Q (${a.topic}): ${a.question}\nA: ${a.answer.trim()}`)
      .join("\n\n");
    suggestions.push({
      title: `Repo '${repoId}' onboarding: ${label}`,
      summary:
        `Onboarding ${label} for '${repoId}' (drafted for ratification; not auto-promoted).\n\n` +
        qa,
      tags: ["onboarding", "repo-context", kind, ...group.map((a) => a.topic)],
      kind,
    });
  }
  return suggestions;
}
