#!/usr/bin/env bash
# Build a UNIVERSAL (arm64 + x64) macOS binary of the custom cursorkeyshare-native
# addon and place it at build/Release/cursorkeyshare-native.node.
#
# Why: the addon is packaged as a plain file (build/Release/*.node), NOT as an
# installed node_module, so electron-builder copies that ONE file into BOTH the
# arm64 and x64 DMGs without rebuilding it per-arch. If it were a single-arch
# slice, one of the two DMGs would ship an incompatible binary and fall back to
# the JS backend at runtime. A universal Mach-O works in both. (uiohook-napi ships
# darwin-arm64 + darwin-x64 prebuilds and libnut-darwin is already universal, so
# only this custom addon needs merging.)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "build-native-mac.sh must run on macOS" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# NOTE: electron-rebuild only rebuilds modules under node_modules/, so it can NOT
# build this ROOT binding.gyp addon. Use node-gyp directly, against Electron's
# headers, once per arch. (The addon is N-API, so it's ABI-stable across the
# Node/Electron runtimes; --arch is what selects the Mach-O slice.)
ELECTRON_VER="$(node -p "require('electron/package.json').version")"
HEADERS="https://electronjs.org/headers"
echo "==> electron $ELECTRON_VER"

for ARCH in arm64 x64; do
  echo "==> building cursorkeyshare-native for $ARCH"
  npx node-gyp rebuild --arch="$ARCH" --target="$ELECTRON_VER" --dist-url="$HEADERS"
  cp build/Release/cursorkeyshare-native.node "$TMP/$ARCH.node"
done

echo "==> lipo-merging into a universal binary"
lipo -create "$TMP/arm64.node" "$TMP/x64.node" -output build/Release/cursorkeyshare-native.node
lipo -info build/Release/cursorkeyshare-native.node
