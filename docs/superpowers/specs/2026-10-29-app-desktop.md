# App desktop, backend e FFmpeg — spec de 2026-10-29

Três frentes em paralelo (A: Go, B: Rust/FFmpeg, C: app Tauri + web). Esta spec é o contrato entre elas; quem mudar um contrato avisa no relatório.

## Decisões travadas

- App em **Tauri v2** (Windows, macOS, Linux) em `desktop/` no monorepo. Ignore os projetos `~/projects/jlocal` e `~/projects/juntos-app`.
- **Front remoto**: a janela carrega `https://juntos.lol` (em dev, `JUNTOS_URL`). IPC liberada só para esse domínio, com comandos estreitos (nada de shell/fs genérico). Handshake de versão (`protocolVersion`). Sem internet: tela offline local embutida, bonita, no visual do site, que recarrega sozinha quando a rede volta.
- O app é **um produtor pessoal da sala, não um worker da frota**: torrent (fork do librqbit em `ss-worker/vendor/librqbit`), yt-dlp e ffmpeg como sidecar, remux e ponte com o R2 pelo claim de client-media do host. Sem registro na frota, heartbeat, jobs assinados, leases ou cota.
- O host toca do cache local (fMP4/HLS gerado pelo ffmpeg, servido ao webview por protocolo próprio do Tauri ou 127.0.0.1). Rápido como o Stremio.
- **Upload só quando há convidado de navegador.** Sala solo ou só com apps não sobe nada. Mas tudo **engatilhado**: o cache local já tem os segmentos; quando entra alguém de navegador no meio do filme, o app sobe primeiro init + playlist + 2–3 segmentos em volta do playhead (travadinha curta), depois a janela à frente, depois o que já tocou. Seek/volta: o trecho pedido vai na frente da fila.
- Qualidade adaptativa: na VPS, só 480p superfast **sob demanda** (gatilho = telemetria do viewer). No app, o 480p sai por encoder de hardware (VideoToolbox no Mac) e só sobe se houver convidado de navegador que precise.

## Contratos

### Hello do WS (A implementa, C usa)
O hello aceita `client: "desktop"` e `features: ["localSource"]`. O hub guarda no client. `capability` continua sendo só autorização do assento.

### Fonte local (A implementa, C usa)
- `POST /api/rooms/{id}/source` aceita `kind: "local"` com `{ title, durationMs? }`, só do controller. A sala vai para o status novo `"local"` (constante tipada; aproveite para tipar os outros status). Gera geração nova como qualquer troca de fonte. `HasMedia()` verdadeiro; o gate de buffer funciona entre apps; reclaim trata `local` como sem trabalho pendente.
- Evento do hub ao host (controller), `{ "type": "needBrowserMedia", "generation": n }`: enviado quando a sala está `local` (ou `uploading` vindo de local) e há pelo menos um membro sem `localSource`; reenviado quando o host reconecta. `{ "type": "browserMediaIdle" }` quando o último membro sem `localSource` sai.
- `POST /api/rooms/{id}/local/promote` (sessão do controller): transição atômica `local → uploading` **sem trocar a geração nem zerar o relógio**. Responde no mesmo formato do endpoint de claim de client-media que já existe (claim, runId, metadataToken etc.). A publicação esparsa a partir do meio do filme usa as regiões que já existem (`/client-media/run`, `MediaRegions`).
- Ao `browserMediaIdle`, o app para de subir; o que já está no R2 fica. A sala continua `uploading` (não volta para `local`).
- Convidado de navegador numa sala `local`/`uploading` sem mídia ainda vê "preparando" curto, não erro, e não segura o gate dos outros enquanto não houver mídia.

### Renditions (A e B)
- `remuxStart` ganha `renditions: ["480p"]` opcional (contrato versionado em `internal/remux` e `ss-remux/src/protocol.rs`).
- B: com `480p`, o ss-remux gera uma segunda variante libx264 superfast 480p com `-force_key_frames source` (keyframes alinhados), e o master escrito pelo publicador (`publish.rs`) lista as duas variantes, por região. Sem o campo, nada muda.
- A: gatilho pela telemetria (`bandwidthKbps < 1.3 × mediaKbps` ou stalls repetidos de algum viewer, ver `telemetry.go`), liga `renditions` para os próximos runs da sala. Uma vez ligado, fica ligado até trocar de fonte.
- O player (hls.js) já faz ABR e mostra o menu de qualidade com >1 nível.

## Frente A — backend Go
1. Vazamentos: `byRoom`/`follows` em `internal/worker/remux.go` e `lastSwarm` em `cmd/server/main.go` limpos no `CancelRoom`/fim da sala.
2. `go onPosition(...)` em `internal/sync/hub.go:~1056`: posições não podem chegar fora de ordem (serializar por sala ou carimbar seq e descartar velhas).
3. Erros engolidos de `saveRun`, `SetLive`, `RemoveMember`: logar (ou propagar onde importa).
4. Testes para Follow/debounce/reinício/`applyReport` do orquestrador e para `gate.go`.
5. Contratos acima (hello, `local`, `needBrowserMedia`, `promote`, renditions + gatilho).
6. Duplicação `changeSource`/`CloseStage` e o "carrega sala + checa expiração" repetido: extrair se ficar simples.

## Frente B — Rust e FFmpeg
1. Workspace Cargo na raiz: `crates/librqbit` (o fork, saindo de `ss-worker/vendor`), `crates/ss-torrent` (window, fill, local, TorrentFiles, ByteSource, range), `crates/ss-youtube` (select, plan_for, Resolver, HttpSource), `crates/ss-remux` (depende dos dois; `live/`/MoQ atrás de feature `live`, ligada só no worker). `ss-worker` vira membro. Um `Cargo.lock`, um `target/`. Atualizar `ss-worker/Dockerfile` (contexto na raiz), `.dockerignore`, `docker-compose.yml` e o que mais referenciar os caminhos (scripts de deploy, docs). Deixe `desktop/src-tauri` como membro previsto (C cria a pasta; se não existir na sua branch, deixe comentado).
2. FFmpeg: `-aac_coder fast` nas faixas convertidas; ffprobe de keyframe em paralelo com o probe de streams; menos aberturas do torrent (reaproveitar o probe; `-probesize`/`-analyzeduration` menores no ffmpeg). Medido: AC3→AAC é ~85% do custo do remux.
3. Dockerfile do worker com **FFmpeg 8.1.3 estático** (build BtbN fixado por versão e sha256) no lugar do apt. Garantir que os testes de dublagem atrasada (`tfdt`/`frag_discont`) continuam passando.
4. Renditions 480p (contrato acima), com encoder configurável (`libx264` superfast por padrão; `h264_videotoolbox` disponível para o app no macOS).
5. Remover deps sem uso (`hex`, `sha2`, `tokio-stream`, `http-body-util` no worker, `hang` no ss-remux — confirmar com `cargo machete` ou grep).
6. Limpeza do repo: `dump.rdb`, `output/` (se não referenciado), `node_modules/` vazio da raiz, `web/dev/presence-replaced.png`, `.worktrees/` vazio; CI em `.github/workflows/` com `go test ./...`, `cargo test --workspace` (sem o desktop) e `npm test`/`npm run build` do web.

## Frente C — app Tauri + web
1. `desktop/` com Tauri v2: janela carregando o site remoto, capability IPC restrita ao domínio, comandos estreitos, handshake de versão, tela offline local que volta sozinha.
2. Núcleo local em Rust: torrent pelo librqbit (fork) com `torrent::local` do ss-remux (hoje em `ss-worker/ss-remux`; B vai mover para `crates/` — use o caminho atual, o merge ajusta), YouTube pelo Resolver do ss-remux com yt-dlp sidecar, ffmpeg sidecar. Remux para cache local fMP4/HLS com teto (~20 GB, LRU). Servir ao player do webview por protocolo próprio (`juntos-media://` ou o equivalente por plataforma) com Range; fallback 127.0.0.1.
3. Upload engatilhado: ao `needBrowserMedia`, `POST .../local/promote`, depois fila com prioridade (playhead → à frente → o que já tocou; seek fura a fila) usando o uploader do ss-remux (`upload.rs`, presign em lote por claim). Para no `browserMediaIdle`.
4. 480p por hardware no app (VideoToolbox no Mac; libx264 fora) só quando houver convidado de navegador com banda baixa — pode ficar atrás de uma flag se o gatilho do servidor ainda não estiver pronto.
5. Web (`web/src`): `platform.ts` (`isDesktop`, ponte para a IPC do Tauri), substituindo a costura do jlocal onde o app entra (torrent, YouTube); com o app, a sala nasce com `kind: "local"` e o player toca do cache local; tratar `needBrowserMedia`/`browserMediaIdle`; esconder o botão "Baixar o app" (`components/DownloadApp.tsx`) dentro do app; estado "preparando" do convidado.
6. Release: macOS com o mesmo fluxo de `~/projects/stickyyy/app/scripts` (`signing-identity.sh`, `notarize.sh`, `make-dmg.sh`, `make-release.sh`: Developer ID do time FlashZ `2Y79CQGUMY`, chave ASC `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`, hardened runtime, assinatura de dentro para fora incluindo os sidecars, DMG, notarização e staple). Universal (arm64 + x86_64). Updater do Tauri com chave própria (gerar e guardar fora do repo, só a pública no config). Workflow do GitHub Actions para Windows (`Juntos-setup.exe`) e Linux (`Juntos.AppImage`) disparado por tag `desktop-v*`, subindo para o GitHub Release. Nomes estáveis dos assets: `Juntos.dmg`, `Juntos-setup.exe`, `Juntos.AppImage` (o modal do site aponta para `releases/latest/download/<nome>`).

## Visual
`CLAUDE.md` do repo: base lawcore (`lawcore-design-eng`), spring popover, **sem subdescrição**. Tokens de `web/src/theme.css`.
