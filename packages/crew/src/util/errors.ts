/**
 * Structured Crew error. The `code` is a stable machine-readable string so
 * the CLI and MCP layers can return predictable, typed failures rather than
 * leaking raw exceptions.
 */
export class CrewError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CrewError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): CrewError {
  return new CrewError("NOT_FOUND", `${entity} not found: ${id}`, { entity, id });
}

export function invalidConfig(message: string, details: Record<string, unknown> = {}): CrewError {
  return new CrewError("INVALID_CONFIG", message, details);
}
