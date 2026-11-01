import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { DispatchError, type DispatchErrorCode } from "../util/errors.js";
import { toZod3Issues } from "../util/zod3Compat.js";

/**
 * Shared HTTP primitives + error mapping for the REST surface. Extracted from
 * server.ts so the per-resource route modules under ./routes share ONE copy of
 * the request/response helpers (no behaviour change — a pure move).
 */

/**
 * The HTTP status for every DispatchError code. A `Record` over the closed code
 * union, so the compiler refuses a code with no status: a deliberate domain refusal
 * (a gate, a binding check, a leak guard) must never surface as a 500.
 */
const STATUS_FOR_CODE: Record<DispatchErrorCode, number> = {
  NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  INVALID_EDGE: 422,
  INVALID_DEPENDENCY: 422,
  ADVANCED_RELATION_REQUIRED: 422,
  // A payload the gate refuses on its content: the contract names the implementation,
  // or an acceptance PASS is not bound to what was tested.
  TEST_CONTRACT_LEAK: 422,
  BINDING_REQUIRED: 422,
  POLICY_DENIED: 400,
  STATE_CONFLICT: 409,
  PARTLY_LANDED: 409,
  CONCURRENCY_CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  NO_OP: 409,
  DUPLICATE: 409,
  CLAIM_INVALID: 409,
  CLAIM_REQUIRED: 409,
  TICKET_NOT_CLAIMABLE: 409,
  TICKET_NOT_HUMAN_OWNED: 409,
  DEPENDENCY_BLOCKED: 409,
  AGENT_NOT_ELIGIBLE: 409,
  SCOPE_NODE_IN_USE: 409,
  REPO_NOT_LINKED: 409,
  // Conflicts with recorded state: the contract changed since the tester started, the
  // observed risk outgrew the auto-ship ceiling, a role owns this move, a bundle or
  // target DB does not fit.
  CONTRACT_MISMATCH: 409,
  OBSERVED_RISK_ESCALATED: 409,
  FACTORY_RUNNER_OWNED: 409,
  DB_NOT_EMPTY: 409,
  // CLI-only today: an implicit DB path with no database, an id prefix matching several.
  DB_NOT_FOUND: 404,
  AMBIGUOUS_REF: 409,
  INCOMPATIBLE_BUNDLE: 409,
  INCONSISTENT_BUNDLE: 409,
  ACTOR_NOT_PERMITTED: 403,
  NOT_CONFIGURED: 503,
  // Genuine server-side failures (UNSAFE_BIND is startup-only).
  IO_ERROR: 500,
  UNSAFE_BIND: 500,
  INTERNAL_ERROR: 500,
};

/** Map a stable DispatchError code to an HTTP status (500 for an unknown code). */
export function statusForCode(code: string): number {
  return (STATUS_FOR_CODE as Record<string, number | undefined>)[code] ?? 500;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Readonly<Record<string, unknown>> };
}

// M2: `details` is Readonly so a caller can hand us a Readonly source (e.g.
// DispatchError.details) without a misleading `as Record<string, unknown>` cast.
export function errorBody(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorBody {
  return details && Object.keys(details).length > 0
    ? { error: { code, message, details } }
    : { error: { code, message } };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Emit a 201 Created with a `Location` header pointing at the canonical URL of
 * the resource just created (M5). The header is set before {@link sendJson}'s
 * writeHead so Node merges it with the content-type/length headers.
 */
export function sendCreated(res: ServerResponse, location: string, payload: unknown): void {
  res.setHeader("Location", location);
  sendJson(res, 201, payload);
}

/** Read and JSON-parse a request body. Empty bodies resolve to `{}`. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BYTES = 1_000_000;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BYTES) {
      // Stop consuming an over-limit (possibly hostile/unbounded) upload before
      // rejecting — draining it to the end would read attacker-controlled data, and
      // leaving it undrained resets the keep-alive connection. Destroy the stream so
      // the socket closes deterministically instead of dangling mid-read.
      req.destroy();
      throw new DispatchError("VALIDATION_ERROR", "Request body too large.");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DispatchError("VALIDATION_ERROR", "Request body is not valid JSON.");
  }
}

/** Translate a thrown error into a structured JSON response. */
export function handleError(res: ServerResponse, err: unknown): void {
  if (err instanceof z.ZodError) {
    sendJson(
      res,
      422,
      errorBody("VALIDATION_ERROR", "Invalid request payload.", {
        issues: toZod3Issues(err.issues),
      }),
    );
    return;
  }
  if (err instanceof DispatchError) {
    sendJson(res, statusForCode(err.code), errorBody(err.code, err.message, err.details));
    return;
  }
  // M3: never leak an unexpected error's message to the client. Log it
  // server-side for diagnosis and return a fixed, generic 500 body.
  console.error("[dispatch-api] Unhandled internal error:", err);
  sendJson(res, 500, errorBody("INTERNAL_ERROR", "An unexpected internal error occurred."));
}

export function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, errorBody("METHOD_NOT_ALLOWED", "Method not allowed for this route."));
}

/** Percent-decode a path segment, returning null on a malformed sequence. */
export function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
