#!/usr/bin/env bash
# Regera os PNGs da TV a partir dos SVGs desta pasta (rsvg-convert + magick).
# Sem canal alfa: a loja da LG e a da Samsung querem fundo sólido.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../tizen ../webos

png() { rsvg-convert -w "$2" -h "$3" "$1" | magick - -alpha off "$4"; }

png icon.svg 512 512 ../tizen/icon.png
png icon.svg 80 80 ../webos/icon-80.png
png icon.svg 130 130 ../webos/icon-130.png
png splash.svg 1920 1080 ../webos/splash-1920x1080.png
