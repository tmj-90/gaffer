// Config + registries
export * from "./config/schema.js";
export * from "./config/loader.js";
export * from "./config/init.js";
export { defaultConfigYaml, defaultSafetyPolicyYaml } from "./config/template.js";
export { RepoRegistry } from "./registry/repoRegistry.js";
export { AgentRegistry } from "./registry/agentRegistry.js";

// Scan + adapters
export * from "./scan/repoScan.js";

// Repo onboarding (FG-003) + non-committed context store (FG-004)
export { scanRepoForOnboarding, type OnboardingScanResult } from "./onboarding/onboardScan.js";
export {
  RepoContextStore,
  resolveDataRoot,
  repoProfileSchema,
  repoContextSchema,
  repoMappingSchema,
  type RepoProfile,
  type RepoContext,
  type RepoMapping,
  type RepoMappingMode,
  type ScanHistoryEntry,
  type ContextStoreOptions,
} from "./onboarding/contextStore.js";
export {
  onboardRepo,
  rescanRepo,
  availableScopeNodes,
  type OnboardOptions,
  type OnboardResult,
  type OnboardDeps,
  type OnboardMappingChoice,
  type RescanResult,
} from "./onboarding/onboard.js";
// Agent-asked onboarding clarifying questions (Ticket #9)
export {
  authorOnboardingQuestions,
  requestOnboardingClarifications,
  buildClarificationSuggestions,
  type ClarifyingQuestion,
  type RaisedClarification,
  type AnsweredClarification,
  type ClarifyContext,
} from "./onboarding/clarify.js";

// Secret-path discipline (shared by scanner + context store)
export {
  isSecretPath as isSecretRepoPath,
  isExcludedDir,
  SECRET_PATH_GLOBS,
  SECRET_DIR_NAMES,
  SKIP_DIR_NAMES,
} from "./safety/secretPaths.js";
export { systemGitAdapter, DryRunGitAdapter, type GitAdapter } from "./adapters/gitAdapter.js";
export {
  systemCommandRunner,
  FakeCommandRunner,
  type CommandRunner,
  type CommandResult,
} from "./adapters/commandRunner.js";

// Safety
export * from "./safety/index.js";

// Context packet
export * from "./context/packet.js";
export {
  estimateTokens,
  measurePacket,
  packetFingerprint,
  type PacketTokenReport,
  type PacketSection,
} from "./context/tokens.js";

// Clients
export * from "./dispatch/client.js";
export { FakeDispatchClient } from "./dispatch/fakeClient.js";
export { RealDispatchClient } from "./dispatch/realClient.js";
export * from "./memory/client.js";
export {
  McpMemoryClient,
  type AsyncMemoryClient,
  type McpMemoryConfig,
} from "./memory/mcpClient.js";
export {
  prefetchLore,
  seededSyncClient,
  flushSuggestions,
  flushRepoUnderstanding,
  type PrefetchQuery,
  type FlushResult,
  type RepoUnderstandingFlushResult,
} from "./memory/prefetch.js";
export {
  deriveRepoUnderstanding,
  ONBOARD_PROVENANCE,
  type RepoUnderstanding,
  type DeriveUnderstandingInput,
} from "./onboarding/repoDigest.js";
export { hasRealMemory, resolveAsyncMemory, resolveUnderstandingSink } from "./memory/factory.js";
export {
  CliMemoryClient,
  cliConfigFromEnv,
  parseFeatureNames,
  type CliMemoryConfig,
  type CliRunner,
  type CliRunResult,
} from "./memory/cliClient.js";
export {
  selectScopedLore,
  buildScopeGraphView,
  LORE_PRIORITY,
  type ScopedLoreRecord,
  type ScopeGraphView,
  type ScopeLoreDeps,
  type LorePriority,
  type ScopeGraphNodeInput,
  type ScopeGraphEdgeInput,
} from "./memory/scopeLore.js";

// Runtime + events + loops
export * from "./runtime/agentRuntime.js";
export * from "./runtime/claudeAgentRuntime.js";
export { EventLog, type RuntimeEvent } from "./events/eventLog.js";
export * from "./loops/implementationLoop.js";
export * from "./loops/idleLoop.js";
export {
  runIdleTestQualityLoop,
  scanTestQuality,
  type TestQualityFinding,
} from "./loops/idleTestQuality.js";
export { runIdleDocsLoop, scanDocs, type DocFinding } from "./loops/idleDocs.js";
export {
  runIdleSecurityHotspotLoop,
  scanSecurityHotspots,
  isSecurityScanFile,
  type SecurityHotspotFinding,
} from "./loops/idleSecurityHotspot.js";
export {
  runIdleDependencyLoop,
  scanDependencies,
  scanPackageJson,
  parseAudit,
  parseOutdated,
  type DependencyFinding,
} from "./loops/idleDependencies.js";
export { type IdleScanOutcome, type ScanDraft } from "./loops/idleScans.js";
export {
  runIdleLoops,
  runIdleLoreGap,
  runIdleFeatureBacklog,
  IDLE_LOOPS,
  type IdleLoopId,
  type IdleLoopDefinition,
  type IdleLoopRunOutcome,
  type IdleRunReport,
} from "./loops/idleRegistry.js";
export {
  runIdleLoreGapLoop,
  detectConventions,
  type IdleLoreGapDeps,
  type IdleLoreGapOutcome,
  type LoreGapSuggestion,
  type ConventionCandidate,
} from "./loops/idleLoreGap.js";
export {
  runIdleFeatureBacklogLoop,
  pickBacklogFeature,
  type IdleFeatureBacklogDeps,
  type IdleFeatureBacklogOutcome,
} from "./loops/idleFeatureBacklog.js";
export {
  SpawnDecomposer,
  parseEpicPlan,
  type Decomposer,
  type DecomposeRequest,
  type EpicPlan,
  type EpicTicketPlan,
  type SpawnDecomposerConfig,
} from "./adapters/decomposer.js";
export { hasRealDecomposer, resolveDecomposer } from "./adapters/decomposerFactory.js";

// Issue ingest adapters (GitHub, Jira) + their shared dedup contract
export {
  ingestIssueAsDraft,
  type IngestDeps,
  type IngestSummary,
  type IngestedIssue,
  type IngestError,
  type NormalizedIssue,
} from "./ingest/core.js";
export { ingestGithubIssues, parseGithubSlug, type GithubIssue } from "./ingest/githubIssues.js";
export { ingestJiraIssues, type JiraIssue } from "./ingest/jiraIssues.js";

// Hooks engine
export * from "./hooks/index.js";

// Skills registry
export * from "./skills/index.js";

// Runtime wiring (shared by CLI + MCP)
export { loadFactory, openDispatch, type FactoryContext } from "./runtime/wiring.js";

// MCP server
export { createCrewServer, runStdioServer, type ServerOptions } from "./mcp/server.js";
export {
  makeHandlers,
  toolSchemas,
  type ToolName,
  type ToolResult,
  type DispatchOpener,
} from "./mcp/tools.js";

// Audit (redacted, append-only MCP tool-call log)
export {
  audit,
  isAuditDisabled,
  resolveAuditPath,
  summariseArgs,
  readAuditRecords,
  summariseRecentRuns,
  type AuditEntry,
  type AuditOptions,
  type AuditRecord,
  type RecentRunSummary,
} from "./audit/index.js";

// Ops (doctor + stats)
export {
  runDoctor,
  renderDoctor,
  buildStats,
  renderStats,
  type DoctorReport,
  type DoctorCheck,
  type DoctorDeps,
  type CheckLevel,
  type FactoryStats,
  type StatsOptions,
} from "./ops/index.js";

// Util
export { CrewError } from "./util/errors.js";
export { systemClock, TestClock, type Clock } from "./util/clock.js";
