#!/usr/bin/env bash
# =====================================================================
# The docker sandbox's RESEARCH profile (backlog 69, protection E), daemon-free.
# ---------------------------------------------------------------------
# Drives the REAL wrapper (lib/sandbox-docker.sh) in GAFFER_SANDBOX_DRY_RUN=1 mode (it
# prints the `docker run` argv instead of running it) and the REAL worker seam with a
# fake `docker` that only answers `info`. Proves:
#   (a) the research profile runs the research command on its OWN network
#       (gaffer-research-int), mounting only the throwaway home (rw) and runner/ (ro):
#       no packages/, node_modules, $GAFFER_DATA, socket or git metadata; forwarding
#       only the model credential and the hook's state path, with the proxy settings;
#   (b) the profile is refused for any command that is not the research agent (an MCP
#       config, a permission bypass, no or another --tools, a command worker), for a
#       home that is a repository or lies under $GAFFER_DATA, and with a read root;
#   (c) without the profile the same command gets the delivery network and filter;
#   (d) through the worker seam: deliver() strips a research profile from its caller's
#       env (a delivery stays on the delivery network), deliverResearch selects it;
#   (e) the research filter refuses plain http, IP literals in every spelling, single
#       labels, internal and metadata names and wildcard DNS services, and lets ordinary
#       public hosts through (checked with grep -E, the same extended regex dialect);
#       the delivery filter is a different file and has no match-all line.
# What only a real daemon proves: that tinyproxy reads the filter this way for CONNECT
# (host:port) under FilterURLs, that the internal network has no other route out, and
# a live research agent working through it (SECURITY.md, docs/sandbox.md).
# Run: bash runner/test/sandbox-docker-research-seam.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
export RUNNER_DIR
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "SKIP: git required"; exit 0; }

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sbx-research.XXXXXX")"
gaffer_test_check_tmp "$WORK" || exit 70
WORK="$(cd "$WORK" && pwd -P)"
trap 'gaffer_test_rm_work "$WORK"' EXIT

export GAFFER_DATA="$WORK/data"; mkdir -p "$GAFFER_DATA"
printf 'dashboard-secret\n' > "$GAFFER_DATA/dashboard-token"
: > "$GAFFER_DATA/dispatch.sqlite"
HOME_DIR="$WORK/run/home"; mkdir -p "$HOME_DIR/.claude" "$HOME_DIR/.research-state"
WRF="$WORK/wroots"; printf '%s\n' "$HOME_DIR" > "$WRF"
RRF="$WORK/rroots"; : > "$RRF"
RESEARCH_CMD=( env HOME=/root PATH=/usr/bin claude -p hi --output-format json --permission-mode default --strict-mcp-config --tools WebSearch,WebFetch --allowedTools WebSearch WebFetch --disallowedTools Bash Read mcp__* --max-turns 80 )

wrap() {  # <env assignments...> -- <cmd...>
  local envs=()
  while [ "$1" != "--" ]; do envs+=( "$1" ); shift; done; shift
  (cd "$HOME_DIR" && env "${envs[@]}" GAFFER_SANDBOX_DRY_RUN=1 GAFFER_MCP_BRIDGE=1 \
    ANTHROPIC_API_KEY=sk-test GAFFER_RESEARCH_STATE="$HOME_DIR/.research-state" \
    bash "$RUNNER_DIR/lib/sandbox-docker.sh" "$WRF" "$RRF" -- "$@")
}

echo "== (a) the research profile: its own network, only the home and runner/ =="
ARGV="$(wrap GAFFER_SANDBOX_PROFILE=research -- "${RESEARCH_CMD[@]}" 2>"$WORK/err")"; rc=$?
[ "$rc" = 0 ] && ok "the research command is wrapped (exit 0)" || fail "research wrap exit $rc: $(cat "$WORK/err")"
grep -qxF -- "gaffer-research-int" <<<"$ARGV" && ok "on the research network" || fail "research network missing"
grep -qxF -- "gaffer-egress-int" <<<"$ARGV" && fail "the delivery network is used" || ok "not on the delivery network"
grep -qxF -- "$HOME_DIR:$HOME_DIR:rw" <<<"$ARGV" && ok "the home is mounted rw" || fail "home mount missing"
grep -qxF -- "$RUNNER_DIR:$RUNNER_DIR:ro" <<<"$ARGV" && ok "runner/ is mounted ro (the hook runs from it)" || fail "runner mount missing"
_mounts="$(grep -A1 -xF -- "-v" <<<"$ARGV" | grep -v -xF -- "-v" | grep -v -xF -- "--")"
_n="$(grep -c . <<<"$_mounts")"
[ "$_n" = 2 ] && ok "exactly two mounts" || fail "expected 2 mounts, got $_n: $_mounts"
grep -qF -- "$GAFFER_DATA" <<<"$ARGV" && fail "\$GAFFER_DATA appears in the research argv" || ok "nothing of \$GAFFER_DATA is mounted or named"
grep -qE -- "/packages:|/node_modules:" <<<"$ARGV" && fail "packages or node_modules mounted" || ok "no packages/ or node_modules"
grep -qxF -- "GAFFER_RESEARCH_RESOLVE=proxy" <<<"$ARGV" && ok "the hook is told the proxy resolves names" || fail "GAFFER_RESEARCH_RESOLVE=proxy missing"
grep -qxF -- "GAFFER_RESEARCH_STATE" <<<"$ARGV" && ok "the hook state path is forwarded" || fail "state path not forwarded"
grep -qxF -- "ANTHROPIC_API_KEY" <<<"$ARGV" && ok "the model credential is forwarded" || fail "credential not forwarded"
grep -qxF -- "HTTPS_PROXY=http://egress-proxy:8888" <<<"$ARGV" && ok "egress goes through the proxy" || fail "proxy setting missing"
for k in GAFFER_DATA GAFFER_FACTORY DISPATCH_DB MEMORY_DB GIT_CONFIG_COUNT; do
  grep -qE -- "^$k(=|$)" <<<"$ARGV" && fail "$k forwarded" || ok "$k not forwarded"
done

echo "== (b) refused for anything that is not the research agent =="
refused() {  # <label> <env...> -- <cmd...>
  local label="$1"; shift
  if wrap "$@" >"$WORK/out" 2>"$WORK/err"; then fail "$label: wrapped (should be refused)"; else ok "$label: refused"; fi
}
refused "a delivery with an MCP config" GAFFER_SANDBOX_PROFILE=research -- claude -p hi --mcp-config "$GAFFER_DATA/mcp.json" --strict-mcp-config --tools WebSearch,WebFetch
refused "no --tools" GAFFER_SANDBOX_PROFILE=research -- claude -p hi --strict-mcp-config
refused "--tools with Bash" GAFFER_SANDBOX_PROFILE=research -- claude -p hi --strict-mcp-config --tools Bash,WebFetch
refused "--tools=joined" GAFFER_SANDBOX_PROFILE=research -- claude -p hi --strict-mcp-config --tools=WebSearch,WebFetch
refused "no --strict-mcp-config" GAFFER_SANDBOX_PROFILE=research -- claude -p hi --tools WebSearch,WebFetch
refused "a permission bypass" GAFFER_SANDBOX_PROFILE=research -- "${RESEARCH_CMD[@]}" --dangerously-skip-permissions
refused "bypassPermissions mode" GAFFER_SANDBOX_PROFILE=research -- "${RESEARCH_CMD[@]}" --permission-mode bypassPermissions
refused "a command worker" GAFFER_SANDBOX_PROFILE=research -- env -i GAFFER_WORKER_CONTRACT=1 /bin/true --tools WebSearch,WebFetch --strict-mcp-config
printf '%s\n' "$WORK" > "$WORK/rroots-some"
RRF_SAVE="$RRF"; RRF="$WORK/rroots-some"
refused "a read root" GAFFER_SANDBOX_PROFILE=research -- "${RESEARCH_CMD[@]}"
RRF="$RRF_SAVE"
REPO="$WORK/repo"; mkdir -p "$REPO"; git -C "$REPO" init -q
printf '%s\n' "$REPO" > "$WRF"
refused "a home that is a repository" GAFFER_SANDBOX_PROFILE=research -- "${RESEARCH_CMD[@]}"
mkdir -p "$GAFFER_DATA/research-home"; printf '%s\n' "$GAFFER_DATA/research-home" > "$WRF"
refused "a home under \$GAFFER_DATA" GAFFER_SANDBOX_PROFILE=research -- "${RESEARCH_CMD[@]}"
printf '%s\n' "$HOME_DIR" > "$WRF"

echo "== (c) without the profile: the delivery network and filter =="
ARGV="$(wrap -- "${RESEARCH_CMD[@]}" 2>"$WORK/err")"
grep -qxF -- "gaffer-egress-int" <<<"$ARGV" && ok "the same command without the profile is on the delivery network" || fail "delivery network missing: $(cat "$WORK/err")"
grep -qxF -- "gaffer-research-int" <<<"$ARGV" && fail "the research network without the profile" || ok "the research network is not chosen without the profile"
ARGV="$(wrap GAFFER_SANDBOX_PROFILE=validation -- "${RESEARCH_CMD[@]}" 2>/dev/null)"
grep -qxF -- "gaffer-research-int" <<<"$ARGV" && fail "another profile reached the research network" || ok "another profile never reaches the research network"

echo "== (d) through the worker seam =="
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE/docker"; chmod +x "$FAKE/docker"
seam() {  # <deliver|deliverResearch> <argv json> <extra env json>; the first node argument is a placeholder: worker.mjs runs its own CLI when process.argv[1] names it
  (cd "$HOME_DIR" && PATH="$FAKE:$PATH" SANDBOX_PROVIDER=docker GAFFER_SANDBOX_DRY_RUN=1 STRICT_MODE=1 \
    GAFFER_STRICT_REQUIRE=1 GAFFER_ALLOW_UNCAPPED=1 GAFFER_MCP_BRIDGE=1 \
    node --input-type=module -e '
      const m = await import(process.argv[2]);
      const fn = m[process.argv[3]];
      const r = fn({ bin: "claude", argv: JSON.parse(process.argv[4]), cwd: process.cwd(), timeoutMs: 20000,
        maxBuffer: 1 << 20, kind: process.argv[3] === "deliver" ? "research" : undefined,
        env: { PATH: process.env.PATH, GAFFER_SANDBOX_DRY_RUN: "1", GAFFER_WRITE_ROOTS: process.cwd(), ...JSON.parse(process.argv[5]) } });
      const { writeSync } = await import("node:fs");
      writeSync(1, String(r.stdout || "")); writeSync(2, String(r.stderr || ""));
      process.exit(r.status ?? 1);' seam "$RUNNER_DIR/lib/worker.mjs" "$1" "$2" "$3")
}
ARGS_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- -p hi --output-format json --strict-mcp-config --tools WebSearch,WebFetch --allowedTools WebSearch WebFetch)"
OUT="$(seam deliver "$ARGS_JSON" '{"GAFFER_SANDBOX_PROFILE":"research","GAFFER_RESEARCH_STATE":"/x"}' 2>"$WORK/err")"
grep -qxF -- "gaffer-egress-int" <<<"$OUT" && ok "deliver() (any other launcher) strips a research profile: delivery network" || fail "deliver() did not strip the profile: $(head -c 400 "$WORK/err") $(head -c 400 <<<"$OUT")"
grep -qxF -- "gaffer-research-int" <<<"$OUT" && fail "deliver() reached the research network" || ok "deliver() never reaches the research network, even claiming kind research"
OUT="$(seam deliverResearch "$ARGS_JSON" '{}' 2>"$WORK/err")"
grep -qxF -- "gaffer-research-int" <<<"$OUT" && ok "deliverResearch selects the research network" || fail "deliverResearch: $(head -c 400 "$WORK/err")"

echo "== (e) the research filter =="
FILTER="$RUNNER_DIR/sandbox/research-proxy/filter"
PATTERNS="$WORK/patterns"; grep -v -e '^#' -e '^[[:space:]]*$' "$FILTER" > "$PATTERNS"
denied() { grep -qiE -f "$PATTERNS" <<<"$1"; }
for u in "http://github.com/" "127.0.0.1:443" "2130706433:443" "0x7f000001:443" "0177.0.0.1:443" "127.1:443" \
         "[::1]:443" "::1:443" "localhost:443" "intranet:443" "router.local:443" "jira.internal:443" \
         "nas.lan:443" "hub.home.arpa:443" "metadata.google.internal:443" "metadata.goog:443" \
         "10.0.0.1.nip.io:443" "app.localtest.me:443" "127-0-0-1.attacker-domain.org:443" "www.example.com:443" \
         "site.onion:443" "user@github.com:443" "app.localhost.direct:443" "lacolhost.com:443"; do
  denied "$u" && ok "the research filter refuses $u" || fail "the research filter lets $u through"
done
for u in "github.com:443" "docs.python.org:443" "www.reddit.com:443" "1.bp.blogspot.com:443" "news.ycombinator.com:443" "api.github.com:443"; do
  denied "$u" && fail "the research filter refuses the ordinary host $u" || ok "the research filter lets $u through"
done
grep -qE '^ConnectPort 443$' "$RUNNER_DIR/sandbox/research-proxy/tinyproxy.conf" && ! grep -qE '^ConnectPort [^4]' "$RUNNER_DIR/sandbox/research-proxy/tinyproxy.conf" \
  && ok "CONNECT is allowed to port 443 only" || fail "ConnectPort is not 443 only"
grep -qE '^FilterURLs On$' "$RUNNER_DIR/sandbox/research-proxy/tinyproxy.conf" && ok "the filter sees the request URL (plain http refusable)" || fail "FilterURLs not on"
cmp -s "$FILTER" "$RUNNER_DIR/sandbox/egress-proxy/filter" && fail "the research filter is the delivery filter" || ok "the research filter is its own file"
grep -qE '^\.\*$|^\^?\.\*\$?$' "$RUNNER_DIR/sandbox/egress-proxy/filter" && fail "the delivery filter has a match-all line" || ok "the delivery filter has no match-all line"
grep -qE '^FilterDefaultDeny Yes$' "$RUNNER_DIR/sandbox/egress-proxy/tinyproxy.conf" && ok "the delivery proxy still denies by default" || fail "the delivery proxy no longer denies by default"

echo
if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"
  exit 1
fi
echo "sandbox-docker-research-seam: all $PASS checks passed"
