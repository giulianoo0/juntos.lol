# Deploy do host de extensões

O Worker `juntos-ext` serve cada extensão no próprio subdomínio de
`santamagia.com` e pergunta o registro a `https://juntos.lol`, então o
servidor com a migração `0005_extensions` precisa estar no ar antes.

## Na Cloudflare, uma vez

- Zona `santamagia.com` ativa na conta.
- Registro DNS curinga com proxy (nuvem laranja), sem origem de verdade:
  `AAAA  *  100::`
- Token do Wrangler com **Workers Scripts: Edit** e **Workers Routes: Edit**
  na zona `santamagia.com` (a rota é `*.santamagia.com/*`).

## Publicar

```sh
cd extensions/host
npm ci
npm run deploy   # gera o SDK e roda wrangler deploy --env production
```

Para conferir sem publicar:
`npx wrangler deploy --env production --dry-run --outdir /tmp/juntos-ext`.

## Conferir

Com uma extensão registrada, o `sub` dela vem de
`curl -s https://juntos.lol/api/extensions/<id>`. Então:

```sh
curl -sI https://<sub>.santamagia.com/
```

Tem de responder `302` com `location: /@<sha>/<entry>`. Um subdomínio que não
está no registro responde `404`.
