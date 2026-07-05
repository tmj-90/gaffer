import type { IncomingMessage, ServerResponse } from "node:http";

import { DispatchError } from "../util/errors.js";

/**
 * Bind-safety, DNS-rebinding, and security-header helpers for the REST surface.
 * Extracted from server.ts unchanged (a pure move) so the request handler and
 * the bin layer share one copy of the network-safety logic.
 */

/** Default port; overridden by DISPATCH_API_PORT / --port at the bin layer. */
export const DEFAULT_API_PORT = 8787;

/**
 * Loopback hosts the API may bind to with no opt-in. Anything else exposes the
 * unauthenticated API to other machines, so it requires {@link assertSafeBind}'s
 * explicit override. `0.0.0.0` / `::` (wildcard binds) are deliberately absent.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/** Normalise a host for loopback comparison: trim, lowercase, strip `[]` and a `%zone`. */
function normaliseHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
}

/** True when `host` is a loopback address the API may bind to without opt-in. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normaliseHost(host));
}

/**
 * Extract the hostname from a `Host` (`host[:port]`) or `Origin`
 * (`scheme://host[:port]`) header value, normalised for comparison. Returns
 * `undefined` for an empty or unparseable value so the caller can treat it as
 * disallowed.
 */
function headerHostname(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Origin carries a scheme; a bare Host does not — synthesise one so the URL
  // parser can split host from port (and reject a garbage value).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return normaliseHost(new URL(withScheme).hostname);
  } catch {
    return undefined;
  }
}

/**
 * Extra hostnames the Host/Origin check accepts, from `DISPATCH_ALLOWED_HOSTS`
 * (comma-separated). For deployments fronted by a reverse proxy or a DNS name,
 * where the original `Host` the client sent never byte-equals the bind host.
 * Parsed defensively: entries are trimmed, normalised via {@link normaliseHost}
 * (lowercase, `[]`/`%zone` stripped, a `:port` suffix dropped via
 * {@link headerHostname}), and empties ignored. Read per request — consistent
 * with how the bearer token is resolved — so tests and embedders can adjust it
 * without rebuilding the handler.
 */
function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = (env.DISPATCH_ALLOWED_HOSTS ?? "").trim();
  if (raw === "") return new Set();
  const hosts = raw
    .split(",")
    .map((entry) => headerHostname(entry) ?? "")
    .filter((h) => h !== "");
  return new Set(hosts);
}

/**
 * DNS-rebinding defense for TOKENLESS requests. A browser page served from an
 * attacker origin that has rebound its DNS to 127.0.0.1 can reach the local
 * API, but the browser still sends the attacker's own `Host`/`Origin`. We
 * refuse any request whose `Host` (or, when present, `Origin`) names a host
 * other than the bound host, a loopback alias, or an operator-allowlisted
 * hostname (`DISPATCH_ALLOWED_HOSTS`, for proxy/DNS fronting) — so a rebound
 * foreign page can't read local control state on the tokenless loopback read
 * path. Non-browser clients (curl, the runner) that omit both headers are
 * unaffected.
 *
 * The route layer only consults this check for requests WITHOUT a valid bearer
 * token, and exempts `/healthz`: a browser cannot attach the bearer token
 * cross-origin, so a valid token proves the caller is legitimate (and health
 * probes carry arbitrary `Host` headers and expose no state). The bearer token
 * remains the real auth mechanism; this only closes the browser-rebinding hole.
 */
export function isHostHeaderAllowed(req: IncomingMessage, bindHost: string): boolean {
  const boundHostNormalised = normaliseHost(bindHost);
  const extraAllowed = allowedHostsFromEnv();
  const allowed = (host: string | undefined): boolean =>
    host !== undefined &&
    (isLoopbackHost(host) || host === boundHostNormalised || extraAllowed.has(host));

  const rawHost = req.headers.host;
  if (rawHost !== undefined) {
    const hostValue = Array.isArray(rawHost) ? (rawHost[0] ?? "") : rawHost;
    if (!allowed(headerHostname(hostValue))) return false;
  }

  const rawOrigin = req.headers.origin;
  // A literal "null" Origin (sandboxed iframe, file://) carries no usable host —
  // reject it like any other non-matching origin.
  if (rawOrigin !== undefined) {
    const originValue = Array.isArray(rawOrigin) ? (rawOrigin[0] ?? "") : rawOrigin;
    if (!allowed(headerHostname(originValue))) return false;
  }

  return true;
}

/**
 * Guard against silently exposing the unauthenticated API on a public interface.
 *
 * The REST API has no authentication unless `DISPATCH_API_TOKEN` is set, and no
 * per-role RBAC yet (see the module note above), so binding to a non-loopback host
 * can put the whole control plane on the network for any reachable client when no
 * token is configured. This refuses such binds unless the operator explicitly
 * opts in via `--unsafe-bind` / `DISPATCH_UNSAFE_BIND=1`. Loopback binds
 * (127.0.0.1 / ::1 / localhost) are always allowed.
 *
 * Pure check — it never opens a socket. Throws {@link DispatchError} so callers
 * get a stable `UNSAFE_BIND` code and a message that explains the risk + override.
 *
 * @throws {DispatchError} code `UNSAFE_BIND` when binding a non-loopback host
 *   without the opt-in.
 */
export function assertSafeBind(
  host: string,
  unsafeBindOptIn: boolean,
  authConfigured = false,
): void {
  // A configured bearer token makes the API safe to expose: every non-public
  // request must then authenticate, so a non-loopback bind no longer hands the
  // control plane to anyone who can reach the interface.
  if (isLoopbackHost(host) || unsafeBindOptIn || authConfigured) return;
  throw new DispatchError(
    "UNSAFE_BIND",
    `Refusing to bind the Dispatch API to non-loopback host "${host}": the REST API ` +
      `has no authentication configured, so this would expose the full control plane ` +
      `to any client that can reach this interface. Bind to a loopback address ` +
      `(127.0.0.1, ::1, or localhost), set DISPATCH_API_TOKEN to require a bearer ` +
      `token, or, if you accept the risk, re-run with --unsafe-bind ` +
      `(DISPATCH_UNSAFE_BIND=1).`,
    { host },
  );
}

// --- Security response headers (P1-C) --------------------------------------

/**
 * Content-Security-Policy for the dashboard. Scripts are `'self'` ONLY — the SPA
 * loads a single external module (`/app.js`), so no inline-script allowance is
 * needed (and none is granted: an injected inline `<script>` is refused).
 *
 * `style-src` permits `'unsafe-inline'` + the Google Fonts stylesheet origin
 * because the shell uses an inline `style=""` attribute (the hidden SVG sprite)
 * and `app.js` sets element styles via innerHTML; `font-src` allows the Google
 * Fonts file origin. These style/font origins are a deliberate, reviewed
 * deviation from a bare `default-src 'self'` policy so the SPA's typography
 * keeps working — they do NOT relax `script-src`.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Apply baseline security headers to every response. Called once at the top of
 * the request handler so it covers static assets, JSON API responses, and error
 * paths alike. HSTS is emitted ONLY for a non-loopback bind: on plain-HTTP
 * loopback (the default dev posture) a `Strict-Transport-Security` header would
 * wrongly pin the browser to HTTPS for `localhost`.
 *
 * `loopbackBind` is resolved once at server-construction time from the bind host,
 * not per request, so a spoofed `Host:` header can't toggle HSTS.
 */
export function applySecurityHeaders(res: ServerResponse, loopbackBind: boolean): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (!loopbackBind) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}
