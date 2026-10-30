#!/bin/zsh
# Sourced, never executed: resolves $IDENTITY (the code-signing identity for the
# .app and the .dmg) and the App Store Connect API key used by notarize.sh.
# Same resolution as ~/projects/stickyyy/app/scripts/signing-identity.sh:
#
#   1. "Developer ID Application: …" — the only cert notarization accepts.
#      When several exist, the one whose team matches the ASC key's team wins.
#   2. "flashz" — the shared self-signed identity across ~/projects (local only).
#   3. "-" — ad-hoc.

# Defaults: the FlashZ team (FLASHZ SERVICOS DIGITAIS LTDA, 2Y79CQGUMY).
ASC_KEY_ID="${ASC_KEY_ID:-3694H9FGLS}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-d9587169-052a-4ca2-b0a2-dee63d28840a}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
ASC_TEAM_ID="${ASC_TEAM_ID:-2Y79CQGUMY}"

IDENTITY="${JUNTOS_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="-"
  _ids=$(security find-identity -v -p codesigning 2>/dev/null || true)
  _devids=$(print -r -- "$_ids" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | sort -u)
  _match=""
  for _cand in ${(f)_devids}; do
    [[ -n "$_cand" && "$_cand" == *"($ASC_TEAM_ID)" ]] && { _match="$_cand"; break }
  done
  if [[ -n "$_match" ]]; then
    IDENTITY="$_match"
  elif [[ -n "$_devids" ]]; then
    IDENTITY="${${(f)_devids}[1]}"
    echo "warning: no Developer ID for ASC team $ASC_TEAM_ID; using '$IDENTITY' — notarization will likely fail." >&2
  elif print -r -- "$_ids" | grep -q '"flashz"'; then
    IDENTITY="flashz"
  fi
  unset _ids _devids _match _cand
fi

[[ "$IDENTITY" == "-" ]] && echo "note: signing ad-hoc."
IS_DEVELOPER_ID=0
[[ "$IDENTITY" == "Developer ID Application:"* ]] && IS_DEVELOPER_ID=1
