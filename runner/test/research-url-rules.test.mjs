#!/usr/bin/env node
// =====================================================================
// The research agent's URL rules (backlog 69, protection B), table-tested.
// runner/lib/hook/url-rules.mjs is pure: every row of the shared vector file
// (runner/test/fixtures/research-url-vectors.json, hand-written expectations, also run
// by dispatch's TypeScript twin) must get its verdict and, for a refusal, the rule
// (`code`) that refused it. Then: the WebSearch input rules, the address classifier
// the hook uses where it can resolve a name, and the evidence for the length caps
// (the 40 ordinary pages fit far inside them).
// Run: node runner/test/research-url-rules.test.mjs
// =====================================================================
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  QUERY_MAX,
  SEARCH_QUERY_MAX,
  URL_MAX,
  checkResearchSearch,
  checkResearchUrl,
  isNonPublicAddress,
  secretLike,
} from "../lib/hook/url-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { vectors } = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "research-url-vectors.json"), "utf8"),
);

let passed = 0;
const failures = [];
const assert = (label, cond) => {
  if (cond) passed += 1;
  else failures.push(label);
};

// --- the table ---------------------------------------------------------------
assert(`the table holds at least 150 URLs (${vectors.length})`, vectors.length >= 150);
const ordinary = vectors.filter((v) => v.why === "ordinary page");
assert(`40 ordinary pages (${ordinary.length})`, ordinary.length === 40);
for (const v of vectors) {
  const r = checkResearchUrl(v.url);
  const shown = JSON.stringify(v.url).slice(0, 90);
  if (v.ok) {
    assert(`allows ${shown} (${v.why}); got ${r.code}: ${r.reason}`, r.ok === true);
  } else {
    assert(
      `refuses ${shown} as ${v.code} (${v.why}); got ${r.ok ? "ok" : `${r.code}: ${r.reason}`}`,
      r.ok === false && r.code === v.code,
    );
  }
}

// An allowed URL comes back with its host, lowercased.
{
  const r = checkResearchUrl("HTTPS://GitHub.com/vitejs/vite");
  assert("an allowed URL reports its lowercased host", r.ok && r.host === "github.com");
}

// Non-string input never throws.
for (const bad of [undefined, null, 42, {}, ["https://github.com/"]]) {
  let r;
  try {
    r = checkResearchUrl(bad);
  } catch (e) {
    r = { ok: true, threw: e };
  }
  assert(`a ${typeof bad} input is refused without throwing`, r.ok === false);
}

// --- the caps' evidence -------------------------------------------------------
const longest = Math.max(...ordinary.map((v) => Buffer.byteLength(v.url)));
const longestQuery = Math.max(
  ...ordinary.map((v) => Buffer.byteLength(new URL(v.url).search.replace(/^\?/, ""))),
);
assert(
  `the longest ordinary page (${longest} bytes) is under a quarter of URL_MAX (${URL_MAX})`,
  longest * 4 <= URL_MAX,
);
assert(
  `the longest ordinary query (${longestQuery} bytes) is under a third of QUERY_MAX (${QUERY_MAX})`,
  longestQuery * 3 <= QUERY_MAX,
);

// --- WebSearch ----------------------------------------------------------------
const searchCases = [
  [{ query: "open source workout tracker apps comparison" }, true, "a plain query"],
  [{ query: "habit tracker", allowed_domains: ["github.com", "reddit.com"] }, true, "domains"],
  [{ query: "habit tracker", blocked_domains: ["pinterest.com"] }, true, "blocked domains"],
  [{ query: "x" }, false, "too short"],
  [{}, false, "missing"],
  [{ query: 42 }, false, "not a string"],
  [{ query: "a".repeat(SEARCH_QUERY_MAX) }, true, "exactly the cap"],
  [{ query: "a".repeat(SEARCH_QUERY_MAX + 1) }, false, "over the cap"],
  [{ query: "find sk-ant-api03-AAAABBBBCCCCDDDD leaks" }, false, "a key in the query"],
  [{ query: "tracker‮exe" }, false, "bidi override"],
  [{ query: "tracker\nnext" }, false, "newline"],
  [{ query: "tracker", allowed_domains: ["localhost"] }, false, "localhost domain"],
  [{ query: "tracker", allowed_domains: ["10.0.0.1"] }, false, "IP domain"],
  [{ query: "tracker", allowed_domains: ["*.example.org"] }, false, "wildcard"],
  [{ query: "tracker", allowed_domains: ["GitHub.com"] }, false, "not lowercase"],
  [{ query: "tracker", allowed_domains: ["accounts.google.com"] }, false, "auth host"],
  [{ query: "tracker", blocked_domains: "github.com" }, false, "not a list"],
  [{ query: "tracker", allowed_domains: Array(11).fill("github.com") }, false, "too many"],
];
for (const [input, want, why] of searchCases) {
  const r = checkResearchSearch(input);
  assert(`WebSearch ${why}: want ${want ? "ok" : "refused"}, got ${r.ok ? "ok" : r.code}`, r.ok === want);
}

// --- addresses (the resolution check) -----------------------------------------
const nonPublic = [
  "127.0.0.1",
  "127.255.255.254",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "0.0.0.0",
  "224.0.0.1",
  "255.255.255.255",
  "198.18.0.1",
  "::1",
  "::",
  "fe80::1",
  "fc00::1",
  "fd12:3456::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:7f00:1",
  "64:ff9b::a00:1",
  "2002:7f00:1::1",
  "ff02::1",
  "not-an-address",
  "",
];
for (const ip of nonPublic) assert(`${ip || "(empty)"} is not public`, isNonPublicAddress(ip));
for (const ip of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"]) {
  assert(`${ip} is public`, !isNonPublicAddress(ip));
}

// --- the secret shapes ---------------------------------------------------------
assert("a commit id alone is not a query secret false positive in a path", checkResearchUrl("https://github.com/a/b/commit/" + "ab12".repeat(10)).ok);
assert("a long slug of words is not secret-like", !secretLike("how-to-build-a-workout-tracker-in-react-and-node-2024"));
assert("an opaque mixed run is secret-like", secretLike("a8F3kL9qZ2xW7pR4tY6uI0oP5sD1fG3hJ8kL2zX4"));

if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`research-url-rules: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`research-url-rules: all ${passed} checks passed`);
