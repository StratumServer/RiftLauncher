#!/usr/bin/env bash
# Stops a headless RiftLauncher started by launch.sh. Kills the given PID
# only: a pattern match (pkill -f riftlauncher, killall electron, ...) has
# taken down the caller's own shell and other agents' launcher instances
# before, since more than one of these can be running at once on the same
# machine.
#
# Usage: scripts/headless/stop.sh <pid>
set -euo pipefail

usage() {
  echo "usage: stop.sh <pid>" >&2
  exit 1
}

[ $# -eq 1 ] || usage

pid="$1"

# Digits only, no leading zero, greater than 1, before anything is signalled.
# kill(2) treats a pid of 0 (or a negative pid) as "every process in a group",
# which is how "stop.sh 0" has taken down a caller's whole session before;
# pid 1 is init, never a headless launcher. This also refuses "00", "1e3",
# " 12", "-1" and empty input, none of which are a bare positive pid.
[[ "$pid" =~ ^[1-9][0-9]{0,9}$ ]] || usage
[ "$pid" -gt 1 ] || usage

# Confirm the pid is still the launcher before signalling it. launch.sh backs
# `timeout 600 dist/linux-unpacked/riftlauncher ...` and prints that timeout's
# pid; the kernel can recycle it for an unrelated process between then and a
# late stop.sh call, and a raw pid argument alone cannot tell the difference.
if [ -d /proc ]; then
  cmdline="/proc/$pid/cmdline"
  if [ ! -r "$cmdline" ]; then
    echo "error: no such process: $pid" >&2
    exit 1
  fi
  if ! tr '\0' '\n' <"$cmdline" | grep -qF "dist/linux-unpacked/riftlauncher"; then
    echo "error: pid $pid is not a headless riftlauncher launch" >&2
    exit 1
  fi
else
  # No /proc on this platform (e.g. macOS): nothing to read the command line
  # from, so the pid is trusted once it has passed the argument check above.
  :
fi

if ! kill "$pid" 2>/dev/null; then
  echo "error: no such process: $pid" >&2
  exit 1
fi

for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || exit 0
  sleep 0.5
done

# Still around after 10s of asking nicely: timeout(1) forwards the signal it
# receives to the launcher process it wraps, but a stuck renderer can outlive
# that. One SIGKILL on the same PID, still not a pattern match.
kill -9 "$pid" 2>/dev/null || true
