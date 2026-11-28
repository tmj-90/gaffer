/**
 * The research agent's URL rules (backlog 69, protection B). PURE: no network, no
 * filesystem, no environment. The same input always gets the same verdict.
 *
 * Who calls it:
 *   - runner/lib/hook/research.mjs on every WebFetch and WebSearch the research agent
 *     asks for (the safety hook's research role, runner/research-hook.mjs);
 *   - runner/lib/research-result.mjs on every source URL the agent reports;
 *   - dispatch's twin (packages/dispatch/src/util/researchUrl.ts) when it stores a run.
 *     Both run one vector file (runner/test/fixtures/research-url-vectors.json), the way
 *     the two quarantine escapers share theirs.
 *
 * What it decides, in order (the first refusal wins, its `code` names the rule):
 *   input    a string, no whitespace, control, bidi or backslash character anywhere;
 *   length   the whole URL at most URL_MAX bytes, its query at most QUERY_MAX;
 *   scheme   the text itself starts with `https://` (http, file, ftp, data, javascript,
 *            blob, about, ws and every other scheme refused; the tool upgrading http is
 *            never relied on);
 *   authority no `@` (userinfo, `https://good.com@evil.com/`), no `%` (an encoded dot or
 *            slash in the host), no `:` (any explicit port, `:443` included);
 *   host     a public DNS name: at least two labels of [a-z0-9-], none starting or
 *            ending with `-`, an alphabetic top label, no trailing dot, no IDN (`xn--`,
 *            see below), not an IP literal in any spelling (the WHATWG parser turns
 *            decimal, hex, octal and short IPv4 forms into dotted quads and IPv6 into
 *            `[...]`; both are refused, and so is a numeric top label), not a name that
 *            never leaves a machine or a network (INTERNAL_SUFFIXES), not a cloud
 *            metadata name and not a wildcard DNS service that answers with the IP
 *            written in the name (127.0.0.1.nip.io);
 *   auth     no host label and no path segment that is an authentication or account
 *            step (AUTH_WORDS), matched as a WHOLE label or segment (a segment's file
 *            extension and `;params` are dropped first, so `wp-login.php` and
 *            `login;jsessionid=1` count, `how-oauth-works` does not);
 *   query    no parameter whose name is credential-shaped (CREDENTIAL_PARAMS, or any
 *            name with token/secret/password/signature as a word in it), and no value
 *            that looks like a secret (secretLike);
 *   secret   no known credential prefix anywhere in the URL (sk-ant-, ghp_, AKIA, xox?-,
 *            a JWT, a private key header).
 *
 * IDN DECISION: every punycode label (`xn--`) is refused rather than shown decoded. A
 * look-alike host (Cyrillic `аpple.com`) is the standard way to make a person trust the
 * wrong site, and a person reading a research source decides by its host; telling a
 * confusable apart needs the Unicode confusables table, which a decoded display does not
 * apply. The cost: a site whose name is not ASCII cannot be fetched. Its ASCII mirror,
 * or a search result naming the claim elsewhere, can.
 *
 * Not decided here (needs the network): whether the name resolves, and to what. That is
 * research.mjs (where the hook can resolve) and the research egress proxy (docker).
 */

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
export const AUTH_WORDS = Object.freeze(
  new Set([
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
export const CREDENTIAL_PARAMS = Object.freeze(
  new Set([
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
    "pw",
    "passcode",
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
  "localhost.direct",
  "lacolhost.com",
]);

const FILE_EXTENSION = /\.(?:php[0-9]?|html?|aspx?|jspx?|cgi|do|action|pl|cfm)$/;
// Whitespace, C0/C1 controls, DEL, the bidi overrides and isolates, zero-width marks.
const FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\\]/u;

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
export function secretLike(value) {
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

function utf8Bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

function refuse(code, reason) {
  return { ok: false, code, reason };
}

/** Does `host` equal `suffix` or end with `.suffix`? */
function underSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The verdict on one host name (already lowercased ASCII, no port). Returns null when
 * it passes, else a refusal. Shared by the URL check and WebSearch's domain lists.
 */
export function hostRefusal(host) {
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
  const top = labels[labels.length - 1];
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
      return refuse(
        "rebinding",
        `"${host}" is a wildcard DNS service that answers with any address`,
      );
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

/**
 * Is one `;`-separated part of a decoded, lowercased path segment an authentication or
 * account step? The part as written, and its stem: leading and trailing punctuation
 * dropped (`login.`, `login~`, `login%00`), then one file extension of any kind
 * (`login.json`, `wp-login.php`), then the punctuation again.
 */
function segmentIsAuthStep(part) {
  if (AUTH_WORDS.has(part)) return true;
  const trim = (x) => x.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  const stem = trim(
    trim(part)
      .replace(FILE_EXTENSION, "")
      .replace(/\.[a-z0-9]{1,8}$/, ""),
  );
  return AUTH_WORDS.has(stem);
}

/** The credential words a query parameter name may hold as a word of its own. */
const CREDENTIAL_WORD =
  /(?:^|[_.\-[\]\s])(?:token|secret|password|passwd|passcode|signature|apikey|api_key|api-key|authkey|auth|credential|credentials|sessionid)(?:[_.\-[\]\s]|$)/;

/**
 * Is a query parameter name credential-shaped? Judged on the name lowercased, on the name
 * with its array or object brackets dropped (`token[]`, `token[0]`), and on the name
 * with camelCase split into words (`accessToken`, `sessionToken`, `authKey`).
 */
function credentialParamName(name) {
  const raw = name.trim();
  const forms = [
    raw.toLowerCase(),
    raw.toLowerCase().replace(/\[[^\]]*\]/g, ""),
    raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
  ];
  return forms.some((n) => CREDENTIAL_PARAMS.has(n) || CREDENTIAL_WORD.test(n));
}

/** The authority part of an `https://` text: up to the first `/`, `?` or `#`. */
function rawAuthority(text) {
  const rest = text.slice("https://".length);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The verdict on one URL the research agent wants to fetch or reports as a source.
 * Returns `{ ok: true, url, host }` (url is the WHATWG-serialised form) or
 * `{ ok: false, code, reason }`.
 */
export function checkResearchUrl(raw) {
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
  let u;
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
    let seg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      return refuse("parse", "a path segment does not decode");
    }
    seg = seg.toLowerCase();
    if (/[/\\]/.test(seg)) return refuse("parse", "an encoded slash in a path segment is refused");
    if (seg.split(";").some(segmentIsAuthStep)) {
      return refuse(
        "auth-step",
        `the path segment "${seg.slice(0, 60)}" is a login, sign-up or account step`,
      );
    }
  }
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    let name;
    let value;
    try {
      name = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      return refuse("parse", "a query parameter does not decode");
    }
    const n = name.trim().toLowerCase();
    if (credentialParamName(name)) {
      return refuse(
        "credential-param",
        `the query parameter "${n.slice(0, 40)}" carries a credential`,
      );
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

/**
 * The verdict on one WebSearch call's input: the query (length, characters, secrets)
 * and each allowed / blocked domain (the host rules). `{ ok: true }` or a refusal.
 */
export function checkResearchSearch(input) {
  const q = input && typeof input === "object" ? input.query : undefined;
  if (typeof q !== "string" || q.trim().length < 2) {
    return refuse("input", "the search query is missing");
  }
  if ([...q].length > SEARCH_QUERY_MAX) {
    return refuse(
      "length",
      `the search query is ${[...q].length} characters; the cap is ${SEARCH_QUERY_MAX}`,
    );
  }
  // A query is prose: spaces are fine, controls and bidi overrides are not.
  if (
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u.test(
      q,
    )
  ) {
    return refuse(
      "input",
      "the search query holds a control, bidirectional or zero-width character",
    );
  }
  if (secretLike(q)) return refuse("secret", "the search query looks like it carries a secret");
  for (const key of ["allowed_domains", "blocked_domains"]) {
    const list = input[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return refuse("input", `${key} is not a list`);
    if (list.length > SEARCH_DOMAINS_MAX) {
      return refuse(
        "length",
        `${key} names ${list.length} domains; the cap is ${SEARCH_DOMAINS_MAX}`,
      );
    }
    for (const d of list) {
      if (typeof d !== "string" || !/^[a-z0-9.-]+$/.test(d)) {
        return refuse("host", `${key} holds something that is not a plain lowercase host name`);
      }
      const why = hostRefusal(d);
      if (why) return { ...why, reason: `${key}: ${why.reason}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Addresses (used where a name can be resolved: research.mjs). Pure.
// ---------------------------------------------------------------------------

function v4ToInt(ip) {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4Private(ip) {
  const n = v4ToInt(ip);
  if (n === null) return true; // unreadable: refuse
  return V4_BLOCKS.some(([base, bits]) => {
    const b = v4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (b & mask) >>> 0;
  });
}

/** Expand an IPv6 text to its eight 16-bit groups, or null. */
function v6Groups(ip) {
  let s = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  let tail = [];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    if (n === null) return null;
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, -v4[1].length).replace(/:$/, ":0").replace(/::0$/, "::");
    if (s.endsWith(":0") && !s.endsWith("::0")) s = s.slice(0, -2);
  }
  const want = 8 - tail.length;
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? want - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g || "0", 16));
  if (groups.length !== want || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff))
    return null;
  return [...groups, ...tail];
}

function v6Private(ip) {
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  const embedded = (hi, lo) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): judge the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return v4Private(embedded(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(embedded(g[6], g[7])); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 carries an IPv4 address: refused outright
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  return false;
}

/**
 * True when an address (as a resolver returns it) is loopback, private, link-local,
 * carrier-grade NAT, unique-local, multicast, reserved or unreadable.
 */
export function isNonPublicAddress(ip) {
  const s = String(ip ?? "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return v4Private(s);
  if (s.includes(":")) return v6Private(s);
  return true;
}
