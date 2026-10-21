#!/bin/sh
# =====================================================================
# Copias de seguridad automáticas: base de datos (pg_dump) y archivos subidos.
#   - Cada BACKUP_INTERVAL_HOURS horas (por defecto 24).
#   - Se conservan BACKUP_KEEP_DAYS días (por defecto 7).
#   - Se guardan en la carpeta ./backups del proyecto.
# Copia inmediata:  docker compose exec backup sh /backup.sh --once
# =====================================================================
set -eu

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
DEST=/backups
mkdir -p "$DEST"

backup() {
  ts=$(date +%Y-%m-%d_%H%M)
  echo "[backup] $(date -Iseconds) iniciando copia $ts"
  pg_dump -h db -U rag_owner -d rag -Fc -f "$DEST/db_$ts.dump.tmp"
  mv "$DEST/db_$ts.dump.tmp" "$DEST/db_$ts.dump"
  tar czf "$DEST/uploads_$ts.tgz.tmp" -C /uploads .
  mv "$DEST/uploads_$ts.tgz.tmp" "$DEST/uploads_$ts.tgz"
  find "$DEST" -name 'db_*.dump' -mtime +"$KEEP_DAYS" -delete
  find "$DEST" -name 'uploads_*.tgz' -mtime +"$KEEP_DAYS" -delete
  echo "[backup] copia $ts terminada: $(du -h "$DEST/db_$ts.dump" | cut -f1) base de datos, $(du -h "$DEST/uploads_$ts.tgz" | cut -f1) archivos"
}

if [ "${1:-}" = "--once" ]; then
  backup
  exit 0
fi

# Esperar a que la base de datos acepte conexiones.
until pg_isready -h db -U rag_owner -d rag >/dev/null 2>&1; do sleep 2; done
while true; do
  backup || echo "[backup] ERROR en la copia (se reintentará en el próximo ciclo)"
  sleep $((INTERVAL_HOURS * 3600))
done
