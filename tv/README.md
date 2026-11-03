# App de TV

Casca para Samsung (Tizen) e LG (webOS) que abre `https://juntos.lol/tv`. A
página faz tudo; o pacote só leva a casca, o ícone e o splash.

- **Samsung**: página hospedada não recebe as APIs do Tizen
  ([Hosted Applications Q&A](https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html)),
  então a casca é local (`shell/tizen.html` + `shell/tizen-shell.js`): registra
  as teclas de mídia com `tizen.tvinputdevice.registerKey`, abre a página num
  iframe com foco e fecha o app quando a página manda
  `parent.postMessage({type: "juntos-tv:exit"}, "*")`. Ao carregar, a casca manda
  para a página `{type: "juntos-tv:shell", platform: "tizen", keys: [...]}`. Dentro
  do iframe `window.tizen` não existe; as teclas registradas chegam como
  `keydown` normal.
- **LG**: app hospedado do jeito da LG
  ([Web App Types](https://webostv.developer.lge.com/develop/getting-started/web-app-types)):
  `index.html` local redireciona para a página. `disableBackHistoryAPI: true`
  entrega a tecla Voltar (461) à página; o Magic Remote é ponteiro (eventos de
  mouse) em qualquer página.

## Build

```bash
tv/build.sh                                         # tv/dist/juntos.wgt e tv/dist/lol.juntos.tv_0.1.0_all.ipk
JUNTOS_TV_URL=http://192.168.0.10:5173/tv tv/build.sh   # aponta para um servidor de dev
TIZEN_PROFILE=outro-perfil tv/build.sh
```

Precisa do Tizen Studio em `~/tizen-studio` (ou `TIZEN_STUDIO`), de Java (o
script acha o `openjdk@21` do Homebrew) e do `ares-package`
(`npm i -g @webos-tools/cli`). Ícones e splash saem de `art/*.svg` com
`tv/art/render.sh`.

## Instalar

Samsung (Developer Mode na TV: Apps → `12345` → ligar → IP deste Mac → reiniciar
a TV). O `sdb` vem no pacote de ferramentas do Tizen Studio (`tools/sdb`):

```bash
sdb connect <ip-da-tv>
sdb devices                                    # serial = <ip>:26101
tizen install -n juntos.wgt -- tv/dist -s <serial>
sdb -s <serial> shell 0 was 6BfN87oaeM.juntos  # abrir
sdb -s <serial> shell 0 kill 6BfN87oaeM.juntos # fechar
```

LG (Developer Mode app na TV, sessão ligada):

```bash
ares-setup-device -a minha-tv -i "host=<ip-da-tv>" -i "port=9922" -i "username=prisoner"
ares-novacom --device minha-tv --getkey        # passphrase que o app mostra
ares-install -d minha-tv tv/dist/lol.juntos.tv_0.1.0_all.ipk
ares-launch -d minha-tv lol.juntos.tv
```

## Debug

Samsung: o `dlog` vem trancado nas TVs de loja; o caminho é o Web Inspector.

```bash
sdb -s <serial> shell 0 kill 6BfN87oaeM.juntos
sdb -s <serial> shell 0 debug 6BfN87oaeM.juntos   # "... debug 1 port: 37199" (se imprimir "closed", o app ainda estava aberto)
sdb -s <serial> forward tcp:37199 tcp:37199
curl -s http://localhost:37199/json              # webSocketDebuggerUrl da casca e do iframe
```

Abra `http://localhost:37199` no Chrome ou ligue um cliente CDP no
`webSocketDebuggerUrl` (Runtime/Log/Console) para pegar console e exceções. A
página real é o alvo do iframe, não a casca.

LG: `ares-inspect -d minha-tv --app lol.juntos.tv --open`.

## Limitações

- Alvo Tizen 7+ e webOS 23+ (Chromium 94+). O `required_version` do Tizen é
  baixo para não travar a instalação, então TVs mais velhas instalam, mas a
  página pode não funcionar.
- A assinatura de distribuidor do `blumo-prod` só instala nas TVs cujo DUID está
  no certificado (`sdb -s <serial> shell 0 getduid`; TV nova = refazer o passo
  Distributor no Certificate Manager).
- No Samsung a página roda num iframe de outra origem: cookies `SameSite=Lax`
  não vão junto. A TV se autentica pelo token (`Authorization` e `?token=`), não
  por cookie.
- Se a página não carregar (sem rede), Voltar fecha o app só enquanto o foco
  está na casca; com o iframe focado numa página de erro, sai pelo Home.
