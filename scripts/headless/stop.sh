#!/usr/bin/env bash
# Stops a headless RiftLauncher started by launch.sh. Kills the given PID
# only: a pattern match (pkill -f riftlauncher, killall electron, ...) has
# taken down the caller's own shell and other agents' launcher instances
# before, since more than one of these can be running at once on the same
# machine.
#
# Usage: scripts/headless/stop.sh <pid>
set -euo pipefail

pid="${1:?usage: stop.sh <pid>}"

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
