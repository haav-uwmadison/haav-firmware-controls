#!/usr/bin/env bash
# Build (if needed) and run mission_daemon. Extra arguments go to the daemon, e.g. ./daemon/run.sh --sim
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v cmake >/dev/null; then
  echo "cmake not found. macOS: brew install cmake ninja sdl2   Linux: sudo apt install cmake ninja-build g++ libsdl2-dev" >&2
  exit 1
fi

GEN=()
command -v ninja >/dev/null && GEN=(-G Ninja)

# Apple's newest SDK stubs sometimes confuse older linkers; prefer the latest SDK the linker accepts.
if [[ "$(uname)" == "Darwin" && -z "${SDKROOT:-}" ]]; then
  for sdk in /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk; do
    if [[ -d "$sdk" ]] && printf 'int main(){}' | clang -isysroot "$sdk" -x c - -o /dev/null 2>/dev/null; then
      export SDKROOT="$sdk"
    fi
  done
fi

cmake -S . -B build "${GEN[@]}" -DCMAKE_BUILD_TYPE=Release ${SDKROOT:+-DCMAKE_OSX_SYSROOT="$SDKROOT"} >/dev/null
cmake --build build --parallel --config Release
BIN=build/mission_daemon
[[ -x "$BIN" ]] || BIN=build/Release/mission_daemon
exec "$BIN" "$@"
