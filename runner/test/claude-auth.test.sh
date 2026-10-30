#!/usr/bin/env bash
# =====================================================================
# lib/claude-auth.sh + preflight.sh — an unauthenticated claude no longer reads
# "→ ready".
# ---------------------------------------------------------------------
# preflight checked only `claude --version`, which succeeds logged out. Proves, with
# a scratch HOME and fake claude binaries (no real call):
#   • no credential visible → gaffer_claude_auth_probe rc 1; preflight WARNS;
#   • ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ~/.claude/.credentials.json /
#     CLAUDE_CONFIG_DIR → rc 0 naming the source (never its contents);
#   • GAFFER_PREFLIGHT_LIVE=1: a claude that exits 1 ("Invalid API key"), and one that
#     exits 0 with is_error JSON, both FAIL preflight with claude's own error line;
#     a working claude passes; without the knob no `-p` call is ever made.
# Run: bash test/claude-auth.test.sh   (bash 3.2 safe)
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib/claude-auth.sh
source "$RUNNER_DIR/lib/claude-auth.sh"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-auth-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
CALLS="$WORK/calls"
mkclaude() {  # $1 = name, $2 = body for a `-p` call
  cat > "$WORK/$1" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi
echo "\$*" >> "$CALLS"
$2
EOF
  chmod +x "$WORK/$1"
}
mkclaude claude-401 "echo 'Invalid API key · Please run /login' >&2; exit 1"
mkclaude claude-iserr "printf '%s\n' '{\"type\":\"result\",\"is_error\":true,\"result\":\"OAuth token has expired\"}'; exit 0"
mkclaude claude-good "printf '%s\n' '{\"type\":\"result\",\"is_error\":false,\"result\":\"ok\"}'; exit 0"
NOCRED=(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CONFIG_DIR)
probe() { "${NOCRED[@]}" "$@" bash -c 'source "$1"; gaffer_claude_auth_probe; rc=$?; echo "$rc|$GAFFER_CLAUDE_AUTH_SOURCE"' _ "$RUNNER_DIR/lib/claude-auth.sh"; }

echo "== gaffer_claude_auth_probe: is a credential visible? =="
H="$WORK/home-empty"; mkdir -p "$H"
r="$(probe HOME="$H")"
if [ "$(uname -s)" = "Darwin" ]; then
  [ "${r%%|*}" = "2" ] && ok "macOS, nothing visible → unknown (Keychain), not a false alarm" || fail "macOS probe: $r"
else
  [ "${r%%|*}" = "1" ] && ok "no env var, no credentials file → rc 1" || fail "empty home: $r"
fi
r="$(probe HOME="$H" ANTHROPIC_API_KEY=sk-test-secret)"
[ "$r" = "0|\$ANTHROPIC_API_KEY" ] && ok "ANTHROPIC_API_KEY → visible, named (value never printed)" || fail "api key: $r"
r="$(probe HOME="$H" CLAUDE_CODE_OAUTH_TOKEN=tok)"
[ "$r" = "0|\$CLAUDE_CODE_OAUTH_TOKEN" ] && ok "CLAUDE_CODE_OAUTH_TOKEN → visible" || fail "oauth: $r"
HC="$WORK/home-cred"; mkdir -p "$HC/.claude"; echo '{"x":1}' > "$HC/.claude/.credentials.json"
r="$(probe HOME="$HC")"
[ "$r" = "0|$HC/.claude/.credentials.json" ] && ok "~/.claude/.credentials.json → visible" || fail "cred file: $r"
r="$(probe HOME="$H" CLAUDE_CONFIG_DIR="$HC/.claude")"
[ "${r%%|*}" = "0" ] && ok "CLAUDE_CONFIG_DIR is honoured" || fail "config dir: $r"

echo "== gaffer_claude_live_probe (GAFFER_PREFLIGHT_LIVE=1) =="
for b in claude-401 claude-iserr; do
  GAFFER_CLAUDE_LIVE_ERROR=""; CLAUDE_BIN="$WORK/$b" gaffer_claude_live_probe 10; rc=$?
  want="Invalid API key"; [ "$b" = claude-iserr ] && want="OAuth token has expired"
  [ "$rc" = 1 ] && [[ "$GAFFER_CLAUDE_LIVE_ERROR" == *"$want"* ]] \
    && ok "$b → rc 1 with claude's own error ('$GAFFER_CLAUDE_LIVE_ERROR')" || fail "$b: rc=$rc err='$GAFFER_CLAUDE_LIVE_ERROR'"
done
CLAUDE_BIN="$WORK/claude-good" gaffer_claude_live_probe 10; rc=$?
[ "$rc" = 0 ] && ok "a working claude → rc 0" || fail "good claude: rc=$rc"
# The probe is a liveness question, not a session: no tools, no MCP, no slash commands,
# and never from the caller's cwd (a write-capable stub once committed into the checkout
# from there, because loop.sh runs with the runner dir as cwd).
last="$(tail -n 1 "$CALLS")"
[[ "$last" == *"--tools  --mcp-config "* && "$last" == *"--strict-mcp-config"* && "$last" == *"--disable-slash-commands"* ]] \
  && ok "the live probe passes --tools \"\" --mcp-config <empty> --strict-mcp-config --disable-slash-commands" \
  || fail "live probe argv lacks the no-tools flags: $last"
mkclaude claude-pwd "pwd > '$WORK/probe.cwd'; printf '%s\n' '{\"type\":\"result\",\"is_error\":false,\"result\":\"ok\"}'; exit 0"
( cd "$RUNNER_DIR" && CLAUDE_BIN="$WORK/claude-pwd" gaffer_claude_live_probe 10 ) >/dev/null 2>&1
pcwd="$(cat "$WORK/probe.cwd" 2>/dev/null)"
[ -n "$pcwd" ] && [ "$pcwd" != "$RUNNER_DIR" ] && [[ "$pcwd" != "$RUNNER_DIR"/* ]] && [[ "$pcwd" != "$(cd "$RUNNER_DIR/.." && pwd)"* ]] \
  && ok "the live probe runs from a scratch dir, not the caller's cwd ($pcwd)" || fail "live probe cwd: '$pcwd' (caller: $RUNNER_DIR)"
[ ! -d "$pcwd" ] && ok "the scratch dir is removed afterwards" || fail "scratch dir left behind: $pcwd"
CLAUDE_BIN="$WORK/absent" gaffer_claude_live_probe 10; rc=$?
[ "$rc" = 2 ] && ok "no claude on PATH → skipped (rc 2)" || fail "absent claude: rc=$rc"

echo "== preflight.sh end to end =="
pf() { "${NOCRED[@]}" HOME="$H" GAFFER_DATA="$WORK/data" GAFFER_REGISTRY_PROBE=0 "$@" bash "$RUNNER_DIR/preflight.sh" 2>&1; }
: > "$CALLS"
OUT="$(pf CLAUDE_BIN="$WORK/claude-401")"
if [ "$(uname -s)" != "Darwin" ]; then
  [[ "$OUT" == *"no claude credential visible"* ]] && ok "preflight warns when no credential is visible" || fail "no warning: $OUT"
fi
[ ! -s "$CALLS" ] && ok "without GAFFER_PREFLIGHT_LIVE no paid call is made" || fail "preflight called claude -p: $(cat "$CALLS")"
OUT="$(pf CLAUDE_BIN="$WORK/claude-401" GAFFER_PREFLIGHT_LIVE=1)"; rc=$?
[[ "$OUT" == *"claude live call FAILED: Invalid API key"* ]] && [ "$rc" -ne 0 ] \
  && ok "GAFFER_PREFLIGHT_LIVE=1 + broken claude → a failure, exit non-zero" || fail "live broken: rc=$rc out=$OUT"
[[ "$OUT" != *"→ ready"* ]] && ok "…and preflight no longer says ready" || fail "still says ready"
OUT="$(pf CLAUDE_BIN="$WORK/claude-good" GAFFER_PREFLIGHT_LIVE=1 ANTHROPIC_API_KEY=sk-x)"
[[ "$OUT" == *"claude answers a live call"* ]] && [[ "$OUT" == *"claude credential visible (\$ANTHROPIC_API_KEY)"* ]] && [[ "$OUT" != *"sk-x"* ]] \
  && ok "working claude + key → both ok, key value never printed" || fail "live good: $OUT"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "claude-auth: ALL $PASS checks passed"
  exit 0
fi
echo "claude-auth: ${#FAILURES[@]} FAILURE(S):"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
exit 1
