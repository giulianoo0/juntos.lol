#!/usr/bin/env bash
# Baixa os sidecars de sidecars.lock para desktop/sidecars/, conferindo o sha256:
#   ./scripts/fetch-sidecars.sh macos     (ffmpeg/ffprobe universais via lipo, yt-dlp universal)
#   ./scripts/fetch-sidecars.sh windows
#   ./scripts/fetch-sidecars.sh linux
# Os nomes saem como o Tauri pede no externalBin: <ferramenta>-<triple>[.exe].
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORM="${1:?uso: fetch-sidecars.sh macos|windows|linux}"
OUT=sidecars
CACHE=build/sidecar-cache
mkdir -p "$OUT" "$CACHE"

sha() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Baixa uma vez para o cache e recusa qualquer byte que não bata com o lock.
fetch() {
  local url=$1 want=$2 file="$CACHE/$(basename "$url")"
  if [[ ! -f "$file" || "$(sha "$file")" != "$want" ]]; then
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  local got
  got=$(sha "$file")
  if [[ "$got" != "$want" ]]; then
    echo "error: sha256 de $url é $got, o lock pede $want" >&2
    exit 1
  fi
  printf '%s' "$file"
}

# Tira um membro de um zip ou tar.xz para um arquivo.
extract() {
  local archive=$1 member=$2 dest=$3
  local work
  work=$(mktemp -d)
  case "$archive" in
    *.zip) unzip -q -o "$archive" "$member" -d "$work" ;;
    *.tar.xz) tar -xJf "$archive" -C "$work" "$member" ;;
    *) echo "error: formato desconhecido: $archive" >&2; exit 1 ;;
  esac
  mv "$work/$member" "$dest"
  rm -rf "$work"
  chmod +x "$dest"
}

entry() {
  # ferramenta plataforma -> "sha membro url"
  awk -v t="$1" -v p="$2" '$1 == t && $2 == p { print $3, $4, $5 }' sidecars.lock
}

place() {
  local tool=$1 platform=$2 dest=$3
  read -r want member url < <(entry "$tool" "$platform")
  [[ -n "${url:-}" ]] || { echo "error: $tool $platform fora do lock" >&2; exit 1; }
  local file
  file=$(fetch "$url" "$want")
  if [[ "$member" == "-" ]]; then
    cp "$file" "$dest"
    chmod +x "$dest"
  else
    extract "$file" "$member" "$dest"
  fi
}

case "$PLATFORM" in
  macos)
    for tool in ffmpeg ffprobe; do
      place "$tool" macos-arm64 "$CACHE/$tool-arm64"
      place "$tool" macos-x86_64 "$CACHE/$tool-x86_64"
      lipo -create "$CACHE/$tool-arm64" "$CACHE/$tool-x86_64" -output "$OUT/$tool-universal-apple-darwin"
      cp "$CACHE/$tool-arm64" "$OUT/$tool-aarch64-apple-darwin"
      cp "$CACHE/$tool-x86_64" "$OUT/$tool-x86_64-apple-darwin"
    done
    place yt-dlp macos-universal "$OUT/yt-dlp-universal-apple-darwin"
    cp "$OUT/yt-dlp-universal-apple-darwin" "$OUT/yt-dlp-aarch64-apple-darwin"
    cp "$OUT/yt-dlp-universal-apple-darwin" "$OUT/yt-dlp-x86_64-apple-darwin"
    ;;
  windows)
    for tool in ffmpeg ffprobe yt-dlp; do
      place "$tool" windows-x86_64 "$OUT/$tool-x86_64-pc-windows-msvc.exe"
    done
    ;;
  linux)
    for tool in ffmpeg ffprobe yt-dlp; do
      place "$tool" linux-x86_64 "$OUT/$tool-x86_64-unknown-linux-gnu"
    done
    ;;
  *) echo "error: plataforma desconhecida: $PLATFORM" >&2; exit 2 ;;
esac
ls -l "$OUT"
