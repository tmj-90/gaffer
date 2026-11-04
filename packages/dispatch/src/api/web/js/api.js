// API client: the bearer token helpers and api(), the one door to the REST API.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import {
  ADMIN_TITLE,
  READ_ONLY_TITLE,
  readOnly,
  scopeRefuses,
  scopeTitle,
  scoped,
} from "./access.js";
import { learnDisplaysFrom, squad } from "./club.js";
import { learnKits } from "./icons.js";
import { renderLogin } from "./login.js";
import { freshness } from "../app.js";
// --- API client ------------------------------------------------------------

// Bearer token (set when the server enforces DISPATCH_API_TOKEN). Stored in
// localStorage so it survives reloads; sent on every API call. Empty = no auth.
const TOKEN_KEY = "wg_api_token";
const authToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setAuthToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearAuthToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * One-scan phone access (AFK-LOOP P3). `gaffer dashboard --lan` prints a QR of
 * `http://LAN:PORT/?token=…`; when a scan lands here with that param we adopt
 * the token and immediately scrub it from the URL (history + query) so it never
 * lingers in browser history. A malformed URL must never block boot — the login
 * gate is always the safe fallback.
 */
function adoptTokenFromUrl() {
  try {
    const params = new URLSearchParams(location.search || "");
    const t = params.get("token");
    if (!t) return;
    setAuthToken(t.trim());
    params.delete("token");
    const qs = params.toString();
    history.replaceState(
      null,
      "",
      location.pathname + (qs ? `?${qs}` : "") + (location.hash || ""),
    );
  } catch {
    // Ignore — fall through to the normal (paste-a-token) login gate.
  }
}

/**
 * Call the Dispatch REST API. Resolves to the parsed JSON body on 2xx.
 * On a non-2xx response it throws an Error carrying the API error envelope
 * ({ error: { code, message } }) so callers can surface it to the user.
 * A 401 means the server requires a token — render the login gate and stop.
 *
 * Honest failure modes: a network failure or timeout becomes code NETWORK with
 * one plain sentence (never the browser's raw "Failed to fetch"); a non-JSON
 * body (a proxy's HTML error page) becomes BAD_GATEWAY instead of a SyntaxError.
 * Every outcome is reported to the freshness tracker that drives the header's
 * "Data as of" line. `opts.signal` lets the router abort a superseded view's
 * reads; an aborted call (in the fetch or while its body is read) rejects with
 * code ABORTED and is never toasted.
 */
const API_GET_TIMEOUT_MS = 15000;
/** A fetch or body read that failed: ABORTED when the caller's signal superseded it, else NETWORK. */
function unreachable(cause, signal) {
  if (signal && signal.aborted) {
    const e = new Error("Superseded");
    e.code = "ABORTED";
    return e;
  }
  freshness.fail("network");
  const e = new Error("Can't reach the factory — retrying.");
  e.code = "NETWORK";
  e.cause = cause;
  return e;
}
async function api(method, path, body, opts = {}) {
  // A read token changes nothing: the server refuses every non-GET with 403
  // READ_ONLY_TOKEN, so the page never sends one (a control that slipped through
  // gets this refusal at once, and the console no 403). A write sent before the
  // capability is known waits for whoami first.
  if (method !== "GET" && method !== "HEAD") {
    if (!squad.capability && squad.loaded) await squad.loaded.catch(() => null);
    if (readOnly()) {
      const e = new Error(READ_ONLY_TITLE);
      e.code = "READ_ONLY_TOKEN";
      e.status = 403;
      throw e;
    }
  }
  // A scoped token (a principal with a repo or ticket scope) sees only its tickets:
  // the server refuses a factory-wide read or write with 403 SCOPE_DENIED, so the page
  // never sends one (the view shows what it has; a control that slipped through gets
  // this refusal at once, and the console no 403). Likewise a repository-level write
  // by a principal that is not an admin.
  if (scopeRefuses(method, path)) {
    const e = new Error(scoped() ? scopeTitle() : ADMIN_TITLE);
    e.code = "SCOPE_DENIED";
    e.status = 403;
    throw e;
  }
  const headers = body !== undefined ? { "content-type": "application/json" } : {};
  const tok = authToken();
  if (tok) headers["authorization"] = "Bearer " + tok;
  const signals = [];
  if (opts.signal) signals.push(opts.signal);
  // Reads time out; writes may legitimately run long (spawns, merges) and do not.
  if (method === "GET" && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    signals.push(AbortSignal.timeout(opts.timeoutMs || API_GET_TIMEOUT_MS));
  }
  const signal =
    signals.length > 1 && typeof AbortSignal.any === "function"
      ? AbortSignal.any(signals)
      : signals[0];
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (cause) {
    throw unreachable(cause, opts.signal);
  }
  if (res.status === 401) {
    freshness.fail("auth");
    renderLogin(Boolean(tok)); // tok present + still 401 ⇒ wrong token
    const e = new Error("Authentication required");
    e.code = "UNAUTHORIZED";
    throw e;
  }
  // The body can still be aborted after the headers arrive (the router superseding
  // the view, or the read timing out): Chromium then rejects res.text() with a raw
  // DOMException (AbortError, numeric code 20), which slipped past every ABORTED
  // check and was toasted as "20 The user aborted a request.".
  let text;
  try {
    text = await res.text();
  } catch (cause) {
    throw unreachable(cause, opts.signal);
  }
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      freshness.fail("network");
      const e = new Error(`The factory answered ${res.status} with a page that isn't data.`);
      e.code = "BAD_GATEWAY";
      throw e;
    }
  }
  // Any parsed answer from the server — even a 4xx refusal — proves it is up.
  freshness.ok();
  if (!res.ok) {
    const err =
      data && data.error ? data.error : { code: String(res.status), message: res.statusText };
    const e = new Error(err.message || "Request failed");
    e.code = err.code;
    // The HTTP status rides along: callers test it (a ticket's 404) and the
    // error page shows it; it was never set, so `e.status === 404` never matched.
    e.status = res.status;
    // The envelope's details (a 409's holder, a 422's field) for an inline message.
    if (err.details !== undefined) e.details = err.details;
    throw e;
  }
  if (data && Array.isArray(data.repositories))
    learnKits(data.repositories.map((r) => r && r.name));
  // Any payload that carries the server's agent_display refreshes the squad map.
  if (data && typeof data === "object") learnDisplaysFrom(data);
  return data;
}

export { authToken, setAuthToken, clearAuthToken, adoptTokenFromUrl, api };
