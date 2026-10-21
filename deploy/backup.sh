#!/bin/sh
# =====================================================================
# Copias de seguridad automáticas: base de datos (pg_dump) y archivos subidos.
#   - Cada BACKUP_INTERVAL_HOURS horas (por defecto 24).
#   - Se conservan BACKUP_KEEP_DAYS días (por defecto 7).
#   - Se guardan en la carpeta ./backups del proyecto.
# Copia inmediata:  docker compose exec backup sh /backup.sh --once
# Cada copia se verifica restaurándola en una base temporal (rag_restore_test).
# =====================================================================
set -eu

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
DEST=/backups
mkdir -p "$DEST"

# Comprueba que la copia sirve de verdad: restaura el volcado en una base temporal,
# cuenta algunas tablas y comprueba que el archivo de subidas se puede leer.
verify() {
  dump="$1"
  uploads="$2"
  tar tzf "$uploads" >/dev/null 2>&1 || { echo "[backup] ERROR: el archivo de subidas $uploads está dañado"; return 1; }
  dropdb -h db -U rag_owner --if-exists rag_restore_test >/dev/null 2>&1
  createdb -h db -U rag_owner rag_restore_test
  if ! pg_restore -h db -U rag_owner -d rag_restore_test --no-owner --exit-on-error "$dump" >/dev/null 2>/tmp/restore.log; then
    echo "[backup] ERROR: no se pudo restaurar $dump:"
    cat /tmp/restore.log
    dropdb -h db -U rag_owner --if-exists rag_restore_test >/dev/null 2>&1
    return 1
  fi
  counts=$(psql -h db -U rag_owner -d rag_restore_test -At -F ', '     -c "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM documents), (SELECT count(*) FROM chunks)")
  dropdb -h db -U rag_owner --if-exists rag_restore_test >/dev/null 2>&1
  echo "[backup] VERIFICADA (restaurada en una base temporal). Usuarios, documentos, fragmentos: $counts"
}

backup() {
  ts=$(date +%Y-%m-%d_%H%M)
  echo "[backup] $(date -Iseconds) iniciando copia $ts"
  pg_dump -h db -U rag_owner -d rag -Fc -f "$DEST/db_$ts.dump.tmp"
  mv "$DEST/db_$ts.dump.tmp" "$DEST/db_$ts.dump"
  tar czf "$DEST/uploads_$ts.tgz.tmp" -C /uploads .
  mv "$DEST/uploads_$ts.tgz.tmp" "$DEST/uploads_$ts.tgz"
  verify "$DEST/db_$ts.dump" "$DEST/uploads_$ts.tgz"
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
