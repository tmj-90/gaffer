#!/usr/bin/env bash
# =====================================================================
# AFK-LOOP Phase 3 — one-scan QR for `gaffer dashboard --lan`.
# ---------------------------------------------------------------------
# The LAN dashboard is token-protected; copy-pasting the token onto a
# phone is the friction. When `qrencode` is available the front door
# prints a scannable QR of the URL WITH the token embedded so a scan
# logs you straight in. When it's absent the block must degrade
# gracefully — still print the URL + token, never error.
#
#   AC1  qrencode present  → a QR is emitted for http://<LAN>:<port>/?token=<TOK>
#   AC2  qrencode ABSENT   → still prints the token, exit 0, no error
#        (the negative control — the graceful fallback)
#
# Hermetic: shadows node + curl with fakes (as the deeplink test does).
# For AC2 the whole PATH is rebuilt as a symlink farm that deliberately
# EXCLUDES qrencode, so a qrencode installed on the dev box can't leak
# in and mask the fallback path.
# Run: bash test/dashboard-qr.test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"

PASS=0; FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dashboard-qr-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Shared fakes (node + curl) — kept in their OWN dir so the qrencode fake can be
# added for AC1 and left out for AC2 without dragging node/curl along.
FAKES="$WORK/fakes"; mkdir -p "$FAKES"

# Fake node: the dashboard server launch is a no-op success (we only care about
# what the front door PRINTS, not the server). Every other node call is a silent
# success too (factory.config's settings reader).
cat > "$FAKES/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKES/node"

# Fake curl: the health-check probe always reports the server up so the "up on
# your LAN" branch (which prints the token + QR) is reached.
cat > "$FAKES/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKES/curl"

# Fake qrencode (AC1 only, in its own dir): record the payload it was asked to
# encode and emit a recognisable marker on stdout so the test can prove a QR was
# rendered. QRMARK is grep -F'd (it contains regex-special brackets on purpose).
QRDIR="$WORK/qrbin"; mkdir -p "$QRDIR"
QRMARK="[[QR-RENDERED]]"
cat > "$QRDIR/qrencode" <<EOF
#!/usr/bin/env bash
# last arg is the data to encode
data="\${!#}"
printf '%s %s\n' "$QRMARK" "\$data"
exit 0
EOF
chmod +x "$QRDIR/qrencode"

# Build a sanitized PATH (symlink farm) that contains every real tool currently
# on PATH EXCEPT qrencode — used for the absent-case so a real install can't leak.
NOQR="$WORK/noqr"; mkdir -p "$NOQR"
IFS=: read -r -a _pdirs <<< "$PATH"
for d in "${_pdirs[@]}"; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    [ "$name" = "qrencode" ] && continue          # deliberately exclude
    [ -e "$NOQR/$name" ] || ln -s "$f" "$NOQR/$name" 2>/dev/null || true
  done
done

run_gaffer() {
  # $1 = data dir, $2 = PATH to use, rest = gaffer args. Captures stdout+stderr.
  local data="$1"; local usepath="$2"; shift 2
  mkdir -p "$data"
  PATH="$usepath" GAFFER_DATA="$data" GAFFER_HOME="$RUNNER_DIR/.." \
    bash "$RUNNER_DIR/gaffer" dashboard "$@" 2>&1
}

echo "== AC1: qrencode present → QR of the URL WITH token embedded =="
out_present="$(run_gaffer "$WORK/data-present" "$FAKES:$QRDIR:$PATH" --lan)"; rc_present=$?
if [ "$rc_present" -eq 0 ] \
   && printf '%s' "$out_present" | grep -qF "$QRMARK" \
   && printf '%s' "$out_present" | grep -Eq 'http://[^ ]+:8787/\?token=.+'; then
  ok "QR emitted encoding http://<LAN>:8787/?token=<TOK>"
else
  fail "expected a QR of the token-embedded URL (rc=$rc_present)"
  printf '    --- output ---\n%s\n    --------------\n' "$out_present"
fi

echo "== AC2 (negative control): qrencode ABSENT → token still printed, no error =="
out_absent="$(run_gaffer "$WORK/data-absent" "$FAKES:$NOQR" --lan)"; rc_absent=$?
# FAKES supplies fake node/curl only (no qrencode); NOQR supplies coreutils minus
# qrencode. So `command -v qrencode` must fail and the fallback prints.
if [ "$rc_absent" -eq 0 ] \
   && printf '%s' "$out_absent" | grep -q "token:" \
   && ! printf '%s' "$out_absent" | grep -qF "$QRMARK" \
   && ! printf '%s' "$out_absent" | grep -qiE 'command not found|qrencode.*not found|no such file'; then
  ok "fallback printed the token, exit 0, no qrencode error"
else
  fail "absent-qrencode path did not degrade gracefully (rc=$rc_absent)"
  printf '    --- output ---\n%s\n    --------------\n' "$out_absent"
fi

# PROOF (static): the QR block is guarded by `command -v qrencode` so its absence
# can never hard-fail the dashboard launch.
grep -q 'command -v qrencode' "$RUNNER_DIR/gaffer" \
  && ok "gaffer guards the QR on command -v qrencode" \
  || fail "gaffer missing the qrencode availability guard"

echo
if [ "${#FAILURES[@]}" -eq 0 ]; then echo "  ALL PASS ($PASS checks)"; exit 0
else printf '  %d FAILURE(S), %d passed\n' "${#FAILURES[@]}" "$PASS"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done; exit 1; fi
