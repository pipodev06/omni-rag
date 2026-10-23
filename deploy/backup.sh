#!/bin/sh
# =====================================================================
# Copias de seguridad automáticas: base de datos (pg_dump) y archivos subidos.
#   - Cada BACKUP_INTERVAL_HOURS horas (por defecto 24), o a una hora fija todos los días con BACKUP_AT=03:00
#     (hora de BACKUP_TZ; por defecto Lima, UTC-5). Con BACKUP_AT no se hace copia al arrancar el contenedor.
#   - Se conservan BACKUP_KEEP_DAYS días (por defecto 7).
#   - Se guardan en la carpeta ./backups del proyecto.
# Copia inmediata:  docker compose exec backup sh /backup.sh --once
# Cada copia se verifica restaurándola en una base temporal (rag_restore_test).
#   - Con BACKUP_OFFSITE=true también se copia (y cifra, si hay passphrase) a una carpeta externa.
# =====================================================================
set -eu

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
AT="${BACKUP_AT:-}"
DEST=/backups
mkdir -p "$DEST"

# Segundos hasta la próxima vez que sean las HH:MM en la zona BACKUP_TZ (por defecto Lima: UTC-5, sin horario de verano).
secs_until() {
  now=$(TZ="${BACKUP_TZ:-<-05>5}" date +%H:%M:%S)
  echo "$1 $now" | awk '{ split($1, t, ":"); split($2, n, ":"); d = t[1] * 3600 + t[2] * 60 - (n[1] * 3600 + n[2] * 60 + n[3]); if (d <= 0) d += 86400; print d }'
}
check_at() {
  case "$1" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "[$2] ERROR: $3 debe tener el formato HH:MM (24 h), por ejemplo 03:00"; exit 1 ;; esac
}

# Comprueba que la copia sirve de verdad: restaura el volcado en una base temporal,
# cuenta algunas tablas y comprueba que el archivo de subidas se puede leer.
verify() {
  dump="$1"
  uploads="$2"
  if [ -n "$uploads" ]; then tar tzf "$uploads" >/dev/null 2>&1 || { echo "[backup] ERROR: el archivo de subidas $uploads está dañado"; return 1; }; fi
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

# Copia las copias verificadas a una carpeta EXTERNA al servidor (disco USB, NAS, carpeta
# sincronizada con la nube…). Si hay BACKUP_ENCRYPTION_PASSPHRASE se cifran con AES-256
# antes de salir de aquí: contienen los datos de todos los clientes.
offsite() {
  [ "${BACKUP_OFFSITE:-false}" = "true" ] || return 0
  [ -d /offsite ] || { echo "[backup] AVISO: BACKUP_OFFSITE=true pero /offsite no existe"; return 1; }
  for f in "$@"; do
    name=$(basename "$f")
    if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
      openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$f" -out "/offsite/$name.enc.tmp"         && mv "/offsite/$name.enc.tmp" "/offsite/$name.enc"
    else
      cp "$f" "/offsite/$name.tmp" && mv "/offsite/$name.tmp" "/offsite/$name"
    fi
  done
  find /offsite \( -name 'db_*' -o -name 'uploads_*' \) -mtime +"$KEEP_DAYS" -delete
  if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then how="cifrada"; else how="SIN cifrar"; fi
  echo "[backup] copia enviada a la carpeta externa ($how)"
}

backup() {
  ts=$(date +%Y-%m-%d_%H%M)
  echo "[backup] $(date -Iseconds) iniciando copia $ts"
  pg_dump -h db -U rag_owner -d rag -Fc -f "$DEST/db_$ts.dump.tmp"
  mv "$DEST/db_$ts.dump.tmp" "$DEST/db_$ts.dump"
  files=""
  if [ "${BACKUP_UPLOADS_TGZ:-true}" = "true" ]; then
    tar czf "$DEST/uploads_$ts.tgz.tmp" -C /uploads .
    mv "$DEST/uploads_$ts.tgz.tmp" "$DEST/uploads_$ts.tgz"
    files="$DEST/uploads_$ts.tgz"
  fi
  verify "$DEST/db_$ts.dump" "$files"
  offsite "$DEST/db_$ts.dump" $files
  find "$DEST" -name 'db_*.dump' -mtime +"$KEEP_DAYS" -delete
  find "$DEST" -name 'uploads_*.tgz' -mtime +"$KEEP_DAYS" -delete
  if [ -n "$files" ]; then size="$(du -h "$files" | cut -f1) archivos"; else size="archivos aparte (BACKUP_UPLOADS_TGZ=false)"; fi
  echo "[backup] copia $ts terminada: $(du -h "$DEST/db_$ts.dump" | cut -f1) base de datos, $size"
}

if [ "${1:-}" = "--once" ]; then
  backup
  exit 0
fi

# Esperar a que la base de datos acepte conexiones.
until pg_isready -h db -U rag_owner -d rag >/dev/null 2>&1; do sleep 2; done
if [ -n "$AT" ]; then
  check_at "$AT" backup BACKUP_AT
  while true; do
    wait=$(secs_until "$AT")
    echo "[backup] próxima copia a las $AT (hora local; ahora son $(TZ="${BACKUP_TZ:-<-05>5}" date +%H:%M)), dentro de $((wait / 60)) min"
    sleep "$wait"
    backup || echo "[backup] ERROR en la copia (se reintentará mañana a la misma hora)"
  done
fi
while true; do
  backup || echo "[backup] ERROR en la copia (se reintentará en el próximo ciclo)"
  sleep $((INTERVAL_HOURS * 3600))
done
