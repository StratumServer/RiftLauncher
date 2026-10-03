#!/usr/bin/env bash
# Launches the packaged RiftLauncher build headless, against a seeded profile
# (see seed.mjs), and prints its PID. Never opens a window (--ozone-platform=
# headless), never touches a real player's profile (XDG_* point at the given
# folder only), and is killed on its own after 10 minutes if nothing stops it
# first.
#
# ELECTRON_FORCE_IS_PACKAGED and APPIMAGE are unset before launch: shell state
# for a developer build or AppImage install must not change this packaged run.
#
# Usage: scripts/headless/launch.sh <profileRoot> <port>
set -euo pipefail

profile="${1:?usage: launch.sh <profileRoot> <port>}"
port="${2:?usage: launch.sh <profileRoot> <port>}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
binary="$repo_root/dist/linux-unpacked/riftlauncher"

if [ ! -x "$binary" ]; then
  echo "error: $binary not found. Run npm run build:unpack first." >&2
  exit 1
fi

mkdir -p "$profile/config" "$profile/cache" "$profile/data"

XDG_CONFIG_HOME="$profile/config" \
XDG_CACHE_HOME="$profile/cache" \
XDG_DATA_HOME="$profile/data" \
  env -u ELECTRON_FORCE_IS_PACKAGED -u APPIMAGE \
  timeout 600 "$binary" --ozone-platform=headless --disable-gpu --remote-debugging-port="$port" --no-sandbox \
  >"$profile/launch.log" 2>&1 &

echo $!
