# YouTube como fonte de sala

Data: 2026-09-11

## Objetivo

Abrir uma sala a partir de um link do YouTube com a mesma experiência de um torrent: vídeo sincronizado pelo pipeline atual, faixas de áudio dubladas, legendas (manuais e automáticas), capítulos e seek livre. Sem embed, sem iframe e sem nenhum byte de vídeo no servidor Go.

## Por que não roda no navegador

Testado em 2026-09-11 com uma URL resolvida pelo yt-dlp:

- `googlevideo.com/videoplayback` só devolve `Access-Control-Allow-Origin` para `https://www.youtube.com`; para qualquer outra origem a resposta vem sem CORS e o preflight responde 400.
- `youtube.com/youtubei/v1/player` (a API interna que o yt-dlp e o YouTube.js usam) responde 403 a um POST ou OPTIONS com `Origin` estranha.
- Cada URL do googlevideo carrega `ip=` e só serve ao IP que a resolveu.

Nenhuma linguagem muda isso; WASM não é um fator. Quem resolve tem de ser quem lê, e tem de ser um processo fora da página. O sync da sala não processa conteúdo (é WebSocket mais relógio do servidor), então não há nada para acelerar nele.

## Decisão

Dois backends com o mesmo comportamento, escolhidos pelo site:

1. **jlocal** (preferido): o app companheiro na máquina do host roda yt-dlp e FFmpeg. IP residencial, sem cota de frota, sem bloqueio anti-robô de datacenter.
2. **ss-worker** (fallback): a frota que já remuxa torrents ganha yt-dlp na imagem e um segundo tipo de fonte.

O site escolhe o jlocal quando ele está conectado e anuncia `youtube.available`; senão vai à frota; sem os dois, a tela diz que YouTube está indisponível. Não há fallback no servidor nem no navegador.

Os dois backends publicam pelo caminho que o worker já usa hoje: `/client-media/presign`, `/client-media/publish` e `/subtitles/fleet`, autorizados por um claim `client:`. Para viewers e para o sync, uma sala de YouTube é indistinguível de uma de torrent.

## Componentes

### 1. Crate compartilhado `ss-remux`

O módulo `ss-worker/src/remux` vira um crate em `ss-remux/`, no mesmo workspace Cargo que o `ss-worker`; o jlocal o consome como dependência git com rev fixada. O crate contém o que já existe (plan, args do FFmpeg, sink, upload, publish, subs, process, bridge) e ganha duas coisas novas:

- **Fonte abstrata.** O `InputTarget` da bridge deixa de conhecer o engine de torrent. Vira um trait `ByteSource { size, read(range, prio) }`. O ss-worker implementa sobre o engine de torrent; o YouTube implementa sobre HTTP.
- **Módulo `youtube`**: resolução via yt-dlp, seleção de formatos, leitor HTTP por faixas e extração de legendas/capítulos (abaixo).

Nada do comportamento de torrent muda com a extração.

### 2. Resolução (`youtube::resolve`)

`yt-dlp -J --no-playlist <url>` produz o info.json. Dele saem:

- `videoId`, título, duração, thumbnail, idioma original;
- formatos de vídeo e de áudio com itag, codec, resolução, bitrate, `language` e `audio_is_original`;
- legendas manuais (`subtitles`) e automáticas (`automatic_captions`), cada uma com URL em `vtt`;
- capítulos (`chapters`).

Regras de seleção, decididas no crate e iguais nos dois backends:

- **Vídeo**: o melhor `avc1` até 1080p; sem `avc1` nessa resolução, o melhor `vp09`; sem os dois, `av01`. Nunca acima de 1080p.
- **Áudio**: uma faixa por idioma dublado. Prefere o `m4a` de maior bitrate (AAC, copiado sem transcodificação); sem `m4a`, o melhor `opus`, convertido a AAC pela matriz atual. A faixa original vem primeiro.
- **Legendas**: todas as manuais; das automáticas, só a do idioma original, com o título marcado como automática. Traduções automáticas ficam de fora.
- **Recusa**: live, playlist sem vídeo, vídeo com restrição de idade ou sem formato utilizável viram um erro tipado (`youtube_unsupported`, `youtube_unavailable`), nunca um fallback.

A resolução devolve um `Resolved` com o `videoId` e a lista de itags escolhidos. URLs do googlevideo não saem do processo que as resolveu.

### 3. Leitor HTTP por faixas (`youtube::HttpSource`)

O FFmpeg lê `http://127.0.0.1/in/:cap` na bridge, como no torrent. Por trás, o `HttpSource`:

- busca o googlevideo em pedaços de 10 MiB usando o parâmetro `range=a-b` da própria URL, que é como o yt-dlp evita o throttling de pedidos grandes;
- guarda os últimos pedaços num cache em memória (96 MiB), porque o FFmpeg relê o cabeçalho e o `sidx` a cada seek;
- em 403 ou URL expirada, resolve o vídeo de novo uma vez e repete o pedido; na segunda falha, o run falha com `youtube_expired`.

Cada faixa (vídeo e cada áudio) é um input separado do FFmpeg: `-i` da bridge para cada um, `-map 0:v:0 -map 1:a:0 -map 2:a:0 …`. Os streams DASH do mesmo vídeo partem de zero, então o sync entre inputs é o padrão do FFmpeg. O `-ss` para seek vale para todos os inputs.

O `plan_streams` ganha uma variante que constrói o `SourcePlan` a partir do `Resolved` sem `ffprobe` (codec, canais, idiomas e duração já vêm do info.json), com o `video_codecs` do itag para VP9/AV1.

### 4. Legendas e capítulos

As legendas não passam pelo FFmpeg: o crate baixa o VTT de cada faixa escolhida (a URL vem do info.json, no mesmo processo) e o publica em `/subtitles/fleet` no mesmo formato de hoje, com `complete` na primeira publicação, porque o documento já vem inteiro. Isso acontece antes do vídeo começar.

Capítulos vão no `SourcePlan.chapters`, que já é publicado.

### 5. Ciclo de um run

Igual ao torrent: `start(spec)` com `runId`, `claim`, `roomId`, `mediaGeneration`, `region`, `startMs`, `apiBase`. Sink, presign, PUT, publish, `producedMs`, cancel e supersessão por região são os de hoje. O seek segue o mesmo esquema de regiões (`r{n}_`).

Um run de YouTube não tem lease de torrent: o "recurso" é só o `videoId` e os itags.

### 6. ss-worker

- Dockerfile instala o binário `yt-dlp` de uma release fixada do GitHub, com sha256. A frota reporta a versão no heartbeat (`youtube: { version }`), e o servidor só despacha YouTube para workers que a reportam.
- Jobs novos no `control/jobs.rs`: `ytResolve { url }` devolve o `Resolved`; `remuxStart` aceita `source: { kind: "youtube", videoId, video: itag, audios: [itag], subtitles: [...] }` no lugar de `infohash` + `fileIndex`.
- Quando um `ytResolve` falha por extrator desatualizado, o worker roda `yt-dlp -U` uma vez por dia no máximo e repete.
- Se o teste na VPS mostrar bloqueio anti-robô, a imagem ganha um arquivo de cookies via env (`YTDLP_COOKIES_FILE`) e o sidecar `bgutil-ytdlp-pot-provider` no compose. Isso é decidido na primeira etapa do plano, com evidência, não antes.

### 7. Servidor Go

- `POST /api/youtube { url }` cria um job (`JobRecord` com `Kind: youtube`), aplica a cota por sessão que hoje vale para magnets, escolhe um worker capaz e despacha `ytResolve`. `GET /api/youtube/{jobId}` faz poll até o `Resolved` chegar, e devolve título, duração, thumbnail, idiomas de áudio e legendas para a tela de espera.
- `POST /api/youtube/{jobId}/remux` reusa o `RemuxOrchestrator`: `RemuxRun` ganha um campo `Source` (torrent ou youtube) e `dispatchStart` monta o `remuxStart` correspondente. Follow de posição, restarts, heartbeat e cancelamento não mudam.
- `GET /api/torrents/capacity` ganha um irmão `GET /api/youtube/capacity`, para a página dizer quando a frota não tem yt-dlp.
- Sala: `sourceOrigin: 'youtube'`, com `sourceTitle` e `sourceUrl` para o cabeçalho e o histórico. `POST /rooms/:id/source` aceita `kind: 'youtube'` para trocar a fonte de uma sala viva.

### 8. jlocal

- Endpoints novos, todos em loopback e com o CORS de hoje:
  - `GET /capabilities` passa a anunciar `youtube: { available, tools: 'ready' | 'missing' | 'downloading' }`.
  - `POST /youtube/tools` baixa yt-dlp, ffmpeg e ffprobe para o diretório de dados do app, com URL e sha256 fixados por plataforma (macOS arm64/x86_64, Windows x86_64). Progresso em `/events`. O DMG não cresce.
  - `POST /youtube/resolve { url }` devolve o `Resolved` mais o resumo para a tela de espera.
  - `POST /youtube/run { spec, source }` inicia um run com o claim que o site obteve em `/client-media/claim`; o site é quem orquestra, então um `run` novo para a mesma sala supersede o anterior (é assim que o seek chega).
  - `DELETE /youtube/run/{runId}` cancela.
  - `GET /youtube/run/{runId}` devolve `{ state, producedMs, error }`; `/events` emite `youtube.run` a cada mudança.
- yt-dlp se atualiza com `-U` quando uma resolução falha por extrator, no máximo uma vez por dia.

### 9. Site

- **Entrada**: no Home, o campo de magnet passa a aceitar link do YouTube (`youtube.com/watch`, `youtu.be`, `youtube.com/shorts`, `music.youtube.com`) e o botão muda de rótulo conforme o que foi colado. Um item próprio no menu manual ("Link do YouTube") leva ao mesmo campo.
- **Orquestração** em `web/src/youtube.ts`, espelhando `remoteTorrent.ts`: uma interface `YoutubeBackend { resolve, start, cancel, status }` com duas implementações, `jlocalBackend` e `fleetBackend`. A escolha é feita uma vez ao abrir a sala e fica na sala (`youtubeBackend` no estado do host), para o seek ir ao mesmo lugar.
- **Seek e regiões com o jlocal**: o host já sabe a posição autoritativa; ao receber um seek para fora do que foi produzido, chama `start` de novo com `region + 1` e o `startMs`, com o mesmo debounce que o Go aplica à frota. Com a frota, o Go segue fazendo isso sozinho.
- **Tela de espera**: as fases do torrent (resolvendo, preparando, pronto) com o título e a thumbnail do vídeo. Quando o jlocal está conectado sem as ferramentas, a tela oferece "Baixar ferramentas" e mostra o progresso; enquanto isso, se a frota puder, o host pode escolher "usar a frota agora".
- **Sala**: cabeçalho com título e link do vídeo; seleção de áudio e legendas como hoje; capítulos como hoje.
- **Histórico**: entradas `kind: 'youtube'` com url e título, reabrindo pelo mesmo fluxo.

## Fluxo de dados

```
host cola link
  → site resolve (jlocal ou POST /api/youtube) → título, faixas, legendas
  → site cria a sala (sourceOrigin: youtube) e obtém o claim
       jlocal: POST /youtube/run com o claim
       frota:  POST /api/youtube/{job}/remux (o Go guarda o claim)
  → backend: legendas VTT → /subtitles/fleet (completas)
             FFmpeg lê a bridge ← HttpSource ← googlevideo (10 MiB por pedido)
             segmentos → presign → PUT R2 → publish
  → sala ready no primeiro segmento confirmado; viewers tocam do bucket
  → seek fora do produzido: run novo em região n+1 (site para jlocal, Go para frota)
```

## Erros

| Situação | Onde aparece |
|---|---|
| Link inválido | no campo, antes de qualquer pedido |
| Live, playlist, restrição de idade | `youtube_unsupported` na tela de espera, com o motivo |
| Vídeo privado ou removido | `youtube_unavailable` |
| Bloqueio anti-robô na frota | `youtube_blocked`; a tela sugere o jlocal |
| URL expirou no meio (falha dupla) | `youtube_expired`; o run falha e o site reinicia uma vez na mesma região |
| jlocal sem ferramentas e frota sem yt-dlp | `youtube_no_backend` |

## Testes

- `ss-remux`: seleção de formatos sobre info.json reais gravados (avc1 e vp9, dublagens, auto-legendas), args do FFmpeg com N inputs, `HttpSource` com um servidor local que exige `range=` e simula 403, VTT publicado inteiro.
- Go: rotas de `/api/youtube` (cota, capacidade, estado do job), `RemuxRun` com fonte youtube no orquestrador, troca de fonte para youtube.
- Site: parse de links, escolha de backend, orquestração de seek para o jlocal, tela de espera nos três estados, histórico.
- jlocal: download de ferramentas com sha256 errado recusado, `resolve` e `run` contra um yt-dlp falso no PATH.
- E2E: `web/dev/e2e-youtube.mjs` abre uma sala por link com o jlocal rodando e confirma `ready`, troca de áudio, legenda e seek frio, no molde de `e2e-seek.mjs`.

## Etapas (ordem do plano)

1. Prova na VPS: yt-dlp dentro da imagem do ss-worker resolve e o FFmpeg lê o googlevideo com `range=`. Decide cookies e PO token com evidência.
2. Extração do crate `ss-remux` com o trait `ByteSource`, sem mudança de comportamento; ss-worker passa a usá-lo.
3. `youtube` no crate: resolve, seleção, `HttpSource`, plano sem ffprobe, legendas VTT.
4. ss-worker: jobs `ytResolve` e `remuxStart` com fonte youtube; heartbeat.
5. Go: rotas, cota, `RemuxRun.Source`, sala com origem youtube.
6. Site: entrada, `youtube.ts` com o backend da frota, tela de espera, sala, histórico.
7. jlocal: ferramentas, endpoints, capability; site ganha o `jlocalBackend` e a orquestração de seek.
8. E2E, deploy, confirmação visual em produção.

## Fora de escopo

Playlists, lives, vídeos acima de 1080p, traduções automáticas de legendas, login do usuário no YouTube pelo site, Linux no jlocal.
