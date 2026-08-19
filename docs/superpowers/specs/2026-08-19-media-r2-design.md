# Mídia no R2

Data: 2026-08-19

## Problema

Uma sala ocupa hoje ~850 MB no disco da VPS, medidos em produção:

```
/data/rooms/{id}/hls           585M
/data/rooms/{id}/original.mp4  264M
/data/rooms/{id}/subs           20K
```

Com 96 GB de disco, o teto prático é de ~4 salas simultâneas — e o disco
foi o limite que apareceu antes de CPU e de banda no teste de carga.

Pior que o teto: o disco amarra a mídia à máquina que a produziu. Enquanto
a mídia mora em `/data`, uma segunda instância da aplicação não consegue
servir uma sala que a primeira encodou. Escalar significa comprar uma
máquina maior, nunca somar máquinas.

O R2 resolve os dois: tira os bytes do disco e os torna endereçáveis por
qualquer instância. Egress é gratuito, e regras de lifecycle expiram os
objetos sem que o sweeper precise varrer arquivo.

## Decisões tomadas

**Bucket público com TTL curto.** `media.giuli.dev` aponta para o bucket.
Quem tiver a URL acessa até a lifecycle apagar. É o único desenho em que os
bytes do viewer nunca tocam a VPS, que é o ponto inteiro da migração.

**Playlists continuam saindo do Go.** São KB, não MB. Mantêm o
`normalizeEventPlaylist` onde ele já está e testado, e devolvem a barreira
de sala expirada que o bucket público perde: sala vencida dá 404 no
`master.m3u8`, então ninguém *inicia* playback mesmo com os segmentos
públicos.

**Corte seco, sem fallback.** O R2 é o único destino. Um caminho só para
manter e testar. O risco aceito, explicitamente: R2 indisponível é sala
quebrada, sem plano B.

## Arquitetura

### O sinal de "segmento pronto"

Este é o detalhe de que tudo depende. Vigiar o diretório à espera de um
arquivo com nome final seria confiar no `+temp_file` do ffmpeg e numa
corrida de escrita.

A playlist é o sinal. O muxer HLS só acrescenta um segmento ao `.m3u8`
depois de tê-lo escrito por inteiro — garantia do formato, não de timing.
O publisher lê a playlist e sobe o que estiver listado.

### Fluxo

```
ffmpeg  ──escreve──>  /data/rooms/{id}/hls/   (efêmero, local ao encoder)
                              │
                        publisher lê a playlist
                              │
                    ┌─────────┴─────────┐
                    │                   │
              PUT segmento          playlist renderizada
              para o R2             para o Redis
                    │                   │
            media.giuli.dev        GET /media/{id}/hls/*.m3u8
                    │                   │
                    └────> player <─────┘
```

O viewer busca a playlist na aplicação e os segmentos no R2. A aplicação
nunca serve um byte de vídeo.

## Componentes

### `internal/media/objectstore/` (novo)

```go
type ObjectStore interface {
    Put(ctx context.Context, key string, r io.Reader, size int64, contentType, cacheControl string) error
}
```

Duas implementações: R2 sobre a API S3, e um fake em memória para os
testes. A interface existe pelos testes — não é ponto de extensão para um
fallback de disco, que foi descartado.

Dependência nova: `minio-go`. O `aws-sdk-go-v2` puxa cerca de quinze
módulos para fazer o mesmo trabalho.

### `internal/media/publisher.go` (novo)

Uma goroutine por job de encode, com tick de 1s — metade da duração do
segmento de preview, que é o caminho sensível a latência. A cada tick:

1. Lê as playlists de variante em `{hlsDir}/*.m3u8`.
2. Para cada segmento listado que ainda não subiu: `Put` em
   `rooms/{id}/hls/{nome}`, registra o nome no set de publicados, apaga o
   arquivo local.
3. Renderiza a playlist e grava no Redis: normalizada pelo
   `normalizeEventPlaylist` atual, com URIs absolutas apontando para
   `media.giuli.dev`, e **truncada no último segmento confirmado**.

O passo 3 é o que torna o desenho seguro. Um `Put` lento vira uma playlist
mais curta — o viewer espera. Nunca vira um 404 no player.

O master playlist é caso à parte: as URIs dele apontam para playlists de
variante, que continuam sendo servidas pelo Go. Ficam relativas.

**A troca do preview pelo final precisa ser atômica.** Hoje ela é: o remux
final escreve `final_master.m3u8` e faz `os.Rename` por cima de
`master.m3u8` (`remux.go:156`). Com as playlists no Redis, o equivalente é
gravar o master e todas as playlists de variante do encode final num único
`HSET` — o pacote `redis` já expõe isso via pipeline transacional, usado em
`store.go:57`. Escrever o master antes das variantes deixaria uma janela em
que o player pede a escada final e recebe playlists de preview.

### `internal/httpapi/media.go` (modificado)

`serveMedia` passa a ler `.m3u8` do Redis em vez do disco. Mesma rota,
mesmo handler, mesma checagem de sala existente e não expirada.

Ler do Redis em vez do disco é o que faz o horizontal existir de fato: uma
playlist em disco estaria no disco da máquina que encodou, e uma segunda
instância não teria como servi-la.

A rota continua a mesma; o que muda é o que ela aceita. Um pedido de
`.m4s` ou `.mp4` passa a responder 404: esses nomes só chegavam ao player
por dentro da playlist, que agora aponta para o R2.

### Legendas

Vão para o R2 junto, em `rooms/{id}/subs/{nome}.vtt`. São 20 KB, mas
mantê-las em disco amarraria o caminho de serviço à máquina do encode pelo
mesmo motivo das playlists.

O frontend monta essas URLs (`Player.tsx:583`), então o payload da sala
ganha um campo `mediaBaseUrl`. As legendas já são versionadas por query
string (`?g=&s=`), o que continua valendo.

### Arquivo original

Permanece em disco — o preview progressivo depende do ffmpeg lendo um
arquivo que ainda cresce (`streamGrowingFile`), e o R2 não tem semântica de
append nem de leitura-durante-escrita.

Muda o momento de apagá-lo: hoje ele sobrevive até a sala ser varrida;
passa a ser removido assim que o remux final publica. Ele só precisa
sobreviver a um restart no meio do job, e depois do publish final não há
nada a recuperar. É o que leva o disco de "70% menor" para praticamente
zero em regime.

## Chaves

**R2:**

```
rooms/{roomID}/hls/{filename}     segmentos e arquivos de init
rooms/{roomID}/subs/{filename}    legendas
```

**Redis** (seguindo `room:{id}:{coisa}` de `store.go:37-41`):

```
room:{id}:playlists   HASH  nome do arquivo -> playlist renderizada
room:{id}:published   SET   nomes de objetos já no R2
```

Ambas com `Expire` igual ao TTL da sala, como `membersKey` já faz.

**Cache-Control nos objetos R2:** segmentos e init recebem
`public, max-age=31536000, immutable` — nomes carregam número de sequência,
e um encode novo escreve nomes novos. Legendas recebem
`public, max-age=3600`, porque o mesmo nome é reescrito enquanto a extração
progressiva avança. São exatamente os valores de `mediaCacheControl` hoje,
aplicados na escrita em vez de na resposta.

## Configuração

Todas obrigatórias, validadas no boot. Corte seco significa falhar alto na
largada, não descobrir no meio de uma sala.

```
R2_ACCOUNT_ID          e270a2e902b37cc9c371a473a0de188f
R2_BUCKET              ss-media
R2_ACCESS_KEY_ID       (token de API do R2)
R2_SECRET_ACCESS_KEY   (SHA-256 do valor do token)
MEDIA_PUBLIC_URL       https://media.giuli.dev
```

## Infraestrutura já provisionada

- Bucket `ss-media`, região ENAM — mesma região da VPS (OVH Beauharnois).
- Domínio `media.giuli.dev` anexado à zona `giuli.dev`, TLS mínimo 1.2.
- Regra de lifecycle `expire-room-media-24h`: apaga o prefixo `rooms/`
  após 24h e aborta uploads multipart pendentes no mesmo prazo.

Falta apenas o token de API, que precisa ser criado manualmente — o token
OAuth do plugin não tem escopo para criar credenciais.

## O que sai

`SweepSupersededPreviews` e a constante `PreviewGracePeriod` são removidas
por inteiro. A lifecycle cobre preview e final juntos.

Os objetos de preview passam a viver 24h em vez de 5 minutos. Cerca de
US$ 0,003 por sala — a simplicidade compensa.

O sweeper fica com Redis, uploads travados e o diretório da sala.

## Erros

- **Falha de `Put`:** o job falha, sala vai para estado de erro. É o corte
  seco. O segmento não entra no set de publicados, então a playlist não o
  referencia em nenhum momento.
- **Redis indisponível na escrita da playlist:** já é uma condição fatal em
  todo o resto da aplicação. Sem tratamento novo.
- **Objeto expirado pela lifecycle com a sala ainda viva:** só ocorre se
  `ROOM_TTL_HOURS` passar de 24. Validado no boot.

## Custo

Um episódio de ~45 min gera cerca de 2.250 segmentos finais (quatro
rendições mais áudio, 6s cada) e ~1.350 de preview (2s). Uns 3.600 PUTs por
sala.

O free tier de Class A é 1M/mês: ~275 salas por mês sem custo, e
US$ 0,016 por sala depois disso. Storage com TTL de 24h é ruído.

Custo não é um fator nesta decisão.

## Testes

- Fake `ObjectStore` em memória.
- Publisher: segmento listado sobe e é registrado; playlist trunca no
  último confirmado; falha de upload derruba o job; arquivo local some
  depois do upload.
- Handler: playlist vem do Redis; sala expirada dá 404; playlist ausente
  dá 404.
- Integração com ffmpeg real contra o fake, verificando que a playlist
  publicada é tocável.
- `internal/e2e/torrent_integration_test.go` precisa do store injetado.

## Fora de escopo

Depois desta mudança o gargalo passa a ser CPU de encode — medido em ~3,5x
tempo real agregado. Escalar horizontal de verdade ainda exige workers de
encode consumindo de uma fila compartilhada.

Este design é o pré-requisito dessa segunda fase, não a segunda fase.
