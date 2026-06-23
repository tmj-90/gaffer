/**
 * Structured Dispatch error. The `code` is a stable machine-readable string so
 * the CLI and MCP layers can return predictable, typed failures rather than
 * leaking raw exceptions.
 */
export class DispatchError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): DispatchError {
  return new DispatchError("NOT_FOUND", `${entity} not found: ${id}`, { entity, id });
}
