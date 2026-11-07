# Extensões — rascunho para as docs

Rascunho completo do sistema de extensões do juntos, para virar a documentação
pública depois. Os nomes de rota, campo, mensagem e limite foram conferidos no
código. As regras de publicação e instalação da seção 9 são as do produto e
já valem no código.

Onde está cada parte:

| Parte | Código |
| --- | --- |
| Host de extensões (Worker `juntos-ext`), CSP, SDK, proxy de mídia | `extensions/host/src/` |
| Registro global de ids (Go + Postgres) | `internal/extension/`, `internal/httpapi/extensions.go` |
| Painel, iframe, protocolo, retomada | `web/src/extensions/` |
| Preparo de HLS e de arquivo | `web/src/pipeline/hlsInput.ts`, `web/src/pipeline/probeSize.ts`, `web/src/upload.ts` |

Os exemplos usam uma extensão fictícia, **Exemplo** (id `exemplo`): um
catálogo com login, que fala com `api.example.com`, mostra capas de
`cdn.example.com` e entrega vídeo de `media.example.com`.

---

## 1. O que é uma extensão

O juntos não tem catálogo embutido. Quem traz o que assistir são as extensões.

Uma extensão é um app web pequeno — HTML, JavaScript e CSS próprios — que
desenha a interface que quiser: login no serviço dela, cadastro, home, busca,
página de um título, episódios. Quando a pessoa escolhe um vídeo, a extensão
entrega ao juntos uma fonte para tocar: uma playlist **HLS** ou um **arquivo**
por HTTPS. Daí em diante o caminho é o de qualquer url: o navegador do host
prepara o vídeo e publica no bucket, e a sala inteira assiste.

Toda extensão é **código aberto**: vem de um repositório público do GitHub,
com licença, registrado no juntos por um id.

Consequências práticas:

- **Só quem abre o vídeo usa a extensão.** O painel Extensões só abre para
  quem pode abrir mídia na sala. Quem entra pelo link não carrega extensão
  nenhuma, não precisa de conta no serviço dela e não executa o código dela;
  recebe o vídeo já preparado.
- **Cada pessoa usa a própria conta.** O login feito numa extensão fica no
  navegador, na origem daquela extensão. Não vai ao servidor do juntos nem a
  outra pessoa da sala.
- **Nada vem instalado.** O painel começa vazio; a pessoa instala cada
  extensão digitando o id dela e aprovando os hosts que ela vai alcançar.
- **Extensão não é plugin de fonte.** Não existe mais `streams(target, api)`,
  catálogo de metadados embutido, IMDb id, Web Worker sem rede nem o hop
  `/api/plugins/fetch`. Tudo isso saiu.

---

## 2. Como funciona de ponta a ponta

```
juntos.lol (confiável)
  └─ <iframe src="https://<sub>.santamagia.com/@<sha>/<entry>"
             sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
             referrerpolicy="no-referrer" allow="">
        extensão + /_juntos/sdk.js
        ↕ postMessage, protocolo v1, validado dos dois lados

*.santamagia.com → Cloudflare Worker "juntos-ext"
  - <sub> → GET {JUNTOS_ORIGIN}/api/extensions/host/<sub> → {id, source}
  - <sha> atual → GET {JUNTOS_ORIGIN}/api/extensions/<id>/latest
  - serve os arquivos do commit atual (raw.githubusercontent.com),
    com CSP montada do juntos.json
  - serve /_juntos/sdk.js e /_juntos/media (proxy de mídia)
```

Passo a passo de um episódio tocando:

1. O host abre **Extensões** no menu de fontes da sala e escolhe uma das que
   instalou.
2. O site pergunta o commit atual (`GET /api/extensions/:id/latest`), lê o
   `juntos.json` desse commit e compara com o que este aparelho aprovou. Se os
   hosts mudaram, pede aprovação de novo.
3. O iframe abre `https://<sub>.santamagia.com/@<sha>/<entry>`. O Worker
   resolve o `sub` no registro, lê o arquivo do repositório naquele commit e
   responde com a CSP da extensão.
4. A extensão carrega o SDK, registra os callbacks e chama `juntos.ready()`. O
   juntos responde com `init` (tema, idioma, `canPlay`).
5. A pessoa navega na extensão; a extensão fala com a API do serviço dela
   (hosts de `hosts.connect`).
6. Ao escolher um episódio, a extensão pede o stream ao serviço e chama
   `juntos.play({...})` na mesma hora.
7. O juntos valida a mensagem, fecha o painel e abre a fonte **imediatamente**
   (uma URL assinada pode valer segundos): lê a playlist e mede cada segmento,
   ou mede o arquivo. Se o CDN não manda CORS, refaz pelo proxy de mídia.
8. A sala troca de fonte e o pipeline do navegador do host remuxa e publica,
   como com qualquer url. Convidados tocam do bucket.
9. Se o host recarregar a página no meio do preparo, o juntos carrega a
   extensão num iframe oculto, manda `refresh` com o `ref` que ela tinha dado
   e espera até 20 s por uma URL nova (`refreshed`). Sem resposta, o preparo
   não retoma.

---

## 3. Modelo de isolamento

### Uma origem por extensão

Cada extensão é servida em `https://<sub>.santamagia.com`. O `sub` é derivado
do id:

```
sub = base32_minúsculo(sha256("juntos-ext:" + id))[0:16]   // alfabeto a-z2-7, sem "="
sub("exemplo") = "lczfxd2q74zxknb5"
```

A mesma fórmula está no Go (`internal/extension/sub.go`) e no Worker
(`extensions/host/src/sub.ts`). O sub é estável: a mesma extensão mora sempre
no mesmo lugar, e o que ela guarda no navegador continua lá entre versões.

O **id é globalmente único**. O registro (tabela `extensions` no Postgres)
guarda `id → github:<dono>/<repo>`, e o primeiro a registrar leva. O id casa
`^[a-z][a-z0-9-]{2,31}$`; `host` é reservado (é um segmento de
`/api/extensions/host/:sub`). Duas extensões nunca dividem uma origem, então o
navegador as trata como sites diferentes, uma da outra e do juntos.

`santamagia.com` é um domínio separado de `juntos.lol` de propósito: são sites
diferentes, então os cookies `SameSite=Lax` do juntos não acompanham pedidos
feitos de dentro de uma extensão.

### O iframe

```html
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerpolicy="no-referrer" allow="">
```

- `allow-scripts allow-same-origin`: a extensão roda script e tem armazenamento
  na **própria** origem (o subdomínio dela, nunca a do juntos).
- `allow-forms`, `allow-popups`: formulários e janelas (captchas usam).
  Popups herdam o sandbox (não há `allow-popups-to-escape-sandbox`).
- Sem `allow-top-navigation`: a extensão não navega a página do juntos.
- Sem `allow-modals`: `alert`, `confirm` e `prompt` não funcionam.
- `allow=""`: nenhuma permissão delegada (câmera, microfone, tela, área de
  transferência, geolocalização…).
- `referrerpolicy="no-referrer"`: o subdomínio não fica sabendo de qual sala
  veio.

### Cabeçalhos do host de extensões

Toda resposta de arquivo leva:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' [https://js.hcaptcha.com https://*.hcaptcha.com];
  style-src 'self' [https://hcaptcha.com https://*.hcaptcha.com];
  connect-src 'self' https://<cada host de hosts.connect>;
  img-src 'self' data: https://<cada host de hosts.images>;
  frame-src 'none' | https://hcaptcha.com https://*.hcaptcha.com;
  frame-ancestors <origens do juntos>;
  base-uri 'none';
  form-action 'none';
  object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
```

Os trechos entre colchetes e o `frame-src` do hCaptcha só entram com
`"captcha": "hcaptcha"` no manifesto. Nenhuma resposta grava cookie.

O que isso significa para quem escreve:

- Script só de arquivo da própria extensão: nada de `<script>` inline, nada de
  `eval`/`new Function`, nada de CDN de terceiros (exceto o hCaptcha
  declarado).
- Estilo só de arquivo `.css` da própria extensão: `<style>` inline e o
  atributo `style="…"` no HTML são bloqueados. Mexer em `element.style` por
  JavaScript funciona.
- Fontes, mídia e workers caem em `default-src 'self'`: só da própria origem.
- Rede (`fetch`, `XMLHttpRequest`, `WebSocket`) só para a própria origem e os
  hosts de `hosts.connect`, sempre `https:`.
- Imagem só da própria origem, `data:` e os hosts de `hosts.images`.
- `form-action 'none'`: formulário não pode ser enviado por navegação; trate o
  `submit` em JavaScript e chame a API com `fetch`.
- `frame-ancestors`: a extensão só abre embutida pelo juntos. Aberta direto
  numa aba, ela carrega (é a origem dela), mas sem o juntos do outro lado o
  SDK não recebe `init`.

### Caminhos servidos

- Só arquivos destes tipos: `html`, `js`, `mjs`, `css`, `json`, `svg`, `png`,
  `jpg`, `jpeg`, `webp`, `woff2`, `ico`. Qualquer outro (`.map`, `.txt`,
  `.wasm`, `.ttf`, `.woff`, `.gif`, `.mp4`…) é 404.
- Cada segmento do caminho casa `^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,127}$`: sem
  espaço, sem começar com ponto, sem `..`. `%2e%2e`, barra invertida e `%00`
  dão 404.
- `sub` que o registro não conhece dá 404.
- Um commit que não é o HEAD atual dá 404: o host só serve a versão de agora.

### Armazenamento

O token do serviço fica no `localStorage` da origem da extensão. Nem o
juntos.lol nem outra extensão o leem. Os navegadores atuais também separam o
armazenamento de um iframe pelo site de cima: o que a extensão guarda dentro
do juntos não aparece se o subdomínio for aberto direto numa aba.

O que o **juntos** guarda sobre extensões fica no `localStorage` de juntos.lol,
na chave `ss.extensions`: por extensão instalada, `{id, sub, version,
manifest}` aprovado neste aparelho.

### O protocolo como fronteira

Juntos e extensão só trocam `postMessage` (seção 6). Dos dois lados:

- **No juntos**: a mensagem só conta se `event.source` é a janela daquele
  iframe **e** `event.origin` é a origem daquela extensão. Depois cada campo é
  conferido (tipo, tamanho, URL `https:` sem porta nem credenciais, host
  permitido pelo manifesto), só objetos simples passam (nada de array ou
  protótipo emprestado), e a mensagem é **remontada** só com os campos
  conhecidos. Uma mensagem com qualquer campo inválido é descartada inteira, em
  silêncio. Nada vira HTML.
- **No SDK**: só ouve mensagens com `source === window.parent` e origem na
  lista do juntos (`JUNTOS_ORIGINS` do Worker). Depois do primeiro contato,
  fixa aquela origem e ignora as outras. Os valores de tema só são aplicados
  se o nome casar `^--[A-Za-z0-9_-]{1,64}$` e o valor não tiver `;{}<>`.

### O que isso protege

- Um XSS no juntos.lol não lê o token de uma extensão.
- Uma extensão não lê o armazenamento de outra.
- Uma extensão não alcança o DOM do juntos, a sessão, a sala nem o `/api` com
  as credenciais de quem a abriu.
- Uma extensão não navega o topo, não abre modal, não pede câmera nem
  microfone.
- Uma mensagem forjada (outra aba, outro iframe, popup, a própria extensão com
  payload hostil) é ignorada; nenhum texto vira HTML; nenhuma URL fora de
  `hosts.media` vira fonte de vídeo.
- A extensão não fala com host que não declarou: a CSP do navegador barra.
- Email e senha do serviço nunca passam pelo servidor do juntos.

### O que isso não protege

- **A extensão vê o que você digita nela.** A senha do serviço passa pelo
  código da extensão, porque é ela que faz o login. O isolamento impede que
  *outros* leiam, não que a própria extensão faça mau uso.
- **A extensão escolhe o que tocar.** Dentro dos hosts de mídia declarados, a
  fonte que ela entregar é a que a sala abre.
- **Código novo entra sem perguntar.** A extensão roda sempre o HEAD do branch
  padrão do repositório. Se os hosts (e o `captcha`) não mudaram, a
  atualização vale na próxima abertura, sem aviso; só uma mudança de hosts
  pede aprovação de novo.
- **Hosts são nomes, não endereços.** Um host declarado pode resolver para a
  rede local de quem abre, e a extensão pode fazer o navegador bater ali. O
  CORS impede ler a resposta, não o pedido.
- **Os hosts declarados veem você**: o seu IP, como em qualquer site.
- **O proxy de mídia não exige origem.** Ele responde a qualquer um, mas só
  para hosts que alguma extensão registrada declarou em `hosts.media` (seção
  7).

A confiança termina em quem escreveu a extensão. Por isso publicar um id é
fechado e o código tem de ser aberto (seção 9): qualquer um pode ler o que
roda, no commit exato que roda.

---

## 4. O manifesto `juntos.json`

Fica na **raiz** do repositório. É lido no registro, pelo Worker a cada
versão e pelo site antes de abrir.

```json
{
  "id": "exemplo",
  "name": "Exemplo",
  "version": "0.1.0",
  "protocol": 1,
  "entry": "dist/index.html",
  "icon": "icon.svg",
  "hosts": {
    "connect": ["api.example.com"],
    "images": ["cdn.example.com"],
    "media": ["media.example.com"]
  }
}
```

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `id` | sim | `^[a-z][a-z0-9-]{2,31}$`, não pode ser `host`. Único no mundo; decide o subdomínio. |
| `name` | sim | 1 a 64 caracteres, sem os espaços das pontas. |
| `version` | sim | texto livre, 1 a 64 caracteres. Só informativo: quem decide a versão servida é o commit. |
| `protocol` | sim | `1`. |
| `entry` | sim | caminho relativo do HTML de entrada, terminado em `.html` (minúsculo), ex.: `index.html` ou `dist/index.html`. Cada parte do caminho começa por letra, número, `_` ou `-` e só tem letras, números e `._@+-`; nada de `/` inicial, `..`, parte vazia ou pasta oculta. |
| `icon` | não | caminho relativo, nas mesmas regras, de um `.png` ou `.svg`. `""` e `null` contam como ausente. |
| `hosts.connect` | não | hosts que a extensão chama por rede (`connect-src`). |
| `hosts.images` | não | hosts de onde mostra imagem (`img-src`) e de onde pode vir o `poster` do `play`. |
| `hosts.media` | não | hosts de onde pode vir a `source.url` do `play`, e os únicos que o proxy de mídia busca. Aceita `*.dominio`. |
| `captcha` | não | `"hcaptcha"` libera o hCaptcha na CSP (e os hosts dele vão em `connect`/`images`). Nenhum outro valor existe; `""` e `null` contam como ausente. |

`hosts` e cada uma das listas podem faltar ou ser `null`: contam como `[]`.
As chaves são lidas exatamente como escritas: `ID` ou `Hosts` no lugar de
`id` ou `hosts` recusam o manifesto. Chaves desconhecidas são ignoradas.

O servidor, o host de extensões e o site aplicam a mesma regra, caso a caso,
pela tabela `extensions/manifest-cases.json` que os três testes leem.

Regras de host:

- Nome puro, minúsculo: sem esquema, porta, caminho ou barra
  (`api.example.com`, não `https://api.example.com/`).
- Pelo menos dois rótulos; nada de IP, `localhost` ou `*.localhost`.
- Nada de `juntos.lol` nem `santamagia.com`, nem subdomínio deles: o juntos e
  o lugar das extensões nunca são host de uma extensão.
- Até 16 por lista.
- Curinga só em `media`, e só na forma `*.dominio.tld`. `*.example.com` casa
  `sa-east-1.example.com`, não casa `example.com` nem `example.com.evil.net`.
- Tudo é `https:`; não há como declarar `http:`.

Mudar qualquer lista de `hosts` (ou o `captcha`) faz cada aparelho pedir
aprovação de novo antes de abrir a versão nova.

---

## 5. O SDK `/_juntos/sdk.js`

O host de extensões serve o SDK na raiz de todo subdomínio. Carregue-o com
caminho **absoluto**, como script clássico (não módulo), antes do seu código:

```html
<script src="/_juntos/sdk.js"></script>
<script type="module" src="./main.js"></script>
```

Ele define `window.juntos` (congelado; não é redefinido se já existir):

| Método | O que faz |
| --- | --- |
| `juntos.onInit(cb)` | `cb({ juntos: 1, type: 'init', theme, locale, canPlay })` quando o juntos responde ao `ready`. Se o `init` já chegou, chama na hora. |
| `juntos.onTheme(cb)` | `cb(theme)` quando o tema do juntos muda (claro/escuro). |
| `juntos.onRefresh(cb)` | `cb(ref) → Promise<{kind, url} \| null>`: devolve uma fonte nova para um `ref` dado antes. Só um callback (o último vale). |
| `juntos.ready()` | Avisa que a extensão está pronta. O juntos só manda `init` (e `refresh`) depois disso. |
| `juntos.play(p)` | Pede para tocar: `{ title, subtitle?, poster?, ref, source: { kind: 'hls' \| 'file', url } }`. |
| `juntos.close()` | Fecha o painel. |
| `juntos.toast(text)` | Mostra um aviso curto no juntos. |

O SDK também aplica o tema sozinho: cada `theme.vars` vira uma custom property
no `:root` e `theme.mode` vira `data-theme="dark|light"` no `<html>`. Use as
variáveis no seu CSS para a extensão parecer parte do juntos.

Variáveis que o juntos manda (valores já resolvidos, até 64 caracteres):

```
--text --text-muted --text-faint
--primary --primary-hover --on-primary --focus --danger
--frame-ground --frame-side --surface --surface-2 --surface-3 --overlay --field
--line --line-strong --hover --hover-strong
--radius-md --radius-lg --radius-xl --radius-2xl --radius-full
--ease-out --ease-in-out --duration-fast --duration-base
```

Ordem importa: registre `onInit`, `onTheme` e **`onRefresh`** antes de chamar
`ready()`. Na retomada, o `refresh` chega logo depois do `ready`; sem callback
registrado, o SDK responde `source: null` e o preparo não retoma.

Tipos para TypeScript:

```ts
interface ThemeTokens { mode: 'dark' | 'light'; vars: Record<string, string> }
type ExtSource = { kind: 'hls' | 'file'; url: string }
interface InitMessage { theme: ThemeTokens; locale: string; canPlay: boolean }
interface PlayRequest { title: string; subtitle?: string; poster?: string; ref: string; source: ExtSource }
interface Juntos {
  onInit(cb: (init: InitMessage) => void): void
  onTheme(cb: (theme: ThemeTokens) => void): void
  onRefresh(cb: (ref: string) => Promise<ExtSource | null>): void
  ready(): void
  play(p: PlayRequest): void
  close(): void
  toast(text: string): void
}
declare global { interface Window { juntos?: Juntos } }
```

---

## 6. Protocolo v1

Toda mensagem tem `juntos: 1`. O SDK põe isso sozinho; quem fala o protocolo
direto precisa pôr.

### juntos → extensão

```ts
{ juntos: 1, type: 'init', theme: ThemeTokens, locale: string, canPlay: boolean }
{ juntos: 1, type: 'theme', theme: ThemeTokens }
{ juntos: 1, type: 'refresh', nonce: string, ref: string }
```

- `init` responde a cada `ready`.
- `locale` é o idioma da interface (`pt-BR`, `en`).
- `canPlay` diz se quem abriu pode trocar a mídia da sala. Com `false`, um
  `play` é ignorado. (Hoje o painel só abre para quem pode, então na prática
  vem `true`.)
- `refresh` só é mandado ao iframe oculto da retomada.

### extensão → juntos

```ts
{ juntos: 1, type: 'ready' }
{ juntos: 1, type: 'play', title: string, subtitle?: string, poster?: string, ref: string, source: ExtSource }
{ juntos: 1, type: 'refreshed', nonce: string, source: ExtSource | null }
{ juntos: 1, type: 'close' }
{ juntos: 1, type: 'toast', text: string }
```

Validação no juntos (qualquer falha descarta a mensagem inteira):

| Campo | Regra |
| --- | --- |
| `title`, `subtitle`, `text` | string até 300 caracteres. |
| `ref`, `nonce` | string até 128 caracteres. |
| `source.kind` | `hls` ou `file`. |
| `source.url` | até 2048 caracteres; `https:`, sem porta, sem usuário/senha; host em `hosts.media`. |
| `poster` | mesma regra de URL, host em `hosts.images`. |
| mensagem e `source` | objeto simples (nada de array, classe ou protótipo estranho). Campos extras são ignorados. |

`ref` é opaco para o juntos: é o que a extensão usa para achar o vídeo de novo
(por exemplo, o id do episódio no serviço). Ele é guardado como fonte
retomável da sala e volta no `refresh`.

`refreshed` só vale se o `nonce` for o do `refresh` pedido.

---

## 7. Fontes de vídeo e proxy de mídia

### HLS (`kind: 'hls'`)

- A URL pode ser uma playlist master ou de mídia. Na master, o juntos escolhe
  a variante de maior `BANDWIDTH`.
- Segmentos TS ou fMP4 (`EXT-X-MAP` vira o começo).
- `EXT-X-KEY` (ou `EXT-X-SESSION-KEY`) com `METHOD` diferente de `NONE` é
  recusado: "Esse vídeo vem cifrado e não dá para preparar".
- Na master, uma variante cujo áudio vem numa playlist à parte
  (`EXT-X-MEDIA:TYPE=AUDIO` com `URI`) é pulada; se só houver dessas, o
  vídeo é recusado. Também são recusados: um segundo `EXT-X-MAP` e playlist
  sem `EXT-X-ENDLIST` (ao vivo).
- O tamanho de cada segmento é medido por `HEAD` (16 ao mesmo tempo); se o
  `HEAD` falhar, por `Range: bytes=0-0`, lendo `Content-Range` ou, se o CDN
  ignorar o `Range` e mandar tudo, o `Content-Length` (o corpo é cancelado).
- O HLS vira um arquivo virtual único e entra no remux do navegador do host:
  vídeo copiado (H.264, HEVC, VP9, AV1), áudio transcodificado para AAC. Cada
  segmento que é um arquivo próprio é baixado inteiro uma vez e guardado (os
  4 mais recentes), então CDN que ignora `Range` funciona; pedaços de
  `EXT-X-BYTERANGE` de um arquivo grande são lidos por `Range`.
- Nenhum pedido segue redirecionamento: só os hosts da playlist foram
  conferidos. Um redirecionamento, como a falta de CORS, faz a abertura
  inteira ir pelo proxy de mídia, que confere cada salto.
- A assinatura dos segmentos precisa durar o preparo (alguns minutos); não há
  renovação de URL no meio dele.
- A playlist é aberta no instante do `play`, antes da sala trocar de fonte.
  Mesmo assim, entregue uma URL recém-assinada: peça o stream ao serviço e
  chame `play` na mesma hora.

### Arquivo (`kind: 'file'`)

O tamanho vem de `Content-Length` do `HEAD`, ou de `Content-Range` de um
`Range: bytes=0-0`. O servidor precisa aceitar `Range`. A URL é lida como
veio (sem parâmetro a mais) e nenhum pedido segue redirecionamento; com
redirecionamento ou sem CORS, tudo vai pelo proxy de mídia.

### Proxy de mídia

Se a primeira leitura (a playlist, ou a medição do arquivo) falha por CORS, o
navegador do host refaz tudo por:

```
https://<sub>.santamagia.com/_juntos/media?u=<url codificada>
```

Regras do proxy:

- Só `GET` e `HEAD` (outros: 405).
- Só `https:`, sem porta nem credenciais, e o host tem de estar em
  `hosts.media` da extensão daquele `sub` (senão 403).
- Redirects seguidos até 3, cada destino conferido de novo contra
  `hosts.media`.
- Repassa `Range` e devolve `206` com `content-range`, `content-length`,
  `accept-ranges`, `content-type`, `etag`, `last-modified`, `cache-control`.
- Numa `.m3u8` (pelo caminho ou `content-type` com `mpegurl`), reescreve as
  linhas de URI e os `URI="…"` de `EXT-X-KEY`/`EXT-X-MAP` para passarem pelo
  próprio proxy, com URL absoluta. Playlist sai com `cache-control: no-store`.
- `Access-Control-Allow-Origin` só para as origens do juntos que pediram.
- Toda resposta leva `Content-Security-Policy: sandbox; default-src 'none'` e
  `nosniff`.
- Só atende pedido com `Origin` de uma das origens do juntos; sem `Origin`
  (navegação, `<video>` de outro site, `curl`) ou de outra origem, inclusive
  de uma extensão, responde `403` sem buscar nada.
- Playlist acima de 4 MB é recusada com `502`.
- Segue redirecionamento só para hosts de `hosts.media`, conferindo cada
  salto (até 5).

Segmentos lidos pelo proxy passam pela Cloudflare: o CDN vê o IP do Worker,
não o do host.

---

## 8. Escrever uma extensão

### O mínimo

```
exemplo/
  juntos.json
  index.html
  app.js
  app.css
  LICENSE
```

`juntos.json`:

```json
{
  "id": "exemplo",
  "name": "Exemplo",
  "version": "0.1.0",
  "protocol": 1,
  "entry": "index.html",
  "hosts": {
    "connect": ["api.example.com"],
    "images": ["cdn.example.com"],
    "media": ["media.example.com"]
  }
}
```

`index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Exemplo</title>
    <link rel="stylesheet" href="./app.css" />
    <script src="/_juntos/sdk.js"></script>
    <script type="module" src="./app.js"></script>
  </head>
  <body>
    <main id="app"></main>
  </body>
</html>
```

`app.css`:

```css
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--surface); color: var(--text); }
button { background: var(--primary); color: var(--on-primary); border: 0; border-radius: var(--radius-full); padding: 8px 14px; }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
```

`app.js`:

```js
const app = document.getElementById('app')

async function streamFor(id) {
  const res = await fetch(`https://api.example.com/videos/${encodeURIComponent(id)}/stream`)
  if (!res.ok) throw new Error(`stream ${res.status}`)
  const body = await res.json()
  return { kind: 'hls', url: body.hls }
}

function render(videos, canPlay) {
  app.replaceChildren()
  for (const video of videos) {
    const button = document.createElement('button')
    button.textContent = video.title // texto, nunca innerHTML
    button.disabled = !canPlay
    button.addEventListener('click', async () => {
      try {
        const source = await streamFor(video.id) // peça e toque na mesma hora
        juntos.play({ title: video.title, ref: String(video.id), source })
      } catch {
        juntos.toast('Não deu para abrir o vídeo')
      }
    })
    app.append(button)
  }
}

juntos.onInit(async ({ canPlay }) => {
  const res = await fetch('https://api.example.com/videos')
  render(await res.json(), canPlay)
})
juntos.onRefresh((ref) => streamFor(ref).catch(() => null))
juntos.ready()
```

### Uma extensão de catálogo com login

O caso típico: o serviço tem conta, e o catálogo só aparece logado.

- **Telas.** Entrar e criar conta, home com fileiras, busca, página do título
  (capa, sinopse, temporadas, episódios paginados com "carregar mais"),
  escolha de qualidade, sair.
- **Login.** O formulário trata o `submit` em JavaScript e chama a API do
  serviço direto do navegador (`fetch` para um host de `hosts.connect`). Email
  e senha nunca passam pelo juntos.
- **Sessão.** Token de acesso e refresh token no `localStorage` da origem da
  extensão. Renove pouco antes de vencer; num 401, tente renovar uma vez e
  repita o pedido; se a renovação falhar, limpe a sessão e volte ao login.
- **Captcha.** Se o serviço exige hCaptcha, declare `"captcha": "hcaptcha"` e
  ponha os hosts do hCaptcha que a API usa em `connect` e `images`. O widget
  abre num iframe e em janelas, que o sandbox permite.
- **Tocar.** Ao escolher o episódio, peça o stream e chame `juntos.play` no
  mesmo tick da resposta, com `title` (o título), `subtitle` (o episódio),
  `ref` (o id do episódio) e a melhor qualidade disponível.
- **Retomar.** `onRefresh(ref)` pede o stream do episódio `ref` de novo e
  devolve a fonte.
- **Fechar.** Escape chama `juntos.close()` quando não há popover aberto.
- **Visual.** Os tokens do juntos com um acento próprio da extensão; claro e
  escuro; de 360 px para cima; foco visível.

### Regras de ouro

- Dado da API vira **texto**: `textContent`, `setAttribute`. Nada de
  `innerHTML` com o que veio de fora.
- URL de imagem só `https:` e de `hosts.images`; confira antes de pôr no
  `src` e use um placeholder se não bater.
- Registre os callbacks antes de `ready()`.
- Peça o stream e chame `play` no mesmo fluxo, sem esperar outra interação:
  assinaturas curtas vencem.
- Dê um `ref` que permita pedir o mesmo vídeo de novo, e implemente
  `onRefresh` — sem ele, recarregar a página do host perde o preparo.
- Nada de estilo ou script inline (a CSP bloqueia); `<form>` com `submit`
  tratado em JS.

### Com bundler

Funciona com Vite ou outro bundler, desde que:

- os caminhos do build sejam **relativos** (no Vite, `base: './'`), porque a
  extensão é servida em `/@<sha>/`;
- o `juntos.json` fique na raiz do repositório, com `entry` apontando para a
  pasta do build (ex.: `"entry": "dist/index.html"`);
- **o build esteja commitado**: o host lê os arquivos de
  `raw.githubusercontent.com/<dono>/<repo>/<sha>/`, não roda build nenhum;
- o build não gere `eval`/`new Function` nem arquivos de tipo fora da lista
  (desligue sourcemaps `.map`, use `woff2`);
- o `/_juntos/sdk.js` fique fora do bundle (é do host, não seu).

### Testar local

**Só a interface.** Rode a página fora do juntos com um SDK de mentira:

1. No servidor de desenvolvimento, sirva `/_juntos/sdk.js` vazio. No Vite, um
   plugin com `configureServer` que responde `''` nesse caminho.
2. No seu código, só em `import.meta.env.DEV` e quando `window.juntos` não
   existe, instale um objeto com a mesma API: `ready()` chama o callback de
   `onInit` com `{ theme: { mode, vars: {} }, locale: 'pt-BR', canPlay: true }`;
   `play(p)` faz `console.info` e mostra um aviso; `toast` mostra o texto.
3. Uma página de harness com um `<iframe>` em tamanhos de painel (1100×760,
   760×640, 360×720) ajuda a ver o layout como no juntos.

**De ponta a ponta.** Suba o juntos e o host de extensões na sua máquina. O
Chrome resolve `*.localhost` para 127.0.0.1, e cada subdomínio continua sendo
uma origem própria:

```bash
# Redis, Postgres e bucket como no README (Desenvolvimento local)
(cd web && npm ci && npm run build)

# juntos em :8090, apontando as extensões para o Worker local
PORT=8090 EXTENSION_BASE=localhost:8787 EXTENSION_SCHEME=http go run ./cmd/server

# noutro terminal: host de extensões em :8787 (wrangler dev)
cd extensions/host && npm ci && npm run dev
```

As variáveis de desenvolvimento do Worker já vêm no `wrangler.toml`:
`JUNTOS_ORIGIN=http://127.0.0.1:8090`, `JUNTOS_ORIGINS` com
`http://localhost:5173`, `http://127.0.0.1:5173`, `http://127.0.0.1:8090` e
`http://localhost:8090`, `EXT_BASE=localhost:8787`, `EXT_SCHEME=http`.

O host lê o código do GitHub, então a extensão precisa estar num repositório
público com o build commitado no branch padrão. Registre o id **no servidor
local** — com uma conta de `EXTENSION_PUBLISHERS` local, ou direto no Postgres
local — para não tomar o id em produção só para testar:

```sql
INSERT INTO extensions (id, source, sub, name)
VALUES ('exemplo', 'github:voce/juntos-exemplo', 'lczfxd2q74zxknb5', 'Exemplo');
```

(Confira as colunas na migração em `internal/db/migrations/`; o `sub` sai da
fórmula da seção 3.) Para nem depender do GitHub, o e2e
`web/dev/e2e-extensions.mjs` faz o papel dele num servidor local, servindo a
pasta da extensão como um repositório num sha fixo; o servidor Go roda com
`GITHUB_API_BASE` e `GITHUB_RAW_BASE` apontando para lá e o Worker com
`GITHUB_RAW`. Depois abra `http://127.0.0.1:8090`, crie uma sala,
**Extensões**, instale `exemplo` e abra. Ela carrega em
`http://lczfxd2q74zxknb5.localhost:8787/@<sha>/<entry>`.

Cada push muda o HEAD; o host vê o commit novo em até 60 s (cache do
`latest`) e o manifesto novo em até 5 min.

---

## 9. Publicar e instalar

### Fonte única: GitHub

Toda extensão vem de `github:<dono>/<repo>`. O Worker lê os arquivos de
`raw.githubusercontent.com/<dono>/<repo>/<sha>/`, com o sha de 40 hex do HEAD
do branch padrão (cache de 60 s para o sha; arquivos com `cache-control:
immutable`). Publicar uma versão nova é dar push; não há versão fixada nem
canal de atualização separado.

### Publicar (registrar um id)

Regras:

- **Publicar é fechado.** Só contas na lista `EXTENSION_PUBLISHERS` (ids de
  conta separados por vírgula; padrão `1`, a conta do dono) podem registrar um
  id. Por enquanto, só o dono publica.
- **Código aberto.** O registro só aceita repositório GitHub **público** com
  **licença** declarada.
- **Id único, primeiro a registrar leva.** O mesmo repositório de novo é
  idempotente; outro repositório com um id já tomado é recusado.

Como o registro funciona (`POST /api/extensions`, corpo `{"repo": "dono/repo"}`):

1. `dono/repo` é normalizado para minúsculas (o GitHub não distingue).
2. O servidor confere que o repositório é público e tem licença
   (`api.github.com/repos/<repo>`), lê o HEAD por
   `api.github.com/repos/<repo>/commits/HEAD` e o `juntos.json` de
   `raw.githubusercontent.com/<repo>/<sha>/juntos.json` (até 64 KB, 10 s).
   O HEAD de cada repositório fica 30 s em memória: sem token, a API do
   GitHub aceita 60 chamadas por hora por IP. Com `GITHUB_TOKEN` no
   servidor, o limite sobe para 5000.
3. Valida o manifesto e grava `id → github:<repo>`, com o `sub`, o `name` e o
   `icon`.

Respostas:

| Status | Corpo | Quando |
| --- | --- | --- |
| 201 | `{id, sub, sha, manifest}` | id novo registrado. |
| 200 | `{id, sub, sha, manifest}` | o id já era deste repositório. |
| 400 | `{"error": "bad_repo"}` | não é `dono/repo`. |
| 401 | `{"error": "account_required"}` | sem conta logada. |
| 403 | `{"error": "publisher_only"}` | a conta não está em `EXTENSION_PUBLISHERS`. |
| 404 | `{"error": "repo_not_found"}` | repositório não existe. |
| 409 | `{"error": "id_taken"}` | o id é de outro repositório. |
| 422 | `{"error": "bad_manifest", "detail": "…"}` | `juntos.json` inválido; `detail` diz o campo. |
| 422 | `{"error": "not_open_source"}` | repositório privado ou sem licença. |
| 429 | — | mais de 10 tentativas por sessão na hora. |
| 502 | `{"error": "github_unavailable"}` | GitHub fora ou lento. |

### Instalar

Regras:

- **Nada vem instalado.** O painel começa vazio para todo mundo.
- **Instalar é digitar o id.** A pessoa digita o id no painel; o juntos acha
  esse id no registro, busca o commit atual do repositório registrado, lê o
  `juntos.json` dali e mostra **Vai acessar** com todos os hosts que a
  extensão vai alcançar. Só depois de **Instalar** a extensão abre.
- **Atualizar.** A cada abertura, o juntos resolve o commit atual e compara
  com o que este aparelho aprovou (`ss.extensions` no `localStorage`):
  - mesmo commit: abre;
  - commit novo com os mesmos hosts e o mesmo `captcha`: atualiza e abre, sem
    perguntar;
  - hosts ou `captcha` diferentes: mostra **Vai acessar** de novo, com o botão
    **Atualizar**, e só abre depois.
- A retomada de um preparo depois de recarregar a página faz a mesma conta:
  atualização silenciosa segue; uma que pede aprovação para a retomada até a
  pessoa abrir o painel.
- A aprovação é por aparelho e navegador. Limpar os dados do site esquece as
  instalações; o login feito dentro de cada extensão fica na origem dela.

Ainda não há botão de remover.

### Rotas do registro

| Método | Rota | Resposta |
| --- | --- | --- |
| `GET` | `/api/extensions/:id` | `{id, name, sub, source, icon?}` ou 404. |
| `GET` | `/api/extensions/host/:sub` | `{id, source}` ou 404. Público, `Cache-Control: public, max-age=60`. Usado pelo Worker. |
| `POST` | `/api/extensions` | Registro, acima. |
| `GET` | `/api/extensions/:id/latest` | `{sha}` do HEAD (30 s em memória); 404 sem id; 502 `github_unavailable`. |

### Rotas do host de extensões

| Rota | O que faz |
| --- | --- |
| `GET /` | 302 para `/@<sha atual>/<entry>`, `cache-control: no-store`. |
| `GET /@<sha>/<caminho>` | O arquivo, com a CSP do manifesto. Só o sha atual: o host guarda o `latest` por 1 min e, se pedirem outro sha, pergunta de novo antes do 404 (logo depois de um push o site já conhece o sha novo). `GET` e `HEAD`. |
| `GET /_juntos/sdk.js` | O SDK, com a lista de origens do juntos embutida. Cache de 5 min. |
| `GET /_juntos/media?u=` | Proxy de mídia (seção 7). |

Cache interno do Worker: registro e `latest` 60 s, manifesto 5 min (Cache API
da Cloudflare). Uma mudança de hosts pode levar até 5 min para refletir na
CSP.

---

## 10. Operação

### Variáveis

Servidor (Go):

| Variável | Padrão | Uso |
| --- | --- | --- |
| `EXTENSION_BASE` | `santamagia.com` | Domínio dos subdomínios; vai ao site em `/api/config` como `extensionBase`. Dev: `localhost:8787`. |
| `EXTENSION_SCHEME` | `https` | `https` ou `http` (só dev); vai como `extensionScheme`. |
| `EXTENSION_PUBLISHERS` | `1` | Ids de conta que podem registrar extensões, separados por vírgula. |
| `GITHUB_TOKEN` | vazio | Token do GitHub (só leitura de repositórios públicos basta). Sem ele, a API aceita 60 chamadas por hora por IP; vai só para a API, nunca para os arquivos. |
| `GITHUB_API_BASE` | `https://api.github.com` | Onde ler HEAD e licença; dev aponta para um GitHub local. |
| `GITHUB_RAW_BASE` | `https://raw.githubusercontent.com` | Onde ler os arquivos; vai ao site em `/api/config` como `extensionRaw`, de onde o painel lê o `juntos.json`. |

Worker (`extensions/host/wrangler.toml`):

| Variável | Dev | Produção (`--env production`) | Uso |
| --- | --- | --- | --- |
| `JUNTOS_ORIGIN` | `http://127.0.0.1:8090` | `https://juntos.lol` | De onde lê o registro. |
| `JUNTOS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8090,http://localhost:8090` | `https://juntos.lol` | Quem pode embutir (`frame-ancestors`), falar com o SDK e receber CORS do proxy. |
| `EXT_BASE` | `localhost:8787` | `santamagia.com` | Sufixo do host; tem de bater com `EXTENSION_BASE`. |
| `EXT_SCHEME` | `http` | `https` | Esquema das URLs que o proxy reescreve. |
| `GITHUB_RAW` | vazio (GitHub) | vazio (GitHub) | Onde ler os arquivos das extensões; tem de bater com `GITHUB_RAW_BASE` do servidor. |

### Publicar o Worker

```bash
cd extensions/host
npm ci
npm test
npx wrangler deploy --env production
```

Precisa da rota `*.santamagia.com/*` na zona `santamagia.com` e de um DNS
curinga (`*`) com proxy da Cloudflare. O token tem de ter permissão de
Workers e DNS nessa zona.

### Testes

- Host: `cd extensions/host && npm test` (gera o SDK antes).
- Registro: `go test ./internal/extension/... ./internal/httpapi/...` (com
  `TEST_DATABASE_URL`).
- Site: `cd web && npx vitest run src/extensions src/pipeline`.

### Limites conhecidos

- **Repositório renomeado.** O registro guarda `dono/repo`, não o id numérico
  do repositório. Se o dono renomear ou apagar a conta ou o repositório e
  outra pessoa criar o mesmo nome, o `latest` passa a apontar para o código
  dela no mesmo subdomínio (com os mesmos hosts, a atualização entra sem
  perguntar). Enquanto só a conta do dono publica, o risco é dele; antes de
  abrir a publicação, guardar o id do repositório e conferi-lo no `latest`.
- **Assinatura de segmento curta.** Não há renovação das URLs dos segmentos
  no meio do preparo; um CDN que assina cada segmento por segundos falha.
- **Quadro em branco.** Se o host de extensões responde 404 ou 502, o iframe
  fica em branco; o painel ainda não mostra erro para isso.
