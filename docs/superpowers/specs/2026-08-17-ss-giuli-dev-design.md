# ss.giuli.dev — Design

Watch together de vídeos: alguém envia um arquivo (até 10 GB, MKV/MP4/AVI, com
múltiplas faixas de áudio e legendas), recebe um link e assiste com os amigos no
navegador, em sincronia, com chat lateral. Tudo é efêmero: a sala vive no máximo
5 horas e depois nada permanece no servidor (nem disco, nem Redis).

## Decisões tomadas no brainstorm

| Tema | Decisão |
| --- | --- |
| Pipeline de mídia | Processar no servidor após o upload (remux ffmpeg para HLS fMP4), servir estático |
| Transporte de mídia | HTTP/HLS (nunca WebSocket); WebSocket só para sinalização e chat |
| Controle da reprodução | Host + delegação |
| Upload | tus resumável (tusd embutido + Uppy no React) |
| Identidade | Apelido por sala, sem conta (localStorage) |
| Screen share | LiveKit (SFU) como serviço no compose |
| Estado | Redis com TTL; arquivo em disco só durante a vida da sala |
| Limites | 10 GB / 20 pessoas por sala / ~10 salas simultâneas (tudo via env) |
| Deploy | docker-compose: app + redis + livekit |
| UI | Skrivo dark, i18n pt-BR/en, labels simples, sem em dash |

## Arquitetura

Três serviços no `docker-compose.yml`:

- **app** — imagem Go (multi-stage) com ffmpeg no runtime. Contém: API Gin,
  handler tus embutido, hub WebSocket, pipeline ffmpeg, sweeper de limpeza.
- **redis** — `redis:7-alpine`, estado efêmero das salas.
- **livekit** — `livekit/livekit-server`, SFU para compartilhamento de tela.

Volume `/data/rooms/{roomId}/` guarda, só enquanto a sala vive:

```
/data/rooms/{roomId}/
  original.{ext}        # upload via tus
  hls/master.m3u8       # master playlist com EXT-X-MEDIA por faixa de áudio
  hls/*.m3u8, *.m4s     # variant playlists e segmentos fMP4
  subs/{lang}_{i}.vtt   # legendas de texto extraídas
```

## Estados da sala

`uploading → processing → ready` (e `error` a partir de `processing`).

- Sala vazia por mais de 10 minutos expira na hora.
- Qualquer sala expira no máximo 5 horas após a criação.

## Pipeline de mídia

1. Upload tus retomável grava `original.{ext}` (store em disco do tusd).
2. `ffprobe` inventaria streams: codec de vídeo, faixas de áudio (índice,
   idioma, título), legendas (codec, idioma).
3. `ffmpeg` remuxa para HLS fMP4: vídeo `-c:v copy` (sem re-encode); cada faixa
   de áudio vira uma saída AAC; `-var_stream_map` + `-master_pl_name` geram a
   master playlist com `EXT-X-MEDIA` por faixa. Se o codec de vídeo não for
   copiável para fMP4, fallback: transcode H.264 com aviso de demora na UI.
4. Legendas de texto (subrip/ass/webvtt) extraídas para `.vtt` (stream copy,
   `-sub_charenc` quando necessário). Legendas bitmap (PGS/VobSub) são
   detectadas no ffprobe e puladas com aviso na UI.
5. Sala vira `ready` e os conectados são avisados via WebSocket.

Processamento roda numa fila in-process com no máximo `FFMPEG_JOBS` (default 2)
jobs simultâneos. Começar a assistir durante o processamento (playlist
progressiva) é fase 2, fora do MVP.

## Upload

- tus embutido no app (`github.com/tus/tusd/v2` como handler Gin), store em
  disco, `max-size` = `MAX_UPLOAD_MB`.
- Frontend: Uppy + plugin Tus, com barra de progresso e retry automático.
- Upload abortado remove o diretório da sala.

## Sincronização e chat (WebSocket)

Uma conexão WS por participante: `/ws/rooms/{id}`.

- Eventos de controle: `{type: "play"|"pause"|"seek", positionMs, rate}`.
  O servidor carimba `serverTime` e replica para todos.
- **Host + delegação**: a sala tem `controllerID` (quem criou). Só o controller
  emite controle; ele pode delegar para outro membro. Se o controller sai, o
  membro mais antigo assume.
- Quem entra tarde recebe snapshot e calcula
  `positionNow = positionMs + (now - serverTime) * rate` quando `playing`.
  No handshake o cliente estima o offset de relógio com o servidor
  (`offset = serverTime - (t0 + rtt/2)`) e passa a usar o relógio do servidor
  como referência em todos os cálculos.
- Drift: heartbeat a cada 5 s; se `|local - esperado| > 0.45 s`, hard seek.
  Cliente em buffering avisa e, ao voltar, faz catch-up seek automático.
- Chat na mesma conexão; histórico limitado às últimas 200 mensagens no Redis.
- Presença: lista de membros com apelido, entrada/saída broadcastadas.

## Redis

Chaves (todas com TTL de `ROOM_TTL_HOURS`, default 5h):

- `room:{id}` — hash: metadados (arquivo, duração, faixas, estado, controllerID, createdAt, expiresAt)
- `room:{id}:state` — hash: playing, positionMs, rate, serverTime
- `room:{id}:chat` — lista capped
- `room:{id}:members` — hash apelido/entrada
- `rooms:by_expiry` — ZSET (score = expiresAt)

**Limpeza**: sweeper roda a cada minuto, lê `rooms:by_expiry` vencidos, apaga
`/data/rooms/{id}` inteiro e deleta as chaves. (Keyspace notifications não são
usadas: não são confiáveis como único mecanismo.) Redis com
`maxmemory-policy volatile-ttl` para nunca evictar sala viva sob pressão.

## Screen share

Botão na sala chama `getDisplayMedia` e publica no LiveKit. O backend expõe
`POST /rooms/{id}/screenshare/token` que gera token LiveKit (room = id da
sala). Viewers recebem o stream como tile sobre o player. Quem compartilha
publica um stream só; o SFU distribui para todos.

## Frontend

React + Vite + TypeScript. Player com hls.js sem wrapper + `<video>` nativo;
fallback Safari via `canPlayType('application/vnd.apple.mpegurl')`. Legendas
via `<track>` com os VTT extraídos; troca de faixa de áudio via
`hls.audioTracks`.

### Design (Skrivo dark para web)

Fonte: `~/projects/telepromter/DESIGN.md` (variante dark) e
`~/projects/nasa/DESIGN.md` (Skrivo). Tokens em CSS custom properties:

- canvas near-black plano, card um passo acima, well afundado, hairline border
  branco a 8%; índigo é o único acento
- raised (pressionável): highlight interno 1px branco 10% + sombra rasa;
  sunken (digitar/escolher): fill mais escuro + inner shadow; nunca os dois
- raios: 8 controles, 12 inputs/pills/rows, 18 cards/painéis; cápsulas são
  cápsulas
- status sempre dot + label, nunca só cor: Conectando (amarelo), Ao vivo
  (verde), Buffering (laranja), Processando (índigo)
- números que mudam usam dígitos tabulares/mono

### Telas

- **Home**: headline de uma linha, uma frase de guia, drop zone com hairline
  tracejada que vira índigo quando o arquivo sobrevoa. Nunca parece erro.
- **Sala**: player com controles em cápsula flutuante, seletores de faixa de
  áudio e legenda, lista de participantes, botão de screen share, chat lateral.

### Chat lateral animado

Coluna dockada à direita no desktop (espelho da assistant column do
telepromter); no mobile vira drawer sobre o player. Motion conforme a skill
`animate` e os tokens Skrivo:

- ease padrão `cubic-bezier(0.22, 1, 0.36, 1)`; abre 250 ms, fecha 150 ms
- deslocamento máximo 8px em transições de conteúdo; stagger total máximo 300 ms
- uma confirmação por evento; nada pulsa ou faz loop para chamar atenção
- `prefers-reduced-motion` remove transforms e springs, estado segue legível

### i18n e copy

UI bilíngue pt-BR/en (detecção do navegador, troca manual na UI). Labels
curtos e simples; sem em dash nos textos da interface.

### Responsivo

Layout fluido do player, alvos de toque adequados, chat como drawer em telas
estreitas, controles que degradam com elegância (esconde o texto, fica o dot).

## Erros e limites

- Arquivo maior que o limite: rejeitado no tus com mensagem clara.
- Sala cheia (20): quem entra pelo link recebe aviso desenhado.
- Link inválido ou expirado: estado vazio desenhado com ação para criar sala.
- Falha no ffmpeg: sala vira `error` com motivo legível.
- Upload abortado: diretório removido.
- Controller sai: membro mais antigo assume; sala vazia por 10 min expira.

## Testes

- Go: unitários de sync/estado e sweeper com miniredis; integração do pipeline
  com fixture de vídeo pequeno (ffprobe/ffmpeg reais); testes do hub WS.
- Frontend: Vitest + Testing Library para o cliente de sync (cálculo de
  posição, correção de drift); smoke e2e Playwright (cria sala, envia fixture,
  dois clientes sincronizam).

## Deploy

`docker-compose.yml` com `app` (build multi-stage, ffmpeg instalado), `redis`,
`livekit`; volume `/data`. Config por env: `MAX_UPLOAD_MB` (10240),
`ROOM_TTL_HOURS` (5), `MAX_PARTICIPANTS` (20), `ROOM_IDLE_MINUTES` (10),
`FFMPEG_JOBS` (2), `REDIS_URL`, credenciais LiveKit, `PORT`.

## Fora de escopo (v1)

- Contas de usuário, histórico de salas, qualquer persistência além do TTL
- Playback durante o processamento (playlist progressiva)
- Legendas bitmap (PGS/VobSub) renderizadas (só aviso)
- DASH, DRM, transcode de vídeo sob demanda
- Múltiplas instâncias do backend (broadcast cross-instance via Redis Pub/Sub)
