# P2P na entrega de mídia do ss — viabilidade, segurança e estabilidade

Data: 2026-08-22. Pesquisa feita por 7 agentes (mapa do código, arte prévia
peer-assisted, codecs — ver `2026-08-22-p2p-codecs.md` —, transporte WebRTC, segurança, e
um crítico adversarial sobre o conjunto). Este doc é a síntese; números carregam fonte.

## Veredicto

**Nenhuma variante de P2P passa no teste custo/benefício na configuração atual do ss.**
A única tecnicamente defensável (peer-assisted HLS com origin como fallback) economizaria
**cerca de meio centavo de dólar por sala** — porque o custo que o P2P atacaria já é ~zero.

| Variante | Veredicto |
|---|---|
| P2P puro (peers substituem o origin) | Morto: áudio AC-3/DTS/TrueHD não decodifica em navegador nenhum; o HLS que o player consome só existe depois do FFmpeg; churn mata a última cópia; iOS nativo nem tem loader. |
| Uploader serve do navegador | Morto três vezes: `original.{ext}` é apagado no fim do remux (`queue.go:371`); o `File` morre com a aba; o player consome fMP4+AAC+ladder que só o FFmpeg produz. É o modelo que o PeerTube removeu na v6. |
| WebTorrent no navegador | Morto: PeerTube (maior usuário) abandonou; qBittorrent nunca habilitou WebRTC; swarms públicos praticamente sem peers WebRTC. O ramo existente em `web/src/torrent.ts` tem bug latente (`select()` do fallback não seleciona nada, `torrent.ts:151,181-184`) e zero testes. |
| LiveKit como transporte de segmento | Morto por definição: é SFU — todo byte volta para a VPS, teto de 15 KiB por pacote. Serve só como sinalização, e o hub WS já faz isso mais barato. |
| **Peer-assisted HLS (`fLoader` + p2p-media-loader v4)** | **Única defensável tecnicamente; não se justifica economicamente hoje.** Guardada com critérios de reavaliação (abaixo). |

## Por que o prêmio é ~zero

- A VPS **não serve nenhum byte de mídia**: só playlists `.m3u8` (`internal/httpapi/media.go:27-84`).
  Segmentos, init e legendas saem do R2 via `MEDIA_PUBLIC_URL` (`publisher.go:449`), com
  `Cache-Control: immutable` de 1 ano e edge da Cloudflare na frente.
- Egress do R2 para a internet é **gratuito**. Sobra Class B ops: sala de 20 assistindo um
  episódio de 45 min ≈ 9-18 mil GETs *assumindo hit ratio zero no edge* ≈ **US$ 0,003-0,006**.
  P2P com 95% de offload economiza meio centavo, na hipótese irreal.
- O único custo que **escala com viewers** é outro: o polling da playlist EVENT com
  `no-store` (`media.go:82`) — 20 membros repollando uma playlist que chega a 80-100 KB a
  cada ~4 s durante todo o preview ≈ **~3 Mbit/s de texto** + 2 round-trips de Redis por
  poll. P2P não toca nesse custo; ETag/`If-None-Match` ou delta playlist (`EXT-X-SKIP`)
  resolvem com dezenas de linhas.
- A conversa muda se: (1) `MAX_PARTICIPANTS` for para centenas ou muitas salas assistirem
  o mesmo conteúdo (swarm cross-sala); (2) o egress passar a ser cobrado (sair do R2);
  (3) medição em produção mostrar a entrega de segmentos como gargalo. Hoje não se sabe
  nem o hit ratio do edge — medir antes de qualquer decisão.

## O que a arte prévia diz

- **p2p-media-loader (Novage) v4.0.0** (2026-08-19, ativo, 0 issues abertas): o P2P não
  opera na borda do playhead — `highDemandTimeWindow` (0-15 s) é HTTP-first; a troca P2P
  vive na janela distante, populada por **prefetch HTTP aleatório** que diverge os buffers
  deliberadamente. Watch party em VOD estável é caso favorável (PeerTube mediu 98% de
  offload em VOD vs ~75% em live, stress test com 1.000 browsers reais, 2023).
- **Mas o regime favorável não sobrevive ao ss:** durante o preview a playlist é truncada
  no último segmento publicado (`publisher.go:472-479`) — não existe janela distante, o
  swarm vale zero exatamente na fase mais longa e frágil. E um **seek do controlador**
  invalida o buffer distante dos 20 peers ao mesmo tempo: os bytes pré-baixados viram
  lixo e todos caem juntos na janela HTTP-first — thundering herd com o download pago
  duas vezes. Swarm também **fragmenta por rendição** (o swarmId do PeerTube inclui codec
  e resolução): sala de 20 com ABR heterogêneo vira 3-4 swarms de 4-6 peers.
- **Teleparty** (o watch party mais bem-sucedido) não faz P2P de mídia nenhum — só
  sincroniza. **Peer5/Streamroot** foram absorvidos em eCDN corporativo (Microsoft/Lumen),
  onde o P2P de fato ganha (LAN gerenciada). Limiar de utilidade citado no mercado:
  **~500 espectadores concorrentes no mesmo conteúdo**; salas de ≤20 estão 1,5 ordem de
  grandeza abaixo.

## Transporte (se um dia for construído)

- RTCDataChannel: mensagens ≤ 16 KiB são o baseline seguro; descobrir limite real via
  `pc.sctp.maxMessageSize`; backpressure por `bufferedAmount` (Chrome fecha o canal se o
  buffer passar de 16 MB). Throughput cai forte com RTT (série medida é pré-dcSCTP —
  **lacuna: não há benchmark público pós-M95**; medir com p2pspeedtest.com antes de
  dimensionar).
- NAT: 10-22% das sessões precisam de relay (agregados de mercado); IPv6 nativo dos dois
  lados dispensa NAT. **TURN é autodestrutivo aqui**: relay custa 2× a banda na VPS — com
  20% de relay numa mesh de 20, ~76 fluxos relayados vs 20 no modelo servidor-central.
  Cair para HTTP é o fallback correto, não TURN.
- Mesh de 19 conexões está longe dos limites do browser (500 PC/processo); o limite real é
  o **uplink residencial**: 95% de offload numa sala de 20 a 4 Mbps exige 76 Mbps de
  upload agregado sustentado. O paper DSN mediu upload chegando a **200% do download com
  só 3 peers** — numa sala com screenshare LiveKit ativo, o seeding disputa uplink com o
  único fluxo em tempo real do produto.

## Segurança (fonte-âncora: "Stealthy Peers", DSN 2024, arXiv:2212.02740)

- **Poluição de segmento**: Peer5 e Viblast falharam no teste (manifesto intacto +
  segmentos trocados); poluição atinge 47% dos viewers em live P2P em escala. A defesa —
  hash por segmento assinado pela origem — era inviável para PDNs (não controlam a
  origem) e é **trivial para o ss**: o FFmpeg é nosso. Hash sobre a **tupla**
  `(bytes, roomID, generation, mediaVersion, variante, sequência)` mata replay. O
  p2p-media-loader v4 expõe `validateP2PSegment` (default: sem validação).
- **IP**: nenhum mecanismo de navegador em 2025/26 esconde o IP público entre peers (mDNS
  só cobre o IP local, e nem isso se a página tem permissão de câmera/mic). Numa sala
  fechada de ≤20 convidados o vazamento é "amigos veem o IP uns dos outros" — nível de
  uma chamada WebRTC comum —, mas exige consentimento explícito (LGPD/GDPR: IP é dado
  pessoal) e opt-out (padrão PeerTube: aviso fixo + toggle). Risco residual: alguém entra
  na sala só para coletar IPs; o gate é o roomID de 8 chars.
- **Swarm fechado obrigatório**: sem DHT, sem PEX, sem tracker público — sinalização pelo
  hub WS autenticada pela `capability` de 32 bytes já existente (`hub.go:154-161`,
  precedente em `screenshare.go:55-58`). Seedar para estranhos é o agravante jurídico;
  swarm restrito à sala o remove.
- **E2EE (Insertable Streams): fora de escopo** — a API não cobre DataChannel, o
  transporte já é DTLS obrigatório, e o adversário real (membro da sala) é destinatário
  legítimo.
- macOS 26: a primeira `RTCPeerConnection` da página dispara o prompt de sistema "Local
  Network" (w3c/webrtc-pc#3109) — em sala de upload não há `getUserMedia` prévio para
  absorvê-lo; ordem de inicialização vira requisito de produto.

## Estabilidade: o gate é o ativo em risco

O acoplamento mais perigoso é específico do ss: `gateOnStall` pausa **a sala inteira**
quando um membro seca (`gate.go:236-260`, cooldown de 20 s); prontidão exige 3 s de buffer
em 20 s (`gate.go:12-27`); correção de drift é seek duro a 450 ms (`useSync.ts:177`).
Churn de swarm viraria pausa coletiva a cada 20 s, e o laço peer sai → stall → re-gate →
seek → cache miss → stall se retroalimenta. `MemberReadiness` (`sync/messages.go:64-74`)
não carrega a origem dos bytes — o gate não distinguiria "internet ruim" de "churn de
swarm". Qualquer implementação precisa estender o readiness e desligar P2P por membro/sala
quando o swarm causar re-gates.

## Ponto de inserção correto (registrado para o futuro)

`fLoader` custom no hls.js — mesmo padrão do `codecStrippingLoader` já existente
(`Player.tsx:938-960`), testável no harness atual (`PlayerHls.test.tsx`). Nunca tocar em
`publisher.go:449` (URLs relativas quebram o player nativo do Safari). Segmentos já são
imutáveis e endereçados por nome+geração — a chave de swarm natural é o prefixo
`rooms/{id}/g{N}/hls/`, derivada com segredo para não ser adivinhável.

## Correções colaterais encontradas pela pesquisa (valem por si)

1. README diz "prévia usa segmentos de 2 segundos"; o código usa 4 (`remux.go:25`).
2. Ramo WebTorrent do navegador (`web/src/torrent.ts:151,181-184`): fallback adiciona o
   torrent com `deselect: true` e nunca seleciona nada — dívida sem testes; remover ou
   consertar.
3. Polling de playlist EVENT com `no-store` é o único custo por-viewer que escala —
   ETag/304 ou delta playlists dão mais retorno que qualquer swarm.

## Fontes principais

- [p2p-media-loader](https://github.com/Novage/p2p-media-loader) (README, FAQ, `core.ts`, `hybrid-loader.ts`) — v4.0.0
- [PeerTube stress test 2023](https://joinpeertube.org/news/stress-test-2023) · [v6 sem WebTorrent](https://joinpeertube.org/news/release-6.0) · [privacy guide](https://docs.joinpeertube.org/admin/privacy-guide) · issues #5493, #2934
- [Stealthy Peers (DSN 2024, arXiv:2212.02740)](https://arxiv.org/abs/2212.02740)
- [RFC 8831 (data channels)](https://www.rfc-editor.org/rfc/rfc8831.pdf) · [Mozilla — Large Data Channel Messages](https://blog.mozilla.org/webrtc/large-data-channel-messages/) · [coturn wiki — performance](https://github.com/coturn/coturn/wiki/TURN-Performance-and-Load-Balance)
- [LiveKit — data packets](https://docs.livekit.io/home/client/data/packets/) (SFU, 15 KiB)
- [webtorrent FAQ](https://webtorrent.io/faq) · [qBittorrent #4163](https://github.com/qbittorrent/qBittorrent/issues/4163)
- [w3c/webrtc-pc#3109 (prompt Local Network, macOS 26)](https://github.com/w3c/webrtc-pc/issues/3109)
