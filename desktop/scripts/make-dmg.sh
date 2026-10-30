#!/bin/zsh
# Builds a drag-to-Applications DMG from an already-signed Juntos.app.
#   ./scripts/make-dmg.sh build/release/build/release/Juntos.app build/release/Juntos.dmg
# Set JUNTOS_DMG_LAYOUT=0 to skip the Finder window layout (AppleScript).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:?usage: make-dmg.sh <app> <dmg>}"
DMG="${2:?usage: make-dmg.sh <app> <dmg>}"
VOL="Juntos"
ICON_SRC=../logos/juntos-icon-1024.png

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
RW="$WORK/rw.dmg"
mkdir -p "$STAGE"

# Volume icon: 1024 PNG → iconset → icns.
ICONSET="$WORK/Juntos.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/VolumeIcon.icns"

ditto "$APP" "$STAGE/Juntos.app"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs APFS -format UDRW -quiet "$RW"

# Mount visibly: Finder needs to see it for the layout.
MOUNT=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')

if [[ "${JUNTOS_DMG_LAYOUT:-1}" == 1 ]]; then
  DISK=$(basename "$MOUNT")
  # Best effort: needs Automation permission for Finder; a failure only loses the layout.
  perl -e 'alarm 30; exec @ARGV' osascript <<EOF || echo "note: Finder layout skipped."
tell application "Finder"
  tell disk "$DISK"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 740, 460}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 112
    set position of item "Juntos.app" of container window to {140, 160}
    set position of item "Applications" of container window to {400, 160}
    update without registering applications
    delay 1
    close
  end tell
end tell
EOF
fi
# Volume icon goes in AFTER the Finder pass: Finder drops .VolumeIcon.icns and
# the custom-icon bit when it rewrites the volume's .DS_Store.
cp "$WORK/VolumeIcon.icns" "$MOUNT/.VolumeIcon.icns"
xattr -wx com.apple.FinderInfo \
  "0000000000000000040000000000000000000000000000000000000000000000" "$MOUNT"
sync
hdiutil detach "$MOUNT" -quiet || { sleep 2; hdiutil detach "$MOUNT" -force -quiet; }

rm -f "$DMG"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -quiet -o "$DMG"

source ./scripts/signing-identity.sh
if [[ "$IDENTITY" != "-" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
fi
echo "Built $DMG (signed: $IDENTITY)"
