#!/bin/sh
# =====================================================================
# Copia en Backblaze B2, siempre cifrada:
#   1. Las copias de la base de datos («*.enc») que deja el servicio «backup» en /offsite.
#   2. Con B2_SYNC_UPLOADS=true, los archivos subidos (/uploads) de forma INCREMENTAL: solo sube lo nuevo o
#      cambiado. Lo que se borra en la aplicación pasa a «archive/AAAA-MM-DD» y allí se conserva B2_KEEP_DAYS días.
#      Los nombres y el contenido se cifran con BACKUP_ENCRYPTION_PASSPHRASE (rclone crypt) antes de salir.
#   - Cada B2_INTERVAL_HOURS horas (por defecto 6) o, con B2_AT=04:00, una vez al día a esa hora (hora de BACKUP_TZ;
#     por defecto Lima, UTC-5): ponla después de BACKUP_AT. Con B2_AT, al arrancar se sube lo que haya quedado
#     pendiente (copias *.enc de /offsite que aún no están en B2), tras esperar 5 minutos a la copia de «backup».
#   - En B2 se conservan B2_KEEP_DAYS días (por defecto 30) las copias de la base y lo borrado de los archivos.
# Subida inmediata:  docker compose run --rm backup-b2 --once
# Restaurar archivos: docker compose run --rm -v "$PWD/restore:/restore" backup-b2 --restore /restore [origen]
#   origen: «current» (por defecto, todo), «current/<carpeta>/<carpeta>» (una parte) o «archive/AAAA-MM-DD» (lo borrado ese día).
# Ver lo borrado:    docker compose run --rm backup-b2 --archive
# Se activa con COMPOSE_PROFILES=backblaze (ver docs/produccion.md → «Copias de seguridad»).
# =====================================================================
set -eu

# Estado para la pantalla Sistema → Copias (lo lee el worker en el volumen «backup-status»). Sin secretos.
STATUS_DIR=/status
LAST_ERROR=""
LAST_OK_AT=""
NEXT_AT=""
[ ! -f "$STATUS_DIR/b2.json" ] || LAST_OK_AT=$(sed -n 's/.*"lastOkAt":"\([^"]*\)".*/\1/p' "$STATUS_DIR/b2.json" 2>/dev/null || true)
save_status() {
  [ -d "$STATUS_DIR" ] || return 0
  ok=true; [ -z "$LAST_ERROR" ] || ok=false
  printf '{"checkedAt":"%s","ok":%s,"error":"%s","lastOkAt":"%s","at":"%s","intervalHours":%s,"nextAt":"%s","syncUploads":%s,"keepDays":%s}\n' \
    "$(date -Iseconds)" "$ok" "$(printf '%s' "$LAST_ERROR" | tr -d '"\\')" "$LAST_OK_AT" "${B2_AT:-}" "${B2_INTERVAL_HOURS:-6}" "$NEXT_AT" \
    "$([ "${B2_SYNC_UPLOADS:-false}" = "true" ] && echo true || echo false)" "${B2_KEEP_DAYS:-30}" > "$STATUS_DIR/b2.json.tmp" \
    && mv "$STATUS_DIR/b2.json.tmp" "$STATUS_DIR/b2.json" || true
}

# Sin las tres variables no se puede subir nada: se anota en el estado (para verlo en la pantalla) y se sale.
missing=""
[ -n "${B2_BUCKET:-}" ] || missing="$missing B2_BUCKET"
[ -n "${RCLONE_CONFIG_B2_ACCOUNT:-}" ] || missing="$missing B2_KEY_ID"
[ -n "${RCLONE_CONFIG_B2_KEY:-}" ] || missing="$missing B2_APPLICATION_KEY"
if [ -n "$missing" ]; then
  LAST_ERROR="faltan en el .env:$missing (o quita backblaze de COMPOSE_PROFILES)"
  echo "[b2] ERROR: $LAST_ERROR"
  save_status
  # Sin esta espera, Docker lo reinicia en bucle cada pocos segundos.
  sleep 600
  exit 1
fi

DEST="b2:${B2_BUCKET}/${B2_PATH:-omni-rag}"
INTERVAL_HOURS="${B2_INTERVAL_HOURS:-6}"
KEEP_DAYS="${B2_KEEP_DAYS:-30}"
AT="${B2_AT:-}"
SYNC_UPLOADS="${B2_SYNC_UPLOADS:-false}"

# Remote «cr»: los archivos cifrados (contenido y nombres) en la subcarpeta «archivos» del destino. La frase de
# cifrado es la misma de las copias de la base; sin ella no se puede leer nada de lo que hay en B2.
if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  export RCLONE_CONFIG_CR_TYPE=crypt
  export RCLONE_CONFIG_CR_REMOTE="$DEST/archivos"
  export RCLONE_CONFIG_CR_PASSWORD="$(rclone obscure "$BACKUP_ENCRYPTION_PASSPHRASE")"
  export RCLONE_CONFIG_CR_PASSWORD2="$(rclone obscure "${BACKUP_ENCRYPTION_PASSPHRASE}:nombres")"
fi

# Segundos hasta la próxima vez que sean las HH:MM en la zona BACKUP_TZ (por defecto Lima: UTC-5, sin horario de verano).
secs_until() {
  now=$(TZ="${BACKUP_TZ:-<-05>5}" date +%H:%M:%S)
  echo "$1 $now" | awk '{ split($1, t, ":"); split($2, n, ":"); d = t[1] * 3600 + t[2] * 60 - (n[1] * 3600 + n[2] * 60 + n[3]); if (d <= 0) d += 86400; print d }'
}
check_at() {
  case "$1" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "[$2] ERROR: $3 debe tener el formato HH:MM (24 h), por ejemplo 03:00"; exit 1 ;; esac
}

need_passphrase() {
  [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] && return 0
  LAST_ERROR="falta BACKUP_ENCRYPTION_PASSPHRASE: los archivos solo se guardan cifrados"
  echo "[b2] ERROR: $LAST_ERROR"
  save_status
  exit 1
}

upload_db() {
  if ! ls /offsite/*.enc >/dev/null 2>&1; then
    LAST_ERROR="no hay copias cifradas (*.enc) en /offsite: activa BACKUP_OFFSITE=true y BACKUP_ENCRYPTION_PASSPHRASE (sin cifrar no se sube nada)"
    echo "[b2] AVISO: $LAST_ERROR"
    return 1
  fi
  rclone copy /offsite "$DEST" --include '*.enc' --max-depth 1 --transfers 2 --stats-one-line --stats 0 -v || return 1
  rclone delete "$DEST" --min-age "${KEEP_DAYS}d" --include '*.enc' --max-depth 1 -v || return 1
  echo "[b2] $(date -Iseconds) copias de la base sincronizadas con $DEST"
}

# Sincroniza /uploads con cr:current. Lo que desaparece (o cambia) se mueve a cr:archive/AAAA-MM-DD, nunca se borra
# al instante; las carpetas de archive de más de KEEP_DAYS días se eliminan.
upload_files() {
  [ "$SYNC_UPLOADS" = "true" ] || return 0
  need_passphrase
  # Un volumen vacío casi seguro es un error de montaje: no se toca el destino.
  if [ -z "$(ls -A /uploads 2>/dev/null)" ]; then
    echo "[b2] AVISO: /uploads está vacío; no se sincronizan los archivos."
    return 0
  fi
  today=$(date +%F)
  rclone sync /uploads cr:current --backup-dir "cr:archive/$today" --transfers 4 --checkers 8 --stats-one-line --stats 0 -v || return 1
  cutoff=$(date -d "@$(( $(date +%s) - KEEP_DAYS * 86400 ))" +%F)
  for d in $(rclone lsf cr:archive --dirs-only 2>/dev/null | tr -d '/'); do
    case "$d" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) continue ;; esac
    if expr "$d" "<" "$cutoff" >/dev/null; then
      rclone purge "cr:archive/$d" -v
    fi
  done
  echo "[b2] $(date -Iseconds) archivos subidos sincronizados ($(rclone size cr:current 2>/dev/null | tr '\n' ' '))"
}

# Cada paso comprueba su error: la función se llama como «upload || …», y ahí `set -e` no actúa dentro.
upload() {
  LAST_ERROR=""
  upload_db || [ -n "$LAST_ERROR" ] || LAST_ERROR="no se pudieron subir las copias de la base a B2 (revisa las claves y el bucket)"
  [ -n "$LAST_ERROR" ] || upload_files || LAST_ERROR="no se pudieron sincronizar los archivos subidos con B2"
  [ -n "$LAST_ERROR" ] || LAST_OK_AT=$(date -Iseconds)
  save_status
  [ -z "$LAST_ERROR" ]
}

# Anota la próxima subida en el estado y espera hasta entonces.
wait_until_next() {
  NEXT_AT=$(date -Iseconds -d "@$(( $(date +%s) + $1 ))" 2>/dev/null || true)
  save_status
  sleep "$1"
}

# ¿Hay copias cifradas en /offsite que todavía no están en B2? (el servidor estuvo apagado a la hora de la subida)
pending() {
  ls /offsite/*.enc >/dev/null 2>&1 || return 1
  remote=$(rclone lsf "$DEST" --include '*.enc' --max-depth 1 --files-only) || return 1
  for f in /offsite/*.enc; do
    printf '%s\n' "$remote" | grep -qxF "$(basename "$f")" || return 0
  done
  return 1
}

restore() {
  need_passphrase
  dest="${1:?Indica la carpeta de destino, por ejemplo /restore}"
  src="${2:-current}"
  rclone copy "cr:$src" "$dest" --transfers 4 --stats-one-line --stats 5s -v
  echo "[b2] archivos de «$src» restaurados en $dest"
}

case "${1:-}" in
  --once) upload; exit $? ;;
  --restore) shift; restore "$@"; exit 0 ;;
  --archive) need_passphrase; rclone lsf cr:archive --dirs-only | tr -d '/'; exit 0 ;;
esac

if [ -n "$AT" ]; then
  check_at "$AT" b2 B2_AT
  # Al arrancar, «backup» puede estar haciendo la copia que faltaba: se le da tiempo antes de comprobar.
  sleep 300
  if pending; then
    echo "[b2] hay copias sin subir a B2: se suben ahora"
    upload || echo "[b2] ERROR al subir (se reintentará a las $AT)"
  fi
  while true; do
    wait=$(secs_until "$AT")
    echo "[b2] próxima subida a las $AT (hora local; ahora son $(TZ="${BACKUP_TZ:-<-05>5}" date +%H:%M)), dentro de $((wait / 60)) min"
    wait_until_next "$wait"
    upload || echo "[b2] ERROR al subir (se reintentará mañana a la misma hora)"
  done
fi
while true; do
  upload || echo "[b2] ERROR al subir (se reintentará en el próximo ciclo)"
  wait_until_next $((INTERVAL_HOURS * 3600))
done
