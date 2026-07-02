/**
 * Agent-asked onboarding clarifying questions (Ticket #9, extended for
 * product-intent capture — Track 1c).
 *
 * Asserts:
 *   - the agent authors grounded clarifying questions from an onboarding scan,
 *     INCLUDING product-why questions (why this exists, non-goals, key decisions);
 *   - onboardClarifications is RE-ENABLED but BATCHED: it raises a SINGLE
 *     human_required decision (not one-per-question — no review-queue flood);
 *   - answered questions become BATCHED DRAFT Memory suggestions grouped by kind
 *     (a few review items, not one-per-answer), each carrying its product-intent
 *     `kind`, and always as drafts;
 *   - the boundary maps `requestDecision` onto the real Dispatch `createDecision`.
 */
import { describe, expect, it } from "vitest";
import { Dispatch } from "dispatch";

import { StubMemoryClient } from "../src/memory/client.js";
import {
  authorOnboardingQuestions,
  buildClarificationSuggestions,
  onboardClarifications,
  requestOnboardingClarifications,
  type AnsweredClarification,
} from "../src/onboarding/clarify.js";
import type { OnboardingScanResult } from "../src/onboarding/onboardScan.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { RealDispatchClient } from "../src/dispatch/realClient.js";

function fakeScan(overrides: Partial<OnboardingScanResult> = {}): OnboardingScanResult {
  return {
    path: "/repos/api",
    name: "api",
    isGitRepo: true,
    currentBranch: "main",
    stack: "typescript",
    packageManager: "pnpm",
    testCommand: "pnpm test",
    lintCommand: "pnpm lint",
    coverageCommand: null,
    buildCommand: "pnpm build",
    riskSignals: ["ci:github-actions", "infra:docker"],
    remoteUrl: "git@github.com:acme/api.git",
    defaultBranch: "main",
    importantPaths: ["package.json", "src"],
    fingerprint: "fp-1",
    secretPathsSkipped: false,
    ...overrides,
  };
}

describe("authorOnboardingQuestions", () => {
  it("authors product-intent AND repo-context questions, grounded in scan signals", () => {
    const questions = authorOnboardingQuestions(fakeScan(), { repoId: "api", name: "api" });

    // Product-why questions are asked, not just the code-adjacent ones.
    expect(questions.map((q) => q.topic)).toEqual([
      "product-why",
      "non-goals",
      "key-decisions",
      "conventions",
      "deploy",
      "deprecated-patterns",
      "cross-repo-boundaries",
      "auth",
    ]);
    // Each question carries the lore kind its answer should be captured as.
    const kindByTopic = Object.fromEntries(questions.map((q) => [q.topic, q.kind]));
    expect(kindByTopic["product-why"]).toBe("requirement");
    expect(kindByTopic["non-goals"]).toBe("non-goal");
    expect(kindByTopic["key-decisions"]).toBe("decision");
    expect(kindByTopic["conventions"]).toBe("convention");
    expect(kindByTopic["deprecated-patterns"]).toBe("gotcha");
    // Grounded: stack, infra signals and origin are woven into the questions.
    const conventions = questions.find((q) => q.topic === "conventions")!;
    const deploy = questions.find((q) => q.topic === "deploy")!;
    const crossRepo = questions.find((q) => q.topic === "cross-repo-boundaries")!;
    expect(conventions.question).toContain("typescript");
    expect(deploy.question).toContain("infra:docker");
    expect(crossRepo.question).toContain("git@github.com:acme/api.git");
  });

  it("degrades gracefully when the scan has no stack/remote/infra", () => {
    const questions = authorOnboardingQuestions(
      fakeScan({ stack: null, remoteUrl: null, riskSignals: [] }),
      { repoId: "api", name: "api" },
    );
    expect(questions).toHaveLength(8);
    expect(questions.find((q) => q.topic === "conventions")!.question).toContain(
      "an unknown stack",
    );
    expect(questions.find((q) => q.topic === "deploy")!.question).toContain(
      "no infra signals detected",
    );
    expect(questions.find((q) => q.topic === "cross-repo-boundaries")!.question).toContain(
      "no remote (local-only)",
    );
  });
});

describe("requestOnboardingClarifications (AC1)", () => {
  it("raises every authored question as a human_required decision", () => {
    const dispatch = new FakeDispatchClient();
    const questions = authorOnboardingQuestions(fakeScan(), { repoId: "api", name: "api" });

    const raised = requestOnboardingClarifications(questions, { dispatch });

    expect(raised).toHaveLength(questions.length);
    expect(dispatch.decisions).toHaveLength(questions.length);
    for (const decision of dispatch.decisions) {
      expect(decision.severity).toBe("human_required");
      expect(decision.status).toBe("human_required");
      expect(decision.question.length).toBeGreaterThan(0);
    }
  });
});

describe("onboardClarifications — RE-ENABLED but BATCHED (Track 1c)", () => {
  it("raises ONE bundled human_required decision, not one-per-question (no flood)", () => {
    const dispatch = new FakeDispatchClient();

    const raised = onboardClarifications(fakeScan(), { repoId: "api", name: "api" }, { dispatch });

    // Every authored question is returned (capture is re-enabled)…
    expect(raised).toHaveLength(8);
    // …but the review queue gains exactly ONE item, not eight.
    expect(dispatch.decisions).toHaveLength(1);
    // …and each question maps to that single bundled decision.
    const [decision] = dispatch.decisions;
    expect(new Set(raised.map((r) => r.decisionId))).toEqual(new Set([decision!.decisionId]));
    expect(decision!.severity).toBe("human_required");
    // The bundle asks the product-why question too, not just repo context.
    expect(decision!.question).toContain("product-why");
  });
});

describe("buildClarificationSuggestions (AC2) — batched by kind, gated as drafts", () => {
  const answers: AnsweredClarification[] = [
    {
      topic: "product-why",
      question: "Why does 'api' exist?",
      answer: "It is the billing gateway for partner integrations.",
    },
    { topic: "non-goals", question: "Non-goals?", answer: "It must not store card PANs." },
    {
      topic: "key-decisions",
      question: "Key decisions?",
      answer: "We chose event-sourcing over CRUD for auditability.",
    },
    { topic: "conventions", question: "Conventions?", answer: "Use Zod at boundaries." },
    { topic: "deploy", question: "Deploy?", answer: "GitHub Actions to ECS." },
    { topic: "cross-repo-boundaries", question: "Boundaries?", answer: "Consumes auth-svc." },
    { topic: "deprecated-patterns", question: "Deprecated?", answer: "Old REST client is dead." },
    { topic: "auth", question: "Auth?", answer: "  " }, // blank — skipped
  ];

  it("BATCHES answers into a few drafts grouped by kind (does not flood one-per-answer)", () => {
    const suggestions = buildClarificationSuggestions("api", answers);

    // 7 non-blank answers span 4 kinds (requirement / non-goal / decision /
    // convention x3 + gotcha) — so we get FAR fewer drafts than answers.
    expect(suggestions.length).toBeLessThan(7);
    // The three product-intent kinds each produced a draft…
    const kinds = suggestions.map((s) => s.kind);
    expect(kinds).toContain("requirement");
    expect(kinds).toContain("non-goal");
    expect(kinds).toContain("decision");
    // …and the three CONVENTION answers collapse into a single grouped draft.
    const conventionDrafts = suggestions.filter((s) => s.kind === "convention");
    expect(conventionDrafts).toHaveLength(1);
    expect(conventionDrafts[0]!.summary).toContain("Use Zod at boundaries.");
    expect(conventionDrafts[0]!.summary).toContain("GitHub Actions");
    expect(conventionDrafts[0]!.summary).toContain("Consumes auth-svc.");
    // The product-why answer is captured (kind requirement).
    const requirement = suggestions.find((s) => s.kind === "requirement")!;
    expect(requirement.summary).toContain("billing gateway");
    // The blank answer never became a draft.
    expect(suggestions.every((s) => !s.summary.includes("Auth?"))).toBe(true);
  });

  it("lands every batched suggestion as a DRAFT via the Memory suggest boundary", () => {
    const lore = new StubMemoryClient();
    const suggestions = buildClarificationSuggestions("api", answers);

    const results = suggestions.map((s) => lore.suggestLore(s));

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.status === "draft")).toBe(true);
    expect(lore.suggestions.every((s) => s.tags?.includes("onboarding"))).toBe(true);
  });

  it("returns nothing when every answer is blank", () => {
    const blank: AnsweredClarification[] = [
      { topic: "product-why", question: "Why?", answer: "   " },
    ];
    expect(buildClarificationSuggestions("api", blank)).toEqual([]);
  });
});

describe("requestDecision boundary", () => {
  it("maps onto the real Dispatch createDecision and blocks as pending", () => {
    const facade = Dispatch.open(":memory:");
    const client = RealDispatchClient.fromFacade(
      facade as unknown as Parameters<typeof RealDispatchClient.fromFacade>[0],
    );

    const decision = client.requestDecision({
      title: "Conventions for 'api'",
      question: "What conventions should agents follow?",
    });

    expect(decision.decisionId.length).toBeGreaterThan(0);
    expect(decision.severity).toBe("human_required");
    const pending = facade.listPendingDecisions();
    expect(pending.some((d) => d.id === decision.decisionId)).toBe(true);
  });
});
