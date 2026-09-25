/**
 * Notify-sink URL policy — the outbound channel must not become an SSRF primitive.
 *
 * The webhook / Slack sinks POST to a URL the operator configures. That URL is
 * also editable from the dashboard settings panel, so anyone holding the
 * dashboard token could aim the factory's outbound POSTs at a loopback service
 * (the dispatch API itself, a local DB admin), a link-local metadata endpoint
 * (169.254.169.254), or a private-range host. Body redaction (the default)
 * limits what LEAVES, but not where the request LANDS. This module decides
 * which URLs a sink may be built from:
 *
 *   - scheme must be http: or https: (no file:, ftp:, data:, gopher:, …);
 *   - the host must not be loopback, link-local, unspecified, or a private
 *     range (RFC 1918 / RFC 4193 / CGNAT), NOR `localhost`, unless the operator
 *     opts in with `GAFFER_NOTIFY_ALLOW_PRIVATE=1` (a self-hosted Slack relay on
 *     the LAN is a legitimate setup — it is a conscious choice, not the default).
 *
 * Hostnames are checked lexically (no DNS): a public hostname that RESOLVES to a
 * private address is out of scope for a policy that must stay pure and fast —
 * the operator owns their resolver. IP literals (v4, v6, v4-mapped v6) are
 * classified exactly.
 */

export interface NotifyUrlPolicyOptions {
  /** Permit loopback / link-local / private-range / `localhost` destinations. */
  readonly allowPrivate?: boolean;
}

/**
 * Returns `null` when `raw` is an acceptable sink URL, otherwise a short,
 * operator-facing reason. Never throws.
 */
export function notifyUrlProblem(raw: string, opts: NotifyUrlPolicyOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `scheme ${url.protocol.replace(/:$/, "")} is not allowed (http/https only)`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return "URL has no host";
  if (opts.allowPrivate === true) return null;
  const why = privateHostReason(host);
  return why === null
    ? null
    : `${why} destinations are refused unless GAFFER_NOTIFY_ALLOW_PRIVATE=1`;
}

/** True when the environment opts into private/loopback notify destinations. */
export function notifyAllowsPrivate(env: NodeJS.ProcessEnv): boolean {
  const v = (env.GAFFER_NOTIFY_ALLOW_PRIVATE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Classify a lower-cased hostname; `null` when it is not a private/local destination. */
export function privateHostReason(host: string): string | null {
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const v4 = parseIPv4(host);
  if (v4) return classifyV4(v4);
  if (host.includes(":")) {
    // IPv6 literal (brackets already stripped). Handle v4-mapped first — WHATWG URL
    // parsing (Node's `URL`) normalises `::ffff:127.0.0.1` to the hex form
    // `::ffff:7f00:1`, so accept both spellings.
    const mappedDotted = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
    if (mappedDotted) {
      const inner = parseIPv4(mappedDotted[1] ?? "");
      return inner ? classifyV4(inner) : "unparseable";
    }
    const mappedHex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1] ?? "0", 16);
      const lo = parseInt(mappedHex[2] ?? "0", 16);
      return classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    const compact = host.replace(/(^|:)0+(?=[0-9a-f])/g, "$1");
    if (/^(0*:)+0*$/.test(host) || host === "::") return "unspecified";
    if (compact === "::1" || /^(0*:)+0*1$/.test(host)) return "loopback";
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return "link-local";
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return "private-range (unique local)";
    return null;
  }
  return null;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((p) => Number(p));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

function classifyV4([a, b]: [number, number, number, number]): string | null {
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "private-range";
  if (a === 172 && b >= 16 && b <= 31) return "private-range";
  if (a === 192 && b === 168) return "private-range";
  if (a === 100 && b >= 64 && b <= 127) return "private-range (CGNAT)";
  return null;
}
