/**
 * Machine markers that ingest and the idle loops stamp into a ticket description
 * (`Source: <url>`, `Finding-Key: <key>`), and the ONE matcher every dedup lookup
 * uses (Dispatch itself, crew's real client and crew's fake client).
 *
 * A marker is a whole line `Name: <value>` (a source URL is a single token); the LAST such
 * line in the description wins, because the writer always appends its marker after
 * any free text (an issue body that quotes `Source: https://...` mid-text is not the
 * ticket's identity). Values compare EXACTLY after canonicalisation, never by
 * substring: `.../issues/1` is not `.../issues/10`, and `loop:web` is not
 * `loop:web-app`.
 */

export const SOURCE_MARKER = "Source";
export const FINDING_KEY_MARKER = "Finding-Key";

/**
 * The value of the last whole-line `name: <value>` marker in `description`, if any.
 * With `singleToken` a line whose value holds whitespace is prose, not a marker.
 */
export function lastMarkerValue(
  description: string,
  name: string,
  opts: { singleToken?: boolean } = {},
): string | undefined {
  const prefix = `${name}:`;
  const lines = description.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    if (value === "") continue;
    // `Source: see https://x and y` is prose, not a marker.
    if (opts.singleToken && /\s/.test(value)) continue;
    return value;
  }
  return undefined;
}

/**
 * The canonical form of a source URL, the identity ingest dedupes on.
 *
 * - scheme and host are lower-cased and a default port is dropped (WHATWG URL);
 * - the fragment is dropped (`#issuecomment-1` points into the same issue);
 * - one or more trailing slashes on the path are dropped (`/issues/5/` is `/issues/5`);
 * - the path keeps its case (paths are case-sensitive in general) and the query is
 *   kept verbatim (a source may carry identity there; ingest never writes one);
 * - user information is dropped (it is never identity, and never belongs in a
 *   description).
 *
 * A value that does not parse as an absolute URL is compared as its trimmed text.
 */
export function canonicalSourceUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** The marker line ingest appends for a source URL (canonical form). */
export function formatSourceMarker(sourceUrl: string): string {
  return `${SOURCE_MARKER}: ${canonicalSourceUrl(sourceUrl)}`;
}

/** The canonical source a description records, from its last `Source:` line. */
export function sourceOfDescription(description: string): string | undefined {
  const value = lastMarkerValue(description, SOURCE_MARKER, { singleToken: true });
  return value === undefined ? undefined : canonicalSourceUrl(value);
}

/** True when `description` records exactly `sourceUrl` as its source. */
export function descriptionHasSource(description: string, sourceUrl: string): boolean {
  const recorded = sourceOfDescription(description);
  return recorded !== undefined && recorded === canonicalSourceUrl(sourceUrl);
}

/** True when `description` carries exactly `findingKey` as its finding key. */
export function descriptionHasFindingKey(description: string, findingKey: string): boolean {
  const key = findingKey.trim();
  return key !== "" && lastMarkerValue(description, FINDING_KEY_MARKER) === key;
}
