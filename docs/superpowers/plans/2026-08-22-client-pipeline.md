# Pipeline no cliente (mediabunny + R2) — plano

**Meta:** mover a preparação de mídia (disco + CPU) da VPS para o browser do host
quando o host for capaz, mantendo o pipeline da VPS como fallback silencioso.
O bucket segue sendo quem serve todos os bytes; a VPS vira orquestração,
playlists e verdade sobre o estado da sala.

**Por que agora:** a preparação atual é dimensionada para ~2-4 salas simultâneas
(2 workers de ffmpeg, 64 GB de disco); assistir já escala porque os segmentos
nunca cruzam a VPS. O que falta escalar é exatamente o que o host pode fazer —
e no caminho de torrent do catálogo o browser do host **já baixa e sobe o
arquivo inteiro** (`web/src/upload.ts:349`), então processar no cliente é
banda-neutra para ele.

**Por que dá:** o mediabunny já é dependência (`convert.ts` faz MP4→MKV com
StreamTarget em OPFS); copiar h264/hevc/av1/vp9 é remux puro; e o áudio — o
problema histórico — fechou em 2026: `@mediabunny/ac3` (AC-3/E-AC-3, ~1,1 MB
min) e `@mediabunny/dts` decodificam via WASM do FFmpeg, patente-limpos desde
30/01/2026, e o AAC sai do WebCodecs (Chrome) ou de `@mediabunny/aac-encoder`.
Fica de fora: TrueHD puro (raro; releases trazem faixa AC3 do lado) e vídeo
não-copiável — ambos caem no fallback da VPS.

## Princípios (dos levantamentos)

1. **O precedente é o client-subs.** O contrato "browser produz, servidor
   valida e publica, `complete=false` mantém o passe autoritativo agendado"
   já existe (`httpapi/subtitles.go` + `subtitles.ts`), incluindo o 409 de
   geração obsoleta. O pipeline de mídia do cliente copia esse contrato.
2. **Presign nunca confia no cliente para o caminho.** Prefixo
   `rooms/{id}/g{gen}/hls/` com a geração lida do Redis; nome de objeto com a
   mesma gramática de `media.go:42` (um componente, extensão conhecida);
   content-length-range, content-type e cache-control pinados; expiração curta;
   autorização = capability + controller (`source.go:81-88`); orçamento de
   bytes/objetos por sala no Redis (o tusd não conta mais); contador de
   billing movido para a emissão do presign (o `meteredTransport` não vê
   PUTs presignados).
3. **A playlist aceita é cortada pelo `Published`, como hoje.** O servidor só
   publica playlist que nomeia objetos confirmados — a confirmação de um PUT
   presignado é o problema duro: ou um HEAD por lote (não por segmento), ou o
   cliente confirma e o servidor faz HEAD amostral + verificação no primeiro
   404 do edge. Decidir na Fase 2; começar com HEAD por lote.
4. **Duas pipelines vivas, um dono por vez.** `ReserveUpload` continua sendo o
   lock; um "modo cliente" reserva a sala do mesmo jeito. Aba fechada = o
   fallback assume: o `complete=false` deixa `Queue.Submit` agendado, e a
   fonte precisa continuar chegando à VPS **ou** a sala renasce do zero — a
   Fase 1 aceita "renasce do zero" (a aba do host morrer já mata a sala hoje
   no caminho de upload direto antes do fim).
5. **Capacidade decide, não configuração.** Probe no cliente: codec de vídeo
   copiável + áudio decodificável (WebCodecs ou extensão) + OPFS disponível +
   AudioEncoder AAC (ou extensão) ⇒ modo cliente; qualquer não ⇒ tus como
   hoje. Mesmo idioma do `handOverToServer`: tenta o melhor, degrada em
   silêncio.

## Fases

**Fase 0 — fundação (feita nesta sessão):** VP9 copiável; recusa dura de codec
com purge; capítulos; preview drena até o fim; serialização preview→final;
`R2_ENDPOINT` para stack local com MinIO (e2e completo na máquina).

**Fase 1 — remux no cliente, arquivo local — FEITA (2026-08-22):**
`web/src/pipeline/clientMedia.ts` (mediabunny `HlsOutputFormat` live +
`CmafOutputFormat`, vídeo copiado, áudio → AAC via WebCodecs/extensões,
chunk dinâmico próprio); servidor: claim/presign/publish/release em
`internal/httpapi/clientmedia.go`, gramática de nomes `cs_*/cinit_*` em
`internal/media/clientmedia.go`, `Stat`+`PresignPut` no objectstore, budget
por sala no Redis, HEAD por lote na aceitação, playlists cortadas pelo
`Published` como no publisher. Dispatch em `startRoomUpload` (criação e troca
de fonte), fallback silencioso para tus em qualquer falha. Validado e2e
local: h264+aac (remux puro) e vp9+opus→aac (transcode), zero ffmpeg no
servidor, segmentos direto no MinIO.

Capítulos resolvidos no próprio cliente: `web/src/pipeline/mkvChapters.ts`
(leitor EBML mínimo, SeekHead incluído, testado contra MKV real do ffmpeg)
manda os chapters no primeiro publish. Gaps aceitos e documentados: menu de
áudio (saída muxa vídeo+áudio numa variante só; multi-dub perde o menu no
modo cliente) e o progresso server-side vem do POST de publish (2s) em vez
do tick de 1s do tus.

**Fase 2 — fonte crescendo (torrent no browser):** decidido NÃO fazer, pelo
próprio princípio 4: os caminhos de torrent com bridge/url mantêm os bytes
fora do browser de propósito (banda), e o webtorrent in-browser é candidato
a remoção no plano da beta. Reavaliar só se o bridge sumir.

**Fase 3 — decidir o resto (depois de medir):** renditions no cliente
(provavelmente não: 1 qualidade basta, o preview já provou); legendas do
cliente já existem e rodam no modo cliente; bridge server-side continua
para hosts fracos.

## Os 5 problemas duros (do levantamento) e a resposta

1. Áudio → extensões mediabunny + capability probe + fallback (resolvido em
   princípio; medir performance real do WASM na Fase 1).
2. Invariante de truncamento vira fronteira de confiança → HEAD por lote na
   aceitação; nunca publicar playlist com objeto não confirmado.
3. ProbeResult é fonte de tudo → o cliente manda `tracks/chapters/codecs`
   e o servidor valida shape; o que não der para validar barato é aceito como
   anotação (mesma classe dos client-subs), nunca como segurança.
4. Três caminhos de ingest → só os caminhos onde o browser tem os bytes
   migram; bridge/url continuam server-side.
5. Aba é ponto único de falha → Fase 1 aceita; melhorar com "qualquer membro
   pode retomar" só se doer na prática.

## Backlog das revisões (não bloqueia; não perder)

- Web/a11y do MorphingMenu: foco não alcança o painel portalado (roving
  focus + role=menu/listbox corretos; achados #4, #5, #12 da revisão web);
  re-ancorar painel quando o gatilho move sem scroll (#6); Escape captura
  indiscriminado (#7); toggle do gatilho é código morto (#8).
- Tooltip do seek em viewport estreito (clamp por pixel, #24); stagger do
  dropdown mais curto que o morph (#13); object-position do hero vai no
  wrapper e não no img (#21); decode duplo do hero (#22).
- Go: sidecar `.info` recriado por PATCH em voo após purge (#12 — resíduo
  aceito, documentado em PurgeData); `SetChapters` do preview depende do
  notify do `setPhase` (#18 — aceito, o passe final corrige).
- CSS local: classes `media-switch-pill`/`media-switch-panel` sem regras (#14).
