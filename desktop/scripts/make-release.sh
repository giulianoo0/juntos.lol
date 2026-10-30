#!/bin/zsh
# Release do Mac, local: sidecars → tauri build universal (sem assinar) →
# Developer ID de dentro para fora (sidecars, depois o app; hardened runtime)
# → DMG → notarização + staple (DMG e app) → pacote do updater assinado.
#   ./scripts/make-release.sh
# Saída em build/release/: Juntos.dmg, Juntos.app.tar.gz e Juntos.app.tar.gz.sig.
# A chave do updater fica fora do repo, em ~/.tauri/juntos-updater.key
# (ou TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PATH).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=build/release
ENTITLEMENTS=src-tauri/entitlements.plist
UPDATER_KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/juntos-updater.key}"
mkdir -p "$OUT"

./scripts/fetch-sidecars.sh macos >/dev/null
npm ci --silent

# Sem identidade e sem pacote do updater, o Tauri não assina nada: o app é
# assinado e notarizado abaixo, e só então o pacote do updater é montado.
env -u APPLE_SIGNING_IDENTITY -u TAURI_SIGNING_PRIVATE_KEY \
  npx tauri build --target universal-apple-darwin --bundles app --config src-tauri/tauri.release.conf.json \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

BUILT=$(ls -d "${CARGO_TARGET_DIR:-src-tauri/target}"/universal-apple-darwin/release/bundle/macos/Juntos.app)
APP="$OUT/Juntos.app"
rm -rf "$APP"
ditto "$BUILT" "$APP"
xattr -cr "$APP"

source ./scripts/signing-identity.sh
SIGN=(codesign --force --sign "$IDENTITY")
(( IS_DEVELOPER_ID )) && SIGN+=(--options runtime --timestamp)

# De dentro para fora, sem --deep: os sidecars primeiro, depois o app, que é
# o único a levar as entitlements.
for tool in ffmpeg ffprobe yt-dlp; do
  "${SIGN[@]}" "$APP/Contents/MacOS/$tool"
done
"${SIGN[@]}" --entitlements "$ENTITLEMENTS" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "Signed $APP ($IDENTITY)"

DMG="$OUT/Juntos.dmg"
rm -f "$DMG"
./scripts/make-dmg.sh "$APP" "$DMG"

# Notariza antes de qualquer hash: o staple reescreve a imagem. O ticket do
# DMG cobre o app de dentro, que também recebe o staple para o updater.
./scripts/notarize.sh "$DMG"
if (( IS_DEVELOPER_ID )); then
  xcrun stapler staple "$APP" || echo "note: app not stapled (notarization skipped?)"
fi

TARBALL="$OUT/Juntos.app.tar.gz"
rm -f "$TARBALL" "$TARBALL.sig"
# Sem os ._* do macOS: o updater do Tauri não extrai esses arquivos e a atualização falha.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$TARBALL" -C "$OUT" Juntos.app
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  npx tauri signer sign -k "$TAURI_SIGNING_PRIVATE_KEY" -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$TARBALL"
else
  npx tauri signer sign -f "$UPDATER_KEY" -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$TARBALL"
fi

VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
echo "Release do Mac pronta (Juntos $VERSION):"
for f in "$DMG" "$TARBALL" "$TARBALL.sig"; do
  echo "  $f ($(du -h "$f" | awk '{print $1}'))  sha256 $(shasum -a 256 "$f" | awk '{print $1}')"
done
