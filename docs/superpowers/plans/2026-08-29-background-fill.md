# Preenchimento em segundo plano — plano

**Meta:** fazer todo seek virar *warm* com o tempo, sem tirar nada do playhead.
Dois lados, independentes:

1. **Worker (Rust)** — quando a janela do playhead está satisfeita e há disco,
   seleciona o resto do arquivo para o swarm ir baixando; cai na hora em que
   alguém pede outra coisa. Corta a parte "download" (~3 s de ~7 s) do cold seek.
2. **Host (TS)** — quando a região ao vivo chegou ao fim do arquivo, o remux vai
   preencher os buracos da timeline em vez de estacionar. Com o tempo toda
   posição tem região no R2 e o seek abre em <1 s como um seek quente.

**Fora de escopo:** N downloads paralelos (não há banda a ganhar — o swarm já é
paralelo por piece; cursores extras só dividem os peers), pré-remux do arquivo
inteiro antes de tocar, mudanças no viewer (o `regionFor`/`regionHolds` já
lidam com N regiões).

---

## Parte 1 — worker: `fill`

### Hoje
`apply_window_with` (`ss-worker/src/engine/mod.rs`) seleciona só
`[cursor−BEHIND, cursor+AHEAD]` de cada slot + pins (`window.rs`). A sweep
(`reaper.rs`, 5 s) reaplica com `release=true` e `release_behind_window`
devolve ao disco o que ficou fora. A reserva de disco é `window::footprint`.

### Regra
`entry.fill: bool`. Ligado **só pela sweep** quando:
- não há startup em curso (`since_hint() >= STARTUP` para o playhead);
- a janela do playhead está **inteira em HAVE** (todas as pieces de
  `[at−BEHIND, at+AHEAD]`; sem playhead aberto → não liga);
- cabe: `disk.used() − disk.reserved(self) + file_len ≤ high_water`.

Desligado **imediatamente** por qualquer sinal de que o leitor mudou de lugar:
`hint()`, `open()` com `moved`, e pela própria sweep quando a condição de HAVE
ou de disco deixa de valer. Ligar/desligar loga `tracing::info!(fill = ...)`.

Com `fill` ligado, `needed_ranges_for` recebe um cursor extra cobrindo o
arquivo inteiro (`Cursor{at:0, ahead:file_len, behind:0}`), então a seleção é
tudo e a sweep não libera nada. O que ordena o swarm é a prioridade de stream
do librqbit (`streams.rs::queue`): as pieces na janela do stream do playhead
vêm antes de qualquer outra; o restante do arquivo só é pedido quando as da
janela já estão todas em voo. **Premissa a validar (V1).**

### Disco
- Ao ligar: `disk.reserve_unchecked(infohash, file_len)` (a promessa passa a
  ser o arquivo inteiro). Ao desligar: volta a `footprint`; a sweep seguinte
  faz o punch do que ficou fora da janela normal.
- Admissão de um torrent novo (`select()` → `reserve` falha): antes de
  `evict_idle_until_room`, `shed_fill(need)` desliga o fill dos torrents (maior
  primeiro) e refaz a reserva. Um fill nunca custa uma sala nova.

### Como ler HAVE
`handle.with_chunk_tracker(|ct| ct.get_have_pieces())` (usado em
`streaming.rs::poll_read`). **Validar visibilidade (V2)** — se for `pub(crate)`,
expor com um patch mínimo no vendorizado, como os existentes.

### Testes
- `window.rs`: cursor de fill cobre tudo e mescla com pins.
- engine: fill liga só com janela HAVE + disco; desliga em hint/moved; shed
  libera reserva para uma admissão nova. (Testes de unidade sobre a lógica
  pura — `fill_decision(...)` extraída para função sem I/O.)

---

## Parte 2 — host: regiões de preenchimento

### Hoje
`remuxAndPublish` (`web/src/pipeline/clientMedia.ts`) roda `while(true)`: uma
região converte de `nextStartSeconds` até o fim do arquivo; ao terminar,
`break` se `timelineCovered()` (ou começou do zero), senão **estaciona**
(`wakeFollow`) até o próximo cold seek.

### Regra
Ao terminar uma região "ranToEnd" com a timeline ainda descoberta, em vez de
estacionar:
1. calcular os buracos: spans de `regionMap()` ordenados; primeiro trecho
   `[gapStart, gapEnd)` não coberto (tolerância `COLD_BEHIND_MS`);
2. `nextStartSeconds = snapToKeyframe(gapStart/1000)`, `fillEndSeconds =
   gapEnd/1000 + SEGMENT_SECONDS` (uma folga de segmento para emendar);
3. `continue` — a região seguinte nasce com `trim: {start, end}`.

Preferência de buraco: o que começa logo *antes* do playhead atual
(`lastFollowMs`) — é para onde o host mais provavelmente volta; depois os
demais em ordem. Um seek durante o preenchimento é só um `restartAt` como
qualquer outro: a região de fill morre, a nova nasce no alvo; quando ela chega
ao fim, o loop volta a preencher.

Uma região com `end` não é `ranToEnd` (`regionSpanMs` usa o ledger, nada muda).
`timelineCovered()` decide o `break` — com fill ele acaba chegando a `true` e o
run termina de verdade (`releaseClaim`, etc.), sem estacionar nunca.

**Premissa a validar (V3):** `Conversion.init({ trim: { start, end } })` do
mediabunny 1.55.2 com o patch trim+copy (`patches/`) faz stream-copy com `end`
sem re-encodar e sem o bug que o patch corrige.

**Premissa a validar (V4):** `uncovered()`/`follow()` com a região de fill
`growing` — um seek para dentro do buraco que a região de fill está
produzindo deve contar como coberto (regionAimMs + COLD_AHEAD_MS) e não
reiniciar; um seek para fora deve reiniciar normalmente.

### Custo/limites
Sem throttle na primeira versão: o preenchimento só roda quando a região ao
vivo já acabou (não há competição de uplink). CPU do host: stream-copy. R2:
segmentos extras (egress grátis, storage irrisório). Se ficar pesado, o
seguinte é pausar o fill enquanto `document.hidden` ou enquanto a sala está
pausada há muito tempo — não agora.

### Testes
- `clientMedia` (vitest existente para regiões): após região ao fim com buraco
  atrás, nasce região com `trim.end`; `timelineCovered` fecha o run; seek
  durante fill reinicia no alvo e depois retoma o fill.

---

## Ordem
1. Parte 1 (contida, worker; deploy só do worker).
2. Parte 2 (web; deploy só do app).
3. Medir: `[seek-trace] host` num seek para trecho já preenchido deve mostrar
   o viewer abrindo sem `coldWait`; `docker compose logs worker | grep fill`.

---

## Emendas após validação (Opus 5, 2026-08-29)

V1 parcial: prioridade de stream confirmada (`streaming.rs:43-51`, janela 64 MiB
à frente por stream; `piece_tracker.rs:129-190`), mas (a) o `try_steal` do
passo 1 não filtra por prioridade → filtrar para pieces prioritárias; (b)
desselecionar não cancela in-flight → custo inerente de 1 piece por peer, igual
ao de hoje com AHEAD=256 MiB; aceito. V2 ok (`with_chunk_tracker` é pub). V3 ok
(guardar `start < end`; montar `trim` sempre; progresso da região de fill).
V4: `regionAimMs = start` na região de fill e `forwardEdge` limitado a
`fillEnd`; `ranToEnd` e o `break` do zero só sem `fillEnd`; `closeRegion` deve
selar playlists que já têm ENDLIST; buracos calculados após `ledger.settled`.

Disco: fill liga só com **20 s sem hint**; ao desligar entra em `holding`
(reserva continua `file_len`, sweep não libera) — o que baixou fica até um
`shed` por pressão de disco, que faz o punch síncrono; `select()` mantém
`file_len` quando `holding`. Custo de uplink/R2 da Parte 2 fica registrado
como risco; pausa com `document.hidden` fica para depois.
