# shellcheck shell=bash
# runner/config/10-locks.sh: locks: the portable file lock (flock or mkdir) and its staleness helpers.
# Sourced by runner/factory.config.sh only, in its fixed order, never directly or on
# its own: it reads what the parts before it set. Lines moved verbatim from
# factory.config.sh. The last line tells factory.config.sh this part loaded whole.

# --- Portable file lock (A-1 parallel execution) -----------------------------
# Serialise a critical section across concurrent worker.sh processes. Mirrors the
# gaffer_timeout shim's discipline: prefer the best primitive, fall back portably,
# NEVER skip the lock silently. macOS ships NO `flock`, so the universal fallback
# is an atomic `mkdir` spinlock — `mkdir` is an atomic create-or-fail syscall on
# every POSIX filesystem, so exactly one racer creates the lock dir and the rest
# spin until it's released. A stale lock (a worker killed mid-section) is reaped
# by age so the factory can never wedge on a dead holder's lock.
#
# Usage: gaffer_with_lock <lockfile> <command> [args...]
#   The command runs while the caller holds an EXCLUSIVE lock keyed on <lockfile>.
#   Returns the command's own exit status (so callers see real failures), or 1 if
#   the lock could not be acquired within the bound.
: "${GAFFER_LOCK_TIMEOUT:=30}"     # max seconds to wait for a contended lock
: "${GAFFER_LOCK_STALE:=120}"      # mkdir-lock older than this is treated as stale

# True iff flock(1) is present. FINDING B-L2: the flock branch below holds the lock
# on a STATIC fd 9 (`( flock 9 …; ) 9>>lock`), which every bash supports — including
# 3.2. The old bash>=4.1 floor was a leftover from an earlier dynamic-`{fd}>>` form
# that no longer exists, and it over-constrained (a Linux box on bash 3.2 with flock
# would have needlessly fallen back to the mkdir spinlock). macOS ships no flock, so
# it still always takes the portable mkdir path.
_gaffer_can_flock() {
  command -v flock >/dev/null 2>&1
}
gaffer_with_lock() {
  local lockfile="$1"; shift
  [ -n "$lockfile" ] || { "$@"; return $?; }
  # Prefer flock(1) when it is present; the lock is held on a static fd 9 inside a
  # subshell, which every bash (incl. macOS's 3.2) supports. macOS ships no flock, so
  # it always takes the portable mkdir path below; a Linux/CI box has flock.
  if _gaffer_can_flock; then
    # flock(1) (Linux/CI): hold an exclusive lock on a dedicated fd, run the
    # command, release on close. -w bounds the wait so a wedged holder can't hang
    # the worker forever. Exit 1 specifically signals "couldn't acquire".
    # Hold the lock on fd 9 inside a SUBSHELL so the lock descriptor NEVER exists in
    # the parent shell. The earlier form opened a dynamic `{fd}>>` in the parent and
    # ran the command there — but lock-wrapped log()/skip/ledger calls fire inside the
    # tick's own `while read`/process-substitution loops, and a parent-held descriptor
    # collided with / leaked into those loops, silently breaking candidate selection on
    # the flock (Linux) path. The subshell scopes fd 9 to itself and auto-closes it on
    # exit (releasing the lock); every lock-wrapped call is an external file write, so
    # running it in a subshell is behaviour-preserving. `exit 75` is flock's
    # couldn't-acquire signal (EX_TEMPFAIL; the wrapped writers never return it).
    ( flock -w "$GAFFER_LOCK_TIMEOUT" 9 || exit 75; "$@" ) 9>>"$lockfile"
    local rc=$?
    if [ "$rc" = 75 ]; then
      echo "gaffer_with_lock: could not acquire $lockfile within ${GAFFER_LOCK_TIMEOUT}s" >&2
      return 1
    fi
    return "$rc"
  fi
  # Portable fallback: atomic mkdir spinlock (the macOS path — no flock there).
  # GUARD: a locked section must finish well WITHIN GAFFER_LOCK_STALE — the
  # liveness check below means a *live* holder is never reaped, but a section that
  # outlives both the holder's death AND the staleness window would still be a bug.
  local lockdir="${lockfile}.d"
  local waited=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    # Reap an ABANDONED lock — but only when its holder is provably gone. Staleness
    # alone (mtime, set once at mkdir and never refreshed) wrongly reaps a live but
    # slow holder, breaking mutual exclusion. Liveness, by holder PID, is
    # authoritative:
    #   • readable PID, still alive (kill -0 ok) → NOT stale, however long held: wait.
    #   • readable PID, dead                     → reap immediately (holder gone).
    #   • no readable PID                        → fall back to the mtime-stale check
    #     (a holder killed before it wrote its pid, or a lost pid file).
    local pid
    pid="$(cat "$lockdir/pid" 2>/dev/null)"
    if [ -n "$pid" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        :   # holder is alive — never reap, just wait
      else
        # holder PID is dead: abandoned. Reaped under the guard, only if it still is.
        _gaffer_lock_reap "$lockdir" "$pid" && continue
      fi
    else
      local age
      age="$(_gaffer_lock_age "$lockdir")"
      if [ "${age:-0}" -ge "$GAFFER_LOCK_STALE" ] 2>/dev/null; then
        _gaffer_lock_reap "$lockdir" "" "$GAFFER_LOCK_STALE" && continue
      fi
    fi
    sleep 0.1
    waited=$((waited + 1))
    if [ "$waited" -ge "$((GAFFER_LOCK_TIMEOUT * 10))" ]; then
      echo "gaffer_with_lock: could not acquire $lockdir within ${GAFFER_LOCK_TIMEOUT}s" >&2
      return 1
    fi
  done
  # Record the holder PID so waiters can tell a live-but-slow holder from a dead one.
  echo $$ > "$lockdir/pid" 2>/dev/null || true
  # Hold the lock for the duration of the command; always release, even on failure.
  "$@"; local rc=$?
  rmdir "$lockdir" 2>/dev/null || rm -rf "$lockdir" 2>/dev/null || true
  return $rc
}

# Seconds since a lock dir was created (its mtime). Portable across GNU/BSD stat.
# Used only as the FALLBACK staleness signal when a lock has no live holder PID
# (the live-holder check is authoritative; mtime is the last resort for an
# abandoned lock left by a killed holder that never wrote — or had its pid file
# lost).
# GNU first: GNU `stat -f` is FILESYSTEM status, so `stat -f %m <path>` there prints a
# filesystem report for <path> (and fails on the "%m" operand), which the old BSD-first
# form fed to the arithmetic below. Each answer must be a plain number to count.
_gaffer_lock_age() {
  local d="$1" mtime now
  mtime="$(stat -c %Y "$d" 2>/dev/null)" || mtime=""
  case "$mtime" in ''|*[!0-9]*) mtime="$(stat -f %m "$d" 2>/dev/null)" || mtime="" ;; esac
  case "$mtime" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  now="$(date +%s)"
  echo $((now - mtime))
}

# Take over an ABANDONED mkdir lock, atomically with respect to other waiters.
#   _gaffer_lock_reap <lockdir> <seen-pid> [<min-age-seconds>]
# Two waiters that both read the dead holder's pid used to both `rm -rf` the lock: the
# second removed the lock the first had just taken, and both held it. The removal now
# runs under a reap guard (<lockdir>.reap, an atomic mkdir held for a few syscalls), and
# under it the reap condition is checked AGAIN: the pid file must still read <seen-pid>
# (the dead pid the caller saw, or "" for a lock with no pid) and, when <min-age> is
# given, the lock dir must be at least that old. A waiter that lost the race finds the
# winner's fresh lock (another pid, or no pid yet and a new dir) and leaves it alone.
# Returns 0 when it removed the lock, 1 otherwise (the caller just tries mkdir again).
# A guard older than 10 s belongs to a reaper that died inside it and is cleared.
_gaffer_lock_reap() {
  local d="$1" seen="$2" min="${3:-0}" g="$1.reap" cur age rc=1
  if ! mkdir "$g" 2>/dev/null; then
    age="$(_gaffer_lock_age "$g")"
    [ "${age:-0}" -ge 10 ] 2>/dev/null && rmdir "$g" 2>/dev/null
    return 1
  fi
  if [ -d "$d" ]; then
    cur="$(cat "$d/pid" 2>/dev/null)"
    if [ "$cur" = "$seen" ]; then
      age="$(_gaffer_lock_age "$d")"
      case "$min" in ''|*[!0-9]*) min=0 ;; esac
      if [ "$min" -eq 0 ] || [ "${age:-0}" -ge "$min" ] 2>/dev/null; then
        rm -rf "$d" 2>/dev/null && rc=0
      fi
    fi
  fi
  rmdir "$g" 2>/dev/null || true
  return "$rc"
}

_GAFFER_CONFIG_PART=10-locks
