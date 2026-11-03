#!/usr/bin/env bash
# Gera tv/dist/juntos.wgt (Samsung, assinado) e tv/dist/lol.juntos.tv_<versão>_all.ipk (LG).
#   JUNTOS_TV_URL  página que a casca abre (padrão https://juntos.lol/tv)
#   TIZEN_PROFILE  perfil de assinatura do Tizen Studio (padrão blumo-prod)
#   TIZEN_STUDIO   onde o Tizen Studio está (padrão ~/tizen-studio)
set -euo pipefail

TV="$(cd "$(dirname "$0")" && pwd)"
URL="${JUNTOS_TV_URL:-https://juntos.lol/tv}"
PROFILE="${TIZEN_PROFILE:-blumo-prod}"
STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
DIST="$TV/dist"
STAGE="$DIST/stage"

die() {
  echo "build.sh: $*" >&2
  exit 1
}

[[ "$URL" =~ ^https?://[^[:space:]\"\'\<\>\\]+$ ]] || die "JUNTOS_TV_URL inválida: $URL"

export PATH="$STUDIO/tools/ide/bin:$STUDIO/tools:$PATH"
command -v tizen >/dev/null || die "tizen não encontrado em $STUDIO/tools/ide/bin (instale o Tizen Studio ou defina TIZEN_STUDIO)"
command -v ares-package >/dev/null || die "ares-package não encontrado (npm i -g @webos-tools/cli)"

# O CLI do Tizen é Java; o /usr/bin/java do macOS é só um stub quando não há JDK.
if ! java -version >/dev/null 2>&1; then
  for jdk in "${JAVA_HOME:-}" /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk /usr/local/opt/openjdk; do
    if [[ -n "$jdk" && -x "$jdk/bin/java" ]]; then
      export PATH="$jdk/bin:$PATH"
      break
    fi
  done
  java -version >/dev/null 2>&1 || die "o CLI do Tizen precisa de Java (brew install openjdk@21 ou JAVA_HOME)"
fi

PROFILES="$HOME/tizen-studio-data/profile/profiles.xml"
grep -q "name=\"$PROFILE\"" "$PROFILES" 2>/dev/null || die "perfil de assinatura '$PROFILE' não existe em $PROFILES"

rm -rf "$DIST"
mkdir -p "$STAGE/tizen" "$STAGE/webos"

# Samsung: casca local com o iframe.
cp "$TV/tizen/config.xml" "$TV/tizen/icon.png" "$STAGE/tizen/"
cp "$TV/shell/tizen-shell.js" "$STAGE/tizen/"
cp "$TV/shell/tizen.html" "$STAGE/tizen/index.html"
cp "$TV/webos/splash-1920x1080.png" "$STAGE/tizen/splash.png"
printf 'var JUNTOS_TV_URL = "%s"\n' "$URL" >"$STAGE/tizen/config.js"

tizen package -t wgt -s "$PROFILE" -- "$STAGE/tizen"
[[ -f "$STAGE/tizen/juntos.wgt" ]] || die "tizen package não gerou juntos.wgt (veja ~/tizen-studio-data/cli/logs)"
mv "$STAGE/tizen/juntos.wgt" "$DIST/juntos.wgt"

# LG: redireciona para a página.
cp "$TV/webos/appinfo.json" "$TV/webos/icon-80.png" "$TV/webos/icon-130.png" "$TV/webos/splash-1920x1080.png" "$STAGE/webos/"
JUNTOS_TV_URL="$URL" perl -pe 's/__JUNTOS_TV_URL__/$ENV{JUNTOS_TV_URL}/g' "$TV/shell/webos.html" >"$STAGE/webos/index.html"

ares-package "$STAGE/webos" -o "$DIST"

echo
echo "página: $URL"
ls -1 "$DIST"/*.wgt "$DIST"/*.ipk
