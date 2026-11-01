#!/usr/bin/env bash
# A fake `docker` CLI for the daemon-free docker-provider tests
# (runner/test/sandbox-docker-delivery-seam.test.sh). Install it as `docker` first on
# PATH. Every call is RECORDED; `docker run --rm … <image> <cmd…>` then RUNS <cmd…> on
# this host, so the real wrapper (lib/sandbox-docker.sh), the real worker seam and the
# real DoD runner drive a real delivery without a daemon. It is NOT a sandbox: nothing
# is isolated, which is why the seam test asserts the containment from the recorded
# argv (what would have been mounted / forwarded) and leaves the in-container proof to
# sandbox-docker-delivery.test.sh on a real daemon.
#
#   FAKE_DOCKER_LOG   directory; each call writes <n>.argv (NUL-separated argv) and
#                     appends "<n> <subcommand>" to calls.txt
# What it answers:
#   info / version / build / image / network / rm / ps (empty) / run -d  → exit 0
#   run --rm …       -e KEY (value from this env) and -e KEY=VAL become the ONLY env of
#                    the command (env -i, like a fresh container), -w is its cwd; -v,
#                    --tmpfs and the hardening flags are recorded and otherwise ignored.
set -u
LOG="${FAKE_DOCKER_LOG:?FAKE_DOCKER_LOG must name a directory}"
mkdir -p "$LOG"
n="$(wc -l < "$LOG/calls.txt" 2>/dev/null | tr -d ' ')"; n=$(( ${n:-0} + 1 ))
printf '%s\0' "$@" > "$LOG/$n.argv"
printf '%s %s\n' "$n" "${1:-}" >> "$LOG/calls.txt"

case "${1:-}" in
  info | version | build | image | network | rm | kill | stop) exit 0 ;;
  ps) exit 0 ;;   # nothing running: the wrapper (re)starts its egress proxy, also faked
  run) shift ;;
  *) echo "fake-docker: unsupported subcommand '${1:-}'" >&2; exit 2 ;;
esac

detached=0; workdir=""; envs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d | --detach) detached=1; shift ;;
    --rm | -i | -t | --init) shift ;;
    -e | --env)
      case "$2" in
        *=*) envs+=( "$2" ) ;;
        *) if v="$(printenv "$2")"; then envs+=( "$2=$v" ); fi ;;   # like docker: exported vars only
      esac
      shift 2 ;;
    -w | --workdir) workdir="$2"; shift 2 ;;
    -v | --volume | --tmpfs | --network | --name | --pids-limit | --memory | --cpus | --user | -u | --security-opt | --cap-add | --cap-drop | --mount | --alias)
      shift 2 ;;
    --*=*) shift ;;
    -*) echo "fake-docker: unsupported run flag '$1'" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ "$detached" = 1 ] && exit 0
[ "$#" -ge 1 ] || { echo "fake-docker: run needs an image" >&2; exit 2; }
shift   # the image
[ "$#" -ge 1 ] || exit 0
if [ -n "$workdir" ]; then cd "$workdir" || exit 125; fi
exec env -i ${envs[@]+"${envs[@]}"} "$@"
