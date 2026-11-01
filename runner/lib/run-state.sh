# shellcheck shell=bash
# Gaffer factory — PER-RUN STATE and the POLL LOCK.
#
# A run (one loop.sh pass, one dashboard Poll) keeps lists that only mean something
# for that run: the tickets that failed delivery this run (.failed-tickets, so one
# bad ticket cannot starve the queue), the reviewed / clarified / tested / merge-held
# tickets, the backpressured repos, the warned-once markers and the dry-run preview
# list. They used to be ONE path under $GAFFER_DATA shared by every run, and a run
# "started" by deleting them. Runs overlap (a Poll pressed while the previous Poll is
# still parking its delivery, a Poll beside a daemon pass), so one run cleared the
# other's lists or wrote into them: a Poll cleared .failed-tickets, the still-running
# Poll before it then added a ticket an answered decision had already put back to
# ready, and the new Poll skipped that ticket as "failed delivery this run" (the
# s6-decisions race).
#
# Now every run gets its OWN directory, $GAFFER_DATA/run-state/<kind>-<pid>-<epoch>,
# exported as GAFFER_RUN_STATE_DIR to its ticks and workers and removed when the run
# ends. Nothing is shared, so nothing is cleared: a fresh run starts with empty lists
# by construction. Readers and writers use ${GAFFER_RUN_STATE_DIR:-$GAFFER_DATA}, so
# a hand-run tick.sh (no run around it) keeps the old $GAFFER_DATA paths.
#
# POLL LOCK: two live Polls also used to tick at the same time, and while the claim
# stops a second delivery of one ticket, the first Poll's tail (removing the worktree
# and branch of a delivery whose claim it lost) could run beside the second Poll's
# fresh delivery of the same ticket. A live Poll now holds $GAFFER_DATA/.poll.lock.d
# (mkdir + the holder's pid, the portable form: macOS has no flock) for its whole
# run. A Poll that finds it held WAITS for the other Poll to finish, up to
# GAFFER_POLL_WAIT_TIMEOUT seconds, then refuses. A lock whose holder is gone is
# taken over at once.
#
# PID REUSE: "gone" is `kill -0 <pid>` failing, and a pid can be reused: after a
# container restart (pids are handed out in the same order again) or a long uptime,
# a Poll killed with SIGKILL can leave a lock whose pid now names an unrelated live
# process. A Poll cannot run longer than its outer tick bound plus the reap grace
# (GAFFER_TICK_OUTER_TIMEOUT + GAFFER_REAP_GRACE, the TERM-to-KILL wait), and the holder
# rewrites its pid file just before its tick starts (gaffer_poll_lock_refresh), so a
# lock whose pid file is older than that bound plus a minute is abandoned whatever its
# pid says, and is taken over. Without that bound such a lock made every later Poll
# wait GAFFER_POLL_WAIT_TIMEOUT and refuse, for as long as the unrelated process lived.

# How long a Poll waits for the Poll already running (seconds). The default is the
# longest a Poll can run (its outer tick bound) plus a minute, so a Poll pressed during
# another Poll's delivery runs after it rather than being refused.
: "${GAFFER_POLL_WAIT_TIMEOUT:=$(( ${GAFFER_TICK_OUTER_TIMEOUT:-5520} + 60 ))}"   # Seconds a live Poll waits for the Poll already running before it refuses.

# The per-run state root.
_gaffer_run_state_root() { printf '%s/run-state' "${GAFFER_DATA:?}"; }

# Remove the run-state dirs whose run is gone. A dir is named <kind>-<pid>-<epoch>
# (kind lower-case letters, pid and epoch digits), and only a real directory of exactly
# that shape whose pid is provably dead is removed: a live run's lists are never
# touched, and nothing else under the root (a symlink, a file, a name of another shape)
# is ever deleted.
gaffer_run_state_sweep() {
  local _root _d _name _kind _rest _pid _epoch
  _root="$(_gaffer_run_state_root)"
  [ -d "$_root" ] || return 0
  for _d in "$_root"/*; do
    [ -d "$_d" ] && [ ! -L "$_d" ] || continue
    _name="${_d##*/}"
    case "$_name" in *-*-*) ;; *) continue ;; esac
    _kind="${_name%%-*}"; _rest="${_name#*-}"; _pid="${_rest%%-*}"; _epoch="${_rest#*-}"
    case "$_kind" in ''|*[!a-z]*) continue ;; esac
    case "$_pid" in ''|*[!0-9]*) continue ;; esac
    case "$_epoch" in ''|*[!0-9]*) continue ;; esac
    [ "$_pid" = "$$" ] && continue
    kill -0 "$_pid" 2>/dev/null && continue
    rm -rf "$_d" 2>/dev/null || true
  done
  return 0
}

# Start this run's state: sweep the dead runs' dirs, create a fresh empty one and
# export it as GAFFER_RUN_STATE_DIR. $1 = kind (loop, poll). Returns 1 (and leaves
# GAFFER_RUN_STATE_DIR unset) when the dir cannot be created; the caller refuses to run
# rather than fall back to a shared path another run may be using.
gaffer_run_state_begin() {
  local _kind="${1:-run}" _root _dir
  case "$_kind" in ''|*[!a-z]*) return 1 ;; esac   # the sweep's name shape
  _root="$(_gaffer_run_state_root)"
  unset GAFFER_RUN_STATE_DIR
  gaffer_run_state_sweep
  mkdir -p "$_root" 2>/dev/null || return 1
  _dir="$_root/$_kind-$$-$(date +%s)"
  # mkdir (no -p) fails if the name exists: a dir is only ever this run's.
  ( umask 077; mkdir "$_dir" ) 2>/dev/null || return 1
  GAFFER_RUN_STATE_DIR="$_dir"
  export GAFFER_RUN_STATE_DIR
  return 0
}

# End this run's state (an EXIT trap): remove the dir this process created.
gaffer_run_state_end() {
  local _dir="${GAFFER_RUN_STATE_DIR:-}"
  case "$_dir" in "$(_gaffer_run_state_root)"/*-"$$"-*) rm -rf "$_dir" 2>/dev/null || true ;; esac
  return 0
}

# Take the poll lock, waiting up to GAFFER_POLL_WAIT_TIMEOUT for a running Poll to
# finish. Says once that it is waiting (on stdout, which the dashboard's run log shows).
# Returns 0 when held, 1 when another Poll still holds it after the wait; the holder's
# pid is then in _GAFFER_POLL_LOCK_HOLDER.
_GAFFER_POLL_LOCK_HELD=0
_GAFFER_POLL_LOCK_HOLDER=""
# The age (seconds) past which a held lock's pid file cannot belong to a running Poll:
# the outer tick bound + the reap grace (gaffer_timeout's TERM-to-KILL wait, 30 s unless
# GAFFER_REAP_GRACE says otherwise) + a minute for the Poll's own steps around its tick.
_gaffer_poll_lock_stale_after() {
  local _o="${GAFFER_TICK_OUTER_TIMEOUT:-5520}" _g="${GAFFER_REAP_GRACE:-30}"
  case "$_o" in ''|*[!0-9]*) _o=5520 ;; esac
  case "$_g" in ''|*[!0-9]*|0) _g=30 ;; esac
  printf '%s' "$(( _o + _g + 60 ))"
}
gaffer_poll_lock_acquire() {
  local _lock="${GAFFER_DATA:?}/.poll.lock.d" _pid _said=0 _waited=0 _nopid=0 _age _stale
  local _limit="${GAFFER_POLL_WAIT_TIMEOUT:-0}"
  case "$_limit" in ''|*[!0-9]*) _limit=0 ;; esac
  _stale="$(_gaffer_poll_lock_stale_after)"
  while ! mkdir "$_lock" 2>/dev/null; do
    _pid="$(cat "$_lock/pid" 2>/dev/null)"
    if [ -n "$_pid" ] && ! kill -0 "$_pid" 2>/dev/null; then
      rm -rf "$_lock" 2>/dev/null || true   # the holder is gone: an abandoned lock
      continue
    fi
    # PID REUSE (header): a live pid on a pid file older than any Poll can run is not
    # the Poll that wrote it.
    if [ -n "$_pid" ] && declare -F _gaffer_lock_age >/dev/null 2>&1; then
      _age="$(_gaffer_lock_age "$_lock/pid")"
      case "$_age" in ''|*[!0-9]*) _age=0 ;; esac
      if [ "$_age" -ge "$_stale" ]; then
        echo "gaffer poll: the poll lock (pid $_pid) is ${_age}s old, older than any Poll runs (${_stale}s): that Poll is gone and the pid is another process now; taking the lock over"
        rm -rf "$_lock" 2>/dev/null || true
        continue
      fi
    fi
    # No pid: the holder is between its mkdir and its pid write, or died there. Give it
    # a few seconds, then treat the lock as abandoned.
    if [ -z "$_pid" ]; then
      _nopid=$((_nopid + 1))
      if [ "$_nopid" -gt 5 ]; then rm -rf "$_lock" 2>/dev/null || true; _nopid=0; continue; fi
    else
      _nopid=0
    fi
    _GAFFER_POLL_LOCK_HOLDER="${_pid:-unknown}"
    if [ "$_waited" -ge "$_limit" ]; then
      return 1
    fi
    if [ "$_said" = 0 ]; then
      echo "gaffer poll: waiting for the poll already running (pid ${_pid:-unknown}) to finish (up to ${_limit}s)"
      _said=1
    fi
    sleep 1
    _waited=$((_waited + 1))
  done
  printf '%s\n' "$$" > "$_lock/pid" 2>/dev/null || true
  _GAFFER_POLL_LOCK_HELD=1
  return 0
}

# Rewrite the holder's pid file just before the tick starts, so the stale bound above
# counts from the tick's start (the tick is what the outer bound limits).
gaffer_poll_lock_refresh() {
  [ "${_GAFFER_POLL_LOCK_HELD:-0}" = 1 ] || return 0
  local _lock="${GAFFER_DATA:?}/.poll.lock.d"
  [ "$(cat "$_lock/pid" 2>/dev/null)" = "$$" ] && printf '%s\n' "$$" > "$_lock/pid" 2>/dev/null
  return 0
}

# Release the poll lock (an EXIT trap). Only the holder removes it.
gaffer_poll_lock_release() {
  [ "${_GAFFER_POLL_LOCK_HELD:-0}" = 1 ] || return 0
  local _lock="${GAFFER_DATA:?}/.poll.lock.d"
  [ "$(cat "$_lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$_lock" 2>/dev/null
  _GAFFER_POLL_LOCK_HELD=0
  return 0
}
