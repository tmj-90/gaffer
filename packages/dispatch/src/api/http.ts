import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { DispatchError } from "../util/errors.js";

/**
 * Shared HTTP primitives + error mapping for the REST surface. Extracted from
 * server.ts so the per-resource route modules under ./routes share ONE copy of
 * the request/response helpers (no behaviour change — a pure move).
 */

/** Map a stable DispatchError code to an HTTP status. */
export function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_ERROR":
      return 422;
    case "POLICY_DENIED":
      return 400;
    case "STATE_CONFLICT":
    case "CONCURRENCY_CONFLICT":
    case "ILLEGAL_TRANSITION":
    case "NO_OP":
    case "DUPLICATE":
    case "CLAIM_INVALID":
    case "CLAIM_REQUIRED":
    case "TICKET_NOT_CLAIMABLE":
    case "TICKET_NOT_HUMAN_OWNED":
    case "DEPENDENCY_BLOCKED":
    case "AGENT_NOT_ELIGIBLE":
    case "SCOPE_NODE_IN_USE":
    case "REPO_NOT_LINKED":
      return 409;
    case "INVALID_EDGE":
    case "INVALID_DEPENDENCY":
    case "ADVANCED_RELATION_REQUIRED":
      return 422;
    case "ACTOR_NOT_PERMITTED":
      return 403;
    case "NOT_CONFIGURED":
      return 503;
    default:
      return 500;
  }
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
      errorBody("VALIDATION_ERROR", "Invalid request payload.", { issues: err.issues }),
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
