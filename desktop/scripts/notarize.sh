#!/bin/zsh
# Notarizes and staples a DMG (same flow and ASC key as Skrivo Audio):
#   ./scripts/notarize.sh build/release/Juntos.dmg
# Credentials: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH (defaults in signing-identity.sh).
# Stapling rewrites the image, so hash the DMG *after* this returns.
set -euo pipefail
cd "$(dirname "$0")/.."

DMG="${1:?usage: notarize.sh <dmg>}"
[[ -f "$DMG" ]] || { echo "error: no such image: $DMG" >&2; exit 2 }

AUTH=$(codesign -dv --verbose=2 "$DMG" 2>&1 | sed -n 's/^Authority=//p' | head -1)
if [[ "$AUTH" != "Developer ID Application:"* ]]; then
  echo "note: $DMG is signed by '${AUTH:-nothing}' — only Developer ID code can be notarized. Skipping."
  exit 0
fi

source ./scripts/signing-identity.sh >/dev/null
if [[ ! -f "$ASC_KEY_PATH" ]]; then
  echo "note: $ASC_KEY_PATH missing — skipping notarization." >&2
  exit 0
fi
if [[ "$AUTH" != *"($ASC_TEAM_ID)" ]]; then
  echo "warning: DMG signed by '$AUTH' but ASC key $ASC_KEY_ID is team $ASC_TEAM_ID." >&2
fi

echo "Notarizing $DMG with key $ASC_KEY_ID (waits on Apple)…"
LOG=$(mktemp)
xcrun notarytool submit "$DMG" \
  --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
  --wait --timeout 30m --output-format json | tee "$LOG"
ID=$(plutil -extract id raw "$LOG" 2>/dev/null || true)
STATUS=$(plutil -extract status raw "$LOG" 2>/dev/null || true)
rm -f "$LOG"
echo "submission $ID: $STATUS"
if [[ "$STATUS" != "Accepted" ]]; then
  [[ -n "$ID" ]] && xcrun notarytool log "$ID" \
    --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" >&2 || true
  exit 1
fi

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -v "$DMG"
echo "Notarized and stapled: $DMG"
