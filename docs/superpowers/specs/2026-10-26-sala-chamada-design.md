# Sala vira chamada — design e plano paralelo

Data: 2026-10-26. Mockups: https://claude.ai/artifact/5Sx1MXZSbfakR92ZR4wCG7
(canvas "Juntos — sala nova": sala em grade, sala com dois palcos, entrada com
senha, `/juntos new` no Discord).

## Intenção

A sala deixa de ser "um filme com gente olhando" e vira uma chamada no estilo
Meet / X Calls: várias pessoas, câmera e microfone para quem quiser, pin, e
**palcos** — mídia (arquivo, torrent, YouTube), live e telas — que coexistem.
Um app novo do Discord cria a sala com `/juntos new`. Torrent, remux no PC do
host, ss-worker, legendas ASS e MoQ continuam e são reaproveitados. O visual
inteiro passa para a base do lawcore.

## Decisões do usuário

- Não é Activity do Discord: é um **app novo** ("Juntos") com comando de barra
  `/juntos new` (opções `nome` e `senha`).
- O `/juntos new` responde só para quem rodou ("Entrar como host"). Quando o
  host entra, o app posta no canal o card da sala (nome, cadeado se tem senha,
  avatares, quem está e o que passa, botões "Entrar" e "Copiar link") e vai
  atualizando.
- Convidado continua **anônimo** com apelido (sem login do Discord).
- Senha opcional na sala.
- Qualquer um liga câmera e microfone; o host desliga a câmera e silencia
  qualquer um. Quem preferir fica na voz do Discord.
- Mais de uma pessoa compartilha (tela / filme) ao mesmo tempo, **pedindo ao
  host**.
- Pin de pessoa ou palco.
- Legenda no PiP, sem re-encodar o vídeo.
- Base visual: skill `lawcore-design-eng`
  (`~/projects/lawcore/.claude/worktrees/main/.claude/skills/lawcore-design-eng`,
  com `components.md` e `motion.md`). **Ignorar `lawcore-flat`.** Tokens em
  `~/projects/lawcore/.claude/worktrees/main/packages/ui/src/styles/tokens.css`.
- Toda animação segue a física do **spring popover** do lawcore
  (`packages/ui/src/spring-popover.module.css`): nasce do gatilho em `scale: 0`
  + `blur(8px)`, abre com `--ease-spring-pop` (600 ms), fecha com
  `--ease-spring-settle` (360 ms); reduced-motion vira opacidade.
- Chat no layout do Discord (avatar, nome na cor da pessoa, hora, mensagens
  seguidas agrupadas) com o **voo da mensagem enviada** do lawcore
  (`apps/web/src/components/chat/use-send-flight.ts` e `use-send-anchor.ts`):
  440 ms, `cubic-bezier(.32,.72,0,1)`, sai de trás do composer achatada a 0,86 e
  desfocada em 14 px. Mensagem dos outros aparece pronta.
- **Sem subdescrição** em lugar nenhum (ver `CLAUDE.md`).
- Formato arredondado (pílulas, botões redondos) fica.
- Backend continua em Go (a reescrita em Rust foi oferecida e adiada).

## Decisões do builder (podem ser revistas)

- **Palcos, fase 1:** no máximo **1 palco de mídia com linha do tempo**
  (arquivo / torrent / YouTube; é o pipeline atual inteiro, sem mudar o prefixo
  no R2 nem o ss-worker), **1 live** e **até 4 telas**, coexistindo. Abrir outra
  mídia substitui a atual (como o `/source` hoje), mas **não derruba mais telas
  nem live**. O protocolo já é uma lista de palcos, então abrir mais mídias
  depois só mexe no store.
- Quem abriu o palco de mídia (`SourceMemberID`) dá play/pause/seek nele, além
  do host.
- Cada pessoa escolhe o que fixar; o host pode **destacar para todos**
  (spotlight), e quem quiser sai do destaque localmente.
- Câmera e voz pelo **mesmo relay MoQ da Cloudflare** das telas. Teste de
  latência primeiro (tarefa A). Se a voz passar de ~400 ms boca-ouvido, a tarefa
  para e reporta (alternativa: SFU só para voz/câmera).
- O host silenciar / desligar câmera é aplicado no servidor (estado no membro) e
  em todos os clientes (param de assinar aquela faixa), não só no do alvo.
- Discord: interações por HTTP no próprio backend Go (`POST
  /api/discord/interactions`, ed25519). Post e edição do card pela API de bot
  (precisa do app instalado no servidor); instalado só na conta da pessoa,
  usa o token da interação (15 min) e depois congela.

## Modelo

### Servidor (`internal/room/types.go`)

- `Room.SourceKind` **sai**. O que existe é derivado: palco de mídia = há
  `upload_id`/`Status` de mídia; live = `Room.Live != nil`; telas =
  `Room.Screens`.
- Novos campos: `Name string` (nome da sala), `JoinMode string`
  (`"open" | "password" | "approval"`), `PasswordHash string` (`json:"-"`),
  `Spotlight *Spotlight` (`{kind: "media"|"live"|"screen"|"member", memberId?}`),
  `Discord *DiscordLink` (`json:"-"`: `channelId`, `messageId`,
  `interactionToken`, `tokenExpiresAt`, `guildInstalled`).
- `Member` ganha `Mic bool`, `Cam bool` (o que a pessoa declarou),
  `HostMuted bool`, `HostCamOff bool`.
- A sala nasce **vazia** (sem mídia). `POST /api/rooms` aceita
  `{nickname, name?, joinMode?, password?}`; `kind` e `fileName` saem.

### Protocolo WS novo (`internal/sync/messages.go`, `web/src/types.ts`)

Cliente → servidor:

| type            | campos                                   | quem                 |
| --------------- | ---------------------------------------- | -------------------- |
| `media`         | `mic`, `cam` (bool)                      | qualquer membro      |
| `hostMute`      | `targetId`                               | host                 |
| `hostCamOff`    | `targetId`                               | host                 |
| `stageRequest`  | `kind` (`media`/`screen`/`live`)         | convidado            |
| `stageAnswer`   | `requestId`, `allow`                     | host                 |
| `stageClose`    | `kind`, `targetId?` (dono da tela)       | host ou dono         |
| `spotlight`     | `kind?`, `targetId?` (vazio = tira)      | host                 |
| `admit`/`deny`  | `targetId` (id do pedido de entrada)     | host                 |

Servidor → cliente: `members` (já existe, agora com os campos novos),
`forceMedia` `{mic?: false, cam?: false}` para o alvo, `stageRequest`
`{requestId, memberId, nickname, kind}` para o host, `stageGrant`
`{kind, allow}` para quem pediu, `spotlight` `{spotlight}`, `lobby` (você está
esperando o host), `knock` `{requestId, nickname}` para o host, `admitted`,
`denied`.

Pedido aprovado vira uma **concessão** em memória no hub (`memberId → kind`,
vale 10 min ou até ser usada). As rotas HTTP que hoje exigem controller
(`/source`, `/live`, `/screenshare/token`, `/screenshare/live`, client-media,
subtitles, remux) passam a aceitar **controller ou concessão** (e o dono atual
do palco para operar o próprio palco). `screenShareOpen` sai: tela também é
pedido + concessão, e o host abre direto.

### Entrada

- `open`: como hoje.
- `password`: `POST /api/rooms/:id/join {password}` → `{ticket}` (HMAC de
  `roomId|exp`, 2 min). O `hello` do WS leva `ticket`; sem ticket válido, erro
  `password_required` / `bad_ticket`. Hash argon2id (`golang.org/x/crypto`).
  Limite de tentativas por IP e por sala.
- `approval`: `hello` sem ser admitido → `lobby`; host recebe `knock`;
  `admit` libera o join normal, `deny` fecha.
- Host (ownerToken) sempre entra direto.
- `GET /api/rooms/:id/preview` (público, sem mídia): `name`, `joinMode`,
  `memberCount`, até 5 apelidos — para a tela de entrada.
- `PATCH /api/rooms/:id/access {joinMode, password?}` só host.
- `POST /api/rooms` com rate limit por IP (hoje não tem).

### Câmera e voz

- Uma transmissão MoQ por pessoa:
  `juntos/{room}/{screen_secret}/av/{memberId}.hang`, vídeo ~360p (até ~600
  kbps) e áudio Opus com `echoCancellation`, `noiseSuppression`,
  `autoGainControl`. Token de publish para qualquer membro autenticado
  (`POST /api/rooms/:id/call/token`).
- Cliente assina o áudio de todos que não estão `HostMuted`/sem `Mic`, e o vídeo
  só das tiles visíveis.
- Safari/iPhone: pela ponte `ss-moq-bridge` existente.
- Indicador de fala por nível de áudio (WebAudio).

## Plano: 5 tarefas em paralelo

Cada tarefa roda num worktree próprio a partir da `main` com este documento.
Regras comuns:

- Leia este documento inteiro e o `CLAUDE.md`.
- **Não toque arquivos de outra tarefa** (lista abaixo). Em `hub.go`,
  `rooms.go`, `store.go`, `types.go` e `web/src/types.ts`, que são
  compartilhados, adicione o mínimo (um `case` no switch, um campo) e ponha a
  lógica em arquivos novos (`hub_call.go`, `hub_stage.go`, `hub_join.go`…) —
  o merge depois é feito à mão.
- TDD onde houver lógica (`go test ./...`, `npx vitest run`). No fim:
  `go build ./... && go test ./...` e, em `web/`, `npm run build` (não basta
  `tsc --noEmit`) e `npx vitest run`.
- Commits pequenos, uma linha de assunto em português no estilo do repo
  (`feat: …`/`fix: …`), **sem corpo e sem Co-Authored-By**. Não dê push.
- Ao terminar: relate o que fez, o que ficou de fora, e o que a integração
  precisa ligar.

### A — Câmera e voz (MoQ)

1. **Teste de latência primeiro** (descartável, em `web/dev/`): duas abas
   Playwright (`channel: 'chrome'`, ver `web/dev/e2e-screen.mjs`) publicam e
   assinam áudio pelo relay real; meça boca-ouvido com um clique gerado e
   detectado. Reporte o número. Acima de ~400 ms, **pare e reporte**.
2. Generalize `web/src/screenshare.ts` + `screen/useScreenShare.ts` num módulo
   `web/src/call/` (transmissão por pessoa: publicar câmera+microfone, assinar,
   nível de áudio, troca de dispositivo, pré-visualização local para a tela de
   entrada). A tela continua funcionando sobre o mesmo núcleo.
3. API para a UI: `useCall({roomId, memberId, capability, send})` →
   `{mic, cam, setMic, setCam, devices, setDevice, previewStream, speaking:
   Record<id, boolean>, forced}` e um componente `<CallVideo memberId />` que
   renderiza a câmera de alguém (ou a sua). `send` é a função de envio do WS
   (a integração passa).
4. Servidor: campos de `Member`, mensagens `media`, `hostMute`, `hostCamOff`,
   `forceMedia` (`internal/sync/hub_call.go`), rota
   `POST /api/rooms/:id/call/token` (`internal/httpapi/call.go`).
5. Arquivos seus: `web/src/call/**`, `web/src/screenshare.ts`,
   `web/src/screen/useScreenShare.ts`, `internal/sync/hub_call.go`,
   `internal/httpapi/call.go`, `web/dev/e2e-call*.mjs`.

### B — Palcos e limpeza do tipo de sala

1. Tire `SourceKind` e tudo que decide "a sala é de tela/live/upload" no
   servidor (`rooms.go`, `source.go`, `store.go` `SwapSource` não derruba mais
   telas nem live, `hub.go` `handleSource`) e no cliente (`upload.ts`
   `createScreenRoom`, `isScreenRoom`/`isLiveRoom`/`isStageRoom`, `MediaSwitch`).
2. Sala nasce vazia: `POST /api/rooms {nickname, name?}` (D acrescenta
   `joinMode`/`password` depois); a primeira mídia entra por `/source` numa
   sala vazia. Ajuste `upload.ts` (criar sala e depois abrir mídia).
3. Pedidos e concessões (`stageRequest`, `stageAnswer`, `stageGrant`,
   `stageClose`), spotlight, e a autorização "controller ou concessão ou dono"
   nas rotas de mídia/tela/live (`internal/sync/hub_stage.go`, helper único de
   autorização). `screenShareOpen` sai.
4. Dono do palco de mídia controla play/pause/seek/rate junto com o host.
5. Cliente: `web/src/types.ts` (sem `sourceKind`, com `spotlight`, `name`),
   `player/useSync.ts` expõe um `send(msg)` genérico e os eventos novos
   (pedidos, concessão, spotlight) num formato fácil de a UI consumir
   (`web/src/room/stages.ts` com um reducer testado: lista de palcos
   derivada do `RoomInfo`).
6. **Não mexa em `pages/Room.tsx` além do necessário para compilar** (C
   reescreve a página; deixe só o mínimo funcionando).
7. e2e: `web/dev/e2e-stages.mjs` — host abre arquivo, convidado pede tela, host
   aprova, os dois palcos coexistem; trocar a mídia não derruba a tela.
8. Arquivos seus: `internal/room/**`, `internal/sync/hub.go` (núcleo),
   `internal/sync/hub_stage.go`, `internal/httpapi/{rooms,source,screenshare,live,clientmedia,subtitles}.go`,
   `web/src/upload.ts`, `web/src/player/useSync.ts`, `web/src/room/stages.ts`,
   `web/src/types.ts`.

### C — Base visual e a sala nova (UI)

1. Porte do lawcore para `web/src/ui/` e `web/src/styles/tokens.css`: tokens
   (claro e escuro, `data-theme`, Geist), `SpringPopover` (+ `useSpringPresence`
   para popups próprios), pílula, botão redondo, segmentado, `Tip`, avatar por
   matiz, toast, diálogo no molde do "Novo contato", e o voo da mensagem
   (`useSendFlight`). Leia a skill `lawcore-design-eng` antes.
2. `MorphingMenu`/`MorphPanel`/`morphTokens` saem; todo menu vira
   `SpringPopover`. `theme.css` é reescrito em cima dos tokens (o que for
   específico de tela vai para CSS modules ao lado dos componentes).
3. A sala nova como **componentes de apresentação** em `web/src/room/ui/`,
   alimentados por um modelo de view que você define em
   `web/src/room/model.ts` (`RoomViewModel`: pessoas com mic/cam/fala/host,
   palcos, spotlight, pedidos, chat, modo de entrada; e callbacks). Peças:
   cabeçalho (nome, tempo, pílula de acesso, pílula de pessoas), grade de
   pessoas com pin, vista com palcos (palco em foco grande + coluna com outros
   palcos e câmeras), doca (mic, câmera, Compartilhar com o menu de fontes,
   reações, chat, sair), painel lateral Chat | Pessoas que empurra a grade,
   cartão de pedido, menu de pessoa do host (silenciar, desligar câmera,
   fixar, destacar para todos, expulsar), menu "quem pode entrar", tela de
   entrada (prévia de câmera, apelido, senha), sala de espera. Siga o canvas.
   Para `<CallVideo>` e o player use slots (`renderVideo(memberId)`,
   `renderStage(stage)`), a integração liga.
4. Uma rota de desenvolvimento (`/dev/sala`) que monta a sala com um
   `RoomViewModel` falso e interativo, para ver tudo sem servidor.
5. Home simplificada: criar sala (nome, senha opcional) e entrar por código.
   As fontes (arquivo, torrent/catálogo, YouTube) saem da Home e vão para o menu
   Compartilhar; reaproveite os componentes existentes de catálogo e
   seleção, só como UI.
6. Celular: grade e doca funcionam em 390 px; painel vira sheet de baixo.
7. Arquivos seus: `web/src/ui/**`, `web/src/styles/**`, `web/src/theme.css`,
   `web/src/room/ui/**`, `web/src/room/model.ts`, `web/src/pages/Home.tsx`,
   `web/src/chat/**`, `web/src/App.tsx` (rota dev), componentes visuais em
   `web/src/components/**`. **Não** mexa em `player/`, `screenshare.ts`,
   `upload.ts`, `useSync.ts` nem no servidor.

### D — Entrada, senha e app do Discord

1. `JoinMode`, `PasswordHash` (argon2id), `POST /api/rooms/:id/join` →
   ticket, `hello` com `ticket`, lobby/knock/admit/deny
   (`internal/sync/hub_join.go`), `GET /api/rooms/:id/preview`,
   `PATCH /api/rooms/:id/access`, rate limit de criação de sala e de
   tentativas de senha. Cliente: `web/src/join.ts` (funções de API) — sem UI.
2. App do Discord em `internal/discord/`: verificação ed25519, `PING`,
   comando `/juntos new` (opções `nome`, `senha`) que cria a sala pelo mesmo
   serviço do `POST /api/rooms` e responde ephemeral com o link de host
   (`ownerToken` no fragmento `#`), sem postar no canal. Quando o host entra pela
   primeira vez, posta o card no canal; atualiza (debounce de ~10 s) quando
   entra/sai gente ou muda a mídia; ao fechar a sala, edita para "encerrada".
   Usa a API de bot se o app estiver no servidor; senão, o token da interação
   enquanto valer. Interface `ActivityNotifier` que o hub chama em
   join/leave/mídia (adicione as chamadas mínimas em `hub.go`).
3. `cmd/discord-register`: registra o comando (global) com o bot token.
4. Config: `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`
   (compose só repassa env listada em `environment:` — adicione lá).
5. Testes com payloads assinados por uma chave gerada no teste.
6. Arquivos seus: `internal/discord/**`, `cmd/discord-register/**`,
   `internal/sync/hub_join.go`, `internal/httpapi/{join,access,discord}.go`,
   `internal/config/config.go`, `docker-compose.yml`, `web/src/join.ts`.

### E — PiP com legenda e robustez

1. PiP com legenda: Document Picture-in-Picture (Chrome/Edge) levando o
   `<video>` e o canvas do JASSUB; fallback (Safari/Firefox) desenhando vídeo +
   legenda num canvas a cada frame e usando `canvas.captureStream()` num
   `<video>` oculto para o PiP. Botão de PiP no player. Arquivos:
   `web/src/player/pip.ts` (+ teste) e o mínimo em `Player.tsx`.
2. Robustez no WS: limite de taxa por cliente (balde de tokens por tipo de
   mensagem; chat, `stageRequest`, `knock` com limites mais baixos),
   tamanho máximo de mensagem, e testes (`internal/sync/client.go`,
   `internal/sync/ratelimit.go`).
3. Harness de carga `web/dev/e2e-load.mjs`: N clientes Playwright (padrão 12)
   com câmera e microfone falsos (`--use-fake-device-for-media-stream`) entram,
   conversam, ligam câmera; mede memória, CPU e erros. Escreva contra o
   protocolo deste documento; ele roda de verdade depois da integração.
4. Fuzz (`go test -fuzz`) do decode de `Inbound` e do hello.
5. Arquivos seus: `web/src/player/pip.ts`, `web/src/player/Player.tsx`
   (só o botão e o gancho do PiP), `internal/sync/client.go`,
   `internal/sync/ratelimit.go`, `web/dev/e2e-load.mjs`.

## Depois das 5 tarefas (no loop principal)

1. Merge na ordem B → D → A → E → C, resolvendo os pontos compartilhados.
2. Integração: `pages/Room.tsx` passa a montar `web/src/room/ui` com o
   `RoomViewModel` feito de `useSync` + `useCall` + `stages` + `join`.
3. e2e: `e2e-stages`, `e2e-screen`, `e2e-subtitles`, `e2e-seek`, carga.
4. Revisão: skills `antislop`, `antislop-ui`, `antislop-code`,
   `antislop-human`, `antislop-copywriting`, `emil-design-eng`,
   `review-animations`, `web-design-guidelines`; `/security-review`; teste de
   estabilidade com o harness.
5. Deploy (ver memória `ss-vps-deploy`) e conferir no browser. Spec sai do repo
   no último commit.
