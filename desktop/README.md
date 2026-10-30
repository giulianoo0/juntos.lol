# Juntos (app)

Tauri v2 que abre o juntos.lol e prepara torrent e YouTube no PC.

## Desenvolver

    npm ci
    JUNTOS_URL=http://localhost:5173 npx tauri dev

`JUNTOS_UPDATE_URL` troca o endpoint do updater (para testar com um
`latest.json` servido local).

## Release

Tudo vai para o GitHub Release `desktop-vX.Y.Z` de `giulianoo0/juntos.lol`
(`Juntos.dmg`, `Juntos-setup.exe`, `Juntos.AppImage`, `SHA256SUMS.txt`,
`latest.json`). Notas curtas em `NOTAS.md`.

1. Suba a versão em `src-tauri/tauri.conf.json` e `src-tauri/Cargo.toml`.
2. Windows e Linux: `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`
   (ou rode o workflow `desktop` à mão com a tag).
3. Mac, nesta máquina:

       ./scripts/make-release.sh   # sidecars, build universal, assina, DMG, notariza
       ./scripts/publish-mac.sh    # sobe e refaz latest.json e SHA256SUMS.txt

A ordem entre 2 e 3 tanto faz: cada lado refaz o `latest.json` com o que a
release já tem.

## Chaves

- Updater: privada em `~/.tauri/juntos-updater.key` (fora do repo); a pública
  está em `tauri.conf.json`. No GitHub, o secret `TAURI_SIGNING_PRIVATE_KEY`
  leva o conteúdo do arquivo. Sem essa chave, os apps instalados não aceitam
  mais atualização.
- Mac: Developer ID e chave do App Store Connect, resolvidos por
  `scripts/signing-identity.sh`.

## Sidecars

ffmpeg, ffprobe e yt-dlp vêm das fontes oficiais com sha256 fixo em
`sidecars.lock`; `scripts/fetch-sidecars.sh macos|windows|linux` baixa e
confere. O yt-dlp roda de uma cópia no diretório de dados para se atualizar.
