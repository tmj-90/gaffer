import { skillSchema, type Skill } from "./schema.js";

/**
 * v1 built-in skills (04-loops-hooks-skills.md). These are descriptive, stack-
 * agnostic procedures — they `applies_to` every stack so they are always
 * selectable, scoped by capability. Parsed through the schema so the built-ins
 * are validated exactly like human-authored files.
 */
const RAW_BUILTINS: ReadonlyArray<unknown> = [
  {
    id: "run-tests",
    version: 1,
    name: "Run tests",
    applies_to: { stacks: [], capabilities: ["tests"] },
    steps: [
      "resolve the repo's configured test_command",
      "run the test command in the repo directory",
      "capture stdout/stderr and the exit code",
      "summarise pass/fail counts as evidence",
    ],
    evidence: ["test_output", "exit_code"],
  },
  {
    id: "run-lint",
    version: 1,
    name: "Run lint",
    applies_to: { stacks: [], capabilities: ["tests", "quality"] },
    steps: [
      "resolve the repo's configured lint_command",
      "run the lint command in the repo directory",
      "capture findings and the exit code",
      "summarise lint findings as evidence",
    ],
    evidence: ["lint_output", "exit_code"],
  },
  {
    id: "run-coverage",
    version: 1,
    name: "Run coverage",
    applies_to: { stacks: [], capabilities: ["tests", "quality"] },
    steps: [
      "resolve the repo's configured coverage_command",
      "run the coverage command in the repo directory",
      "parse total coverage and low-covered files",
      "summarise the coverage report as evidence",
    ],
    evidence: ["coverage_report", "low_coverage_files"],
  },
  {
    id: "create-branch",
    version: 1,
    name: "Create branch",
    applies_to: { stacks: [], capabilities: ["git"] },
    steps: [
      "compute a branch name with the required safety prefix",
      "verify the branch passes branch policy",
      "create the branch from the default branch",
      "record the branch reference as evidence",
    ],
    evidence: ["branch_ref"],
  },
  {
    id: "record-evidence",
    version: 1,
    name: "Record evidence",
    applies_to: { stacks: [], capabilities: ["evidence"] },
    steps: [
      "identify the acceptance criterion being satisfied",
      "gather the supporting artefact (output, diff, link)",
      "record the evidence against the AC in Dispatch",
    ],
    evidence: ["evidence_id"],
  },
  {
    id: "submit-review",
    version: 1,
    name: "Submit for review",
    applies_to: { stacks: [], capabilities: ["review"] },
    steps: [
      "verify all acceptance criteria have evidence",
      "produce a diff summary and PR reference if available",
      "submit the ticket for review without self-approving",
    ],
    evidence: ["diff_summary", "pr_url"],
  },
  {
    id: "create-draft-ticket-from-finding",
    version: 1,
    name: "Create draft ticket from finding",
    applies_to: { stacks: [], capabilities: ["triage"] },
    steps: [
      "summarise the finding into a clear title and description",
      "attach the evidence summary to the draft",
      "create a DRAFT Dispatch ticket — never edit code",
    ],
    evidence: ["draft_ticket_ref", "evidence_summary"],
  },
  {
    id: "add-unit-test",
    version: 1,
    name: "Add a unit test",
    applies_to: { stacks: [], capabilities: ["tests"] },
    steps: [
      "find the unit and its existing tests; copy the repo's framework, naming, and assertion style",
      "enumerate behaviours from the AC: happy path, branches, boundaries, error cases",
      "write behaviour-asserting tests (Arrange-Act-Assert) in the repo's test location",
      "run the repo's test command and iterate until green",
      "record the test_output evidence against the AC and submit for review",
    ],
    evidence: ["test_output", "test_file_paths"],
  },
  {
    id: "add-integration-test",
    version: 1,
    name: "Add an integration test",
    applies_to: { stacks: [], capabilities: ["tests"] },
    steps: [
      "read lore for the repo's integration-test conventions (test DB/containers, fixtures, location)",
      "copy an existing integration test's bootstrap; stub only true externals, use real collaborators",
      "enumerate the flow from the AC: entry point, path through components, observable outcome",
      "write an isolated, repeatable test with proper setup/teardown asserting real outcomes",
      "run the repo's integration command, iterate until green and stable, record test_output evidence",
    ],
    evidence: ["test_output", "test_file_paths"],
  },
  {
    id: "add-api-endpoint",
    version: 1,
    name: "Add an API endpoint",
    applies_to: { stacks: [], capabilities: ["backend"] },
    steps: [
      "read lore for routing, response envelope, error format, and auth/authz conventions",
      "copy a sibling endpoint's shape: router registration, handler, DTO/schema",
      "validate input at the boundary with the repo's validation library; reject malformed input",
      "implement a thin handler (validate → delegate to service → standard response) with auth checks",
      "wire the route, add validation/happy-path/authz tests, run tests + lint, record evidence",
    ],
    evidence: ["diff_summary", "test_output"],
  },
  {
    id: "add-db-migration",
    version: 1,
    name: "Add a database migration",
    applies_to: { stacks: [], capabilities: ["database"] },
    steps: [
      "read lore for migration tooling, naming/numbering, and backward-compatibility rules",
      "assess risk: destructive or downtime-risking changes → mark_ticket_blocked for a human",
      "write a reversible migration (up + down); prefer additive expand → migrate → contract steps",
      "make it safe at scale: concurrent indexes, nullable/defaulted columns, batched backfills",
      "apply forward and roll back against the test/dev DB (never production), then run tests and record evidence",
    ],
    evidence: ["migration_file", "apply_rollback_output", "test_output"],
  },
  {
    id: "update-docs",
    version: 1,
    name: "Update the docs",
    applies_to: { stacks: [], capabilities: ["docs"] },
    steps: [
      "identify what changed and locate every doc that references it (README, docs/, API ref, changelog)",
      "read lore for docs/style conventions when the change touches a convention",
      "update only the affected sections in place; add a changelog entry in the repo's format",
      "verify examples are real by running documented commands/requests and fixing drift",
      "record the diff_summary evidence for the changed docs and submit for review",
    ],
    evidence: ["diff_summary", "command_output"],
  },
  {
    id: "fix-flaky-test",
    version: 1,
    name: "Fix a flaky test",
    applies_to: { stacks: [], capabilities: ["tests"] },
    steps: [
      "reproduce the flakiness: run the test repeatedly (and randomised) and capture a failing run",
      "locate the non-determinism: timing, test order/shared state, unseeded randomness, real clock, or network",
      "fix the root cause (await properly, isolate state, seed randomness, fake clock, stub externals) — never add a retry or sleep",
      "prove stability with many repeated passes in random order, then run the full suite for regressions",
      "record the repeated-run test_output evidence against the AC and submit for review",
    ],
    evidence: ["test_output", "diff_summary"],
  },
  {
    id: "refactor-module",
    version: 1,
    name: "Refactor a module",
    applies_to: { stacks: [], capabilities: ["refactor"] },
    steps: [
      "establish the safety net: run the suite green first; add characterization tests if thinly tested",
      "read lore for the repo's module boundaries, layering, and naming conventions",
      "refactor in small behaviour-preserving steps (extract, rename, move, dedupe), re-running tests each step",
      "change no behaviour — no features, fixes, or dependency bumps; log any bug found separately",
      "confirm the suite and lint are green after, then record before/after summaries and a diff_summary",
    ],
    evidence: ["diff_summary", "test_output"],
  },
];

/** Validated copy of the v1 built-in skill definitions. */
export function builtinSkills(): Skill[] {
  return RAW_BUILTINS.map((raw) => skillSchema.parse(raw));
}
