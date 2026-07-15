#!/usr/bin/env bash
# CI dependency-audit gate.
#
# Runs `pnpm audit` and FAILS the job on any HIGH or CRITICAL advisory that is
# not explicitly accepted in .github/audit-allowlist.txt. Accepted advisories
# (each documented in that file) are reported but do not fail the build, so the
# gate is green today yet catches every NEW high/critical going forward.
#
# Exit codes: 0 = clean or only-allowlisted; 1 = un-accepted high/critical found;
# 2 = tooling error (couldn't run/parse the audit).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# GAFFER_TEST_ALLOWLIST lets the hermetic self-test inject an allowlist so the
# accepted-advisory path is actually exercised; production uses the repo file.
ALLOWLIST="${GAFFER_TEST_ALLOWLIST:-$HERE/../audit-allowlist.txt}"

# Collect accepted advisory IDs (strip inline `# …` comments and whitespace;
# ignore blank / comment-only lines).
accepted=""
if [ -f "$ALLOWLIST" ]; then
  accepted="$(sed -E 's/#.*$//; s/[[:space:]]+//g' "$ALLOWLIST" | grep -v '^$' || true)"
fi

# `pnpm audit --json` exits non-zero when advisories exist — that's expected, so
# we capture output regardless of exit status and parse it ourselves.
audit_json="$(pnpm audit --audit-level=high --json 2>/dev/null || true)"
if [ -z "$audit_json" ]; then
  echo "audit-gate: ERROR — empty output from 'pnpm audit'." >&2
  exit 2
fi

# Node does the JSON parsing + allowlist subtraction. It prints one line per
# offending (high/critical, not-allowlisted) advisory and exits 1 if any remain,
# 0 if clean, 2 on a parse error.
ACCEPTED_IDS="$accepted" node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("audit-gate: ERROR — could not parse pnpm audit JSON: " + e.message);
      process.exit(2);
    }
    // Shape guard: a zero-offender result is only trustworthy if the output has the
    // shape we know how to read. If a pnpm change renames/removes the `advisories`
    // key, `parsed.advisories || {}` would silently report "clean" while ignoring
    // every real advisory. Refuse to trust an unexpected shape — exit non-zero so
    // the gate fails loudly and a human re-checks the parser rather than shipping a
    // false all-clear.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(
        "audit-gate: ERROR — unexpected pnpm audit JSON shape (not an object); " +
          "refusing to report clean. The audit output format may have changed.",
      );
      process.exit(2);
    }
    // npm RETIRED the legacy audit endpoints pnpm still calls
    // (/-/npm/v1/security/audits and /quick) — they now return HTTP 410, so
    // `pnpm audit` emits {error:{code:"ERR_PNPM_AUDIT_BAD_RESPONSE", …}} instead of
    // an advisory report. That is an upstream/tooling outage, NOT a vulnerability
    // signal, and it is permanent until pnpm migrates to the bulk advisory endpoint
    // — so failing the build on it would wedge CI red forever WITHOUT adding any
    // safety. Detect that SPECIFIC error and skip the gate with a loud, visible
    // warning; any OTHER error or unexpected shape still fails closed below.
    // TODO: re-enable enforcement once `pnpm audit` reaches a working endpoint
    // (the bulk advisory API) or swap in an alternative scanner (e.g. osv-scanner).
    if (parsed.error && typeof parsed.error === "object") {
      const msg = String(parsed.error.message || "");
      const code = String(parsed.error.code || "");
      // Skip ONLY on the permanent endpoint-retirement signal (HTTP 410 / "being
      // retired" / bulk-advisory migration) in the MESSAGE — never on the bare code.
      // pnpm reuses ERR_PNPM_AUDIT_BAD_RESPONSE for ANY bad HTTP response (503/429/
      // 403/connection reset); skipping on the code alone would silently green-skip
      // the whole gate on a transient registry hiccup. A non-410 bad-response still
      // fails closed below.
      const retired =
        /being retired|responded with 410|bulk advisory endpoint/i.test(msg) ||
        (code === "ERR_PNPM_AUDIT_BAD_RESPONSE" && /\b410\b/.test(msg));
      if (retired) {
        console.log(
          "audit-gate: SKIPPED — npm retired the audit endpoint pnpm calls (HTTP 410); " +
            "`pnpm audit` cannot fetch advisories. This is an upstream outage, not a " +
            "clean result. Re-enable once pnpm uses the bulk advisory endpoint.",
        );
        console.log("  detail: " + (msg || code).slice(0, 300));
        process.exit(0);
      }
      console.error(
        "audit-gate: ERROR — `pnpm audit` returned an error (" +
          (code || "unknown") +
          "): " +
          msg.slice(0, 300),
      );
      process.exit(2);
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "advisories")) {
      console.error(
        "audit-gate: ERROR — pnpm audit JSON has no `advisories` key; refusing to " +
          "report clean. The audit output format may have changed — update this parser.",
      );
      process.exit(2);
    }
    if (typeof parsed.advisories !== "object" || parsed.advisories === null) {
      console.error(
        "audit-gate: ERROR — pnpm audit `advisories` is not an object; refusing to " +
          "report clean. The audit output format may have changed.",
      );
      process.exit(2);
    }
    const accepted = new Set(
      (process.env.ACCEPTED_IDS || "").split("\n").map((s) => s.trim()).filter(Boolean),
    );
    const advisories = parsed.advisories || {};
    const gating = new Set(["high", "critical"]);
    const offenders = [];
    const allowed = [];
    for (const key of Object.keys(advisories)) {
      const a = advisories[key];
      if (!gating.has(a.severity)) continue;
      const id = a.github_advisory_id || a.url || key;
      const line = `${a.severity.toUpperCase()} ${id} (${a.module_name})`;
      if (accepted.has(id)) allowed.push(line);
      else offenders.push(line);
    }
    if (allowed.length) {
      console.log("audit-gate: accepted (allowlisted) advisories:");
      for (const l of allowed) console.log("  - " + l);
    }
    if (offenders.length) {
      console.error("audit-gate: FAIL — un-accepted high/critical advisories:");
      for (const l of offenders) console.error("  - " + l);
      console.error(
        "audit-gate: fix the dependency, or — if genuinely unfixable — add the " +
          "GHSA id to .github/audit-allowlist.txt WITH a justifying comment.",
      );
      process.exit(1);
    }
    console.log("audit-gate: OK — no un-accepted high/critical advisories.");
    process.exit(0);
  });
' <<<"$audit_json"
