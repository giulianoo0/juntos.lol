# Catálogo buscável estilo Stremio

Data: 2026-08-21 · Status: aprovado em conversa, pendente de revisão final

## Objetivo

Transformar a Home em um catálogo de filmes e séries estilo Stremio — busca,
fileiras de pôsteres, página de detalhes — alimentado pelo Cinemeta (metadados)
e por um addon de streams compatível com o protocolo Stremio (Torrentio por
padrão). Escolher um stream cria uma sala pelo fluxo de torrent existente.
Dentro de uma sala, o catálogo reabre como overlay: o host troca a fonte, os
viewers navegam livremente e pedem títulos ao host.

## Decisões tomadas

- **Catálogo vira a Home** (rota `/`). O upload manual continua no header:
  botão "Upload manualmente" abre um dialog com duas opções — **enviar
  arquivo** (drop-zone atual, que mantém o campo de magnet) e **compartilhar
  tela**.
- **Navegação local + pedido sincronizado** (não há "browse together"):
  dentro da sala cada pessoa navega por conta própria; só o pedido de título
  trafega pelo WebSocket.
- **Detalhes como overlay morphing** com URL própria (`/title/:type/:id`),
  deep-linkável. Morph estilo blumoplay/platform (FLIP), reimplementado com a
  lib `motion`.
- **Addon de streams configurável**: `VITE_STREAM_ADDON` (base URL), default
  `https://torrentio.strem.fun`.

## APIs externas (verificadas, CORS aberto)

- Catálogo: `https://cinemeta-catalogs.strem.io/top/catalog/{movie,series}/top.json`
  (o host `v3-cinemeta.strem.io` redireciona para lá; usar `fetch` com redirect
  padrão resolve). Gêneros: `top/genre=X.json`.
- Busca: `https://v3-cinemeta.strem.io/catalog/{movie,series}/top/search=Q.json`
  → `{ metas: [{ id, imdb_id, type, name, poster, background?, releaseInfo }] }`.
- Meta: `https://v3-cinemeta.strem.io/meta/{type}/{id}.json` → `{ meta }` com
  `description, genre[], cast[], director[], imdbRating, runtime, background,
  logo, videos[]` (séries: `videos[{ id, season, episode, name, released }]`).
- Streams: `{addon}/stream/{type}/{id}.json` — para séries o id é
  `tt123:1:2` (temporada:episódio) → `{ streams: [{ name, title, infoHash,
  fileIdx?, behaviorHints.filename? }] }`. O `title` embute qualidade, seeds
  (👤), tamanho (💾) e origem (⚙️) separados por `\n`/emoji — parsear para
  exibir limpo.
- Magnet: `magnet:?xt=urn:btih:{infoHash}&dn={filename}` + trackers públicos
  padrão. `fileIdx`/`filename` selecionam o arquivo dentro do torrent no fluxo
  existente sem precisar do passo manual do TorrentPicker.

## Arquitetura

### Frontend — módulo novo `web/src/catalog/`

- `cinemeta.ts` — cliente + tipos (`CatalogMeta`, `MetaDetail`, `Video`);
  cache em memória por URL; funções `fetchCatalog(type, genre?)`,
  `searchCatalog(query)` (movie+series em paralelo, merge), `fetchMeta(type, id)`.
- `streams.ts` — `fetchStreams(type, id, season?, episode?)`, parser do
  `title` do Torrentio (`parseStreamTitle` → `{ label, quality, seeds, size,
  source, filename }`), `buildMagnet(stream)`.
- `PosterCard.tsx` — card 2:3 com pôster, nome, ano; hover com leve escala e
  reveal; fonte do morph (registra o rect / `layoutId`).
- `MetaRow.tsx` — fileira horizontal com scroll, título da seção, stagger de
  entrada.
- `SearchBar.tsx` — busca com debounce (~300 ms), resultados em grade
  substituindo as fileiras enquanto há query.
- `Catalog.tsx` — a nova Home: header atual (wordmark, "Upload manualmente",
  histórico, idioma), busca, fileiras (Filmes populares, Séries populares,
  + 2–3 gêneros fixos). Reutilizável dentro do overlay da sala.
- `MetaDetails.tsx` — overlay/página de detalhes: hero com `background`,
  logo/nome, sinopse, elenco, nota; séries: seletor de temporada + episódios;
  lista de streams (`StreamList.tsx`). Botão por stream:
  - fora de sala: "Assistir" → dialog de apelido → cria sala + torrent;
  - host na sala: "Trocar para este" → swap de fonte;
  - viewer na sala: "Pedir ao host" → mensagem `titleRequest`.
- `CatalogOverlay.tsx` — wrapper do catálogo dentro da sala (fullscreen sobre
  o player, spring de entrada, fecha com Esc/botão).

### Morph (estilo blumo, com `motion`)

- Card → detalhes: FLIP. O painel de detalhes monta fixado no rect do card
  clicado (mesmo raio de canto) e anima até o layout final; conteúdo (chrome,
  texto) segurado invisível até o fim do morph, então revela com stagger
  (`y: 24 → 0`). Fechar reverte para dentro do card. Implementação com
  `motion`: `layoutId` compartilhado entre o pôster do card e o hero do
  painel, ou FLIP manual com `animate()` se o `layoutId` cruzar mal os
  limites do overlay — o comportamento visual é o contrato, não a técnica.
- Deep link (sem rect de origem) e `prefers-reduced-motion`
  (`useReducedMotion`): fade simples, sem morph.
- Tokens: durações/easing derivados de `--ease`/`--t-open`/`--t-close`.

### Rotas (`App.tsx`)

- `/` → `Catalog` (nova Home).
- `/title/:type/:id` → `Catalog` com `MetaDetails` aberto por cima (o estado
  "veio de um clique" carrega o rect de origem; acesso direto = fade).
- `/room/:id` → inalterada.

### Fluxos de sala

- **Criar sala a partir de stream** (fora de sala): dialog de apelido atual →
  `createRoomAndUploadTorrent`-equivalente com magnet + seleção automática do
  arquivo por `fileIdx`/`filename` (estender `web/src/torrent.ts` para
  aceitar a dica de arquivo e pular o picker).
- **Trocar fonte** (host): caminho existente `chooseTorrent` /
  `changeRoomSource` + `startTorrentTransfer` (`Room.tsx:155`, `upload.ts`).
- **Pedido de título** (viewer): novo tipo WS.

### Backend — mensagem `titleRequest`

- `internal/sync/messages.go`: campos novos com `omitempty` em
  `Inbound`/`Outbound`: `Title *TitleRequest` com `{ metaId, metaType, name,
  poster, season?, episode? }` e, no outbound, `from` (nickname) + `fromId`.
- `internal/sync/hub.go`: `case "titleRequest"` em `handleInbound` — valida
  campos (limites de tamanho), ignora se vier do controller (host não pede a
  si mesmo), rate-limit simples (1 pedido / 5 s por membro), broadcast a toda
  a sala. Sem persistência.
- Cliente (`useSync.ts`): espelho no `interface Outbound`, estado
  `titleRequests` (lista com timestamp), `sendTitleRequest(...)` exposto no
  `SyncResult`.
- UI: pedido aparece como card no chat (pôster mini + nome + quem pediu);
  para o host o card tem ação "ver streams" que abre o overlay direto nos
  streams daquele título.

### i18n

Todas as strings novas em `web/src/i18n/pt-BR.ts` e `en.ts` (chaves
`catalog.*`, `details.*`, `request.*`, `home.uploadManually`, etc.).

## Motion (resumo)

- Entrada das fileiras/cards: fade + rise com stagger curto na primeira
  pintura e ao trocar busca↔fileiras.
- Hover do card: escala leve + sombra (CSS onde basta; motion onde há layout).
- Morph card↔detalhes (acima). Overlay da sala: spring de entrada.
- Tudo condicionado a `useReducedMotion`.

## Erros

- Cinemeta fora do ar: fileira mostra estado de erro discreto com retry; a
  Home nunca bloqueia o upload manual.
- Addon sem streams / erro: estado vazio claro na lista de streams ("nenhuma
  fonte encontrada") com o upload manual como saída.
- Pedido de título com sala cheia de mensagens: rate-limit no hub + dedupe no
  cliente (mesmo título do mesmo membro em 60 s não repete).

## Testes

- `cinemeta.test.ts`: parsing de catálogo/meta/busca com fixtures.
- `streams.test.ts`: `parseStreamTitle` (variações reais do Torrentio),
  `buildMagnet`.
- `hub_test.go` / `messages_test.go`: `titleRequest` — broadcast, validação,
  rate-limit, controller ignorado.
- `useSync.test.ts`: recepção de `titleRequest` e exposição no estado.
- Componente: busca com debounce renderiza resultados; card de pedido no chat.

## Fora do escopo (YAGNI)

Biblioteca/watchlist, continue watching, instalação de addons arbitrários,
calendário, paginação infinita do catálogo (as fileiras usam o top ~50 de
cada catálogo).
