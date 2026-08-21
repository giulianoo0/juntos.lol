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
| `id` | sim | `[a-z0-9-]{1,64}`; rótulo de exibição e chave de deduplicação |
| `name` | sim | até 64 caracteres, exibido na lista |
| `version` | sim | texto livre, exibido na lista |
| `hosts` | sim | nomes de host, sem esquema nem caminho; lista não vazia |
| `updateUrl` | não | repositório git de onde o plugin se atualiza, lido só na instalação |

O `id` não decide nada. Quem identifica um plugin entre versões é a origem
travada na instalação, descrita adiante.

Plugins resolvem fontes e nada mais. O catálogo continua sendo o Cinemeta
embutido; não há ponto de extensão para catálogo, e acrescentar um depois não
quebra este contrato.

## Execução

O plugin roda num Web Worker criado a partir de um blob. Antes do código do
plugin ser carregado, o bootstrap do worker apaga do escopo global tudo que
alcança a rede ou o armazenamento:

`fetch`, `XMLHttpRequest`, `importScripts`, `WebSocket`, `EventSource`,
`caches`, `indexedDB`, `navigator.sendBeacon`.

O que sobra é cálculo puro. A única saída é `api.fetch`, que empacota o pedido
num `postMessage` para a página, e é a página que decide se ele acontece:

- só `https:`
- só hosts declarados no manifest, comparados por igualdade exata do hostname
- nunca a própria origem, nem `localhost`, nem endereço IP literal

A resposta volta para o worker como `{ ok, status, text }`, e o plugin recebe
um objeto com `ok`, `status`, `text()` e `json()` — parecido o bastante com
`Response` para não surpreender, pequeno o bastante para não vazar capacidade.

Cada resolução tem um teto de 15 segundos e um teto de 32 requisições. Estourar
qualquer um dos dois mata o worker e o plugin conta como falho naquela
resolução. Um worker é criado por resolução e destruído no fim; plugins não
guardam estado entre chamadas.

Isto fecha o que dá para fechar de forma honesta. Um plugin ainda escolhe o que
devolver, e um magnet que ele devolva é um magnet que a sala vai abrir. A
confiança acaba em quem escreveu o plugin, e a documentação diz isso.

## Instalação e atualização

Instalados ficam no IndexedDB, por navegador. Cada registro guarda o código
fonte, o manifest lido dele, a origem travada, o SHA-256 do código, o SHA do
commit quando veio de um repositório, os hosts aprovados, e se está ligado.

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

Strings novas em `web/src/i18n/en.ts` e `pt-BR.ts`.

## O plugin do Torrentio

Sai do repositório e vira um repositório público à parte, `ss-plugin-torrentio`,
com `plugin.js`, `README.md` e licença. O `plugin.js` é a função do exemplo
acima: monta o id, chama o Torrentio, devolve `streams`. O parsing de emoji,
qualidade e bandeira continua no ss, onde já está testado.

`VITE_STREAM_ADDON` deixa de existir.

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
- o host é resolvido e cada IP conferido antes de conectar; loopback, privado,
  link-local, multicast e qualquer coisa fora do espaço público são recusados
- redirecionamentos são seguidos com a mesma conferência a cada salto, com
  teto de saltos
- teto de tamanho igual ao do upload manual, e teto de tempo
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

Escrita por até dois subagentes Opus 5 low, cada um instruído a ler
`https://github.com/conorbronsdon/avoid-ai-writing/blob/main/SKILL.md` antes de
escrever.

## Testes

- `parseManifest` — aceita o mínimo válido, recusa `id` fora do padrão, `hosts`
  vazio, `hosts` com esquema ou caminho, campos ausentes
- política de `api.fetch` — permite host declarado, recusa host não declarado,
  `http:`, a própria origem, `localhost`, IP literal
- `resolveStreams` — junta dois plugins, sobrevive a um que lança, sobrevive a
  um que estoura o tempo, marca a procedência de cada stream
- `parseStreams` — aceita `infoHash`, aceita `url` `https:`, recusa `url`
  `http:`, recusa stream sem os dois
- atualização — SHA igual não baixa, SHA diferente troca, `updateUrl`
  divergente recusa, host novo retém em vez de aplicar, aprovar aplica
- armazenamento — instala, lê, liga e desliga, remove
- guarda de SSRF, em Go — recusa `http:`, loopback, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16`, IPv6 local, nome que resolve para privado, e
  redirecionamento de público para privado
- `MetaDetails` — sem plugin mostra o convite, com plugin e sem fonte mostra a
  outra mensagem, `mode === 'viewer'` não resolve nada

O runtime do worker é testado pela sua política e pelo seu contrato de
mensagens; o worker em si roda num teste de integração com um plugin de exemplo.

## Fora de escopo

Plugins de catálogo. Plugins de legenda. Assinatura ou verificação de
procedência do código. Um registro central de plugins. Sincronizar plugins
instalados entre dispositivos.
