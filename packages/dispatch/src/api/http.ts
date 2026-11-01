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
  // A request body over the limit (readJsonBody).
  PAYLOAD_TOO_LARGE: 413,
  INVALID_EDGE: 422,
  INVALID_DEPENDENCY: 422,
  ADVANCED_RELATION_REQUIRED: 422,
  // A payload the gate refuses on its content: the contract names the implementation,
  // or an acceptance PASS is not bound to what was tested.
  TEST_CONTRACT_LEAK: 422,
  BINDING_REQUIRED: 422,
  POLICY_DENIED: 400,
  STATE_CONFLICT: 409,
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

/** A strict decoder: a body that is not valid UTF-8 throws instead of turning into U+FFFD. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The largest request body the REST surface reads (bytes). */
export const MAX_BODY_BYTES = 1_000_000;
/**
 * How much of an over-limit upload is read (and thrown away) before the 413 is
 * written, so the client has finished sending when the answer arrives instead of
 * getting a reset; past this the socket is destroyed.
 */
const OVERFLOW_DRAIN_BYTES = 16 * MAX_BODY_BYTES;
/** How long a refused upload may go quiet before the 413 is written anyway. */
const DRAIN_IDLE_MS = 5000;

/**
 * Read and JSON-parse a request body. Empty bodies resolve to `{}`.
 *
 * A body over {@link MAX_BODY_BYTES} throws PAYLOAD_TOO_LARGE (a JSON 413). The
 * stream used to be destroyed before the throw, so the answer was never sent and
 * every client saw a reset connection. Now nothing more is kept: the rest of the
 * upload is read and discarded, up to {@link OVERFLOW_DRAIN_BYTES} (then the socket
 * is destroyed), BEFORE the 413 goes out with `connection: close`, so the close
 * never races the client's own writes and the socket is never reused mid-upload.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  // destroyOnReturn: false — leaving the loop early must not destroy the request
  // (that resets the socket before the 413 is written). The loop is left first so
  // the iterator releases the stream; only then can the drain below read from it.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      overflow = true;
      break;
    }
    chunks.push(buf);
  }
  if (overflow) {
    await discardRest(req, size);
    throw new DispatchError(
      "PAYLOAD_TOO_LARGE",
      `Request body too large (the limit is ${MAX_BODY_BYTES} bytes).`,
      { limit_bytes: MAX_BODY_BYTES },
    );
  }
  if (chunks.length === 0) return {};
  // Fatal decoding: invalid UTF-8 is refused, never stored lossily as U+FFFD.
  let raw: string;
  try {
    raw = UTF8.decode(Buffer.concat(chunks)).trim();
  } catch {
    throw new DispatchError("VALIDATION_ERROR", "Request body is not valid UTF-8.");
  }
  if (raw === "") return {};
  let parsed: unknown;
  // JSON's \uD800-style escapes can spell half a surrogate pair in valid UTF-8 bytes;
  // stored, it turns into U+FFFD just like an invalid byte, so it is refused the same way.
  let unpaired = false;
  try {
    parsed = JSON.parse(raw, (key: string, value: unknown) => {
      if (LONE_SURROGATE.test(key) || (typeof value === "string" && LONE_SURROGATE.test(value)))
        unpaired = true;
      return value;
    });
  } catch {
    throw new DispatchError("VALIDATION_ERROR", "Request body is not valid JSON.");
  }
  if (unpaired) {
    throw new DispatchError(
      "VALIDATION_ERROR",
      "Request body is not valid UTF-8 (a \\u escape names half a surrogate pair).",
    );
  }
  return parsed;
}

/** A UTF-16 surrogate that is not half of a pair (the `u` flag reads a pair as one code point). */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Read the body of a route that takes none (ready-approval, mono-fallback, POST
 * /plan-sessions): empty or `{}`. It goes through {@link readJsonBody} like every
 * other body, so broken JSON, invalid UTF-8 or an over-limit upload is refused, and
 * a field is a 422 instead of being silently ignored.
 */
export async function readNoBody(req: IncomingMessage): Promise<void> {
  NO_BODY.parse(await readJsonBody(req));
}
const NO_BODY = z.object({}).strict();

/** Keep reading an over-limit upload into nothing, up to a bound, then cut it off. */
function discardRest(req: IncomingMessage, seen: number): Promise<void> {
  // Resolve only once the upload has ended (or the drain cap is hit, or the client
  // has gone quiet for DRAIN_IDLE_MS). Writing the 413 before the client has finished
  // sending makes the close race the client's writes: on macOS the client then sees
  // EPIPE/ECONNRESET instead of the answer, where Linux buffers enough to hide it.
  return new Promise<void>((resolve) => {
    let read = seen;
    let done = false;
    let idle: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      req.off("data", onData);
      resolve();
    };
    const armIdle = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, DRAIN_IDLE_MS);
      idle.unref();
    };
    const onData = (b: Buffer): void => {
      read += b.length;
      if (read > OVERFLOW_DRAIN_BYTES) {
        req.destroy();
        finish();
        return;
      }
      armIdle();
    };
    req.on("data", onData);
    req.once("end", finish);
    req.once("close", finish);
    req.on("error", finish);
    armIdle();
    req.resume();
  });
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
    // The rest of an over-limit upload is never read, so this socket is not reused.
    if (err.code === "PAYLOAD_TOO_LARGE" && !res.headersSent) res.setHeader("connection", "close");
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
