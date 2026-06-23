/**
 * Agent-asked onboarding clarifying questions (Ticket #9).
 *
 * Asserts:
 *   - the agent authors grounded clarifying questions from an onboarding scan;
 *   - AC1: each question is raised as a `human_required` Dispatch decision;
 *   - AC2: each answered question becomes a DRAFT Memory suggestion;
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
  it("authors one question per non-inferable bucket, grounded in scan signals", () => {
    const questions = authorOnboardingQuestions(fakeScan(), { repoId: "api", name: "api" });

    expect(questions.map((q) => q.topic)).toEqual([
      "conventions",
      "deploy",
      "deprecated-patterns",
      "cross-repo-boundaries",
      "auth",
    ]);
    // Grounded: stack, infra signals and origin are woven into the questions.
    expect(questions[0]!.question).toContain("typescript");
    expect(questions[1]!.question).toContain("infra:docker");
    expect(questions[3]!.question).toContain("git@github.com:acme/api.git");
  });

  it("degrades gracefully when the scan has no stack/remote/infra", () => {
    const questions = authorOnboardingQuestions(
      fakeScan({ stack: null, remoteUrl: null, riskSignals: [] }),
      { repoId: "api", name: "api" },
    );
    expect(questions).toHaveLength(5);
    expect(questions[0]!.question).toContain("an unknown stack");
    expect(questions[1]!.question).toContain("no infra signals detected");
    expect(questions[3]!.question).toContain("no remote (local-only)");
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
    // Each raised clarification carries the id of the decision it created.
    expect(raised.map((r) => r.decisionId).sort()).toEqual(
      dispatch.decisions.map((d) => d.decisionId).sort(),
    );
  });
});

describe("onboardClarifications — the decision flood is DISABLED on onboard", () => {
  it("raises ZERO clarifying-question decisions and never touches Dispatch", () => {
    const dispatch = new FakeDispatchClient();

    const raised = onboardClarifications(fakeScan(), { repoId: "api", name: "api" }, { dispatch });

    // The grounded model-backed analysis replaces the generic decision batch, so the
    // onboard seam surfaces no decisions (no "floods the review queue" anti-pattern).
    expect(raised).toEqual([]);
    expect(dispatch.decisions).toHaveLength(0);
  });

  it("does not regress the human-authored primitives it sits beside", () => {
    // The underlying batch still exists for the deliberate `clarify-capture` flow;
    // onboard simply no longer fires it. (Guards against someone re-wiring the flood.)
    const questions = authorOnboardingQuestions(fakeScan(), { repoId: "api", name: "api" });
    expect(questions).toHaveLength(5);
  });
});

describe("buildClarificationSuggestions (AC2)", () => {
  const answers: AnsweredClarification[] = [
    { topic: "conventions", question: "What conventions?", answer: "Use Zod at boundaries." },
    { topic: "auth", question: "How is auth done?", answer: "  " },
  ];

  it("drafts a Memory suggestion per answered question, skipping blanks", () => {
    const suggestions = buildClarificationSuggestions("api", answers);

    expect(suggestions).toHaveLength(1);
    const [only] = suggestions;
    expect(only!.title).toBe("Repo 'api' onboarding: conventions");
    expect(only!.summary).toContain("Use Zod at boundaries.");
    expect(only!.tags).toEqual(["onboarding", "repo-context", "conventions"]);
  });

  it("lands answers as DRAFT records via the Memory suggest boundary", () => {
    const lore = new StubMemoryClient();
    const suggestions = buildClarificationSuggestions("api", answers);

    const results = suggestions.map((s) => lore.suggestLore(s));

    expect(results.every((r) => r.status === "draft")).toBe(true);
    expect(lore.suggestions).toHaveLength(1);
    expect(lore.suggestions[0]!.tags).toContain("onboarding");
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
