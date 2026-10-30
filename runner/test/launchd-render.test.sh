#!/usr/bin/env bash
# =====================================================================
# LAUNCHD SCHEDULED RUN — the rendered plist carries a PATH that finds node.
# ---------------------------------------------------------------------
# launchd starts a job with a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin). The old
# template set no PATH, so on a stock macOS/Linux box (Homebrew/nvm node) the run
# died at "SETUP: could not register factory agent". This pins:
#   1. render.mjs fills every placeholder; the PATH starts with the dir of the node
#      that ran it, and includes claude's dir from the caller's PATH;
#   2. the output is a well-formed plist (plutil -lint on macOS, else python3
#      plistlib) whose ProgramArguments / EnvironmentVariables / log paths are the
#      real ones, XML-escaped;
#   3. running the job the way launchd does (env -i, only the plist's environment)
#      gets past SETUP, while the same run with launchd's bare PATH and node absent
#      stops with a message naming node and PATH;
#   4. a bad --repo is refused;
#   5. a repo / data dir / PATH containing "--" still yields a valid plist: values
#      are substituted only in the plist body, never in the header XML comment
#      (where "--" is not allowed), and the header keeps the placeholder names.
# No model calls: DRY_RUN=1 from the plist, and a stub claude first on PATH.
# Run: bash runner/test/launchd-render.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
RENDER="$RUNNER_DIR/launchd/render.mjs"
command -v node >/dev/null 2>&1 || { echo "SKIP: node required"; exit 0; }
[ -f "$ROOT/packages/dispatch/dist/cli/index.js" ] || { echo "SKIP: packages/dispatch/dist not built (run pnpm -r build)"; exit 0; }

PASS=0; FAILURES=()
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/launchd-render.XXXXXX")"; WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"
cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "0.0.0 (stub)"; exit 0; }
echo "stub claude must not be called: $*" >&2; exit 97
STUB
chmod +x "$WORK/bin/claude"
NODE_DIR="$(dirname "$(node -p process.execPath)")"
DATA="$WORK/data & <logs>"   # a path that needs XML escaping
OUT="$WORK/com.gaffer.factory.plist"

echo "== 1. render fills every placeholder with this machine's paths =="
if PATH="$WORK/bin:$PATH" node "$RENDER" --data "$DATA" --out "$OUT" 2>"$WORK/render.err"; then
  ok "render.mjs exits 0"
else
  fail "render.mjs failed: $(cat "$WORK/render.err")"
fi
sed -n '/<plist/,$p' "$OUT" | grep -q '__GAFFER_' && fail "a placeholder survived rendering" || ok "no __GAFFER_*__ placeholder left in the plist body"

# Extract the plist with a parser so the assertions read real values, not text.
extract() {
  node -e '
    const s = require("fs").readFileSync(process.argv[1], "utf8");
    const un = (v) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
    const env = s.slice(s.indexOf("<key>EnvironmentVariables</key>"));
    const get = (src, k) => { const m = src.match(new RegExp("<key>" + k + "</key>\\s*<string>([^<]*)</string>")); return m ? un(m[1]) : ""; };
    const args = [...s.slice(s.indexOf("<key>ProgramArguments</key>")).split("</array>")[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => un(m[1]));
    console.log(JSON.stringify({ PATH: get(env, "PATH"), GAFFER_DATA: get(env, "GAFFER_DATA"), DRY_RUN: get(env, "DRY_RUN"),
      MAX_TICKS: get(env, "MAX_TICKS"), out: get(s, "StandardOutPath"), args }));
  ' "$OUT"
}
J="$(extract)"
jf() { printf '%s' "$J" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=d[process.argv[1]];console.log(Array.isArray(v)?v.join("\n"):v)' "$1"; }
PLIST_PATH="$(jf PATH)"
case "$PLIST_PATH" in "$NODE_DIR":*) ok "PATH starts with node's dir ($NODE_DIR)" ;; *) fail "PATH does not start with node's dir: $PLIST_PATH" ;; esac
case ":$PLIST_PATH:" in *":$WORK/bin:"*) ok "PATH includes claude's dir from the caller's PATH" ;; *) fail "PATH lacks claude's dir: $PLIST_PATH" ;; esac
case ":$PLIST_PATH:" in *":/usr/bin:"*":/bin:"*) ok "PATH keeps the system dirs" ;; *) fail "PATH lacks /usr/bin:/bin: $PLIST_PATH" ;; esac
[ "$(jf args | tail -1)" = "$ROOT/runner/loop.sh" ] && ok "ProgramArguments runs this checkout's loop.sh" || fail "ProgramArguments: $(jf args)"
[ "$(jf GAFFER_DATA)" = "$DATA" ] && ok "GAFFER_DATA is the rendered data dir (XML round-trips)" || fail "GAFFER_DATA: $(jf GAFFER_DATA)"
[ "$(jf out)" = "$DATA/launchd.out.log" ] && ok "log path under the data dir" || fail "StandardOutPath: $(jf out)"
[ "$(jf DRY_RUN)" = "1" ] && ok "template still ships DRY_RUN=1" || fail "DRY_RUN: $(jf DRY_RUN)"

echo "== 2. the rendered file is a well-formed plist =="
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$OUT" >/dev/null 2>&1 && ok "plutil -lint passes" || fail "plutil -lint: $(plutil -lint "$OUT" 2>&1)"
elif command -v python3 >/dev/null 2>&1; then
  python3 -I -c 'import plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); assert d["Label"]=="com.gaffer.factory"; assert d["EnvironmentVariables"]["PATH"]' "$OUT" 2>"$WORK/lint.err" \
    && ok "python3 plistlib parses it (Label + EnvironmentVariables.PATH present)" || fail "plistlib: $(cat "$WORK/lint.err")"
else
  echo "  ok SKIP no plutil or python3 to lint the plist"
fi

echo "== 3. run the job the way launchd does (env -i + the plist's environment) =="
JOB_DATA="$WORK/jobdata"; mkdir -p "$JOB_DATA"
# The plist's own environment, with GAFFER_DATA moved to a path the stub run owns.
run_job() {   # $1 = PATH to run with
  timeout 120 env -i HOME="$WORK/home" PATH="$1" GAFFER_DATA="$JOB_DATA" \
    DRY_RUN="$(jf DRY_RUN)" MAX_TICKS=1 MAX_TICKS_PER_DAY=0 EMPTY_POLL_LIMIT=1 TICK_SLEEP=0 \
    /bin/bash "$(jf args | tail -1)" >"$WORK/job.out" 2>&1
}
run_job "$PLIST_PATH"; rc=$?
if grep -q 'could not register factory agent' "$WORK/job.out" "$JOB_DATA/factory.log" 2>/dev/null; then
  fail "the rendered PATH still fails SETUP (rc=$rc): $(tail -3 "$WORK/job.out")"
else
  ok "with the rendered PATH the run gets past SETUP (rc=$rc)"
fi
grep -q 'gaffer factory: starting' "$WORK/job.out" && ok "loop.sh started its run" || fail "loop.sh did not start: $(tail -3 "$WORK/job.out")"
# launchd's bare PATH: only meaningful when node is not in it.
if PATH=/usr/bin:/bin:/usr/sbin:/sbin command -v node >/dev/null 2>&1; then
  echo "  ok SKIP node is on the bare system PATH here; the missing-node case cannot be shown"
else
  rm -rf "$JOB_DATA"; mkdir -p "$JOB_DATA"
  run_job "/usr/bin:/bin:/usr/sbin:/sbin"; rc=$?
  [ "$rc" = 3 ] && grep -q 'node is not on PATH' "$WORK/job.out" \
    && ok "with launchd's bare PATH the run stops (rc=3) and names node + PATH" \
    || fail "bare-PATH run: rc=$rc, $(tail -2 "$WORK/job.out")"
fi

echo "== 4. a --repo that is not a Gaffer checkout is refused =="
mkdir -p "$WORK/not-gaffer"
if node "$RENDER" --repo "$WORK/not-gaffer" >/dev/null 2>"$WORK/bad.err"; then
  fail "render accepted a non-Gaffer --repo"
else
  grep -q 'not a Gaffer checkout' "$WORK/bad.err" && ok "non-Gaffer --repo refused with a reason" || fail "refusal reason: $(cat "$WORK/bad.err")"
fi

echo "== 5. values containing '--' never land in an XML comment =="
# lint_plist FILE → 0 when a real XML/plist parser accepts it (prints the reason on failure)
lint_plist() {
  if command -v plutil >/dev/null 2>&1; then plutil -lint "$1" >/dev/null 2>&1 || { plutil -lint "$1" 2>&1; return 1; }; fi
  if command -v xmllint >/dev/null 2>&1; then xmllint --noout "$1" 2>&1 || return 1; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$1" 2>&1 | tail -1; return "${PIPESTATUS[0]}"
  fi
  return 0
}
DD_DATA="$WORK/my--data"; DD_PATH="/a--b:/usr/bin:/bin"
DD_OUT="$WORK/dashdash.plist"
if node "$RENDER" --data "$DD_DATA" --path "$DD_PATH" --out "$DD_OUT" 2>"$WORK/dd.err"; then
  ok "render.mjs accepts a data dir and PATH containing '--'"
else
  fail "render.mjs refused '--' values: $(cat "$WORK/dd.err")"
fi
if lint_out="$(lint_plist "$DD_OUT")"; then ok "the '--' plist parses (no 'Comment must not contain --')"; else fail "the '--' plist is invalid: $lint_out"; fi
OUT="$DD_OUT"; J="$(extract)"
[ "$(jf GAFFER_DATA)" = "$DD_DATA" ] && ok "GAFFER_DATA keeps its '--' value" || fail "GAFFER_DATA: $(jf GAFFER_DATA)"
[ "$(jf PATH)" = "$DD_PATH" ] && ok "--path is used verbatim, '--' and all" || fail "PATH: $(jf PATH)"
HEAD_CMT="$(sed -n '1,/-->/p' "$DD_OUT")"
case "$HEAD_CMT" in *"$DD_DATA"*|*"/a--b"*) fail "a rendered value landed in the header comment" ;; *) ok "no rendered value in the header comment" ;; esac
printf '%s' "$HEAD_CMT" | grep -q '__GAFFER_REPO__ .*absolute path to the Gaffer' \
  && ok "the header comment still names the placeholders it documents" \
  || fail "header comment lost its placeholder names"
# A repo checkout whose own path contains '--' (ProgramArguments is in the body).
DD_REPO="$WORK/check--out"; mkdir -p "$DD_REPO/runner"; : >"$DD_REPO/runner/loop.sh"
if node "$RENDER" --repo "$DD_REPO" --data "$DD_DATA" --path "$DD_PATH" --out "$WORK/ddrepo.plist" 2>"$WORK/ddr.err" \
  && lint_out="$(lint_plist "$WORK/ddrepo.plist")"; then
  OUT="$WORK/ddrepo.plist"; J="$(extract)"
  [ "$(jf args | tail -1)" = "$DD_REPO/runner/loop.sh" ] && ok "a '--' repo path renders into a valid plist" || fail "ProgramArguments: $(jf args)"
else
  fail "a '--' repo path: $(cat "$WORK/ddr.err") ${lint_out:-}"
fi
# The renderer's own fail-closed guard recognises a comment that carries '--'.
# (Path via env, not argv: render.mjs runs its CLI when argv[1] is itself.)
RENDER_MJS="$RENDER" node --input-type=module -e '
  const { badComments } = await import(process.env.RENDER_MJS);
  const bad = badComments("<a><!-- ok --><!-- /x/my--data --></a>");
  process.exit(bad.length === 1 && badComments("<a><!-- fine --></a>").length === 0 ? 0 : 1);
' && ok "badComments() flags a comment containing '--' (render refuses to write one)" \
  || fail "badComments() does not detect a '--' comment"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "PASS ($PASS checks)"; exit 0; fi
printf 'FAILED (%d):\n' "${#FAILURES[@]}"; printf '  - %s\n' "${FAILURES[@]}"; exit 1
