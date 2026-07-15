#!/usr/bin/env node
// =====================================================================
// Gaffer egress-allowlist builder (Mode-2 / docker provider).
// ---------------------------------------------------------------------
// The delivery container reaches the internet ONLY through the tinyproxy
// egress proxy, which is DEFAULT-DENY and permits a request only when the
// destination host matches an extended-regex in its filter file. That
// filter is baked into the proxy image, so an operator with a PRIVATE git
// host or package registry couldn't allow it without rebuilding.
//
// This builds the proxy's effective filter at container-start = the baked
// default allowlist + operator-supplied EXTRA hosts (env / file), so extra
// hosts can be permitted without an image rebuild while default-deny holds.
//
// SECURITY INVARIANT: operator entries are treated as literal HOSTNAMES, not
// raw regexes. Each is regex-escaped and anchored as `(^|\.)<host>$`, so a
// broad pattern like `.*` or `.` CANNOT widen the allowlist to match every
// host — the whole point of an allowlist. Anything that isn't a plausible
// hostname is dropped (never silently turned into a permissive rule).
//
//   buildEgressFilter({ baseFilterText, extraHosts }) -> string
//   parseExtraHosts(env, fileText) -> string[]
//
// Zero runtime dependencies.
// =====================================================================

/**
 * A plausible DNS hostname / domain suffix: dot-separated labels of
 * [a-z0-9-] (no leading/trailing hyphen), 1..253 chars, at least two
 * labels (so a bare token like "localhost" or "com" — which would over-
 * match — is rejected). Case-insensitive; callers lower-case first.
 */
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Escape every regex metacharacter so a hostname is matched literally. */
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalise one operator entry to a safe, anchored allowlist regex line, or
 * null if it isn't a plausible hostname. Accepts a bare host ("git.corp.io"),
 * a leading-dot domain (".corp.io"), or a URL/host:port and extracts the host.
 * The result matches the host exactly OR as a dot-suffix — never more.
 */
export function hostToFilterLine(raw) {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  if (h === "" || h.startsWith("#")) return null;
  // Strip a scheme + path if a whole URL was given.
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split("/")[0];
  // Strip userinfo, port, and a leading dot.
  h = h.split("@").pop();
  h = h.split(":")[0];
  h = h.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!HOST_RE.test(h)) return null;
  return `(^|\\.)${escapeRegex(h)}$`;
}

/**
 * Collect operator extra hosts from an env value (comma / whitespace / newline
 * separated) and an optional file's text (one entry per line, `#` comments ok).
 * Returns a de-duplicated list of raw entries (validation happens in the builder).
 */
export function parseExtraHosts(envValue = "", fileText = "") {
  const fromEnv = String(envValue || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  const fromFile = String(fileText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  return Array.from(new Set([...fromEnv, ...fromFile]));
}

/**
 * Build the effective tinyproxy filter text = the baked default allowlist with
 * an appended, clearly-marked block of validated operator hosts. Invalid entries
 * are dropped and reported on `dropped` so the caller can warn (never fail open).
 * De-duplicates against lines already present in the base filter.
 * Returns { text, added, dropped }.
 */
export function buildEgressFilter({ baseFilterText = "", extraHosts = [] } = {}) {
  const base = String(baseFilterText);
  const existing = new Set(
    base
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#")),
  );
  const added = [];
  const dropped = [];
  for (const raw of extraHosts) {
    const line = hostToFilterLine(raw);
    if (line === null) {
      dropped.push(raw);
      continue;
    }
    if (existing.has(line) || added.includes(line)) continue; // de-dupe
    added.push(line);
  }
  let text = base.endsWith("\n") || base === "" ? base : base + "\n";
  if (added.length > 0) {
    text +=
      "\n# --- operator-added hosts (GAFFER_EGRESS_ALLOW / egress-allow.txt) ---\n" +
      added.join("\n") +
      "\n";
  }
  return { text, added, dropped };
}

// --- CLI: render the effective filter to stdout (used by sandbox-docker.sh) ---
// Reads the base filter from --base <path>, extra hosts from $GAFFER_EGRESS_ALLOW
// and an optional --allow-file <path>. Warnings for dropped entries go to stderr.
async function main(argv) {
  const { readFileSync } = await import("node:fs");
  let basePath = "";
  let allowFile = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") basePath = argv[(i += 1)];
    else if (argv[i] === "--allow-file") allowFile = argv[(i += 1)];
  }
  const baseFilterText = basePath ? readFileSync(basePath, "utf8") : "";
  let fileText = "";
  if (allowFile) {
    try {
      fileText = readFileSync(allowFile, "utf8");
    } catch (err) {
      // ENOENT is expected + correct to ignore (the operator created no allow-file).
      // ANY other error (EACCES/EMFILE/…) means a file the operator DID create can't
      // be read — warn loudly instead of silently dropping their hosts, which would
      // surface only as an opaque agent network error against their private registry.
      if (err && err.code !== "ENOENT") {
        process.stderr.write(
          `egress-allowlist: WARNING — could not read allow-file "${allowFile}": ` +
            `${err.message}; operator hosts NOT applied\n`,
        );
      }
      fileText = "";
    }
  }
  const extraHosts = parseExtraHosts(process.env["GAFFER_EGRESS_ALLOW"] || "", fileText);
  const { text, added, dropped } = buildEgressFilter({ baseFilterText, extraHosts });
  for (const d of dropped) {
    process.stderr.write(`egress-allowlist: ignored invalid host entry "${d}" (not a hostname)\n`);
  }
  if (added.length > 0) {
    process.stderr.write(`egress-allowlist: added ${added.length} operator host(s) to the proxy\n`);
  }
  process.stdout.write(text);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
