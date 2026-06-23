import type { FeatureInput, RepoDigestInput } from "../memory/client.js";
import type { ScopeNodeSummary } from "../dispatch/client.js";
import type { RepoMapping } from "./contextStore.js";
import type { OnboardingScanResult } from "./onboardScan.js";

/**
 * Repo Digest + feature inventory derivation (FG onboarding extension).
 *
 * The whole point is "scan once": this module produces BOTH the Repo Digest
 * (overview / structure / conventions / stack) AND an inventory of the repo's
 * existing user-facing features ENTIRELY from the {@link OnboardingScanResult}
 * the onboarding flow already computed — it never triggers a second repo scan.
 *
 * The digest is the agent's honest SUMMARY of the code: a map, not the
 * territory. It is persisted with its provenance (`source: "onboard"`).
 */

/** Provenance recorded on everything this module emits. */
export const ONBOARD_PROVENANCE = "onboard";

/** What `deriveRepoUnderstanding` produces — ready to persist via the MCP writes. */
export interface RepoUnderstanding {
  digest: RepoDigestInput;
  /** Existing user-facing features inventoried as `shipped` records. */
  features: FeatureInput[];
}

export interface DeriveUnderstandingInput {
  repoId: string;
  name: string;
  scan: OnboardingScanResult;
  mapping: RepoMapping;
  /** Scope nodes available for soft `scope_node` name references (may be empty). */
  scopeNodes?: readonly ScopeNodeSummary[];
}

/** Human label for the detected stack, or a neutral fallback. */
function stackLabel(stack: string | null): string {
  return stack ?? "an undetermined stack";
}

/** Join a list as a readable sentence fragment, or a fallback when empty. */
function listOr(items: readonly string[], fallback: string): string {
  return items.length > 0 ? items.join(", ") : fallback;
}

/** Roles for important top-level paths, so `structure` reads as a map of the repo. */
const PATH_ROLES: Readonly<Record<string, string>> = {
  src: "primary source",
  lib: "library code",
  app: "application code",
  test: "tests",
  tests: "tests",
  docs: "documentation",
  ".github": "CI / GitHub config",
  migrations: "database migrations",
  "package.json": "Node manifest",
  "pyproject.toml": "Python manifest",
  "Cargo.toml": "Rust manifest",
  "go.mod": "Go module",
  "pom.xml": "Maven manifest",
  Makefile: "build/task targets",
  Dockerfile: "container build",
  "docker-compose.yml": "local service composition",
  "README.md": "overview docs",
  "tsconfig.json": "TypeScript config",
};

function roleFor(path: string): string {
  return PATH_ROLES[path] ?? "key path";
}

/**
 * Build the digest's `overview` — a TLDR of what the repo does, grounded in the
 * concrete scan signals (name, stack, git remote, risk signals).
 */
function buildOverview(input: DeriveUnderstandingInput): string {
  const { name, scan } = input;
  const sentences: string[] = [];
  sentences.push(`'${name}' is ${stackLabel(scan.stack)} repository.`);
  if (scan.remoteUrl) sentences.push(`Its origin remote is ${scan.remoteUrl}.`);
  if (scan.riskSignals.length > 0) {
    sentences.push(`Notable signals: ${scan.riskSignals.join(", ")}.`);
  }
  sentences.push(
    "This overview is the onboarding scan's honest summary of the repo (a map, not the territory).",
  );
  return sentences.join(" ");
}

/** Build the digest's `structure` — key modules/dirs and their role. */
function buildStructure(scan: OnboardingScanResult): string {
  if (scan.importantPaths.length === 0) {
    return "No notable top-level modules were detected during the onboarding scan.";
  }
  const lines = scan.importantPaths.map((path) => `${path} — ${roleFor(path)}`);
  return `Key paths:\n- ${lines.join("\n- ")}`;
}

/** Build the digest's `conventions` — stack + the patterns agents should follow. */
function buildConventions(scan: OnboardingScanResult): string {
  const parts: string[] = [];
  parts.push(`Stack: ${stackLabel(scan.stack)}.`);
  if (scan.packageManager) parts.push(`Package manager: ${scan.packageManager}.`);

  const commands: string[] = [];
  if (scan.testCommand) commands.push(`test \`${scan.testCommand}\``);
  if (scan.lintCommand) commands.push(`lint \`${scan.lintCommand}\``);
  if (scan.buildCommand) commands.push(`build \`${scan.buildCommand}\``);
  if (scan.coverageCommand) commands.push(`coverage \`${scan.coverageCommand}\``);
  parts.push(`Commands to use: ${listOr(commands, "none detected")}.`);

  if (scan.riskSignals.length > 0) {
    parts.push(`Respect existing infra: ${scan.riskSignals.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * Inventory the repo's existing user-facing features.
 *
 * Deliberately returns NOTHING. The scan is mechanical — it sees build/test/CI
 * tooling and risk signals, NONE of which are product features. The old derivation
 * mapped those signals to fake "features" ("Build pipeline", "Automated tests",
 * "Infra: ci:github-actions"), which is exactly the low-quality output this work
 * removes: tests / CI / build / automation / linting are INFRASTRUCTURE, not
 * user-facing product capabilities.
 *
 * The SOURCE OF TRUTH for features is now the MODEL-BACKED onboarding analysis
 * (runner/lib/onboard-analyze.mjs), which reads the README / domain / modules
 * and extracts REAL product capabilities (or an honest empty set). So the mechanical
 * derivation emits an empty feature list — never a fake one. The digest PROSE below
 * is still derived from the scan as an honest OFFLINE FALLBACK (overridden by the
 * model analysis when it runs).
 */
function buildFeatures(_input: DeriveUnderstandingInput): FeatureInput[] {
  return [];
}

/**
 * Derive the Repo Digest + feature inventory from the onboarding scan. Pure: no
 * I/O, no second scan — it reads only the {@link OnboardingScanResult} the
 * onboarding flow already produced.
 */
export function deriveRepoUnderstanding(input: DeriveUnderstandingInput): RepoUnderstanding {
  const digest: RepoDigestInput = {
    repo: input.repoId,
    overview: buildOverview(input),
    structure: buildStructure(input.scan),
    conventions: buildConventions(input.scan),
    stack: input.scan.stack,
    source: ONBOARD_PROVENANCE,
  };
  return { digest, features: buildFeatures(input) };
}
