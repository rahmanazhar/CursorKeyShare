#!/usr/bin/env bash
# Build the macOS installer(s) for Cursorkeyshare. MUST run on macOS — a signed,
# notarized .dmg with native addons cannot be produced on Windows/Linux
# (hdiutil / codesign / notarytool / lipo are macOS-only).
#
# Produces two per-arch DMGs (arm64 + x64) in dist/. Per-arch is the reliable
# path for this app because it ships native .node modules that @electron/universal
# will not auto-merge.
#
# Optional env for a SIGNED + NOTARIZED release build (omit for an unsigned local
# build you can run after `xattr -dr com.apple.quarantine` / right-click > Open):
#   CSC_LINK                     base64 of a "Developer ID Application" .p12 (or a path)
#   CSC_KEY_PASSWORD             password for that .p12
#   APPLE_ID                     Apple ID email
#   APPLE_APP_SPECIFIC_PASSWORD  app-specific password (appleid.apple.com)
#   APPLE_TEAM_ID                10-char Team ID
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> node $(node -v), npm $(npm -v)"
npm ci

echo "==> generating icon"
npm run build:icon

echo "==> building UNIVERSAL native addon (arm64 + x64, lipo-merged)"
bash scripts/build-native-mac.sh

# Only sign+notarize when a signing certificate AND all notarization credentials
# are present. Notarizing an unsigned app — or with a missing APPLE_* var — is
# rejected/errors, so require all four.
NOTARIZE_FLAG=""
if [[ -n "${CSC_LINK:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "==> signing cert + Apple credentials present — enabling notarization"
  NOTARIZE_FLAG="-c.mac.notarize.teamId=${APPLE_TEAM_ID}"
else
  echo "==> No signing cert/credentials — building UNSIGNED (ad-hoc). Notarization skipped."
  unset CSC_LINK CSC_KEY_PASSWORD 2>/dev/null || true
fi

echo "==> packaging DMGs"
npx electron-builder --mac --arm64 --x64 --publish never ${NOTARIZE_FLAG}

echo "==> results"
ls -lh dist/*.dmg 2>/dev/null || true
for dmg in dist/*.dmg; do
  [[ -e "$dmg" ]] || continue
  echo "--- $dmg"
  spctl -a -vvv -t install "$dmg" 2>&1 || true
  xcrun stapler validate "$dmg" 2>&1 || true
done
echo "==> done"
