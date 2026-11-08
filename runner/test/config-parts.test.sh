#!/usr/bin/env bash
# =====================================================================
# factory.config.sh is a thin file over runner/config/*.sh.
# ---------------------------------------------------------------------
# The defaults below its prologue live in runner/config/NN-area.sh, sourced from one
# "parts block" in a fixed order. This pins the contract of that split:
#   1. every part is sourced exactly once, in file-name order, each by a guarded line
#      with its shellcheck directive, and no part is sourced that is not on disk;
#   2. every part is a sourced-only file: a `shellcheck shell=bash` header that says
#      so, its marker as the LAST line, `bash -n` clean, no BASH_SOURCE or $0 (a part
#      sits in runner/config/, so its own path is not the runner dir), nothing bash 3.2
#      lacks (associative arrays, mapfile/readarray, ${x,,} / ${x^^});
#   3. it fails CLOSED: a missing part, one that stops early (a syntax error, a
#      truncated copy, a top-level `return`) or one without its own marker stops the
#      sourcing process non-zero and names the part; an intact copy loads;
#   4. a symlinked factory.config.sh still finds its parts (next to the real file);
#   5. re-source hygiene survives: a second source in the same shell leaves exactly
#      the env, variables and functions of the first, the parts block leaves nothing
#      behind, and every variable the source newly exported has its _GAFFER_DV_ record.
# Zero deps. Run: bash runner/test/config-parts.test.sh
# =====================================================================
. "$(dirname "${BASH_SOURCE[0]}")/lib/tmpdir.sh"  # mktemp guard + safe temp removal
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$HERE/.." && pwd)"
CFG="$RUNNER_DIR/factory.config.sh"
PDIR="$RUNNER_DIR/config"

PASS=0
FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL %s\n' "$1"; }

WORK="$(gaffer_test_tmpdir config-parts)" || exit 70
trap 'gaffer_test_rm_work "$WORK"' EXIT
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN

echo "== 1: the parts block sources every part once, in order, guarded =="
ON_DISK="$(cd "$PDIR" && ls -- *.sh 2>/dev/null | tr '\n' ' ')"
SOURCED="$(sed -n 's/^\[ -r "\$_GAFFER_CONFIG_DIR\/\([0-9][0-9]-[a-z-]*\)\.sh" \] && \. "\$_GAFFER_CONFIG_DIR\/\1\.sh"; _gaffer_config_loaded \1$/\1.sh/p' "$CFG" | tr '\n' ' ')"
[ -n "$ON_DISK" ] && ok "runner/config holds parts: $ON_DISK" || fail "no runner/config/*.sh"
[ "$SOURCED" = "$ON_DISK" ] && ok "factory.config.sh sources exactly the parts on disk, in file-name order" \
  || fail "sourced '$SOURCED' but on disk '$ON_DISK'"
ANY_LINE="$(grep -c '_GAFFER_CONFIG_DIR/[0-9]' "$CFG" || true)"
N=0; for _p in $ON_DISK; do N=$((N + 1)); done
[ "${ANY_LINE:-0}" = "$N" ] && ok "no other line sources a part ($N source lines)" \
  || fail "$ANY_LINE lines name a part, $N parts"
bad=""
for p in $ON_DISK; do
  n="${p%.sh}"
  ln="$(grep -n "_gaffer_config_loaded $n\$" "$CFG" | cut -d: -f1)"
  [ "$(sed -n "$((ln - 1))p" "$CFG")" = "# shellcheck source=config/$p" ] || bad="$bad $p"
done
[ -z "$bad" ] && ok "every source line has its shellcheck directive" || fail "no directive before:$bad"
grep -n 'BASH_SOURCE' "$CFG" > "$WORK/bs"
[ "$(wc -l < "$WORK/bs" | tr -d ' ')" = 3 ] && ok "factory.config.sh uses BASH_SOURCE in three places (settings path, RUNNER_DIR, the parts dir)" \
  || fail "BASH_SOURCE uses changed: $(tr '\n' ' ' < "$WORK/bs")"

echo "== 2: every part is a sourced-only, bash 3.2 file =="
for p in $ON_DISK; do
  f="$PDIR/$p"; n="${p%.sh}"; why=""
  [ "$(head -1 "$f")" = "# shellcheck shell=bash" ] || why="$why first-line"
  case "$(sed -n '1,/^$/p' "$f")" in *"never directly"*) ;; *) why="$why header" ;; esac
  [ "$(tail -1 "$f")" = "_GAFFER_CONFIG_PART=$n" ] || why="$why marker"
  bash -n "$f" 2>/dev/null || why="$why bash-n"
  grep -nE 'BASH_SOURCE|\$0\b|\$\{0\}' "$f" | grep -vE '^[0-9]+:[[:space:]]*#' > "$WORK/hits" || true
  [ -s "$WORK/hits" ] && why="$why BASH_SOURCE/\$0"
  grep -nE 'declare -A|typeset -A|local -A|\bmapfile\b|\breadarray\b|\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)' "$f" \
    | grep -vE '^[0-9]+:[[:space:]]*#' > "$WORK/hits" || true
  [ -s "$WORK/hits" ] && why="$why bash4"
  [ -z "$why" ] && ok "$p" || fail "$p:$why"
done

echo "== 3: a part that is missing, stops early or has no marker fails closed =="
src_in() { env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" bash -c 'source "$1" >/dev/null; echo "REACHED rc=$?"' _ "$1/factory.config.sh" 2>&1; }
mkdir -p "$WORK/home" "$WORK/data"
fresh_copy() { rm -rf "$WORK/copy"; mkdir -p "$WORK/copy"; cp "$CFG" "$WORK/copy/"; cp -R "$PDIR" "$WORK/copy/config"; }
fresh_copy
OUT="$(src_in "$WORK/copy")"; RC=$?
[ "$RC" = 0 ] && [[ "$OUT" == *"REACHED rc=0"* ]] && ok "an intact copy loads to the end" || fail "intact copy: rc=$RC $OUT"
set -- $ON_DISK
FIRST="${1%.sh}"; MID="$(eval "echo \${$(( ($# + 1) / 2 ))}")"; MID="${MID%.sh}"; LAST="$(eval "echo \${$#}")"; LAST="${LAST%.sh}"
for n in $FIRST $MID $LAST; do
  fresh_copy; rm -f "$WORK/copy/config/$n.sh"
  OUT="$(src_in "$WORK/copy")"; RC=$?
  [ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && [[ "$OUT" == *"runner/config/$n.sh"*"fail closed"* ]] \
    && ok "missing $n.sh: the process stops non-zero and names it" || fail "missing $n.sh: rc=$RC $OUT"
  fresh_copy
  { head -8 "$PDIR/$n.sh"; printf 'if then (\n'; cat "$PDIR/$n.sh"; } > "$WORK/copy/config/$n.sh"
  OUT="$(src_in "$WORK/copy")"; RC=$?
  [ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && [[ "$OUT" == *"runner/config/$n.sh"*"fail closed"* ]] \
    && ok "a syntax error early in $n.sh: stops non-zero (the rest of the part never ran)" || fail "syntax error in $n.sh: rc=$RC $OUT"
  fresh_copy; sed '$d' "$PDIR/$n.sh" > "$WORK/copy/config/$n.sh"
  OUT="$(src_in "$WORK/copy")"; RC=$?
  [ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && ok "$n.sh without its marker line: stops non-zero" || fail "no marker in $n.sh: rc=$RC $OUT"
done
# A part that returns at its top level (a sourced file's early exit) never reaches its
# marker; a part whose marker names another part did not load as itself.
fresh_copy
{ head -8 "$PDIR/$MID.sh"; printf 'return 0\n'; cat "$PDIR/$MID.sh"; } > "$WORK/copy/config/$MID.sh"
OUT="$(src_in "$WORK/copy")"; RC=$?
[ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && [[ "$OUT" == *"runner/config/$MID.sh"*"fail closed"* ]] \
  && ok "$MID.sh that returns early: stops non-zero and names it" || fail "early return in $MID.sh: rc=$RC $OUT"
fresh_copy; { sed '$d' "$PDIR/$MID.sh"; printf '_GAFFER_CONFIG_PART=%s\n' "$FIRST"; } > "$WORK/copy/config/$MID.sh"
OUT="$(src_in "$WORK/copy")"; RC=$?
[ "$RC" != 0 ] && [[ "$OUT" != *REACHED* ]] && [[ "$OUT" == *"runner/config/$MID.sh"*"fail closed"* ]] \
  && ok "$MID.sh whose marker names another part: stops non-zero and names it" || fail "wrong marker in $MID.sh: rc=$RC $OUT"

echo "== 4: a symlinked factory.config.sh finds its parts next to the real file =="
mkdir -p "$WORK/fake/runner"; ln -s "$CFG" "$WORK/fake/runner/factory.config.sh"
OUT="$(env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" bash -c 'source "$1" >/dev/null 2>&1; echo "REACHED RUNNER_DIR=$RUNNER_DIR"' _ "$WORK/fake/runner/factory.config.sh" 2>&1)"
[[ "$OUT" == "REACHED RUNNER_DIR=$WORK/fake/runner" ]] && ok "loads through the link (RUNNER_DIR is still the link's directory, as before)" \
  || fail "symlinked config: $OUT"

echo "== 5: re-source hygiene: a second source in one shell changes nothing =="
cat > "$WORK/twice.sh" <<'SH'
dump() {
  env | LC_ALL=C sort | grep -Ev '^(_|OLDPWD)=' > "$W/$1.env"
  # bash 3.2 prints arrays from `declare -p` as NAME=(...) with no `declare -a` prefix.
  declare -p | grep -Ev '^(declare (-[a-zA-Z-]+ )?)?(BASH_[A-Z_]*|BASHPID|BASHOPTS|SHELLOPTS|FUNCNAME|LINENO|RANDOM|SRANDOM|SECONDS|EPOCH[A-Z]*|_|PIPESTATUS|PPID|SHLVL|HISTCMD|COLUMNS|LINES|OPTIND|OPTERR|BASH_ARGV0|W|CFG|BEFORE)=' > "$W/$1.declare"
  declare -f > "$W/$1.functions"
}
BEFORE=" $(compgen -e | tr '\n' ' ') "
source "$CFG" >/dev/null 2>&1; dump 1
missing=""
for k in $(compgen -e); do
  case "$k" in _GAFFER_* | GIT_CONFIG_*) continue ;; esac
  case "$BEFORE" in *" $k "*) continue ;; esac
  [ -n "$(eval "printf '%s' \"\${_GAFFER_DV_$k+x}\"")" ] || missing="$missing $k"
done
echo "$missing" > "$W/missing"
unset k missing
source "$CFG" >/dev/null 2>&1; dump 2
{ declare -F _gaffer_config_loaded >/dev/null && echo fn; [ -n "${_GAFFER_CONFIG_DIR+x}${_GAFFER_CONFIG_PART+x}" ] && echo var; } > "$W/left" || true
SH
env -i PATH="$PATH" HOME="$WORK/home" GAFFER_DATA="$WORK/data" W="$WORK" CFG="$CFG" bash --norc --noprofile "$WORK/twice.sh"
for k in env declare functions; do
  cmp -s "$WORK/1.$k" "$WORK/2.$k" && ok "second source: same $k as the first" \
    || fail "second source changed $k: $(diff "$WORK/1.$k" "$WORK/2.$k" | head -5 | tr '\n' ' ')"
done
[ -s "$WORK/left" ] && fail "the parts block left $(tr '\n' ' ' < "$WORK/left")behind" || ok "the parts block leaves no helper function or variable behind"
[ -z "$(tr -d ' \n' < "$WORK/missing")" ] && ok "every variable the source newly exported is recorded (_GAFFER_DV_*), parts included" \
  || fail "exported but not recorded:$(cat "$WORK/missing")"
N_DV="$(grep -c '^_GAFFER_DV_' "$WORK/1.env" || true)"
[ "${N_DV:-0}" -gt 20 ] && ok "the record block saw $N_DV exports" || fail "only ${N_DV:-0} _GAFFER_DV_ records"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "config-parts: ${#FAILURES[@]} FAILURE(S) of $((PASS + ${#FAILURES[@]}))"
  exit 1
fi
echo "config-parts: ALL $PASS checks passed"
