#!/bin/zsh
# Sobe a release do Mac (feita por make-release.sh) para o GitHub Release da
# versão e refaz o latest.json e o SHA256SUMS.txt com o que a release já tem.
#   ./scripts/publish-mac.sh            (versão do tauri.conf.json)
# A release `desktop-vX.Y.Z` é criada aqui se o CI ainda não a criou.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${JUNTOS_REPO:-giulianoo0/juntos.lol}"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="desktop-v$VERSION"
OUT=build/release

for f in Juntos.dmg Juntos.app.tar.gz Juntos.app.tar.gz.sig; do
  [[ -f "$OUT/$f" ]] || { echo "error: $OUT/$f missing; run make-release.sh" >&2; exit 1 }
done
xcrun stapler validate -q "$OUT/Juntos.dmg" || echo "warning: Juntos.dmg is not stapled" >&2

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$REPO" --title "Juntos $VERSION" --notes-file NOTAS.md --latest
fi
gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/Juntos.dmg" "$OUT/Juntos.app.tar.gz" "$OUT/Juntos.app.tar.gz.sig"
node scripts/release-manifest.mjs "$REPO" "$TAG"
gh release edit "$TAG" --repo "$REPO" --latest
echo "Publicado: https://github.com/$REPO/releases/tag/$TAG"
