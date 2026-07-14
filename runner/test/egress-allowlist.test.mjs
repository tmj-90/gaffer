// =====================================================================
// egress-allowlist.mjs — operator-extensible egress allowlist builder.
// ---------------------------------------------------------------------
// The docker delivery container egresses ONLY through a default-deny
// tinyproxy whose filter is baked into the image. This builder lets an
// operator add EXTRA hosts (a private git/registry) without rebuilding —
// while the security invariant holds: an operator entry is a literal
// hostname, regex-escaped + anchored, so it can NEVER widen the allowlist
// to match every host. Invalid entries are dropped, never turned permissive.
//
// Run: node runner/test/egress-allowlist.test.mjs
// =====================================================================
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(HERE, "..", "lib", "egress-allowlist.mjs");

let passed = 0;
const failures = [];
const ok = (l) => {
  passed += 1;
  console.log(`  ok   ${l}`);
};
const fail = (l) => {
  failures.push(l);
  console.log(`  FAIL ${l}`);
};
const eq = (l, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(l)
    : fail(`${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const assert = (l, c) => (c ? ok(l) : fail(l));

const { escapeRegex, hostToFilterLine, parseExtraHosts, buildEgressFilter } = await import(MOD);

console.log("== hostToFilterLine: valid hosts become anchored, escaped regexes ==");
eq("plain host", hostToFilterLine("git.corp.io"), "(^|\\.)git\\.corp\\.io$");
eq("leading-dot domain", hostToFilterLine(".corp.io"), "(^|\\.)corp\\.io$");
eq("uppercase is normalised", hostToFilterLine("Git.CORP.io"), "(^|\\.)git\\.corp\\.io$");
eq(
  "url with scheme/port/path → host only",
  hostToFilterLine("https://reg.corp.io:8443/path"),
  "(^|\\.)reg\\.corp\\.io$",
);
eq("userinfo stripped", hostToFilterLine("user@reg.corp.io"), "(^|\\.)reg\\.corp\\.io$");

console.log("== hostToFilterLine: over-broad / invalid entries are REJECTED (null) ==");
eq("bare single label (over-matches) → null", hostToFilterLine("localhost"), null);
eq("bare TLD → null", hostToFilterLine("com"), null);
eq("regex wildcard .* → null", hostToFilterLine(".*"), null);
eq("lone dot → null", hostToFilterLine("."), null);
eq("empty → null", hostToFilterLine(""), null);
eq("comment → null", hostToFilterLine("# a comment"), null);
eq("space in host → null", hostToFilterLine("foo bar.com"), null);
eq("regex metachars → null", hostToFilterLine("(evil|x).com"), null);

console.log("== escapeRegex escapes every metacharacter ==");
assert("dots escaped", escapeRegex("a.b") === "a\\.b");
assert("star escaped", escapeRegex("a*b") === "a\\*b");

console.log("== parseExtraHosts: env (comma/space/newline) + file, comments + dedup ==");
eq("env split on comma/space", parseExtraHosts("a.com, b.com  c.com", ""), [
  "a.com",
  "b.com",
  "c.com",
]);
eq(
  "file lines + comment strip + dedup with env",
  parseExtraHosts("a.com", "b.com\n# note\n\na.com\nc.com\n"),
  ["a.com", "b.com", "c.com"],
);
eq("empty inputs → []", parseExtraHosts("", ""), []);

console.log("== buildEgressFilter: appends validated hosts, drops invalid, dedupes ==");
{
  const base = "# baked\n(^|\\.)anthropic\\.com$\n";
  const r = buildEgressFilter({
    baseFilterText: base,
    extraHosts: ["git.corp.io", "reg.corp.io", ".*", "localhost", "anthropic.com"],
  });
  assert("valid hosts added", r.added.includes("(^|\\.)git\\.corp\\.io$"));
  assert(
    "invalid .* dropped + reported",
    r.dropped.includes(".*") && r.dropped.includes("localhost"),
  );
  assert(
    "dedupes an entry already in the base filter",
    !r.added.includes("(^|\\.)anthropic\\.com$"),
  );
  assert("base content preserved", r.text.includes("(^|\\.)anthropic\\.com$"));
  assert("operator block marked", r.text.includes("operator-added hosts"));
}

console.log("== SECURITY: no operator input can widen the allowlist to match-all ==");
{
  const base = "(^|\\.)anthropic\\.com$\n";
  // Every one of these is a classic allowlist-defeat attempt.
  const attacks = [".*", ".", ".+", "^.*$", "|", "()", "a|.*", "*", "%.evil.com"];
  const r = buildEgressFilter({ baseFilterText: base, extraHosts: attacks });
  // NONE may produce a filter line that is anything but a literal, anchored host.
  const everyAddedIsAnchoredLiteral = r.added.every((l) => /^\(\^\|\\\.\)[a-z0-9\\.-]+\$$/.test(l));
  assert(
    "every added line is an anchored literal host (never a broad regex)",
    everyAddedIsAnchoredLiteral,
  );
  assert("bare metachar attacks were all dropped", r.added.length === 0);
}

console.log("== base filter without a trailing newline is handled ==");
{
  const r = buildEgressFilter({ baseFilterText: "(^|\\.)a\\.com$", extraHosts: ["b.example.com"] });
  assert("newline inserted before operator block", r.text.includes("a\\.com$\n"));
  assert("host added", r.added.includes("(^|\\.)b\\.example\\.com$"));
}

console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (module: ${MOD})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
