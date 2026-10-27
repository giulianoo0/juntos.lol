#!/usr/bin/env bash
# Dump diário do Postgres do juntos, guardando os últimos 7 dias.
# Roda no host, pelo cron, ao lado do docker-compose.yml:
#   15 4 * * * /opt/ss/scripts/pg-backup.sh >> /opt/ss/backups/backup.log 2>&1
# Restaurar: docker compose exec -T postgres pg_restore -U juntos -d juntos --clean < arquivo.dump
set -euo pipefail

SS_DIR="${SS_DIR:-/opt/ss}"
BACKUP_DIR="${BACKUP_DIR:-$SS_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/juntos-$(date -u +%Y%m%d-%H%M%S).dump"

# Grava num .partial e só renomeia no fim: um dump cortado nunca parece bom.
docker compose --project-directory "$SS_DIR" exec -T postgres \
	pg_dump -U juntos -d juntos --format=custom > "$out.partial"
mv "$out.partial" "$out"

find "$BACKUP_DIR" -name 'juntos-*.dump' -mtime +"$((KEEP_DAYS - 1))" -delete
find "$BACKUP_DIR" -name 'juntos-*.dump.partial' -mmin +60 -delete

echo "$(date -u +%FT%TZ) $out $(du -h "$out" | cut -f1)"
