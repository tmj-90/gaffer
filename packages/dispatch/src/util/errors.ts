/**
 * Every code a {@link DispatchError} may carry. A closed list so a new code cannot
 * ship without being declared here — and, through the REST status table in
 * api/http.ts (a `Record<DispatchErrorCode, number>`), without an HTTP status. Before
 * this, an unmapped domain refusal fell through to a 500 that clients, monitors and
 * retry logic read as a server crash.
 */
export const DISPATCH_ERROR_CODES = [
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "PAYLOAD_TOO_LARGE",
  "POLICY_DENIED",
  "STATE_CONFLICT",
  // A cancel of a ticket whose change already landed in some repository.
  "PARTLY_LANDED",
  "CONCURRENCY_CONFLICT",
  "ILLEGAL_TRANSITION",
  "NO_OP",
  "DUPLICATE",
  "CLAIM_INVALID",
  "CLAIM_REQUIRED",
  "TICKET_NOT_CLAIMABLE",
  "TICKET_NOT_HUMAN_OWNED",
  "DEPENDENCY_BLOCKED",
  "AGENT_NOT_ELIGIBLE",
  "SCOPE_NODE_IN_USE",
  "REPO_NOT_LINKED",
  "INVALID_EDGE",
  "INVALID_DEPENDENCY",
  "ADVANCED_RELATION_REQUIRED",
  "ACTOR_NOT_PERMITTED",
  "FACTORY_RUNNER_OWNED",
  "NOT_CONFIGURED",
  "TEST_CONTRACT_LEAK",
  "BINDING_REQUIRED",
  "CONTRACT_MISMATCH",
  "CONTRACT_FROZEN",
  "OBSERVED_RISK_ESCALATED",
  "DB_NOT_EMPTY",
  "DB_NOT_FOUND",
  "AMBIGUOUS_REF",
  "INCOMPATIBLE_BUNDLE",
  "INCONSISTENT_BUNDLE",
  // A merge the API started for this ticket is still running (a second one would race it).
  "MERGE_IN_FLIGHT",
  "FILE_NOT_FOUND",
  "IO_ERROR",
  // A file the CLI was told to write (export --out) could not be written.
  "WRITE_FAILED",
  // Another process held the SQLite write lock for longer than the busy timeout.
  "DB_BUSY",
  // A --path that is a directory but not inside a git checkout (repo add).
  "NOT_A_GIT_REPO",
  "UNSAFE_BIND",
  "INTERNAL_ERROR",
] as const;
export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[number];

/**
 * Structured Dispatch error. The `code` is a stable machine-readable string so
 * the CLI and MCP layers can return predictable, typed failures rather than
 * leaking raw exceptions.
 */
export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DispatchErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): DispatchError {
  return new DispatchError("NOT_FOUND", `${entity} not found: ${id}`, { entity, id });
}
