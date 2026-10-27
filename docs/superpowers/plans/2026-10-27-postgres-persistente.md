# Postgres para o que é permanente

Hoje tudo mora no Redis, e o Redis do compose não tem volume: recriar o
container apaga contas, amigos e histórico. Sala continua no Redis (é efêmera,
tem TTL); o que precisa durar vai para o Postgres.

## O que muda de casa

| Vai para o Postgres | Fica no Redis |
|---|---|
| `account:*` (conta, `account:seq`, `account:discord:*`) | `room:*`, `rooms:by_expiry`, chat, membros |
| amigos e pedidos (`:friends`, `:requests:in/out`) | `sess:*` anônimas, `sessions:ip:*`, `quota:*` |
| histórico (`:history`) e os contadores `sessions`/`watchedSeconds` | `discord:room:*` (24 h), `job:*`, `charged:*` |
| sessões de login (`account:session:*`, 30 dias) | |
| avisos/notificações e preferências de privacidade da leva nova | |
| `worker:*` (chave pública de enrollment) | |

## Onda única (um subagent)

1. **Infra**
   - Serviço `postgres:18-alpine` no compose com volume `ss-pg` e healthcheck.
   - `DATABASE_URL` no `config` e no `environment:` do app.
   - O app sobe só depois do Postgres estar saudável.
   - Driver `github.com/jackc/pgx/v5` (pgxpool), sem ORM.
2. **Schema**
   - Migrações em SQL embutidas (`internal/db/migrations/*.sql` via `embed`), aplicadas no boot numa tabela `schema_migrations`. Nada de ferramenta externa.
   - Tabelas:
     - `accounts`: id bigserial, discord_id unique, nickname, avatar, visibility, discord_username, discord_public, history_public, created_at, sessions, watched_seconds;
     - `account_sessions`: token_hash pk, account_id, expires_at;
     - `friendships`: a, b com a<b;
     - `friend_requests`: from, to;
     - `watches`: id, account_id, room_id, title, kind, started_at, duration_sec, with bigint[], com índice (account_id, started_at desc);
     - `notifications`, no formato que a leva de avisos usar;
     - `workers`.
3. **Código**
   - `account.Store` e `worker.Registry` passam a usar `*pgxpool.Pool`, com a mesma API pública e os handlers intocados.
   - O token de sessão é guardado como sha256.
   - O histórico continua cortado em 200 por conta, via `DELETE` no mesmo tx.
   - O `seq` vira o próprio `bigserial`, preservando os ids atuais na importação (`setval` para o max).
4. **Importação**
   - Comando `cmd/migrate-redis`, idempotente (`ON CONFLICT DO NOTHING`).
   - Ele lê do Redis por SCAN todas as chaves da coluna esquerda e grava no Postgres.
   - Ao final, compara as contagens (contas, amigos, watches) e as imprime.
5. **Testes**
   - Os testes de store rodam contra um Postgres real, via `testcontainers-go` ou um `DATABASE_URL` de teste com skip se ausente.
   - O miniredis fica só para salas/quota.
   - A suíte Go inteira e o `npm run build` precisam passar.

## Deploy

1. Liga a manutenção (`touch` da flag).
2. Sobe o `postgres`, roda `migrate-redis` contra o Redis de produção e confere as contagens.
3. `up -d` do app novo.
4. Abre o site e confere uma conta com amigos e histórico.
5. Desliga a manutenção.
6. Faz um backup diário com `pg_dump` num cron do host para `/opt/ss/backups` (7 dias).

As chaves antigas `account:*` ficam no Redis uma semana como rede e depois são
apagadas à mão.
