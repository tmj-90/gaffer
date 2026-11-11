/**
 * The ONE redaction rule for notify URLs.
 *
 * A configured webhook / Slack URL is a credential: Slack keeps its secret in the
 * PATH (`/services/T.../B.../<secret>`), other endpoints in the query or user
 * information. So anything that REPORTS on a delivery (a log line, a thrown error,
 * the `dispatch notify test` report) names the URL by its origin only: scheme, host
 * and port. Never the path, the query, the fragment or the user information.
 *
 *   - {@link urlOrigin}      a URL as it may be reported: `https://hooks.slack.com`.
 *   - {@link scrubMessage}   any free text (a transport error, a custom sink's error):
 *                            every absolute URL in it is cut to its origin, and every
 *                            piece of the configured URL (the whole string, its path,
 *                            query, user name and password) is removed, so a message
 *                            like "Failed to parse URL from hooks.slack.com/services/..."
 *                            (no scheme) cannot carry it either.
 *   - {@link linkWithoutCredentials}  the deep link an event carries to the operator:
 *                            its path and fragment stay (that is the link), its user
 *                            information and query go (a dashboard `?token=` rides there).
 */

/** A URL as it may appear in a log or error: its origin only. */
export function urlOrigin(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.host === "") return "<url>";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<url>";
  }
}

// An absolute URL in free text: scheme, then everything up to whitespace or a quote.
// A scheme starts only where no scheme character precedes it (not merely at a word
// boundary): with `\b`, a long run like `a.a.a.` was re-scanned from every dot,
// which is quadratic in the length of the message.
const URL_IN_TEXT = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/**
 * `text` with no trace of a URL beyond its origin. `configured` (the sink's URL, when
 * known) is removed piece by piece as well, whatever form the text quotes it in.
 */
export function scrubMessage(text: string, configured?: string): string {
  // URLs first: removing a piece of the configured URL inserts `<redacted>`, which
  // would end a URL match early and leave the rest of its path in the message.
  let out = text.replace(URL_IN_TEXT, (m) => urlOrigin(m));
  if (configured !== undefined && configured.trim() !== "") {
    const raw = configured.trim();
    out = out.split(raw).join(urlOrigin(raw));
    for (const piece of urlPieces(raw)) out = out.split(piece).join("<redacted>");
  }
  return out;
}

/** The parts of a URL that may carry a secret, longest first. */
function urlPieces(raw: string): string[] {
  const pieces = new Set<string>();
  try {
    const u = new URL(raw);
    if (u.pathname.length > 1) pieces.add(u.pathname);
    if (u.search.length > 1) pieces.add(u.search.slice(1));
    if (u.hash.length > 1) pieces.add(u.hash.slice(1));
    if (u.username) pieces.add(u.username);
    if (u.password) pieces.add(u.password);
    for (const seg of u.pathname.split("/")) if (seg.length >= 8) pieces.add(seg);
  } catch {
    // Unparseable: whatever follows the first slash is the part to hide.
    const slash = raw.indexOf("/");
    if (slash >= 0 && slash < raw.length - 1) pieces.add(raw.slice(slash));
    for (const seg of raw.split("/")) if (seg.length >= 8) pieces.add(seg);
  }
  return [...pieces].filter((p) => p.length >= 2).sort((a, b) => b.length - a.length);
}

/**
 * A deep link fit to send: user information and query removed, path and fragment
 * kept. Undefined when the value is not an http(s) URL (it is then not sent).
 */
export function linkWithoutCredentials(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.username = "";
    u.password = "";
    u.search = "";
    return u.toString();
  } catch {
    return undefined;
  }
}
