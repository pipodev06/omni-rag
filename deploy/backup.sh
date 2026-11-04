#!/bin/sh
# =====================================================================
# Copias de seguridad automáticas: base de datos (pg_dump) y archivos subidos.
#   - Cada BACKUP_INTERVAL_HOURS horas (por defecto 24), o a una hora fija todos los días con BACKUP_AT=03:00
#     (hora de BACKUP_TZ; por defecto Lima, UTC-5). Con BACKUP_AT, al arrancar el contenedor solo se hace copia si
#     la última tiene más de 24 h (el servidor estuvo apagado o parado a esa hora).
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
  COUNTS="$counts"
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
      openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$f" -out "/offsite/$name.enc.tmp" \
        && mv "/offsite/$name.enc.tmp" "/offsite/$name.enc" || { rm -f "/offsite/$name.enc.tmp"; return 1; }
    else
      cp "$f" "/offsite/$name.tmp" && mv "/offsite/$name.tmp" "/offsite/$name" || { rm -f "/offsite/$name.tmp"; return 1; }
    fi
  done
  find /offsite \( -name 'db_*' -o -name 'uploads_*' \) -mtime +"$KEEP_DAYS" -delete
  if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then how="cifrada"; else how="SIN cifrar"; fi
  echo "[backup] copia enviada a la carpeta externa ($how)"
}

# Estado de la última copia para la pantalla Sistema → Copias (lo lee el worker). Sin secretos: solo fechas y textos fijos.
STATUS="$DEST/.estado.json"
LAST_ERROR=""
COUNTS=""
# Una copia manual (--once) conserva la próxima hora que anotó el proceso principal.
NEXT_AT=$(sed -n 's/.*"nextAt":"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null || true)
save_status() {
  ok=true; [ -z "$LAST_ERROR" ] || ok=false
  offsite_on="${BACKUP_OFFSITE:-false}"; encrypted=false; [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] || encrypted=true
  printf '{"attemptAt":"%s","ok":%s,"error":"%s","counts":"%s","at":"%s","intervalHours":%s,"nextAt":"%s","offsite":%s,"encrypted":%s,"keepDays":%s}\n' \
    "${ATTEMPT_AT:-}" "$ok" "$(printf '%s' "$LAST_ERROR" | tr -d '"\\')" "$COUNTS" "$AT" "$INTERVAL_HOURS" "$NEXT_AT" \
    "$([ "$offsite_on" = "true" ] && echo true || echo false)" "$encrypted" "$KEEP_DAYS" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS" || true
}

# Cada paso comprueba su error a mano: la función se llama como «backup || …», y ahí `set -e` no actúa dentro.
# Una copia que falla no deja ningún db_*.dump: si quedara uno a medias, contaría como copia reciente.
fail() {
  LAST_ERROR="$1"
  echo "[backup] ERROR: $1"
  rm -f "$DEST/db_$ts.dump.tmp" "$DEST/uploads_$ts.tgz.tmp"
  [ ! -f "$DEST/db_$ts.dump" ] || mv "$DEST/db_$ts.dump" "$DEST/db_$ts.dump.fallida"
  save_status
  return 1
}

backup() {
  ts=$(date +%Y-%m-%d_%H%M)
  ATTEMPT_AT=$(date -Iseconds)
  LAST_ERROR=""
  COUNTS=""
  echo "[backup] $ATTEMPT_AT iniciando copia $ts"
  pg_dump -h db -U rag_owner -d rag -Fc -f "$DEST/db_$ts.dump.tmp" || { fail "pg_dump no pudo volcar la base de datos"; return 1; }
  mv "$DEST/db_$ts.dump.tmp" "$DEST/db_$ts.dump" || { fail "no se pudo guardar el volcado (¿disco lleno?)"; return 1; }
  files=""
  if [ "${BACKUP_UPLOADS_TGZ:-true}" = "true" ]; then
    tar czf "$DEST/uploads_$ts.tgz.tmp" -C /uploads . || { fail "no se pudo empaquetar los archivos subidos (¿disco lleno?)"; return 1; }
    mv "$DEST/uploads_$ts.tgz.tmp" "$DEST/uploads_$ts.tgz" || { fail "no se pudo guardar el paquete de archivos"; return 1; }
    files="$DEST/uploads_$ts.tgz"
  fi
  verify "$DEST/db_$ts.dump" "$files" || { fail "la copia no se pudo restaurar en la base de prueba"; return 1; }
  offsite "$DEST/db_$ts.dump" $files || { LAST_ERROR="la copia local está bien, pero no se pudo copiar a la carpeta externa"; echo "[backup] ERROR: $LAST_ERROR"; }
  find "$DEST" -name 'db_*.dump' -mtime +"$KEEP_DAYS" -delete
  find "$DEST" -name 'db_*.dump.fallida' -mtime +"$KEEP_DAYS" -delete
  find "$DEST" -name 'uploads_*.tgz' -mtime +"$KEEP_DAYS" -delete
  if [ -n "$files" ]; then size="$(du -h "$files" | cut -f1) archivos"; else size="archivos aparte (BACKUP_UPLOADS_TGZ=false)"; fi
  echo "[backup] copia $ts terminada: $(du -h "$DEST/db_$ts.dump" | cut -f1) base de datos, $size"
  save_status
  [ -z "$LAST_ERROR" ]
}

# Programa la próxima copia en el estado (para la pantalla) y espera hasta entonces.
wait_until_next() {
  NEXT_AT=$(date -Iseconds -d "@$(( $(date +%s) + $1 ))")
  save_status
  sleep "$1"
}

if [ "${1:-}" = "--once" ]; then
  backup
  exit $?
fi

# Esperar a que la base de datos acepte conexiones.
until pg_isready -h db -U rag_owner -d rag >/dev/null 2>&1; do sleep 2; done
if [ -n "$AT" ]; then
  check_at "$AT" backup BACKUP_AT
  # Si el servidor no estaba en marcha a la hora fijada, la copia de ese día se hace ahora.
  if [ -z "$(find "$DEST" -maxdepth 1 -name 'db_*.dump' -mmin -1440 2>/dev/null)" ]; then
    echo "[backup] la última copia tiene más de 24 h (o no hay ninguna): se hace una ahora"
    backup || echo "[backup] ERROR en la copia (se reintentará a las $AT)"
  fi
  while true; do
    wait=$(secs_until "$AT")
    echo "[backup] próxima copia a las $AT (hora local; ahora son $(TZ="${BACKUP_TZ:-<-05>5}" date +%H:%M)), dentro de $((wait / 60)) min"
    wait_until_next "$wait"
    backup || echo "[backup] ERROR en la copia (se reintentará mañana a la misma hora)"
  done
fi
while true; do
  backup || echo "[backup] ERROR en la copia (se reintentará en el próximo ciclo)"
  wait_until_next $((INTERVAL_HOURS * 3600))
done
