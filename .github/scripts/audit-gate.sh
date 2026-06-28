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
ALLOWLIST="$HERE/../audit-allowlist.txt"

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
