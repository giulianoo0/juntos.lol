# YouTube live como fonte de sala (MoQ)

Data: 2026-09-11. Aprovado em chat.

## Objetivo
Uma live do YouTube vira a fonte de uma sala. Não há timeline, seek, pausa
sincronizada nem "voltar": todo mundo assiste ao vivo pelo relay MoQ "juntos"
(Cloudflare), o mesmo do screen share. Um botão "Ir para o vivo" descarta o
buffer acumulado e reassina no grupo mais novo.

## Produtores (iguais em comportamento)
- jlocal (preferido quando conectado e com ferramentas).
- ss-worker na frota (para quem não tem o jlocal). Sai pelo mesmo proxy do YouTube.

Ambos usam o módulo `live` do crate `ss-remux`:
1. `yt-dlp -J`: exige `is_live`; escolhe a variante H.264 mais alta ≤1080p
   (`protocol` m3u8) e a faixa de áudio m3u8 de maior bitrate.
2. `ffmpeg -i video.m3u8 -i audio.m3u8 -c copy -f mpegts -` (proxy via
   `-http_proxy`), reconectando em queda.
3. stdout do ffmpeg → `moq_mux` importador TS (container legacy, catálogo hang)
   → `moq_native` cliente conectado a `<relay>/<token>`, broadcast
   `juntos/{sala}/{segredo}/live.hang`.
4. Estado exposto: `starting | live | ended | failed {code}`; codes reutilizam
   `youtube_blocked|unavailable|unsupported|tool` + `not_live`.

## Servidor (Go)
- Sala: `sourceKind: "live"`, `status: "ready"` quando o produtor reporta
  `live`, `live: {videoId, title, thumbnail, producer: "fleet"|"jlocal",
  broadcast}`. `screenSecret` reaproveitado para o caminho. Estado de playback
  não se aplica (viewer não manda play/pause).
- Tokens MoQ: `GET /rooms/:id/live/relay` devolve `{url}` de subscribe para
  membros; o de publish vai ao worker dentro do job, ou ao site (controlador)
  para repassar ao jlocal.
- Frota: `POST /api/youtube/live` `{url}` → job `youtube-live` num worker com
  yt-dlp e slot livre; `GET /api/youtube/live/:job`; `DELETE`. O job vive até
  troca de fonte, sala idle/reclaim ou fim da live. Heartbeat do worker
  informa `live` e o Go marca `ready`; `ended|failed` vira `error`
  (`error_message` = code).
- jlocal: o site chama `POST /rooms/:id/live/start` `{memberId, capability,
  videoId, title}` (controlador) para o Go registrar `sourceKind live` e
  devolver `{broadcast, publishUrl}`; o site manda ao jlocal
  `POST /youtube/live/start` e reporta `POST /rooms/:id/live/state` `{state}`.

## Site
- `youtube.ts`: `YoutubeSummary.live: boolean`; picker mostra "AO VIVO".
- `startYoutubeLive(roomId, session)`: backend jlocal → frota.
- `LiveStage`: assinante MoQ (mesmo `@moq/watch` do `ScreenStage`), tela cheia,
  badge "AO VIVO", atraso estimado e botão "Ir para o vivo" (reassina). Player
  de HLS não é montado. Late joiner entra no vivo.
- Room: `sourceKind === 'live'` → `LiveStage`; trocar mídia continua igual.

## Fora
Legendas, seek, pausa sincronizada, >1080p, lives sem H.264, DVR.

## Testes
- Rust: seleção de formatos de live a partir de fixture real; parser de estado.
- Go: rotas e transição de status por heartbeat.
- Web: vitest do `youtube.ts` (live) e do `LiveStage` (botão reassina).
- E2E: `web/dev/e2e-live.mjs` com uma live pública achada via
  `ytsearch` (host + guest, canvas com luminância > 0, botão ir para o vivo).
