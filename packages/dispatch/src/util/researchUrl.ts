/**
 * The research agent's URL rules, dispatch's twin of runner/lib/hook/url-rules.mjs
 * (backlog 69, protection B). Dispatch cannot import runner code synchronously, so, as
 * with the quarantine escapers (util/untrusted.ts and runner/lib/untrusted.mjs), the two
 * languages each carry the rules and both run ONE vector file:
 * runner/test/fixtures/research-url-vectors.json (test/research-url-rules.test.ts here,
 * runner/test/research-url-rules.test.mjs there). Used when a research run is stored
 * (every source URL re-checked; a failing one dropped) and by the read model (a source
 * is shown as a link only when it passes). PURE: no network, no environment.
 *
 * The rule text below is the runner module's, typed; change both together.
 */

export interface UrlRefusal {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}
export type UrlVerdict = UrlRefusal | { readonly ok: true; readonly url: string; readonly host: string };

/** The whole URL, in bytes (UTF-8). Real pages: see URL_MAX_EVIDENCE. */
export const URL_MAX = 512;
/** The query string after `?`, in bytes. */
export const QUERY_MAX = 200;
/** A WebSearch query, in characters. */
export const SEARCH_QUERY_MAX = 200;
/** A WebSearch allowed_domains / blocked_domains list. */
export const SEARCH_DOMAINS_MAX = 10;
// URL_MAX_EVIDENCE: the 40 ordinary pages in the vector file (docs, blogs, pricing
// pages, GitHub repositories and files, package pages, forums, search-result shapes)
// are 19 to 117 bytes long, the longest query among them 61. A deep GitHub blob URL
// with a long path is about 160, an arXiv or a docs page with an anchor under 120.
// 512 is over four times the longest ordinary page and still bounds how much of the
// idea can leave in one URL; 200 for the query is three times the longest seen, and
// leaves pagination, a search term and a sort order room while a page of prose cannot
// ride in it. Both are constants: a knob could only loosen them.

/** Host labels and path segments that are an authentication or account step. */
export const AUTH_WORDS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    "login",
    "log-in",
    "log_in",
    "logon",
    "log-on",
    "signin",
    "sign-in",
    "sign_in",
    "signon",
    "sign-on",
    "signup",
    "sign-up",
    "sign_up",
    "register",
    "registration",
    "join",
    "enroll",
    "enrol",
    "onboarding",
    "auth",
    "authn",
    "authenticate",
    "authentication",
    "oauth",
    "oauth2",
    "sso",
    "saml",
    "saml2",
    "openid",
    "oidc",
    "authorize",
    "authorise",
    "authorization",
    "consent",
    "account",
    "accounts",
    "myaccount",
    "my-account",
    "password",
    "passwd",
    "forgot",
    "forgot-password",
    "reset",
    "reset-password",
    "recover",
    "recovery",
    "verify",
    "verification",
    "confirm",
    "activate",
    "activation",
    "2fa",
    "mfa",
    "otp",
    "checkout",
    "cart",
    "basket",
    "billing",
    "payment",
    "payments",
    "pay",
    "subscribe",
    "unsubscribe",
    "subscription",
    "subscriptions",
    "admin",
    "administrator",
    "wp-admin",
    "wp-login",
    "logout",
    "log-out",
    "signout",
    "sign-out",
    "session",
    "sessions",
    "cpanel",
    "webmail",
  ]),
);

/** Query parameter names that carry a credential, a session or an auth flow. */
export const CREDENTIAL_PARAMS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    "token",
    "access_token",
    "id_token",
    "refresh_token",
    "auth",
    "auth_token",
    "authtoken",
    "authorization",
    "key",
    "api_key",
    "apikey",
    "api-key",
    "secret",
    "client_secret",
    "client_id",
    "redirect_uri",
    "response_type",
    "password",
    "passwd",
    "pwd",
    "pass",
    "session",
    "sessionid",
    "session_id",
    "sid",
    "jsessionid",
    "phpsessid",
    "code",
    "state",
    "nonce",
    "signature",
    "sig",
    "jwt",
    "credential",
    "credentials",
    "otp",
    "ticket",
    "samlrequest",
    "samlresponse",
    "relaystate",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "private_token",
    "oauth_token",
    "oauth_verifier",
    "access_key",
    "accesskey",
  ]),
);

/** Names that never leave a machine or a private network (the host or a suffix of it). */
export const INTERNAL_SUFFIXES = Object.freeze([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "home.arpa",
  "arpa",
  "corp",
  "private",
  "test",
  "invalid",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "onion",
  "i2p",
  "alt",
]);

/** Cloud metadata endpoints by name (their addresses are refused as IP literals too). */
export const METADATA_HOSTS = Object.freeze([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data.ec2.internal",
  "metadata.platformequinix.com",
  "metadata.packet.net",
  "metadata.tencentyun.com",
]);

/** Wildcard DNS services that answer with the address written in the name. */
export const REBINDING_SUFFIXES = Object.freeze([
  "nip.io",
  "sslip.io",
  "xip.io",
  "nip.direct",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "traefik.me",
  "1u.ms",
  "rebind.it",
  "rbndr.us",
  "localho.st",
  "fbi.com",
]);

const FILE_EXTENSION = /\.(?:php[0-9]?|html?|aspx?|jspx?|cgi|do|action|pl|cfm)$/;
// Whitespace, C0/C1 controls, DEL, the bidi overrides and isolates, zero-width marks.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿\\]/u;

/** Known credential shapes, anywhere. */
const SECRET_PREFIXES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
];

/**
 * True when `value` looks like a secret: a known credential prefix, or one opaque run
 * of 32 or more URL-safe characters that mixes letters and digits (a session id, an API
 * key, a signed blob). A plain long word or a slug with dashes between words is not.
 */
export function secretLike(value: unknown): boolean {
  const s = String(value ?? "");
  if (SECRET_PREFIXES.some((re) => re.test(s))) return true;
  for (const run of s.match(/[A-Za-z0-9_+/=.-]{32,}/g) ?? []) {
    const letters = /[A-Za-z]/.test(run);
    const digits = (run.match(/[0-9]/g) ?? []).length;
    // A slug of words (`how-to-build-a-thing-in-ten-minutes`) has dashes every few
    // letters; an opaque token has long runs without one.
    const longestWord = Math.max(...run.split(/[-_.]/).map((w) => w.length));
    if (letters && digits >= 4 && longestWord >= 24) return true;
    // A long hex run (a key, a digest of a secret) with both digits and letters in it.
    if (/^[A-Fa-f0-9]{40,}$/.test(run) && digits >= 8 && /[A-Fa-f]/.test(run)) return true;
  }
  return false;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function refuse(code: string, reason: string): UrlRefusal {
  return { ok: false, code, reason };
}

/** Does `host` equal `suffix` or end with `.suffix`? */
function underSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The verdict on one host name (already lowercased ASCII, no port). Returns null when
 * it passes, else a refusal. Shared by the URL check and WebSearch's domain lists.
 */
export function hostRefusal(host: string): UrlRefusal | null {
  if (typeof host !== "string" || host === "") return refuse("host", "no host");
  if (host.startsWith("[") || host.includes(":")) {
    return refuse("ip-literal", `the host is an IPv6 literal (${host})`);
  }
  if (host.endsWith(".")) return refuse("host", `the host ends with a dot (${host})`);
  if (utf8Bytes(host) > 253) return refuse("host", "the host is longer than 253 characters");
  const labels = host.split(".");
  if (labels.length < 2) {
    return refuse("single-label", `a single-label host never leaves a network (${host})`);
  }
  const top = labels[labels.length - 1] ?? "";
  if (/^[0-9]+$/.test(top) || /^0x[0-9a-f]*$/i.test(top)) {
    return refuse("ip-literal", `the host is an IP address (${host})`);
  }
  if (labels.every((l) => /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(l))) {
    return refuse("ip-literal", `the host is an IP address (${host})`);
  }
  for (const label of labels) {
    if (!/^[a-z0-9-]{1,63}$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return refuse("host", `the host label "${label}" is not a DNS label`);
    }
    if (label.startsWith("xn--")) {
      return refuse(
        "idn",
        `internationalised (punycode) host refused: look-alike letters cannot be told apart by reading it (${host})`,
      );
    }
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(top)) {
    return refuse("host", `the top-level label "${top}" is not a public top-level domain`);
  }
  for (const suffix of INTERNAL_SUFFIXES) {
    if (underSuffix(host, suffix)) {
      return refuse("internal-name", `"${host}" is a name that never leaves a machine or network`);
    }
  }
  for (const m of METADATA_HOSTS) {
    if (underSuffix(host, m)) return refuse("metadata", `"${host}" is a cloud metadata name`);
  }
  for (const suffix of REBINDING_SUFFIXES) {
    if (underSuffix(host, suffix)) {
      return refuse("rebinding", `"${host}" is a wildcard DNS service that answers with any address`);
    }
  }
  // An address written into a name (`10.0.0.1.example.org`, `127-0-0-1.example.org`).
  if (/(?:^|\.)(?:[0-9]{1,3}[.-]){3}[0-9]{1,3}(?:\.|$)/.test(host)) {
    return refuse("ip-literal", `the host carries an IP address in its name (${host})`);
  }
  for (const label of labels) {
    if (AUTH_WORDS.has(label)) {
      return refuse("auth-step", `the host label "${label}" is a login, sign-up or account step`);
    }
  }
  return null;
}

/** The authority part of an `https://` text: up to the first `/`, `?` or `#`. */
function rawAuthority(text: string): string {
  const rest = text.slice("https://".length);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The verdict on one URL the research agent wants to fetch or reports as a source.
 * Returns `{ ok: true, url, host }` (url is the WHATWG-serialised form) or
 * `{ ok: false, code, reason }`.
 */
export function checkResearchUrl(raw: unknown): UrlVerdict {
  if (typeof raw !== "string" || raw === "") return refuse("input", "the URL is missing");
  if (utf8Bytes(raw) > URL_MAX) {
    return refuse("length", `the URL is ${utf8Bytes(raw)} bytes; the cap is ${URL_MAX}`);
  }
  if (FORBIDDEN_CHARS.test(raw)) {
    return refuse(
      "input",
      "the URL holds whitespace, a control, bidirectional or zero-width character, or a backslash",
    );
  }
  if (!/^https:\/\//i.test(raw)) {
    const scheme = (raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):/) ?? [])[1];
    return refuse(
      "scheme",
      scheme
        ? `only https: URLs are fetched (this one is ${scheme.toLowerCase()}:)`
        : "only absolute https:// URLs are fetched",
    );
  }
  const authority = rawAuthority(raw);
  if (authority.includes("@")) return refuse("userinfo", "credentials in the URL are refused");
  if (authority.startsWith("[")) return refuse("ip-literal", "the host is an IPv6 literal");
  if (authority.includes("%")) return refuse("host", "percent-encoding in the host is refused");
  if (authority.includes(":")) return refuse("port", "an explicit port is refused (default only)");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return refuse("parse", "the URL does not parse");
  }
  if (u.protocol !== "https:") return refuse("scheme", "only https: URLs are fetched");
  if (u.username !== "" || u.password !== "") {
    return refuse("userinfo", "credentials in the URL are refused");
  }
  if (u.port !== "") return refuse("port", "an explicit port is refused (default only)");
  const hostWhy = hostRefusal(u.hostname);
  if (hostWhy) return hostWhy;
  const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  if (utf8Bytes(query) > QUERY_MAX) {
    return refuse("length", `the query is ${utf8Bytes(query)} bytes; the cap is ${QUERY_MAX}`);
  }
  // Path segments, decoded, as whole words.
  for (const rawSeg of u.pathname.split("/")) {
    if (rawSeg === "") continue;
    let seg: string;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return refuse("parse", "a path segment does not decode");
    }
    seg = seg.toLowerCase();
    if (/[/\\]/.test(seg)) return refuse("parse", "an encoded slash in a path segment is refused");
    const first = seg.split(";")[0] ?? "";
    const bare = first.replace(FILE_EXTENSION, "");
    if (AUTH_WORDS.has(bare) || AUTH_WORDS.has(first)) {
      return refuse(
        "auth-step",
        `the path segment "${seg.slice(0, 60)}" is a login, sign-up or account step`,
      );
    }
  }
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      return refuse("parse", "a query parameter does not decode");
    }
    const n = name.trim().toLowerCase();
    if (
      CREDENTIAL_PARAMS.has(n) ||
      /(?:^|[_.\-[])(?:token|secret|password|passwd|signature|apikey|api_key|credential)(?:[_.\-\]]|$)/.test(
        n,
      )
    ) {
      return refuse("credential-param", `the query parameter "${n.slice(0, 40)}" carries a credential`);
    }
    if (secretLike(value) || secretLike(name)) {
      return refuse("secret", "a query value looks like a secret");
    }
  }
  // A path may carry a long hex id (a commit) or a slug; only a KNOWN credential shape
  // anywhere in the URL is refused (a query value gets the wider secretLike above).
  if (SECRET_PREFIXES.some((re) => re.test(raw))) {
    return refuse("secret", "the URL carries something shaped like a credential");
  }
  return { ok: true, url: u.href, host: u.hostname };
}

