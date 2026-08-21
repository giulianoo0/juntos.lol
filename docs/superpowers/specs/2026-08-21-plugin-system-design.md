# Sistema de plugins de fontes

Data: 2026-08-21

## Problema

Hoje o Torrentio está soldado no `web/src/catalog/streams.ts`: uma URL fixa,
um formato fixo, e a única saída é a variável de build `VITE_STREAM_ADDON`.
Quem clona o repositório recebe junto um resolvedor de torrents que talvez não
queira, e quem quer outra fonte não tem por onde entrar.

A resolução de fontes vira um ponto de extensão. O Torrentio sai do repositório
e passa a ser um plugin como qualquer outro, instalado por quem quiser usá-lo.

## O contrato

Um plugin é um módulo ES com duas exportações.

```js
export const manifest = {
  id: 'torrentio',
  name: 'Torrentio',
  version: '1.0.0',
  hosts: ['torrentio.strem.fun'],
  updateUrl: 'https://github.com/user/ss-plugin-torrentio',  // opcional
}

export async function streams(target, api) {
  const id = target.season
    ? `${target.id}:${target.season}:${target.episode}`
    : target.id
  const res = await api.fetch(`https://torrentio.strem.fun/stream/${target.type}/${id}.json`)
  return (await res.json()).streams
}
```

`target` é `{ type: 'movie' | 'series', id, season?, episode? }`, com `id`
sendo um IMDb id vindo do Cinemeta.

`streams` devolve o formato de stream do Stremio. Isso não é diplomacia com o
Stremio, é economia: `parseStreams`, os filtros de qualidade e idioma e o
`openCatalogStream` já falam esse formato, então quase nada precisa mudar e o
plugin do Torrentio cabe em quinze linhas.

Cada stream carrega uma de duas formas de apontar para os bytes:

- `infoHash` (40 hex) com `fileIdx` opcional — um torrent
- `url` — um arquivo por HTTPS, `.mkv`, `.mp4`, o que for

As duas são suportadas de ponta a ponta. Sem a segunda, um plugin só sabe
falar torrent, e o ponto de extensão não é ponto de extensão nenhum.

Campos do manifest:

| Campo | Obrigatório | Regra |
|---|---|---|
| `id` | sim | `[a-z0-9-]{1,64}`; rótulo de exibição, e nada mais |
| `name` | sim | até 64 caracteres, exibido na lista |
| `version` | sim | texto livre, exibido na lista |
| `hosts` | sim | nomes de host, sem esquema nem caminho; até 253 caracteres cada, lista não vazia |
| `updateUrl` | não | repositório git de onde o plugin se atualiza, lido só na instalação |

O `id` não decide nada, e em particular **não é a chave do registro**. Se
fosse, instalar um plugin qualquer que declarasse `id: 'torrentio'`
sobrescreveria o Torrentio instalado — origem, hosts aprovados e tudo — em
silêncio. Quem identifica um plugin entre versões é a origem travada na
instalação, descrita adiante, e a chave do registro é derivada dela.

Plugins resolvem fontes e nada mais. O catálogo continua sendo o Cinemeta
embutido; não há ponto de extensão para catálogo, e acrescentar um depois não
quebra este contrato.

## Execução

O plugin roda num Web Worker. **Nenhum código de plugin executa na página, em
momento nenhum** — nem para ler o manifest, nem para instalar, nem para
atualizar. Essa é a regra da qual todo o resto depende, porque um plugin que
executa na página tem `localStorage`, tem o IndexedDB dos outros plugins e tem
`/api` com as credenciais da sala; a caixa seria decorativa.

O contorno tem três camadas, e nenhuma delas sozinha basta.

**Cabeçalho.** O script do worker é servido com
`Content-Security-Policy: default-src 'none'; script-src blob:`. É a única
camada que o código do plugin não pode contornar por construção, e é ela que
fecha o `import()` de módulo remoto — que busca a URL **antes** de rejeitá-la,
e portanto é um canal de exfiltração de largura arbitrária que nada de dentro
do worker consegue remover.

O `script-src blob:` não é frouxidão: é o módulo do próprio plugin, que é
importado de um blob. Sem ele, `default-src 'none'` bloquearia o próprio
plugin e o sistema inteiro deixaria de funcionar. O que ele não permite é
`https:`, que é o ponto. De quebra, a ausência de `'unsafe-eval'` e de
`'wasm-unsafe-eval'` remove `eval`, `new Function` e a compilação de
WebAssembly de dentro do worker — a documentação de quem escreve plugin diz
isso, porque é uma limitação real.

**Escopo.** O bootstrap reduz o escopo global a uma **allowlist**, removendo
tudo o mais **subindo a cadeia de protótipos** (parando antes de
`Object.prototype`, onde moram `hasOwnProperty` e `toString`). Duas decisões,
e as duas foram aprendidas errando.

Subir a cadeia, porque `self.fetch = undefined` apenas sombreia: o original
continua em `WorkerGlobalScope.prototype`, a um `Object.getPrototypeOf(self).fetch`
de distância.

Allowlist e não denylist, porque uma denylist perde para toda API nova que a
plataforma entrega. Uma lista de proibidos escrita com cuidado ainda deixou
passar `WebSocketStream` — um segundo WebSocket com outro nome, egresso de
rede completo — e `webkitRequestFileSystemSync`, armazenamento persistente com
ponto de entrada global que não passa por `navigator`. Enumerar o que o plugin
**pode** ficar é a única forma que não apodrece. Na prática, o escopo cai de
385 nomes para cerca de 125: os intrínsecos do ECMAScript, o `postMessage` que
é a única saída, e um punhado de utilitários sem alcance nenhum — `console`,
`crypto`, `performance`, temporizadores, `TextEncoder`/`TextDecoder`, `URL`,
`AbortController` e os streams. Ficam de fora, entre outros, `navigator`,
`location` e `origin`: sem eles o plugin não consegue nem montar a URL absoluta
da própria origem.

**Mediação.** A única saída é `api.fetch`, que empacota o pedido num
`postMessage` para a página, e é a página que decide se ele acontece:

- só `https:`
- só hosts declarados no manifest, comparados por igualdade exata do hostname
- nunca a própria origem, nem `localhost`, nem endereço IP literal
- **a mesma conferência sobre a URL onde a resposta chegou**, não só sobre a
  que foi pedida: um host declarado responde `302` para onde quiser, e uma
  política que só olha o pedido é uma política de pré-voo
- corpo lido com teto de 4 MB, e um `AbortController` por resolução, abortado
  junto com o worker — senão os pedidos em voo sobrevivem ao teto de tempo

A resposta volta para o worker como `{ ok, status, text }`, e o plugin recebe
um objeto com `ok`, `status`, `text()` e `json()` — parecido o bastante com
`Response` para não surpreender, pequeno o bastante para não vazar capacidade.

Cada resolução tem um teto de 15 segundos e um teto de 32 requisições. Estourar
qualquer um dos dois mata o worker e o plugin conta como falho naquela
resolução. Um worker é criado por resolução e destruído no fim; plugins não
guardam estado entre chamadas.

Isto fecha o que dá para fechar de forma honesta, e sobra um limite que não
dá. A política casa hostnames, não endereços: um plugin pode declarar um host
que resolve para a LAN de quem o instalou e fazer o navegador bater em
serviços da rede local. O CORS impede o plugin de **ler** essas respostas, mas
não impede o pedido de acontecer, e um pedido pode ser o efeito. Fechar isso
exigiria resolver DNS no navegador, o que o navegador não oferece. Está na
documentação, dito assim.

E a confiança acaba em quem escreveu o plugin de todo jeito: um plugin escolhe
o que devolver, e um magnet que ele devolva é um magnet que a sala vai abrir.

## Instalação e atualização

Instalados ficam no IndexedDB, por navegador, **chaveados pelo SHA-256 da
origem** — `git:<updateUrl>` ou `file:<nome do arquivo>`. Cada registro guarda
o código fonte, o manifest lido dele, a origem travada, o SHA-256 do código, o
SHA do commit quando veio de um repositório, os hosts aprovados, e se está
ligado.

Ler o manifest é executar o topo do módulo, e por isso acontece **no mesmo
worker endurecido** que roda `streams`, não na página. O worker importa o
módulo, devolve o manifest por `postMessage`, e morre. Instalar e atualizar
usam o mesmo caminho. Isto importa mais do que parece: a atualização automática
roda a cada abertura do site sobre código recém-baixado de um repositório, sem
clique nenhum — se ela executasse na página, um repositório de plugin
comprometido teria execução arbitrária na origem do site, e o worker inteiro
seria teatro.

**Arrastar um `.js`** instala aquele arquivo. Se o manifest declarar
`updateUrl`, ele passa a se atualizar dali como se tivesse sido instalado por
URL — e a tela de instalação diz de onde, porque um arquivo que busca código
de um endereço que você não digitou merece ser dito em voz alta.

**Colar uma URL de repositório** (`https://github.com/user/repo`) busca
`plugin.js` do branch padrão via `raw.githubusercontent.com` e guarda o SHA do
commit obtido da API do GitHub.

Sem token, sem autenticação: os repositórios são públicos.

### Identidade entre versões

A identidade de um plugin é **a origem travada no momento da instalação**, não
o `id` e não o hash do código.

O hash do código não pode servir para isso: ele muda a cada atualização — é o
que uma atualização é. Hash fixa uma versão, não uma identidade. Ele é gravado
e exibido por outro motivo, que é deixar você conferir um `.js` arrastado
contra um hash publicado.

A origem, uma vez aceita, não muda mais. Uma versão nova que venha declarando
outro `updateUrl` é recusada: um plugin não redireciona o próprio canal de
atualização por conta própria. Trocar de origem exige instalar de novo, à mão.
É o raciocínio do `known_hosts` do SSH — a confiança é no endereço que você
aceitou uma vez.

### Reconsentimento

Código mudar é esperado. Capacidade mudar não é.

Se uma versão nova declarar hosts além dos aprovados na instalação, a
atualização fica **retida**: o plugin continua na versão que você tem, e a
lista mostra que há uma atualização esperando aval, com os hosts novos ditos
por extenso. Aprovar aplica e passa a valer a lista nova. Hosts que
desaparecem não pedem nada.

Fora esse caso, a checagem roda a cada abertura do site: SHA do commit
diferente, baixa e troca. Falha de rede é silenciosa — fica a versão instalada.

## Onde entra no aplicativo

`web/src/catalog/streams.ts` perde `ADDON_BASE` e `fetchStreams`. No lugar,
`web/src/plugins/resolve.ts` expõe `resolveStreams(target)`, que roda os
plugins ligados em paralelo, normaliza cada resultado com o `parseStreams` que
já existe, marca cada stream com o plugin que a produziu, e concatena. Um
plugin que falha ou estoura o tempo não derruba os outros.

`parseStreams` deixa de exigir `infoHash`. Um stream é aceito com `infoHash`
válido **ou** com `url` `https:`, e `CatalogStream` ganha esse discriminante.
Hoje o que não tem `infoHash` some sem erro nenhum, que é o pior jeito de
falhar: o plugin funcionou, a lista veio vazia, e nada explica por quê.

`openCatalogStream` passa a ramificar. Torrent segue o caminho de hoje. URL
não abre torrent nenhum: entrega a URL para a rota de ingestão descrita
adiante, e a sala nasce dali.

`MetaDetails` chama `resolveStreams` no lugar de `fetchStreams`, e passa a
distinguir três estados vazios, porque são três problemas diferentes:

- nenhum plugin instalado — "Nenhum plugin instalado", com o botão que abre o
  modal de plugins
- plugins instalados, nenhuma fonte — "Nenhum plugin conseguiu reproduzir essa
  mídia", com o mesmo botão
- filtros escondendo tudo — o texto que já existe

O `useEffect` que busca fontes passa a sair cedo quando `mode === 'viewer'`.
Hoje ele busca para todo mundo, mas o espectador nunca vê a lista: ele vê o
botão de pedir para o host. Sem essa saída, o espectador executaria plugins
para produzir uma lista que a interface descarta — e passaria a precisar de
plugin instalado, o que contradiz o desenho inteiro.

## A interface

Um botão **Plugins** em `.header-end`, ao lado de Upload manualmente, na Home
e no cabeçalho do catálogo dentro da sala.

Abre o mesmo `MorphPanel` do upload manual, com duas etapas:

- **lista** — cada plugin com nome, versão, origem, um interruptor de ligado,
  e remover. Um botão de atualizar tudo. Vazia, é o convite para adicionar.
- **adicionar** — uma área que aceita arquivo arrastado ou clique, e um campo
  de URL. Antes de gravar, mostra o que foi lido do manifest: nome, versão,
  hosts que o plugin vai alcançar, e de onde ele se atualiza.

O Plex aparece na mesma tela, como uma seção à parte da lista de plugins — não
é um plugin, e listá-lo junto ensinaria a coisa errada. Sem conta pareada, um
botão de conectar; com conta, o nome do servidor escolhido, um atalho para
navegar a biblioteca, e desconectar.

Strings novas em `web/src/i18n/en.ts` e `pt-BR.ts`. Não há `I18nProvider` neste
repositório: `useT` é um hook por componente que lê `localStorage['ss.language']`
e cai em `pt-BR`. Componentes novos não precisam de provider, e testes novos
não devem embrulhar nada.

## O plugin do Torrentio

Sai do repositório e vira um repositório público à parte, `ss-plugin-torrentio`,
com `plugin.js`, `README.md` e licença. O `plugin.js` é a função do exemplo
acima: monta o id, chama o Torrentio, devolve `streams`. O parsing de emoji,
qualidade e bandeira continua no ss, onde já está testado.

`VITE_STREAM_ADDON` deixa de existir.

## Plex, fora do sistema de plugins

O Plex entra como fonte nativa, não como plugin, e a razão é que ele precisa
exatamente do que um plugin não pode ter: um fluxo de pareamento, um token de
conta guardado entre sessões, e descoberta de servidor. Dar essas capacidades
ao contrato de plugin significaria dá-las a todo plugin.

Não há impedimento de licença. Os termos de serviço da Plex definem uma
categoria chamada *Interfacing Software* que inclui `client applications`, e
desde setembro de 2025 a Plex publica a especificação OpenAPI oficial do
Media Server — o que remove qualquer leitura de engenharia reversa. As
proibições dos termos são sobre descompilar o software da Plex e criar obras
derivadas dele; um cliente HTTP sobre documentação pública não faz nem uma nem
outra. Infuse e Plezy são precedentes consolidados.

**Pareamento.** Nunca pedimos a senha do Plex. `POST /api/v2/pins?strong=true`
em `plex.tv`, com um `X-Plex-Client-Identifier` que geramos uma vez e
guardamos, devolve um código; o usuário aprova em `app.plex.tv/auth`; um poll
em `/api/v2/pins/{id}` devolve o `authToken`. O token vai para o IndexedDB, em
store próprio — é credencial de conta, e o painel tem um botão que a apaga.

**Descoberta.** `GET plex.tv/api/v2/resources?includeHttps=1&includeRelay=1`
devolve, para cada servidor, uma lista de conexões já com URI pronta. Qual
delas serve não dá para saber no papel: dispara `GET /identity` em todas ao
mesmo tempo, com timeout curto, e fica com a primeira que responder,
preferindo LAN sobre WAN sobre relay.

A conexão de LAN funciona do navegador por causa do `plex.direct`: um DNS
dinâmico em que `192-168-1-50.<hash>.plex.direct` resolve para `192.168.1.50`,
com certificado wildcard real. É HTTPS válido apontando para endereço privado,
que é precisamente o que faltaria para qualquer outra fonte local.

**Biblioteca.** `/library/sections` para as seções, `/library/sections/{key}/all`
e `/search?query=` para navegar, `/library/metadata/{ratingKey}` para o item.
O que interessa é `Media[0].Part[0]`, com `key`, `size` e `container`. O
arquivo original é `{uri}{part.key}?download=1&X-Plex-Token=…`.

**Os bytes**, e é aqui que a corrida de conexões volta a importar:

- **ganhou uma conexão pública** (WAN ou relay) — a URL é HTTPS e alcançável de
  fora, então é a ingestão por URL descrita abaixo. O servidor puxa sozinho e a
  aba do host pode fechar.
- **ganhou a LAN** — a VPS não alcança `192.168.x.x`, e não vai passar a
  alcançar: abrir a guarda de SSRF para endereço privado é desfazer a guarda.
  Quem bombeia é o navegador do host, que já está na mesma rede.

O segundo caso não é código novo. `startTorrentTransfer`, em
`web/src/upload.ts`, já é uma bomba tus no navegador — lê pedaços por offset,
faz `PATCH` sequencial, mantém uma leitura adiantada para não serializar rede
com rede, e alimenta o coletor de legendas. A única troca é o leitor de
pedaço: sai o `read(at, end)` do WebTorrent, entra um `fetch` com
`Range: bytes=at-end` contra a URL do Plex.

Duas coisas que vão gerar suporte e por isso precisam de mensagem própria: o
arquivo original só sai se a conta tiver **Allow Downloads** habilitada, senão
o Plex só oferece transcode; e a conexão de LAN falha em roteador com proteção
agressiva contra DNS rebinding, que recusa resposta de DNS apontando para IP
privado.

O Jellyfin foi avaliado junto e ficou de fora: sem equivalente ao
`plex.direct`, um servidor em `http://192.168.1.50:8096` — o arranjo padrão —
é bloqueado por conteúdo misto a partir de um site HTTPS, e não há saída pelo
navegador.

## Servidor

### Ingestão por URL

Uma sala pode nascer de uma URL. O `Ingestor` já bombeia bytes de uma fonte
para o upload tus; o que entra é uma fonte nova — um GET com range sobre a URL
— reusando o `pump` que já existe. O navegador do host nunca carrega esses
bytes: ele entrega a URL e o servidor puxa, do mesmo jeito que faz com uma
sessão do bridge.

O servidor buscar um endereço que um plugin escolheu é SSRF, e é tratado como
tal:

- só `https:`
- cada IP é conferido **depois de resolvido e antes de conectar**, por conexão.
  Isso é `net.Dialer.Control`, não `Transport.DialContext`: o `DialContext`
  recebe `host:porta` antes do DNS, então uma guarda ali ou recusa toda URL
  legítima ou não confere nada. O `Control` roda no ponto certo, e de quebra
  fecha a janela de DNS rebinding entre a conferência e a conexão
- recusado é tudo que não seja unicast global: loopback, privado, link-local,
  multicast, CGNAT (`100.64/10`), `192.0.0.0/24`, benchmarking (`198.18/15`),
  broadcast, e NAT64 (`64:ff9b::/96`), que mapeia IPv4 — inclusive privado
- redirecionamentos são seguidos com a mesma conferência a cada salto, com
  teto de saltos
- teto de tamanho igual ao do upload manual; teto de tempo por cabeçalho de
  resposta e por job, nunca um teto sobre a leitura inteira do corpo — um
  filme de 10 GB é uma leitura longa e legítima
- só `Content-Type` de vídeo, ou nenhum; nada de seguir para HTML

O erro que chega ao host diz qual dessas regras barrou, sem devolver corpo
nenhum da resposta remota.

### Documentação estática

`registerFrontend` passa a servir `/docs` a partir de `WEB_DIR/docs`, e o
`NoRoute` responde 404 para caminhos sob `/docs` em vez de devolver o
`index.html` do aplicativo — um endereço de documentação errado deve dizer que
está errado, não abrir o site.

O código dos plugins nunca chega ao servidor. O que chega é uma URL que o
plugin produziu, e ela passa pelas regras acima.

## Documentação

Repositório separado, a mesma pilha do opencode: Astro com Starlight e o tema
`toolbeam-docs-theme`, `base: '/docs'`, saída estática. O deploy do ss copia o
`dist/` para `WEB_DIR/docs`.

Páginas:

- o que é o ss e como uma sala funciona
- o sistema de plugins: por que existe, o que um plugin pode e não pode
- instalar, ligar, atualizar e remover
- escrever um plugin: o contrato, um exemplo completo, publicar num repositório
- referência: manifest, `target`, `api.fetch`, o formato de stream, limites
- conectar um servidor Plex, e o que fazer quando a biblioteca não aparece —
  Allow Downloads, e proteção contra DNS rebinding no roteador

A página do sistema de plugins diz por extenso o que a caixa não fecha: um
plugin escolhe o que devolver, e um host declarado pode resolver para a rede
local de quem instalou.

Escrita por até dois subagentes Opus 5 low, cada um instruído a ler
`https://github.com/conorbronsdon/avoid-ai-writing/blob/main/SKILL.md` antes de
escrever.

## Testes

- `parseManifest` — aceita o mínimo válido, recusa `id` fora do padrão, `hosts`
  vazio, `hosts` com esquema ou caminho, campos ausentes
- política de `api.fetch` — permite host declarado, recusa host não declarado,
  `http:`, a própria origem **em qualquer porta**, `localhost`, IP literal em
  qualquer grafia, e devolve a URL sem as credenciais que nela viessem
- escopo do worker — verificação manual contra um build, não contra o `dev`:
  em `dev` o worker é servido de `/src/` e não casa a regra da CSP, então o
  `dev` é **mais frouxo** que a produção. A conferência enumera os globais que
  sobraram e falha se aparecer nome fora da allowlist
- `resolveStreams` — junta dois plugins, sobrevive a um que lança, sobrevive a
  um que estoura o tempo, marca a procedência de cada stream
- `parseStreams` — aceita `infoHash`, aceita `url` `https:`, recusa `url`
  `http:`, recusa stream sem os dois
- atualização — SHA igual não baixa, SHA diferente troca, `updateUrl`
  divergente recusa, host novo retém em vez de aplicar, aprovar aplica
- armazenamento — instala, lê, liga e desliga, remove
- política de redirecionamento — host declarado que responde `302` para host
  não declarado é barrado pela URL de chegada
- registro — duas origens diferentes com o mesmo `id` de manifest convivem
  como dois plugins, e não uma sobrescrevendo a outra
- guarda de SSRF, em Go — recusa `http:`, loopback, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16`, `100.64/10`, IPv6 local, NAT64, nome que resolve
  para privado, e redirecionamento de público para privado. O caso do nome que
  resolve para privado precisa passar por um cliente de verdade, não por uma
  chamada direta à função de conferência de endereço — é justamente o caso que
  uma guarda no lugar errado deixa passar
- Plex — o pareamento guarda o token, a corrida de conexões escolhe a primeira
  que responde, uma conexão pública vai para a ingestão por URL e uma de LAN
  vai para a bomba no navegador
- `MetaDetails` — sem plugin mostra o convite, com plugin e sem fonte mostra a
  outra mensagem, `mode === 'viewer'` não resolve nada

O runtime do worker é testado pela sua política e pelo seu contrato de
mensagens. O worker em si não tem teste automatizado: o jsdom não tem `Worker`,
e montar um ambiente que tenha custa mais do que vale aqui. A verificação é
manual, com passos escritos, e o plano diz isso em vez de fingir cobertura.

## Fora de escopo

Plugins de catálogo. Plugins de legenda. Assinatura ou verificação de
procedência do código. Um registro central de plugins. Sincronizar plugins
instalados entre dispositivos. Jellyfin, pelo motivo dito acima. Um agente
rodando na rede do host para alcançar servidores que o navegador não alcança.
