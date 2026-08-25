# Workers de torrent remotos (ss-worker) — plano de implementação

**Meta:** remover o ss-bridge e mover o torrent para **workers Rust remotos**
rodando em VPSs. O browser cola um magnet, o servidor despacha o job para um
worker assinado, o worker entra no swarm e serve os bytes por **HTTPS direto**
(Range). O remux continua no browser (mediabunny), os segmentos vão para o R2,
e os viewers tocam do R2 — nunca tocam o worker. O diferencial contra debrid/
Stremio: **zero instalação + stream enquanto ainda baixa + seek livre.**

**Escopo deste plano:** a arquitetura decidida, dividida em tarefas de uma
única subagent cada, com um revisor Opus 5 low por tarefa. A subagent cuida da
**coisa remota** (o binário `ss-worker` em Rust e a superfície de controle no
servidor); o autor deste plano (eu) faz o resto — endurecimento do pipeline no
browser, migração do web, escalonamento no Go, timeline esparsa. **Não
implementar agora:** este arquivo é o plano; a implementação vem depois.

**Pesquisa de base:** dois sweeps de 8 agentes Opus cada, em
`docs/superpowers/research/2026-08-24-remote-torrent-workers-1-engine-priorart.md`
e `-2-transport-certs.md`. Tudo abaixo carrega file:line ou a seção de
pesquisa que o justifica. Muitos fatos foram verificados contra o fonte real
(librqbit 9.0.1, mediabunny vendorado, o fork do ss-bridge).

---

## Por que agora, e o que muda de fato

O ss-bridge é um app nativo na máquina de quem abre a sala (loopback,
`http://127.0.0.1:32227`). Ele funciona, mas contradiz a promessa "zero
instalação": a pessoa precisa baixar e abrir um binário, e o Chrome ainda pede
Local Network Access antes da primeira requisição a `127.0.0.1`. Nenhum
serviço comercial (Real-Debrid, TorBox, Premiumize) faz stream de um torrent
**ainda baixando** — todos esperam o download completo; a stack de seedbox nem
consegue (nginx não tem prioridade de peça). Esse é o nosso encaixe: **origem
de browser + sem daemon + seek livre durante o download.**

Três topologias caem da decisão (crítico do sweep 2):

1. **Frota multi-VPS** (ss.giuli.dev: 2 workers do dono) — HTTPS direto,
   cert por worker.
2. **Self-host VPS única** — HTTPS direto, cert de IP do Let's Encrypt, sem DNS.
3. **Self-host em casa atrás de CGNAT** — o worker faz bind em `127.0.0.1`, a
   API faz reverse-proxy same-origin. Sem cert, sem CORS, o cookie de sessão é
   a auth.

O browser **nunca** monta uma URL de worker: recebe sempre uma string
`readBase` emitida pelo servidor. Failover, proxy-vs-direto, draining e refresh
de token caem todos dessa indireção (`design:server-scheduler`).

### Regra que não pode ser violada (postura legal)

O **proxy-through-origin é uma flag por-instância, não um fallback universal**
(contradição resolvida pelo crítico do sweep 2). ON para self-host de caixa
única (única topologia viável atrás de CGNAT, e o operador já aceitou a
exposição). **OFF para a frota ss.giuli.dev** — no instante em que a instância
retransmite bytes de torrent, a caixa que carrega o domínio, o cert TLS e as
sessões de todos os usuários vira a transmissora, destruindo exatamente a
separação legal que a frota de workers existe para criar. Na frota, uma falha
de cert **falha a sala**; não roteia bytes pela instância.

---

## Contrato do sistema (a fonte da verdade para todas as tarefas)

```
CONTROL PLANE (worker → servidor, WSS de saída; enrollment token → mTLS-ish)
  heartbeat a cada 10 s: {disk, leases, por-torrent {infohash, haveBytes, peers,
    speed}, cert notAfter + resultado da última renovação}
    ↑ a tabela de afinidade é DERIVADA disso, nunca armazenada como estado mutável
  servidor → worker: envelope de job assinado com Ed25519
    {infohash, fileIndex, roomID, nonce, exp}  — nunca uma URL
    + Release / Drain / SetLimits / Revoke(jti)

DATA PLANE (browser → worker, HTTPS direto, h2)
  GET https://{worker}/v1/f/{ticket}   Range: bytes=N-M
    → Range de um intervalo é CORS-safelisted → SEM preflight
    → 206 transmitido conforme as peças chegam, cap ~16 MiB/resposta,
      Content-Range honesto; nunca bufferizar o range inteiro
  POST /v1/hint/{ticket} {readOffset, gen}
    → retração de seek; carrega o OFFSET DE LEITURA DO REMUX (não o playhead da sala)
  GET  /v1/file/{ticket}/{index}   → sidecar de legenda, prioridade de arquivo
    inteiro, cap 8 MB no worker
  GET  /v1/t/{…}/haves   → bitfield cru de peças (formato do rqbit) para a
    barra de ranges bufferizados

TICKET = base64url(payload).base64url(sig), Ed25519, escopo
  {roomID, infohash, fileIndex, audience-origin, workerID, exp}
  no CAMINHO da URL, nunca em header (um header Authorization adiciona um
  preflight por região de leitura). ACAO pinado ao audience do ticket.
```

Padrões resolvidos pelo crítico (não reabrir sem medição):

- **Ticket no caminho da URL**, não em header. `Range` de um intervalo é
  safelisted desde o Firefox 117; o GET roda sem preflight.
- **Manter `CustomSource`, retornar `response.body`** (um `ReadableStream`).
  Verificado no fonte da mediabunny: consome chunk a chunk com checagem de
  abort entre chunks → entrega incremental + abort cooperativo, mantendo
  rotação de ticket, retry e deadline dentro da closure. `maxCacheSize:
  64–128 MiB` explícito (o default de 8 MiB é igual à extensão de prefetch e
  faz thrash). `maxWorkerCount` é fixo em 2 — paralelismo não salva o
  throughput; a janela de flow-control do h2 salva.
- **Um único caminho ACME:** http-01 na :80, identificadores de nome e/ou IP
  no mesmo pedido `shortlived`. Nem tls-alpn-01, nem dns-01.
- **A hint carrega o offset de leitura do remux**, de dentro da closure de
  leitura — não o playhead da sala. O remux corre à frente da reprodução;
  priorizar o playhead famintaria as peças em que o leitor está de fato
  bloqueado.

---

## Como as tarefas se dividem

Uma subagent por tarefa. Cada tarefa tem um **revisor Opus 5 low** dedicado
(adversarial: procura o modo de falha concreto, não estilo). A subagent faz a
**coisa remota** (Rust + superfície de controle no Go). Eu faço o resto.

| # | Tarefa | Dono | Depende de | Revisor |
|---|--------|------|-----------|---------|
| 0A | Fixture de Range com injeção de falha + medição de throughput | eu | — | Opus 5 low |
| 0B | Leituras abortáveis e resilientes no pipeline | eu | 0A | Opus 5 low |
| 0C | Identidade anônima + quotas + blocklist | eu | — | Opus 5 low |
| 1A | Binário `ss-worker`: engine, disco, ciclo de vida | **subagent** | — | Opus 5 low |
| 1B | `ss-worker`: data plane HTTP (Range, hint, haves, h2) | **subagent** | 1A, contrato | Opus 5 low |
| 1C | `ss-worker`: ACME (certs de IP/nome, ARI) | **subagent** | 1A | Opus 5 low |
| 1D | `ss-worker`: control plane (WSS, enrollment, envelopes) | **subagent** | 1A | Opus 5 low |
| 1E | Servidor Go: `internal/worker/` (registry, placement, signer) | **subagent** | 1D, 0C | Opus 5 low |
| 2A | Cliente web `remoteTorrent.ts` (mantém o seam) | eu | 1B, 1E | Opus 5 low |
| 2B | Deletar o ss-bridge (LNA, pill, i18n, README) | eu | 2A | Opus 5 low |
| 2C | Stats de swarm em `room.Preparation` para todos os viewers | eu | 1E | Opus 5 low |
| 3  | Seek livre: timeline HLS esparsa | eu | 2A | Opus 5 low |

Ordem de pouso: 0A→0B→0C podem ir em paralelo com 1A–1E (a subagent). 2A
espera 1B+1E. 2B espera 2A. 3 é a feature, por último.

---

## Fase 0 — fundações (testável hoje, sem worker existir)

### Tarefa 0A — Fixture de Range com injeção de falha + rig de medição
**Dono: eu. Revisor: Opus 5 low.**

O "fix ss-bridge in place" morreu, mas o papel dele de harness precisa de um
substituto (quebra de fase-0 identificada pelo crítico). Um servidor HTTP Range
só-de-dev (~100 linhas, Go ou Node) que serve um arquivo local com:

- RTT injetável (20/50/100/200 ms), jitter,
- 206 truncados (menos bytes que o pedido), 5xx aleatórios, stalls no meio do corpo,
- cap de tamanho de resposta configurável.

Dirigido pela variante `{kind:'stream'}` que já existe em
`web/src/pipeline/remuxJob.ts:124`. É o harness de teste para 0B **e** o rig
que responde a pergunta de throughput que nenhum sweep mediu.

**Portão de arquitetura (rodar antes de alugar a 2ª VPS):** rode o remux real
contra o fixture a 100 ms de RTT com a janela h2 ajustada e 2 workers do
CustomSource. O throughput sustentado precisa passar de **~1,5× tempo real
(~13 Mbit/s para o baseline de 8 GB/2 h)** com folga para o upload simultâneo
do host ao R2. A janela de flow-control por stream do hyper/h2 tem default de
64 KiB, que a 100 ms de RTT limita um stream a ~5 Mbit/s — abaixo do piso de
tempo real. Este número decide se `readBase` direto é viável.

Implementação inline:

```
web/dev/range-fixture.ts (ou cmd/rangefixture/main.go)
  - serve GET /f com Range: bytes=N-M sobre um arquivo apontado por env
  - env: RTT_MS, JITTER_MS, TRUNCATE_PCT, ERR_5XX_PCT, STALL_MS, CAP_BYTES
  - responde 206 com Content-Range honesto, corpo em stream com sleep(RTT)
    antes do 1º byte e sleep(jitter) entre chunks
  - modo "truncate": fecha o corpo depois de CAP_BYTES prometendo mais no
    Content-Range → exercita a estritez de comprimento da mediabunny
web/dev/measure-remux.ts
  - roda runRemuxJob contra o fixture, mede MB/s sustentado e time-to-first-segment
  - imprime uma tabela por RTT
```

**Revisor Opus 5 low, procurar:** o fixture reproduz *de fato* a estritez de
comprimento exato da mediabunny (`source.js:1036-1060`, "Yes, we're that
strict")? O stall no meio do corpo termina o corpo cedo (como o worker fará) ou
trava para sempre? A medição isola o teto do h2 do teto do swarm?

---

### Tarefa 0B — Leituras abortáveis e resilientes no pipeline
**Dono: eu. Revisor: Opus 5 low. Depende de: 0A.**

A mediabunny **não dá AbortSignal** para `read` (verificado:
`source.d.ts:269`, assinatura `(start,end)=>...`). O abort tem de ser capturado
na closure da source via um controller mutável, coordenado de
`clientMedia.ts:432` onde os aborts de upload já disparam no seek. Três
caminhos de leitura têm de honrar o mesmo controller: a closure do
CustomSource, a varredura de legenda de arquivo inteiro, e a varredura de
capítulos.

Disciplina de erro (verificada, load-bearing): um `throw` de um worker de
prefetch (sem pending slices) vira **unhandled rejection** dentro do Web Worker
(`source.js:1606-1620`), passando por cima de todo classificador de erro. Logo
retry, backoff, jitter e resume-a-partir-do-contador-de-bytes vivem **dentro da
closure**, que só lança para falhas terminais (401-revogado, 404/410, rejeição
de política). O `putWithRetry` existente (`clientMedia.ts:558-571`) é o modelo,
mas com deadline por-leitura separado do orçamento de retry — uma leitura
bloqueada em peças não baixadas é legitimamente lenta.

Arquivos e funções a mudar (do `design:web-migration`), em ordem de dependência:

```
web/src/pipeline/mediaInput.ts
  - interface MediaInput (:11-18) ganha abortReads(): void
  - fileInput (:20-27) implementa como no-op
  - torrentInput (:34-53) enfia no file.read e no CustomSource
  - urlInput (:60-72): converter o UrlSource(url) (:70) em CustomSource se as
    leituras de url também tiverem de abortar
web/src/pipeline/remuxJob.ts
  - streamInput (:95-119): retornar response.body (ReadableStream), NÃO
    arrayBuffer(); embutir retry+backoff+resume; nunca lançar por erro
    recuperável; maxCacheSize 64-128 MiB
  - buildInput (:121-128): (o caso 'worker' entra na tarefa 2A)
  - runRemuxJob (:135-156): dono do controller
  - extractEmbeddedSubtitles (:180-197): abortável e sob prio=scan (hoje lê o
    arquivo inteiro em fatias de 8 MiB — sobre WAN é uma 2ª cópia do filme)
  - readSideFile (:199-204)
web/src/pipeline/clientMedia.ts
  - restartAt (:424-440): abortar as LEITURAS junto dos uploads (:432), antes
    do conversion.cancel() (:433)
  - snapToKeyframe (:391-398): deadline nas leituras do getKeyPacket
web/src/pipeline/mkvChapters.ts
  - leituras em :80, :108, :113
web/src/uploadErrors.ts
  - novo código WORKER_UNREACHABLE (:6-10), classificado em remuxWorker.ts:64-72
```

**Revisor Opus 5 low, procurar:** um `throw` deliberado da closure (abort de
epoch no seek) deixa o `Input` compartilhado (`clientMedia.ts:82`, reusado em
`:486`) usável, ou o envenena? Se envenena, o mecanismo de abort-por-epoch é
inviável e força `Input.dispose()`+rebuild (com custo de perder o cache e
re-sniffar o container). Isto é um OPEN_QUESTION que 0B tem de fechar
empiricamente contra o fixture 0A.

---

### Tarefa 0C — Identidade anônima + quotas + blocklist
**Dono: eu. Revisor: Opus 5 low.**

Bloqueador de lançamento (não follow-up): hoje a autorização é "posse do room
id + ser o primeiro" (`clientmedia.go:28-31`) e `SetTrustedProxies(nil)`
(`server.go:58`) bloqueia limite por-IP. Com a bridge, torrentar gastava os
recursos do próprio usuário; um endpoint público de magnet despachando às VPSs
do dono sem identidade é torrent-as-a-service aberto.

```
internal/httpapi/session.go (novo)
  - cookie ss_sid (HttpOnly, Secure, SameSite=Lax, 32 bytes) → sess:{id} no
    Redis com TTL de dias, setado preguiçosamente na 1ª chamada de /api/torrents
internal/httpapi/quota.go (novo)
  - por-sessão: dispatches/hora (~10), jobs concorrentes (~2), bytes/dia
    (contados dos heartbeats do worker)
  - limite externo grosso por-IP (sessões criadas/hora) via CF-Connecting-IP
    (SetTrustedProxies(nil) impede ClientIP()) — ler o header explicitamente
  - montado SÓ no grupo /api/torrents; não tocar as rotas de sala
internal/worker/blocklist.go (esboço; preenchido em 1E)
  - blocklist de infohash/keyword aplicada no MOMENTO DA ASSINATURA — hashes
    rejeitados nunca são armazenados (postura do webtor, lição do Real-Debrid)
```

O gate de vídeo-apenas admite sidecars não-vídeo dentro de um torrent de vídeo
(legendas andam pelas mesmas Range reads, não há `/read-file` separado). Modelar
a sessão para que uma conta opcional futura seja só "uma sessão com user_id".

**Revisor Opus 5 low, procurar:** o cookie é reset trivial — o limite externo
por-IP realmente segura, ou um atacante rotaciona sessões? A quota de bytes/dia
vem de heartbeats que o worker reporta — o que impede um worker comprometido de
mentir os números para baixo?

---

## Fase 1 — o worker (a subagent faz esta fase inteira)

Toda a Fase 1 é a **coisa remota**. O `engine.rs` do ss-bridge já é ~80% do
gerenciador de sessão do worker (verificado): refcounting por infohash,
**cancelamento de pending-delete no re-open** (o detalhe de GC mais fácil de
errar), sweep de idle, pool de StreamSlot, timeouts de peer apertados, e quatro
patches de fork que valem carregar (janela de stream de 64 MB; **co-download**
intra-peça — até 4 peers buscam uma peça bloqueante de trás pra frente, o maior
alavanca contra stalls de seek com peças de 8–16 MB). Forkar, não reescrever.

### Tarefa 1A — `ss-worker`: engine, disco, ciclo de vida
**Dono: subagent. Revisor: Opus 5 low.**

Fatos verificados contra librqbit 9.0.1 (`design:worker-lifecycle`) que
governam o design:

- A janela de streaming de 32 MB é **advisory** — um peer sem as peças da
  janela cai no `iter_queued_pieces` e baixa o resto do arquivo
  (`piece_tracker.rs:123-160`; rqbit PR #574 ainda aberto). **Todo torrent
  servido tende ao tamanho cheio no disco.** Logo o disco é quota dura via
  admission control: reservar o tamanho do arquivo selecionado no accept do
  job, reaper LRU por torrent inteiro, recusar no high-water. **Disco, não
  uplink, é a restrição de capacidade** (~12–15 títulos por caixa de 160 GB).
- `add_torrent` dedup por infohash (`AlreadyManaged`) mas só *depois* da
  resolução do magnet → manter o mapa infohash→handle do worker na frente.
- `list_only` resolve metadata sem tocar o disco e devolve `torrent_bytes` +
  `seen_peers` → ponto de enforcement de vídeo-apenas, re-add pelos bytes
  (pula uma 2ª resolução DHT). Timeout de 90 s, órfão deletado.
- Head+tail primeiro é **built-in** (ordem de peças por-arquivo: first, last,
  meio) → moov-no-fim e MKV Cues resolvidos sem código.
- fastresume valida ~65 hashes amostrados → restart custa sub-segundos.
- `disable-upload` é feature de compile-time, sessão-inteira; nunca anunciar
  bitfield leva a choke por tit-for-tat → **não compilar**; impor leech-ish com
  cap runtime `upload_bps` por-torrent (2–5 Mbit/s enquanto quente, parar na
  evicção) — mantém velocidade de download e sibling-seeding para drains.
- `runtime_worker_threads` dimensiona um semáforo que trava **ambos**
  FileStreams concorrentes e `add_torrent` → dimensionar explicitamente
  (leases × slots + init + folga), exportar métrica de permits em uso.

Layout de módulos:

```
ss-worker/ (Rust, tokio multi-thread, librqbit 9.0.1 + os 4 ss patches vendorados)
  main.rs      config, tracing, build Session, spawn control+http+reaper, drain
  config.rs    WorkerConfig {server_url, enrollment_token, data_dir,
               public_hostname, bt_listen_port, https_port, disk_quota_bytes,
               disk_high_water_pct, max_torrents, max_leases,
               per_torrent_peer_limit, bps caps, idle_grace(120s),
               reap_ttl(180s), runtime_worker_threads}
  engine/      descendente direto do engine.rs do ss-bridge
    mod.rs     Engine {session, torrents: Mutex<HashMap<Id20, Entry>>,
               disk: DiskAccountant}
    entry.rs   Entry {handle, leases, last_active, pending_reap, selected_total,
               slots, state: TorrentPhase}
    slots.rs   pool StreamSlot (FileStream parado mantém a janela; try_lock
               fallthrough; MIN_POOLED_FILE)
    admission.rs  no Lease: max_torrents, max_leases, disco vs high_water,
               THEN list_only, THEN política vídeo-apenas, THEN commit
    reaper.rs  sweep de 5 s; idle>grace → pause+schedule reap; reap>ttl →
               session.delete(id, delete_files=TRUE) (worker compartilhado
               recupera); LRU por last_active no high_water, pulando leases vivas
```

Máquina de estados por-torrent → estado do librqbit:
`Requested → Resolving → Screening → Validating → Ready → Serving → Idle
(paused, bytes mantidos; re-open cancela o reap) → Reaped / Failed (1 retry
in-place)`. Invariantes: (1) torrent com lease viva nunca é reapado; (2)
pending_reap e lease viva são mutuamente exclusivos; (3) toda transição escreve
last_active; (4) DiskAccountant é creditado/debitado só em Validating (reserva
o pior caso) e Reaped (libera o real).

**Revisor Opus 5 low, procurar:** o DiskAccountant reserva o pior caso no
accept, mas a janela advisory significa que o download pode ultrapassar a
reserva? O que acontece em ENOSPC no meio de uma sala (corrompe a sala pra
todo mundo, não só recusa um job)? O cancelamento de pending-delete no re-open
tem corrida entre o sweep e o novo Lease?

---

### Tarefa 1B — `ss-worker`: data plane HTTP
**Dono: subagent. Revisor: Opus 5 low. Depende de: 1A + o contrato do sistema.**

Servir o contrato do data plane exatamente como especificado acima. Detalhes
verificados:

- **Transmitir corpos de 206**, nunca bufferizar (a bridge bufferizava 64 MB em
  RAM por request — OOM em multi-tenant). Modelo: o handler do rqbit
  (`ReaderStream::with_capacity(stream.take(len), 65536)` → 206).
- Cap ~16 MiB por resposta com Content-Range honesto; o cliente re-pede o
  resto. 416 só para `start ≥ size`; clampar ends longos por RFC 9110.
- CORS em toda resposta **incluindo 4xx/416**, senão o browser reporta falha
  CORS genérica em vez do status real. `Access-Control-Allow-Origin` = audience
  do ticket (exato, não `*`); `Access-Control-Expose-Headers: Content-Range,
  Accept-Ranges` (Content-Range é obrigatório assim que as respostas têm cap).
- **h2 com janela de flow-control por-stream levantada** — o default de 64 KiB
  limita a ~5 Mbit/s a 100 ms de RTT. Este é o número que 0A vai medir.
- Abort: client abort → RST_STREAM → axum dropa o corpo → guarda `Drop` retrai
  a janela de peças; segurar quente ~30 s para reconexão. Evento normal, não erro.
- Deadlines: 1º byte ≤ ~30 s → 504; stall no corpo ≤ ~20 s → terminar o corpo
  cedo (o cliente resume). Deadline detecta morte, não lentidão.
- Classes de prioridade: `prio=head` (probes de sniff/tail, urgente e minúsculo)
  · `playhead` (o remux) · `scan` (varredura de legenda, estritamente atrás do
  playhead, idealmente só de peças já em disco).
- Sidecar: `/v1/file/{ticket}/{index}`, prioridade de arquivo inteiro, cap 8 MB.
- `/v1/t/{…}/haves`: bitfield cru + `x-bitfield-len` + piece length (formato do
  rqbit já pronto) para a barra de ranges.

```
ss-worker/http/
  mod.rs      axum Router + rustls (ALPN h2 + http/1.1); janela h2 levantada
  range.rs    GET /v1/f/{ticket}: verifica assinatura+escopo do ticket,
              adquire slot, stream via ReaderStream, 206 + Content-Range
  hint.rs     POST /v1/hint/{ticket}: move a janela para readOffset, cancela
              prioridade da região abandonada, para de alimentar respostas
              cujo gen < G
  file.rs     GET /v1/file/{ticket}/{index}: sidecar, prioridade inteira, cap
  haves.rs    GET /v1/t/{ih}/haves: bitfield cru (Accept: application/octet-stream)
  cors.rs, shutdown.rs (contador de in-flight + deadline de drain)
metrics.rs    /metrics em porta separada bind-loopback: as_prometheus() +
              gauges do worker (ssw_disk_used, ssw_leases, ssw_range_stall_seconds
              histograma — o SLI visível ao usuário — ssw_avg_piece_download_seconds,
              ssw_cert_expiry_seconds)
```

**Revisor Opus 5 low, procurar:** o 206 truncado no cap de 16 MiB casa com a
estritez de comprimento exato da mediabunny? (O cliente tem de resumir dentro
da closure — mas o worker tem de fechar de um jeito que o cliente resuma, não
que quebre.) O guarda `Drop` dispara de fato quando o browser aborta via
RST_STREAM em axum/hyper, ou uma conexão TCP semi-aberta faz o Drop nunca
rodar (precisa do sweep de idle de 30 s como cinto-e-suspensório)?

---

### Tarefa 1C — `ss-worker`: ACME (certs de IP/nome)
**Dono: subagent. Revisor: Opus 5 low. Depende de: 1A.**

O game-changer de 2026 (`web:acme-for-workers`): o Let's Encrypt emite certs de
**endereço IP** (GA 2026-01-15, perfil `shortlived` de 160 h, http-01 na :80).
Um worker VPS não precisa de nada além de um IP público e a porta 80 aberta —
sem domínio, sem DNS. Renovações via **ARI são isentas de todos os limites** do
LE, então o único consumo de budget é a 1ª emissão de um worker novo.

Crate: **`instant-acme` 0.8.5** (verificado: suporta `Identifier::Ip`, perfis
ACME, ARI; o rcgen transforma o IP em SAN `iPAddress` automaticamente).
`rustls-acme` está desqualificado (grep do fonte: zero suporte a perfis, IPs,
ARI). Caddy hardcoda uma recusa a pedir cert de IP público.

```
ss-worker/http/tls.rs
  - instant-acme: NewOrder::new(&[Identifier::Ip(ip)]).profile("shortlived")
    (ou [Dns(nome), Ip(v4), Ip(v6)] num pedido só)
  - challenge Http01, servir key_authorization em /.well-known/acme-challenge/
    numa porta :80 (~30 linhas de hyper)
  - renovar via ARI: persistir o CertificateIdentifier do predecessor, NewOrder
    ::replaces(cert_id) — só a 1ª substituição é isenta, persistir através de restart
  - resolver de cert do rustls que devolve o cert quando SNI está AUSENTE
    (browsers não mandam SNI para URL de IP literal, RFC 6066)
  - hot-reload via ArcSwap: renovação nunca dropa uma stream viva
  - readiness gate: o worker NÃO anuncia elegibilidade com cert expirado/ausente
```

Custódia de chave é o modelo Tailscale, não o wildcard do Plex: o worker gera e
guarda as próprias chaves. Um `*.workers.*` compartilhado em todo worker é a
única opção rejeitada de saída. Frota do dono: subdomínio por worker num
**domínio registrado dedicado** (não `workers.giuli.dev` — compartilha o bucket
de 50 certs/semana com `ss.giuli.dev` pelo PSL). Testar contra staging primeiro.

**Revisor Opus 5 low, procurar:** com certs de 160 h, um worker offline por uma
semana volta com cert morto = falha TLS dura no meio da sala, sem bypass. O
`notAfter` está no heartbeat e o servidor recusa colocar job num worker cujo
cert expira dentro da duração esperada da sala? A regra "não chamar `replaces`
duas vezes contra o mesmo predecessor" sobrevive a um restart do worker?

---

### Tarefa 1D — `ss-worker`: control plane
**Dono: subagent. Revisor: Opus 5 low. Depende de: 1A.**

```
ss-worker/control/
  mod.rs       cliente WSS de saída: loop de reconexão com jitter; heartbeat a
               cada 10 s {worker_id, version, uptime, disk_used/quota, torrents,
               leases, load, digest por-torrent, cert notAfter+resultado}
  envelope.rs  verify Ed25519 de todo job de entrada (servidor assina, worker
               verifica): rejeitar não-assinado, rejeitar replay (nonce+exp),
               rejeitar payload que carregue URL em vez de infohash
  jobs.rs      Lease(infohash, file_hint, room_id, exp) / Release(lease_id) /
               Drain / SetLimits / Revoke(jti) / CertUpdate (se a topologia
               empurrar cert pelo canal em vez de ACME local)
  enroll.rs    token de enrollment one-shot → worker gera keypair Ed25519 local,
               CSR se for o caminho de subdomínio, recebe cert/confirmação
```

**Revisor Opus 5 low, procurar:** o `verify_strict` do ed25519-dalek está em uso
(não `verify` — previne forja com chave fraca)? O envelope liga o job a ESTE
worker (`worker_id == self`), senão um job roubado do fio de outro worker é
usável? O nonce é checado contra um store persistente que sobrevive a restart,
ou um replay depois de restart passa?

---

### Tarefa 1E — Servidor Go: `internal/worker/`
**Dono: subagent. Revisor: Opus 5 low. Depende de: 1D + 0C.**

O lado servidor é greenfield (internal/ tem zero código de torrent hoje). A
API a copiar é a máquina de estados debrid (Real-Debrid/TorBox, verbatim):
**registrar por infohash → listar arquivos → selecionar (a seleção porta o
download) → emitir a URL de bytes.** Dois padrões do repo modelam a auth: o
grammar de claim/presign em `clientmedia.go`, e — comportamentalmente exato — o
endpoint de token do LiveKit (`screenshare.go`): membro autenticado troca a
associação por uma credencial curta e escopada para um serviço terceiro que o
browser então contata direto.

```
internal/worker/ (novo)
  registry.go   liveness em memória (espelha o Hub), fatos duráveis no Redis:
                worker:{id} hash, workers:by_seen ZSET, job:{id}, worker:{id}:jobs
  affinity.go   tabela infohash→worker DERIVADA do conteúdo do heartbeat
                (o que cada worker segura agora) — tabela derivada não fica stale
  placement.go  filtros duros (healthy, disco>fileSize*1.2, jobs<max) →
                AFINIDADE de infohash (rewatch/próximo episódio instantâneo) →
                least-loaded composto. Nunca round-robin (jobs de horas, desiguais)
  signer.go     assina envelopes Ed25519; blocklist de infohash no momento da assinatura
  hub.go        control-plane WSS de entrada (/worker-link), enrollment, heartbeat
internal/httpapi/torrent.go (novo)
  POST /api/torrents {infoHash,trackers?,dn?} → 202 {jobId}   (picker roda ANTES
    da sala; resolve DHT leva 10-60 s → poll, não bloquear)
  GET  /api/torrents/{jobId} → {state, name, files[]}  (lista volta PELO servidor)
  POST /api/torrents/{jobId}/select {fileIndex} → {readBase, ticket, expiresAt}
  POST /api/torrents/{jobId}/token → ticket renovado (remux dura horas)
  DELETE /api/torrents/{jobId}  keepalive
config: internal/config/config.go ganha campos de worker (enrollment secret,
    signing key path, proxy policy flag); Load() no estilo os.Getenv existente;
    validateMedia NÃO exige worker (instância sem worker ainda boota, falha só o torrent)
lifecycle:
  - SourceHooks.CancelMedia (declarado, chamado em source.go:90-92, ligado a nil
    em main.go:73) → ligar: para o job do worker e revoga tickets
  - sweeper (sweeper.go:52-81) que já reclama claims stale → também libera leases,
    senão uma aba morta deixa um worker segurando 50 GB pra sempre
```

Zero workers: flag de capacidade anunciada pelo servidor (torrents
disponível/ocupado/desabilitado) que a UI lê para desabilitar o caminho de
magnet — códigos distintos "no_workers" vs "workers_busy", sem fila, sem
fallback. Lembrar: a resolução de metadata precisa de um worker, então essa
falha aterrissa no paste, não no play.

**Revisor Opus 5 low, procurar:** a tabela de afinidade derivada de heartbeat
tem janela onde um worker deletou os dados mas o heartbeat ainda não atualizou →
o servidor despacha para um worker que não tem mais as peças? O failover empurra
`rebase` pelo canal página→worker, mas o offset semeado é o offset de LEITURA
(não o playhead da sala — contradição resolvida pelo crítico)?

---

## Fase 2 — a troca (eu faço)

### Tarefa 2A — Cliente web `remoteTorrent.ts`
**Dono: eu. Revisor: Opus 5 low. Depende de: 1B + 1E.**

O seam `TorrentSession`/`TorrentVideoFile`/`TorrentStats` em `torrent.ts:4-47` é
o presente da migração: TorrentPicker, Home, Room, openStream e upload.ts
consomem só essa forma. Escrever o cliente novo para satisfazê-la mantém a
mudança em algumas centenas de linhas.

```
web/src/worker/remoteTorrent.ts (novo)
  openRemoteTorrent(request, onStats?): Promise<TorrentSession>
    devolve {name, files, subtitleFiles, stats(), select(path), destroy()}
    + abortReads() (para o seek, de clientMedia.ts:432)
    + renewToken() (dirigido por expiresAt; um remux de 50 GB dura horas)
    + rebase(url) (failover: página→worker via {type:'rebase'} simétrico ao follow)
  cada TorrentVideoFile.read(start,end) faz retry com backoff, honra abort de sessão
  CONTROL via /api (browser nunca aprende URL de worker antes da autorização)
  DATA direto ao workerOrigin: GET /v1/f/{ticket} + Range (ticket no caminho)
web/src/pipeline/remuxJob.ts
  - buildInput ganha o caso 'worker' (retorna response.body como ReadableStream)
  - RemuxSource ganha variante {kind:'worker', origin, sessionId, fileIndex,
    ticket, name, size} — tudo string/number, structured-cloneable (cruza o Worker)
web/src/torrent.ts
  - openTorrent (:62-71) dropa o gate helperAvailable(), despacha ao cliente novo
  - HelperRequiredError → NoWorkersError/WorkersBusyError (semântica invertida)
  - openTorrent hoje toma magnet string (buildMagnet) — jobs carregam infohash;
    ou parsear server-side, ou mudar a assinatura para {infoHash, trackers?, dn?}
```

A heurística de resume (`Room.tsx:253-258`) tem de ser re-derivada: transitório
"sem worker livre" mantém o entry de resume (retentável); "infohash rejeitado"
ou "controller perdido" limpa. Errar isso perde salas resumíveis ou deixa
entries mortos por 5 h. Manter o branch page-thread `'input'` (`upload.ts:281`)
vivo — mocks e testes dependem dele.

**Revisor Opus 5 low, procurar:** o ticket no caminho vaza em access logs do
worker / histórico do browser? (Aceitável com TTL de 15 min sobre HTTPS, mas
confirmar.) O `renewToken` no meio de uma leitura bloqueada de horas: o worker
valida o ticket só no início do request (mais simples, correto) ou
continuamente (mata a leitura quando o ticket expira)?

---

### Tarefa 2B — Deletar o ss-bridge
**Dono: eu. Revisor: Opus 5 low. Depende de: 2A.**

Inventário completo (`design:web-migration`):

```
DELETAR inteiro:
  web/src/localHelper.ts (291 linhas — toda a maquinaria de LNA)
  web/src/localHelper.test.ts (os 4 testes provam o gate de LNA, sem análogo)
  web/src/components/BridgeStatus.tsx (234 linhas) + CSS em theme.css:862-913
  web/src/components/platform.ts (77 linhas — só ancoragem de prompt de LNA)
  playConnect() em onboarding/sounds.ts:96-102 (ou repropor p/ "swarm tem peers")
  27 chaves bridge.* × 2 idiomas (en.ts / pt-BR.ts :22-47)
  seção "### Torrents" do README.md :54-66, e as claims em :16, :35-36, :45, :80, :275
REESCREVER:
  torrent.test.ts (asserções de interface ficam; origin loopback vira /api + worker)
  home.torrentNeedsBridge → mensagem de capacidade de worker
  onboard.own.body / .aside :216-217 (zero-install agora é o ponto)
  os 4 call sites que ramificam em HelperRequiredError (TorrentPicker:109,
    Home:278, Room:258, Room:318)
  Onboarding.test.tsx:52,56 (asserta na string ss-bridge — vai falhar)
  comentários em mediaInput.ts:3,29-33, remuxJob.ts:92-94, vite.config.ts:22-24
```

Não há teste de paridade de chaves entre os dicionários — uma chave deletada de
um e não do outro falha em runtime silenciosamente. Cuidado.

**Revisor Opus 5 low, procurar:** algum `streamUrl`/`127.0.0.1`/`bridge` sobra
que compila mas quebra em runtime? Os `127.0.0.1` em README:151,165,176,181 são
o bind do Docker (não mexer) — o revisor confirma que não foram deletados junto?

---

### Tarefa 2C — Stats de swarm para todos os viewers
**Dono: eu. Revisor: Opus 5 low. Depende de: 1E.**

Hoje os stats de swarm vêm de um Map no nível de módulo na aba do host
(`upload.ts:70-75`), então só quem abriu o magnet vê peers/velocidade. Com o
worker heartbeatando `{peers, downSpeed, haveBytes}` ao servidor, os números vão
para `room.Preparation` (`types.go:117-131`, adicionar `Swarm *SwarmStats`) e
chegam a todos pelo poll de `GET /api/rooms/:id` que já existe. Ganho de produto
de graça. Manter o caminho local do host (1 Hz) como overlay rápido.

**Revisor Opus 5 low, procurar:** o campo novo em Preparation flui de fato pelo
`NotifyRoomUpdated` sem mudar o shape que o cliente espera?

---

## Fase 3 — seek livre (a feature)

### Tarefa 3 — Timeline HLS esparsa
**Dono: eu. Revisor: Opus 5 low. Depende de: 2A.**

A camada de bytes move para o worker, mas os achados de seek do sweep 1 valem:
mediabunny random-access está provado (~50 ms seek + copy-remux, <5% do arquivo
lido; landmines: fMP4 sem `mfra`, MKV sem Cues → varredura de 100% — detectar e
recusar). Os bloqueadores restantes vivem na **camada de publicação**: uma
região tocável por vez (`playlists.clear()`), o escalar `mediaOffsetMs`, e o
render de playlist do servidor que corta no primeiro buraco — enquanto as tags
`DISCONTINUITY`/`GAP`/`MAP` já passam validação e os segmentos de regiões mortas
já persistem no R2.

```
- Prototipar hls.js com EXT-X-GAP + DISCONTINUITY + MAP por-região em três
  regiões disjuntas ANTES de construir (verificar que o gap não trava)
- publisher.go para de truncar no 1º buraco; regiões mantidas e reusadas no back-seek
- aposentar o escalar mediaOffsetMs e o teardown de hls.js por-região
- lado worker já pronto por construção (seek = AsyncSeek + hint; head+tail
  pinning e co-download já cobrem os probes)
- portar o e2e antigo: "a sala toca antes do torrent terminar, e um seek para
  20:00 é servido sem baixar 0:00–20:00" + seek-storm + two-head-fairness
```

**Revisor Opus 5 low, procurar:** o hls.js realmente tolera um GAP no meio da
playlist com MAP variando por descontinuidade, ou vai para live-recovery e
joga o viewer pro fim? Se não tolera, o design de N-playlists muda
`mediaOffsetMs` de escalar para mapa de regiões pelo player/servidor/pipeline.

---

## Decisões em aberto (do dono, antes de fechar as tarefas que dependem)

1. **Chaveamento do R2:** objetos por-sala + TTL-deletados, ou content-addressed
   por infohash? As duas recomendações do egress-ledger se contradizem. Dedup
   corta as linhas de custo dominantes e dá rewatch instantâneo — mas um bucket
   content-addressed compartilhado é um índice público do que a instância
   assistiu, e precisa de política de evicção própria. **Maior decisão de custo.**
2. **Domínio de workers dedicado, ou só-IP?** Nomes sobrevivem a mudança de IP
   mas criam um índice permanente da frota em CT log sob um registrante; certs de
   IP não vazam ligação. Para duas VPSs, só-IP é defensável.
3. **Retenção do worker após a sala morrer** — número atado ao TTL de 5 h e ao
   orçamento de disco. Interage direto com o valor da afinidade de infohash.
4. **Postura de seeding** confirmada: upload capado a 2–5 Mbit/s enquanto quente,
   parar na evicção, DHT announce on/off, nunca trackers privados.
5. **O browser verifica os bytes do worker?** Os hashes de peça verificam no
   worker, não no browser. Para workers do dono, "a frota é confiável" é
   provavelmente ok — escrever com o raio de dano (vídeo arbitrário em qualquer
   sala pelos PUTs presignados do host).
6. **A medição-portão (0A)** — o remux real passa de ~1,5× tempo real a 100 ms
   de RTT com a janela h2 ajustada? Se não, as opções são tuning de prefetch,
   levantar a janela, ou repensar as leituras diretas — melhor aprender no
   fixture da fase 0 que numa VPS alugada.
