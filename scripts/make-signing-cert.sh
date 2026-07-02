#!/usr/bin/env bash
# One-time setup: create a STABLE self-signed code-signing certificate so macOS
# keeps the Accessibility / Input Monitoring permission across rebuilds.
#
# Why: an unsigned (or ad-hoc) app gets a fresh code identity on every build, so
# macOS TCC treats each reinstall as a brand-new app — it forgets the grant and
# re-prompts, and you have to remove + re-add it. Signing every build with the
# SAME self-signed certificate gives a stable "designated requirement" that TCC
# remembers, so the permission sticks across reinstalls.
#
# This needs no Apple Developer account and costs nothing. The app is still not
# notarized, so Gatekeeper shows "unidentified developer" on first open — open it
# once via right-click > Open (or `xattr -dr com.apple.quarantine`).
#
# Run once:   bash scripts/make-signing-cert.sh
# You'll be asked to authenticate once (to trust the cert for code signing).
# Then rebuild:  bash scripts/build-mac.sh   (it auto-detects and signs with it)
set -euo pipefail

CN="CursorKeyShare Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is macOS-only." >&2
  exit 1
fi

if security find-identity -v -p codesigning | grep -q "$CN"; then
  echo "==> Signing identity '$CN' already exists — nothing to do."
  echo "    Rebuild with: bash scripts/build-mac.sh"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CN
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

echo "==> Generating a self-signed code-signing certificate (valid 10 years)"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 3650 -nodes -config "$TMP/cfg" >/dev/null 2>&1

# -legacy: OpenSSL 3.x's default PKCS#12 MAC can't be read by macOS `security`.
openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/cert.p12" -passout pass:cks -name "$CN" >/dev/null 2>&1

echo "==> Importing into the login keychain"
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P cks -T /usr/bin/codesign >/dev/null

echo "==> Trusting it for code signing (authenticate when prompted)"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

if security find-identity -v -p codesigning | grep -q "$CN"; then
  echo "==> Success. '$CN' is ready."
  echo "    Now rebuild:  bash scripts/build-mac.sh"
else
  echo "!! Identity not found after import — signing will fall back to unsigned." >&2
  exit 1
fi
