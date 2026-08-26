# Spec: menos banda no player, menos disco no worker

Data: 2026-08-26. Origem: dois workflows adversariais (investigador + refutador, 2 agentes cada) sobre `main` + medições na sala `g0PFl4rK` em produção.

## 0. Resumo executivo

- **O player já está otimizado.** hls.js com um único level, defaults corretos (maxBufferLength 30 s, backBuffer ∞, maxBufferSize 60 MB), segmentos fMP4 com `Cache-Control: public, max-age=31536000, immutable`, overhead de container ~0,1%, sync por WS ≈ 0,2 MB/h. Nada a fazer aqui.
- **Compressão de vídeo não compensa.** Re-encode por WebCodecs (HW H.264/HEVC/AV1) rende de 0 a −30% para ficar imperceptível numa fonte já comprimida, custa CPU que o host não tem sobrando (o pipeline é I/O-bound pelo uplink) e HEVC/AV1 exigem decoder em todo viewer. Opus no lugar de AAC: <1% e quebra o HLS nativo do Safari. **Ambos descartados.**
- **A banda desperdiçada está no host, não no viewer:** o host lê cada MKV **duas vezes** do worker (remux + varredura de legendas embutidas). É 50% do egress worker→host — 8 GB por filme de 8 GB.
- **O disco do worker enche por vazamento, não por falta de RAM:** órfãos deixados a cada restart (`fastresume` sem `persistence`), a mesma varredura de legendas baixando o arquivo inteiro (a janela deslizante nunca limitou nada), e quota default de 120 GB maior que o disco.
- **Worker "sem disco" (RAM/tmpfs): não.** Troca "disco cheio" por OOM/ENOSPC fatal numa VPS de 1–2 GB. O page cache do Linux já faz o cache em RAM de graça e é recuperável.

A mudança que resolve os dois problemas ao mesmo tempo é a **§2.1** (tee da varredura de legendas).

## 1. Mapa de bytes (cenário: filme 2 h, MKV 8 GB, H.264 ~8,5 Mbps, torrent num worker, host com 50 Mbps de upload, 1 host + 3 viewers)

| # | Fluxo | Volume por filme | Estado |
|---|---|---|---|
| A | swarm → worker | ≈ arquivo + janelas abandonadas em seek (≤ 256 MiB por cursor) | ingress, não cobrado |
| B | worker → host | **2× arquivo = 16 GB** | ❌ desperdício principal |
| C | host → R2 (PUT presignado) | 7,8 GB (vídeo copiado + AAC + ~0,1% fMP4) | ✅; duplica só em seek frio p/ frente + seek p/ trás |
| D | R2/CDN → cada viewer | 7,8 GB | ✅ |
| E | VPS → viewer, playlists `.m3u8` | 55 MB (preparo 21 min) a 300 MB (upload ~tempo real) por viewer | ❌ sem gzip, `no-store`, poll 4 s |
| F | VPS → viewer, `/api/rooms/:id` | 15–45 MB/h por viewer durante o preparo | ⚠️ refetch a cada publish de 2 s |
| G | CDN → viewer, VTT | 10–40 MB por viewer com legenda ligada, por preparo | ⚠️ todas as faixas em `hidden` |
| H | WS sync | 0,2 MB/h | ✅ ruído |
| I | host → VPS, `/api/torrents/:id` | 2–10 MB/h | ⚠️ manda a lista de arquivos a cada 2 s |
| J | host → VPS, POST de legendas | 10–50 MB por preparo | ❌ reenvia todas as faixas a cada 8 s, no uplink que limita o remux |

Medido na sala `g0PFl4rK`: vídeo avc1 1080p em segmentos de 2,002 s de 0,39–1,66 MB (média 3,66 Mbps, pico ~6,4), áudio AAC copiado ~185 kbps por faixa (9 faixas), init 696 B. Playlists com URLs absolutas (~95 B/linha, ~170 KB com 1800 segmentos), `no-store`, sem `Content-Encoding`. Cache do Cloudflare é por PoP (MISS/HIT alternam entre MIA/MRS/IAD) — egress de R2, grátis.

Nota: E, F, I e J são medidos na perna VPS→CF (`MediaBytesServed`). O Cloudflare já gzipa `application/json` (F, I) na perna CF→viewer, mas **não** `application/vnd.apple.mpegurl` (E).

## 2. Banda — o que fazer

Todas as propostas abaixo têm custo de CPU zero ou desprezível e nenhum tradeoff perceptível, salvo onde marcado.

### 2.1 Tee do stream do remux para o parser de legendas (fluxo B, −50%)

**Problema.** `web/src/pipeline/remuxJob.ts:137-158` (`extractEmbeddedSubtitles`) lê o MKV inteiro em fatias de 8 MiB com `prio: 'scan'` → `mediaInput.ts:201` → `rangeRead.ts:162`, enquanto o remux lê os mesmos bytes pelo `CustomSource` (`mediaInput.ts:202-207`, `prio: 'playhead'`). Nenhum cache une os dois; no worker cada `prio` abre um Reader próprio (`slots.rs:8-16`) e os dois consomem o mesmo token bucket (`http/throttle.rs:22`) — a varredura rouba metade da vazão do playhead.

**Mudança.** Envolver o `rangeStream` de `mediaInput.ts:205` num `TransformStream` que espelha cada chunk para um *tap* sequencial (offset esperado + buffer de reordenação limitado) alimentando `MatroskaSubtitleStream.write`. A varredura passa a pedir ao worker **só os buracos** que o tap não cobriu.

**Caveats (do refutador).**
- `matroska-subtitles` é um parser EBML sequencial: precisa do header e de uma fronteira de Cluster. Após seek, a região começa no meio do arquivo; o tap precisa ressincronizar (varrer só o trecho do buraco, do último Cluster conhecido). O prefetch `network` do mediabunny alinha reads a 64 KiB e cresce em extensões, então o tap vê blocos não contíguos — daí o buffer de reordenação.
- No caso comum (região 0, sem seek) a segunda leitura desaparece por completo. Com seeks, ganho menor. Zero para MP4/WebM/arquivo local.

**Ganho.** ≈ 8 GB por filme de 8 GB (50% de B); remux mais rápido em workers com `SS_WORKER_TRANSFER_MBIT`. Também é o que faz o disco do worker parar de ser = tamanho do arquivo (§3).

**Validação.** `web/dev/e2e-seek.mjs`: `bytes_served` do worker local ≈ 1× o arquivo numa sessão sem seek; legendas embutidas continuam iguais (diff dos VTT antes/depois).

### 2.2 gzip nas playlists no handler Go (fluxo E, −95%)

**Problema.** `internal/httpapi/media.go:82` manda `Cache-Control: no-store` sem compressão; o Cloudflare não comprime m3u8 por padrão; hls.js recarrega vídeo **e** áudio a cada 4 s enquanto a playlist é live.

**Mudança.** gzip (ou br) no handler `servePlaylist` quando `Accept-Encoding` permitir — o CF repassa `Accept-Encoding: gzip, br` à origem, então é honrado. `no-cache` no lugar de `no-store` é opcional; ETag/304 rende quase nada porque a playlist muda a cada publish de 2 s.

Não usar apenas Compression Rule no CF: alivia só CF→viewer; a VPS continua servindo 170 KB por poll.

**Ganho.** 55 MB → 3 MB por viewer num preparo de 21 min; 300 → 15 MB quando o upload é ~tempo real. Multiplica pelo número de viewers.

### 2.3 Só a faixa de legenda escolhida em `hidden` (fluxo G, −90%)

**Problema.** `web/src/player/Player.tsx:590-598` põe **todas** as faixas em `mode='hidden'` quando qualquer legenda está ligada — e `hidden` faz o browser baixar o arquivo. A key do `<track>` (`Player.tsx:1226`) inclui `subsVersion`, que o store incrementa em **todo** POST (`mutateRoomBump 'subs_version'`), mesmo sem mudança de conteúdo; a URL leva `?s=` (`Player.tsx:134`) e invalida o cache a cada versão.

**Mudança.** `hidden` só em `textTracks[position]` (é a única que `SubtitleLayer` lê via `activeCues`); as demais `disabled`. Versionar a key por faixa (hash/tamanho do VTT daquela faixa), não pelo `subsVersion` global.

**Ganho.** ~90% de G — só para viewers com legenda ligada; egress de CDN, não da VPS.

### 2.4 POST de legendas delta (fluxo J, −90%)

**Problema.** `web/src/subtitles.ts:270-299` reenvia a **união de todas as faixas inteiras** em JSON a cada 8 s; o servidor regrava todos os arquivos e re-digesta (`internal/httpapi/subtitles.go:143-160`, `publisher.go:112-136`). Isso sobe no mesmo uplink que dá backpressure ao remux (`clientMedia.ts:284-300`).

**Mudança.** Enviar só as faixas cujo VTT mudou desde o último POST (ou cues append-only por faixa). Casa com a versão por faixa de §2.3 — o servidor só bumpa a versão da faixa que recebeu bytes.

### 2.5 Coalescer `/api/rooms/:id` durante o preparo (fluxo F, −75%)

**Problema.** `NotifyRoomUpdated` dispara em todo publish de 2 s via `SetIngestProgress` (`internal/httpapi/clientmedia.go:359-362`), em `SetMediaOffset` e em cada POST de legendas; `web/src/pages/Room.tsx:486-510` refaz o GET completo por `roomVersion`, e ainda há poll de 3 s (`Room.tsx:463`) com o WS aberto. Com 512 chapters o corpo passa de 25 KB.

**Mudança.** Desligar o poll de 3 s quando `connected`; levar o progresso no frame WS (ou limitar o notify de progresso a ~5 s). ETag/304 não ajuda: o corpo muda a cada 2 s.

**Ganho.** 50 → ~12 req/min; 15–45 MB/h → 4–10 MB/h por viewer, só durante o preparo.

### 2.6 `trim.end` na região nova quando um seek cai antes de uma região produzida (fluxo C)

**Problema.** `clientMedia.ts:556-561` inicia a `Conversion` só com `trim.start`; uma região iniciada por seek roda até o fim do arquivo, re-lendo do worker e re-subindo o que a região posterior já cobria.

**Mudança.** Ao iniciar a região N, achar a região existente com menor `startMs > início` e passar `trim.end = thatRegion.startMs/1000` (é keyframe por `snapToKeyframe`, `clientMedia.ts:442-454`; o patch do mediabunny já corta em `packet.timestamp >= _endTimestamp`). Ajustar `regionSpanMs` para que `ranToEnd` reclame até o `trim.end`.

**Correções do refutador.** Só acontece no par *seek frio para frente* + *seek para trás* (um seek para trás dentro da região em crescimento é coberto por `uncovered()` e não reinicia nada); a sobreposição típica é de minutos, não a hora inteira. **Tem custo perceptível:** uma troca de região visível na costura (cada troca bumpa `media_version`, remonta todos os `<track>` e reconstrói o hls.js). Prioridade baixa.

### 2.7 Menores

- `probeWorkers` (`web/src/remoteTorrent.ts:195-206,266`) puxa 3 MiB de **todo** worker a cada abertura e no resume, inclusive os que nunca serão escolhidos. Cachear o ranking por infohash por alguns minutos ou parar em ~1 MiB quando ttfb+vazão estabilizam.
- `/api/torrents/:id` a cada 2 s devolve `job.Files` sempre (`internal/httpapi/torrent.go:133-134`); `refreshStats` só usa `swarm`. Omitir a lista após a primeira resposta.
- Placement (`internal/worker/placement.go`) deveria evitar workers `SS_WORKER_RELAYED` quando há um direto alcançável — cada byte relayed sai 3× (`http/relay.rs:30-75`) e passa pela VPS.
- `/v1/t/:ticket/haves` no worker não tem chamador em `web/src` — rota morta, remover.

### 2.8 Descartado com evidência

- **Buffer do hls.js, container fMP4, cache de segmentos, sync, janela do worker:** verificados, já corretos. `testBandwidth` só age com >1 level; há um só.
- **Re-encode de vídeo (WebCodecs HW):** 0 a −30% com H.264 HW para ficar imperceptível; 0–15% HEVC HW no limiar do visível; 40–60% só em BD remux >25 Mbps e com perda visível em grão. AV1 por software viola "pouca CPU". Viola também "sem tradeoff" (decoder nos viewers).
- **Opus em vez de AAC:** ~64 kbps em ~8,7 Mbps (<1%), 0% para fontes AAC (copiadas), fora da spec HLS da Apple. Nota lateral de qualidade: o encoder AAC manda 5.1 a 192 kbps sem escalar por canais (`mediabunny encode.js`) — abaixo do transparente; problema existente, não de banda.

## 3. Disco do worker — o que fazer

### 3.1 O que grava hoje

1. **Pieces do torrent** — único consumidor real. `ss-worker/src/engine/mod.rs:142-168` abre `Session::new_with_opts(data_dir/torrents)` sem `storage_factory` → `FilesystemStorageFactory` (`vendor/librqbit/src/session.rs:1309-1313`), que cria **todos** os arquivos do torrent com `set_len` (esparsos; blocos alocados = baixado). Nada é liberado durante o job: `update_selected_pieces` (patch ss, `chunk_tracker.rs:351-396`) só para de **pedir** peças fora da janela; peças baixadas ficam. Só o reaper apaga (`engine/reaper.rs:30-45`: idle 120 s → pausa, +180 s → `session.delete(id, true)`).
2. Persistência de sessão do librqbit — **não grava** (`persistence: None`; bitfield em RAM).
3. DHT — `dht.json` a cada 60 s no cache dir do SO (`~/.cache/com.rqbit.dht/`), centenas de KB, no overlay do container.
4. ACME/TLS — `data_dir/tls/{account,state}.json`, `cert.pem`, `key.pem` (`http/acme.rs`). KBs.
5. Identidade e anti-replay — `data_dir/identity.json`, `nonces.json` a cada job (`control/envelope.rs:88-104`). KBs.
6. Logs — stdout → json-file do Docker **sem rotação** (nenhuma chave `logging:` no compose). Cresce em `/var/lib/docker/containers` no host.

### 3.2 Por que enche (três causas, confirmadas no código)

1. **Órfãos após restart.** `fastresume: true` mas `persistence: None` (`engine/mod.rs:144-149`): em `session.rs:641-686` sem `persistence` o factory devolve `NonPersistentBitVFactory`, e o loop de restore (`session.rs:861`) não roda. `adopt_persisted` (`mod.rs:185-195`) adota zero torrents. Não há `read_dir`/`remove_dir_all` em `src/`; `DiskAccountant.dir` é `dead_code`. O volume `ss-worker-data` persiste entre deploys. **Cada restart pode deixar até `quota` GB órfãos**, invisíveis à contabilidade. Agravante: re-lease do mesmo infohash reabre o órfão de tamanho cheio com `overwrite: true` e faz SHA1 do arquivo inteiro (`file_ops.rs:73-183`) → risco real de `INIT_TIMEOUT` 90 s (`mod.rs:254`).
2. **A varredura de legendas baixa o arquivo inteiro** (§2.1). A janela (AHEAD 256 MiB, BEHIND 32, PIN 32 — `window.rs:9-15`) nunca limitou o disco por job: disco por MKV = tamanho do arquivo. Reduzir a janela não muda nada sem §2.1.
3. **Quota default 120 GB** (`config.rs:128`) quando `SS_WORKER_DISK_QUOTA_GB` não é setada — maior que o disco de uma VPS de 25–40 GB. A contabilidade é virtual (reserva tamanho cheio de todo arquivo `ever_selected`, `disk.rs:33-42`), não bytes reais.

### 3.3 Alternativas "sem disco" — avaliadas e descartadas

| Opção | Veredito |
|---|---|
| **A. Storage 100% em RAM** (custom `TorrentStorage` + patch `forget_pieces` no librqbit) | ~700 MiB/torrent (2 cursores × (256+32) + 2 × 32 PIN + peças de borda) × 12 torrents ≈ 8,4 GiB; transitório 2× após seek (`update_selected_pieces` não cancela peças em voo, nada manda Cancel aos peers); `piece_tracker.rs:146-152` reserva 64 MiB à frente por FileStream sem consultar `selected`. Estouro = OOM kill sem aviso. Exigiria RamAccountant, reduzir janela, peers 80→30, alocar por chunk. **Esforço grande, risco alto.** |
| **B. tmpfs + punch-hole** | Precisa do **mesmo** patch de A (pread num buraco devolve zeros, `FileStream` não valida). ENOSPC → `on_fatal_error` → torrent em Error; a recuperação (`retry_failed`) refaz `initial_check` com SHA1 do tamanho aparente inteiro — dezenas de segundos de CPU numa vCPU, segurando 1 dos 3 permits de init. tmpfs é cobrado no cgroup do container junto com o app (sem `mem_limit` no compose). |
| **C. Manter disco, parar de vazar** | **É a recomendação.** |
| **D. Zero bytes inclusive certs/identidade/nonces/DHT** | Possível, não vale: reemitir cert a cada boot conta no rate limit do Let's Encrypt e perde ARI (`state.json`); nonces em RAM reabrem replay após restart; identidade por env tira a custódia local. Tudo somado é KBs. |

Regra que decide: **o page cache do Linux já mantém em RAM o que está quente, de graça e recuperável sob pressão; tmpfs/HashMap trocam um limite macio por um duro.**

### 3.4 Marco 1 — parar de encher (pequeno, sem tocar no vendor)

- `ss-worker/src/engine/mod.rs` `Engine::new`: `remove_dir_all(&dir)` + `create_dir_all` **antes** de `Session::new_with_opts` (nada é adotável mesmo). Remover `adopt_persisted` ou deixá-lo como no-op documentado. Opcional: `opts.dht = Some(DhtSessionConfig { persistence: None, ..Default::default() })` para não gravar fora do `data_dir`.
  - **Não** ligar `SessionPersistenceConfig::Json`: o restore volta torrents *Serving* despausados com o arquivo inteiro selecionado (`only_files` = tudo, sem janela), em `Phase::Idle` que o reaper não pausa — 5 min de download cheio a cada restart, com reserva de `total_bytes`.
- `ss-worker/src/main.rs` após `graceful_shutdown`: `engine.reap_all().await` — novo método que faz `session.delete(id, true)` para todo torrent, ignorando leases, dentro do `drain_deadline`.
- `ss-worker/src/engine/disk.rs`: manter a reserva por tamanho selecionado para admissão, mas expor `real_used()` somando `MetadataExt::blocks() * 512` sob `dir` (o campo deixa de ser `dead_code`) e reportar `max(reserved, real)` no snapshot/heartbeat (`engine/mod.rs:203-215`, `control/mod.rs:132`). `placement.go:64-68` e `loadOf` continuam funcionando sem mudança no Go.
- `ss-worker/src/config.rs:128`: default de `SS_WORKER_DISK_QUOTA_GB` derivado de `statvfs(data_dir)` (ex. 80% do filesystem), ou `bail!` quando quota > tamanho do filesystem.
- `docker-compose.yml` (serviço worker): `logging: { driver: json-file, options: { max-size: 50m, max-file: '3' } }`.

Efeito: disco ≤ quota efetiva sempre; órfãos eliminados no boot e no drain. Disco por job ainda = tamanho do arquivo enquanto §2.1 não existir.

### 3.5 Marco 2 — disco ≈ janela (~640 MiB por torrent ativo; patch no librqbit)

Só faz sentido **depois** de §2.1 (sem ele, o cursor Scan continua pedindo o arquivo inteiro).

- `vendor/librqbit/src/chunk_tracker.rs`: `pub fn forget_pieces(&mut self, pieces: &BS, file_infos: &FileInfos)` — só para peças `have && !selected`: limpa o bit em `have`, zera `chunk_status` do `chunk_range`, deixa `queue_pieces` em 0, recalcula `per_file_bytes` e `hns`. Nunca peças em voo (`have = true` nunca está inflight).
- `vendor/librqbit/src/torrent_state/live/mod.rs`: `pub(crate) fn forget_pieces` sob `lock_write`. **Não mexer em `stats.have_bytes`** — é cumulativo; decrementar faz o `ChargeMark` do Go (`service.go:436-480`) zerar a marca e cobrar o re-download em dobro, e o digest em `entry.rs` já depende de ele só crescer. Em `on_download_request` (~1519-1530) trocar o `bail!` de "not ready to upload" por `return Ok(())` para não derrubar peers que viram nosso HAVE antigo.
- `vendor/librqbit/src/torrent_state/mod.rs`: `pub fn forget_pieces(&self, pieces: &[u32])` espelhando `update_selected_pieces` (só em Live).
- `ss-worker/src/engine/mod.rs` `apply_window` (437-488): após `update_selected_pieces`, calcular `have & !selected` (excluindo peças que tocam a borda da janela e os PINs, já em `selected`), chamar `handle.forget_pieces` **primeiro** e só então `libc::fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, off, len)` no arquivo aberto por caminho (`handle.shared().options.output_folder.join(&info.relative_filename)`). `#[cfg(target_os = "linux")]`, no-op no Mac para o e2e local. Adicionar `libc` ao `Cargo.toml`. A ordem forget→punch garante que nenhum `FileStream` vê `have = true` sobre buraco.
- `config.rs:132`: `per_torrent_peer_limit` 80 → ~40 para conter o transitório de peças em voo fora da janela após seek.

**Custos.** Rewatch/próximo episódio perdem a afinidade *Holders* do placement (que hoje só existe porque o Scan baixou tudo). Seek para trás além de BEHIND re-baixa do swarm — mas seeks em trechos já remuxados são servidos do store local do host (e2e-seek: "seek back into region 0's produced stretch: no restart"), então pesa pouco.

**Validação.** `web/dev/e2e-seek.mjs`: após o seek para 600 s, `du --apparent-size` vs `du` real do `data_dir` do worker local ≈ 2×(AHEAD+BEHIND) + 2×PIN; o seek de volta para 20 s ainda toca.

## 4. Ordem de execução

1. **§3.4 Marco 1** (worker para de encher) — pequeno, sem risco, resolve o sintoma hoje.
2. **§2.1 tee da varredura** — o maior ganho de banda (−50% worker→host) e pré-requisito do Marco 2.
3. **§2.2 gzip das playlists** — uma tarde, −95% num fluxo que escala com viewers.
4. **§2.3 + §2.4 legendas** (uma faixa em `hidden`, versão por faixa, POST delta) — juntas.
5. **§2.5 rooms coalescido**, **§2.7 menores**.
6. **§3.5 Marco 2** — só se, depois de 1–2, disco por job ainda incomodar.
7. **§2.6 trim.end** — opcional; tem costura visível.

## 5. Não fazer

- Storage em RAM ou tmpfs no worker.
- `SessionPersistenceConfig::Json`.
- Re-encode de vídeo, Opus.
- Mexer em buffer do hls.js, tamanho de segmento, container.
- Decrementar `stats.have_bytes` em qualquer patch.
