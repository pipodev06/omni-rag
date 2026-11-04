#!/bin/sh
# =====================================================================
# Copia en Backblaze B2, siempre cifrada:
#   1. Las copias de la base de datos («*.enc») que deja el servicio «backup» en la carpeta externa: /offsite o,
#      si se eligió un destino en Sistema → Copias (BACKUP_DESTINATION), /targets/<ruta>.
#   2. Con B2_SYNC_UPLOADS=true, los archivos subidos (/uploads) de forma INCREMENTAL: solo sube lo nuevo o
#      cambiado. Lo que se borra en la aplicación pasa a «archive/AAAA-MM-DD» y allí se conserva B2_KEEP_DAYS días.
#      Los nombres y el contenido se cifran con BACKUP_ENCRYPTION_PASSPHRASE (rclone crypt) antes de salir.
#   - Cada B2_INTERVAL_HOURS horas (por defecto 6) o, con B2_AT=04:00, una vez al día a esa hora (hora de BACKUP_TZ;
#     por defecto Lima, UTC-5): ponla después de BACKUP_AT. Con B2_AT, al arrancar se sube lo que haya quedado
#     pendiente (copias *.enc de la carpeta externa que aún no están en B2), tras esperar 5 minutos a la copia de «backup».
#   - En B2 se conservan B2_KEEP_DAYS días (por defecto 30) las copias de la base y lo borrado de los archivos.
# Ajustes: la variable de entorno (si no está vacía) manda; si no, lo guardado en Sistema → Copias, que el worker deja
# en /backup-config/b2.env (se relee cada minuto); si no, el valor por defecto de este script.
# Sin credenciales no se sale: se anota el error en el estado y se vuelve a mirar cada minuto.
# Subida inmediata:  docker compose run --rm backup-b2 --once
# Restaurar archivos: docker compose run --rm -v "$PWD/restore:/restore" backup-b2 --restore /restore [origen]
#   origen: «current» (por defecto, todo), «current/<carpeta>/<carpeta>» (una parte) o «archive/AAAA-MM-DD» (lo borrado ese día).
# Ver lo borrado:    docker compose run --rm backup-b2 --archive
# Se activa con COMPOSE_PROFILES=backblaze (ver docs/produccion.md → «Copias de seguridad»).
# =====================================================================
set -eu

# Estado para la pantalla Sistema → Copias (lo lee el worker en el volumen «backup-status»). Sin secretos.
STATUS_DIR=/status
CONF="${B2_CONFIG_FILE:-/backup-config/b2.env}"
TARGETS=/targets
LAST_ERROR=""
LAST_OK_AT=""
NEXT_AT=""
[ ! -f "$STATUS_DIR/b2.json" ] || LAST_OK_AT=$(sed -n 's/.*"lastOkAt":"\([^"]*\)".*/\1/p' "$STATUS_DIR/b2.json" 2>/dev/null || true)

# Valores efectivos (los fija apply_config).
BUCKET=""; B2PATH="omni-rag"; INTERVAL_HOURS=6; KEEP_DAYS=30; AT=""; SYNC_UPLOADS=false; TZ_EFF="<-05>5"
DEST_REL=""; SRC=/offsite; DEST=""
WARNED=""
OBSCURED_FOR=""; OBSCURED_1=""; OBSCURED_2=""

# Variables que puede traer el archivo b2.env. Se guarda cómo venían del entorno para que la variable no vacía siempre mande.
Q="'"
CFG_KEYS="B2_AT B2_INTERVAL_HOURS B2_KEEP_DAYS B2_SYNC_UPLOADS B2_BUCKET B2_PATH B2_KEY_ID B2_APPLICATION_KEY BACKUP_TZ BACKUP_AT BACKUP_INTERVAL_HOURS BACKUP_KEEP_DAYS BACKUP_UPLOADS_TGZ BACKUP_OFFSITE BACKUP_DESTINATION"
for k in $CFG_KEYS; do eval "ORIG_$k=\${$k:-}"; done
# La clave que da rclone por el entorno (compose la copia de B2_KEY_ID / B2_APPLICATION_KEY).
ORIG_ACCOUNT="${RCLONE_CONFIG_B2_ACCOUNT:-}"
ORIG_KEY="${RCLONE_CONFIG_B2_KEY:-}"

jstr() { printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037'; }

save_status() {
  [ -d "$STATUS_DIR" ] || return 0
  ok=true; [ -z "$LAST_ERROR" ] || ok=false
  printf '{"checkedAt":"%s","ok":%s,"error":"%s","lastOkAt":"%s","at":"%s","intervalHours":%s,"nextAt":"%s","syncUploads":%s,"keepDays":%s}\n' \
    "$(date -Iseconds)" "$ok" "$(jstr "$LAST_ERROR")" "$LAST_OK_AT" "$AT" "$INTERVAL_HOURS" "$NEXT_AT" \
    "$([ "$SYNC_UPLOADS" = "true" ] && echo true || echo false)" "$KEEP_DAYS" > "$STATUS_DIR/b2.json.tmp" \
    && mv "$STATUS_DIR/b2.json.tmp" "$STATUS_DIR/b2.json" || true
}

# --- Ajustes -----------------------------------------------------------------------------------------------
bad() {
  case "$WARNED" in *"|$1|"*) ;; *) WARNED="$WARNED|$1|"; echo "[b2] AVISO: valor no válido en $1; se usa el valor por defecto" ;; esac
}
is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 5 ] && [ "$1" -gt 0 ]; }
valid_at() { case "$1" in [0-2][0-9]:[0-5][0-9]) [ "${1%%:*}" -le 23 ] ;; *) return 1 ;; esac; }
# Misma regla que la API y que backup.sh para la ruta del destino externo.
valid_path() {
  case "$1" in
    '') return 0 ;;
    /*|*..*|.|./*|*/./*|*/.|*[!A-Za-z0-9\ _./-]*) return 1 ;;
  esac
  [ "${#1}" -le 200 ]
}
set_uint() { # variable, valor, defecto
  if [ -z "$2" ]; then v="$3"; elif is_uint "$2"; then v="$2"; else bad "$1"; v="$3"; fi
  eval "$1=\$v"
}

# Carga el archivo del worker sin pisar lo que venga no vacío del entorno, y calcula los valores efectivos.
apply_config() {
  for k in $CFG_KEYS; do eval "$k=\$ORIG_$k"; done
  if [ -r "$CONF" ]; then
    # Solo se ejecutan las líneas «export CLAVE='valor'» con una clave conocida y el valor entre comillas simples: así
    # el archivo (lo escribe el worker) no puede ejecutar otra cosa.
    # El archivo filtrado trae las claves de B2: solo lo lee quien lo crea (umask 077 solo aquí: el estado de /status lo lee el worker) y se borra en cuanto se carga.
    ( umask 077; grep -E "^export ($(echo "$CFG_KEYS" | tr ' ' '|'))=${Q}([^${Q}]|${Q}\\\\${Q}${Q})*${Q}\$" "$CONF" > /tmp/b2.env.seguro 2>/dev/null ) || true
    . /tmp/b2.env.seguro
    rm -f /tmp/b2.env.seguro
    for k in $CFG_KEYS; do eval "o=\$ORIG_$k"; [ -z "$o" ] || eval "$k=\$o"; done
  fi
  BUCKET="${B2_BUCKET:-}"
  B2PATH="${B2_PATH:-}"; [ -n "$B2PATH" ] || B2PATH=omni-rag
  case "$B2PATH" in *[!A-Za-z0-9\ _./-]*|/*|*..*) bad B2_PATH; B2PATH=omni-rag ;; esac
  set_uint INTERVAL_HOURS "${B2_INTERVAL_HOURS:-}" 6
  set_uint KEEP_DAYS "${B2_KEEP_DAYS:-}" 30
  AT="${B2_AT:-}"; if [ -n "$AT" ] && ! valid_at "$AT"; then bad B2_AT; AT=""; fi
  case "${B2_SYNC_UPLOADS:-}" in true) SYNC_UPLOADS=true ;; ''|false) SYNC_UPLOADS=false ;; *) bad B2_SYNC_UPLOADS; SYNC_UPLOADS=false ;; esac
  TZ_EFF="${BACKUP_TZ:-}"
  case "$TZ_EFF" in '') TZ_EFF="<-05>5" ;; *[!A-Za-z0-9\<\>+:/_,.-]*) bad BACKUP_TZ; TZ_EFF="<-05>5" ;; esac
  DEST_REL="${BACKUP_DESTINATION:-}"
  if valid_path "$DEST_REL"; then :; else bad BACKUP_DESTINATION; DEST_REL=""; fi
  if [ -n "$DEST_REL" ]; then SRC="$TARGETS/$DEST_REL"; else SRC=/offsite; fi
  DEST="b2:${BUCKET}/${B2PATH}"
  # Claves para rclone: la variable de compose (B2_KEY_ID / B2_APPLICATION_KEY) o lo guardado en la pantalla.
  export RCLONE_CONFIG_B2_TYPE=b2 RCLONE_CONFIG_B2_HARD_DELETE=true
  export RCLONE_CONFIG_B2_ACCOUNT="${ORIG_ACCOUNT:-${B2_KEY_ID:-}}"
  export RCLONE_CONFIG_B2_KEY="${ORIG_KEY:-${B2_APPLICATION_KEY:-}}"
  # Remote «cr»: los archivos cifrados (contenido y nombres) en la subcarpeta «archivos» del destino. La frase de
  # cifrado es la misma de las copias de la base; sin ella no se puede leer nada de lo que hay en B2.
  if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
    export RCLONE_CONFIG_CR_TYPE=crypt
    export RCLONE_CONFIG_CR_REMOTE="$DEST/archivos"
    # La frase va a rclone por la entrada estándar (nunca como argumento, que otros procesos pueden ver) y solo se vuelve
    # a ofuscar si cambia: apply_config corre cada minuto.
    if [ "$BACKUP_ENCRYPTION_PASSPHRASE" != "$OBSCURED_FOR" ] || [ -z "$OBSCURED_1" ]; then
      OBSCURED_1=$(printf '%s\n' "$BACKUP_ENCRYPTION_PASSPHRASE" | rclone obscure -) || OBSCURED_1=""
      OBSCURED_2=$(printf '%s\n' "${BACKUP_ENCRYPTION_PASSPHRASE}:nombres" | rclone obscure -) || OBSCURED_2=""
      OBSCURED_FOR="$BACKUP_ENCRYPTION_PASSPHRASE"
    fi
    export RCLONE_CONFIG_CR_PASSWORD="$OBSCURED_1" RCLONE_CONFIG_CR_PASSWORD2="$OBSCURED_2"
  fi
}

# Sin las tres variables no se puede subir nada. Devuelve 1 y deja el motivo en LAST_ERROR.
missing_config() {
  missing=""
  [ -n "$BUCKET" ] || missing="$missing B2_BUCKET"
  [ -n "$RCLONE_CONFIG_B2_ACCOUNT" ] || missing="$missing B2_KEY_ID"
  [ -n "$RCLONE_CONFIG_B2_KEY" ] || missing="$missing B2_APPLICATION_KEY"
  [ -n "$missing" ] || return 1
  LAST_ERROR="faltan los datos de Backblaze:$missing (configúralos en Sistema → Copias o en el .env)"
  return 0
}

# Segundos hasta la próxima vez que sean las HH:MM en la zona BACKUP_TZ (por defecto Lima: UTC-5, sin horario de verano).
secs_until() {
  now=$(TZ="$TZ_EFF" date +%H:%M:%S)
  echo "$1 $now" | awk '{ split($1, t, ":"); split($2, n, ":"); d = t[1] * 3600 + t[2] * 60 - (n[1] * 3600 + n[2] * 60 + n[3]); if (d <= 0) d += 86400; print d }'
}

need_passphrase() {
  [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] && return 0
  LAST_ERROR="falta BACKUP_ENCRYPTION_PASSPHRASE: los archivos solo se guardan cifrados"
  echo "[b2] ERROR: $LAST_ERROR"
  save_status
  return 1
}

# La carpeta externa elegida en la pantalla: si el disco no está conectado no se sube nada.
src_ready() {
  [ -d "$SRC" ] && return 0
  if [ -n "$DEST_REL" ]; then LAST_ERROR="el destino externo no está conectado: no existe $SRC"
  else LAST_ERROR="no existe la carpeta de copias externas $SRC: activa BACKUP_OFFSITE=true"; fi
  echo "[b2] AVISO: $LAST_ERROR"
  return 1
}

upload_db() {
  src_ready || return 1
  if ! ls "$SRC"/*.enc >/dev/null 2>&1; then
    LAST_ERROR="no hay copias cifradas (*.enc) en $SRC: activa BACKUP_OFFSITE=true y BACKUP_ENCRYPTION_PASSPHRASE (sin cifrar no se sube nada)"
    echo "[b2] AVISO: $LAST_ERROR"
    return 1
  fi
  rclone copy "$SRC" "$DEST" --include '*.enc' --max-depth 1 --transfers 2 --stats-one-line --stats 0 -v || return 1
  rclone delete "$DEST" --min-age "${KEEP_DAYS}d" --include '*.enc' --max-depth 1 -v || return 1
  echo "[b2] $(date -Iseconds) copias de la base sincronizadas con $DEST"
}

# Sincroniza /uploads con cr:current. Lo que desaparece (o cambia) se mueve a cr:archive/AAAA-MM-DD, nunca se borra
# al instante; las carpetas de archive de más de KEEP_DAYS días se eliminan.
upload_files() {
  [ "$SYNC_UPLOADS" = "true" ] || return 0
  need_passphrase || return 1
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
  if [ -z "$LAST_ERROR" ]; then
    upload_files || [ -n "$LAST_ERROR" ] || LAST_ERROR="no se pudieron sincronizar los archivos subidos con B2"
  fi
  [ -n "$LAST_ERROR" ] || LAST_OK_AT=$(date -Iseconds)
  save_status
  [ -z "$LAST_ERROR" ]
}

# ¿Hay copias cifradas en la carpeta externa que todavía no están en B2? (el servidor estuvo apagado a la hora de la subida)
pending() {
  [ -d "$SRC" ] || return 1
  ls "$SRC"/*.enc >/dev/null 2>&1 || return 1
  remote=$(rclone lsf "$DEST" --include '*.enc' --max-depth 1 --files-only) || return 1
  for f in "$SRC"/*.enc; do
    printf '%s\n' "$remote" | grep -qxF "$(basename "$f")" || return 0
  done
  return 1
}

restore() {
  need_passphrase || return 1
  dest="${1:?Indica la carpeta de destino, por ejemplo /restore}"
  src="${2:-current}"
  rclone copy "cr:$src" "$dest" --transfers 4 --stats-one-line --stats 5s -v
  echo "[b2] archivos de «$src» restaurados en $dest"
}

case "${1:-}" in
  --once)
    apply_config
    if missing_config; then echo "[b2] ERROR: $LAST_ERROR"; save_status; exit 1; fi
    upload; exit $? ;;
  --restore) shift; apply_config; restore "$@" || exit 1; exit 0 ;;
  --archive) apply_config; need_passphrase || exit 1; rclone lsf cr:archive --dirs-only | tr -d '/'; exit 0 ;;
esac

# Bucle principal: cada minuto relee los ajustes y sube cuando toca. Sin credenciales no sale: espera a que se configuren.
LAST_RUN=0
NEXT_EPOCH=0
CHECK_PENDING=false
SIG=""
START=$(date +%s)
while true; do
  apply_config
  if missing_config; then
    [ "$LAST_ERROR" = "${SHOWN:-}" ] || echo "[b2] AVISO: $LAST_ERROR"
    SHOWN="$LAST_ERROR"
    NEXT_AT=""
    save_status
    sleep 60
    continue
  fi
  case "$LAST_ERROR" in "faltan los datos"*) LAST_ERROR="" ;; esac
  new_sig="$AT|$INTERVAL_HOURS|$TZ_EFF"
  if [ "$new_sig" != "$SIG" ]; then
    first=false; [ -n "$SIG" ] || first=true
    SIG="$new_sig"
    if [ -n "$AT" ]; then
      # Al arrancar, «backup» puede estar haciendo la copia que faltaba: se le da tiempo antes de comprobar.
      if [ "$first" = "true" ]; then NEXT_EPOCH=$(( START + 300 )); CHECK_PENDING=true
      else NEXT_EPOCH=$(( $(date +%s) + $(secs_until "$AT") )); CHECK_PENDING=false; fi
      echo "[b2] próxima subida a las $AT (hora local; ahora son $(TZ="$TZ_EFF" date +%H:%M))"
    else
      NEXT_EPOCH=$(( LAST_RUN + INTERVAL_HOURS * 3600 )); CHECK_PENDING=false
      echo "[b2] una subida cada $INTERVAL_HOURS h"
    fi
  fi
  if [ "$(date +%s)" -ge "$NEXT_EPOCH" ]; then
    if [ "$CHECK_PENDING" = "true" ]; then
      CHECK_PENDING=false
      if pending; then
        echo "[b2] hay copias sin subir a B2: se suben ahora"
        upload || echo "[b2] ERROR al subir (se reintentará a las $AT)"
      fi
    else
      upload || echo "[b2] ERROR al subir (se reintentará en el próximo ciclo)"
    fi
    LAST_RUN=$(date +%s)
    if [ -n "$AT" ]; then NEXT_EPOCH=$(( LAST_RUN + $(secs_until "$AT") )); else NEXT_EPOCH=$(( LAST_RUN + INTERVAL_HOURS * 3600 )); fi
  fi
  if [ "$NEXT_EPOCH" -gt 86400 ]; then NEXT_AT=$(date -Iseconds -d "@$NEXT_EPOCH" 2>/dev/null || true); else NEXT_AT=""; fi
  save_status
  rem=$(( NEXT_EPOCH - $(date +%s) ))
  [ "$rem" -ge 1 ] || rem=1
  [ "$rem" -le 60 ] || rem=60
  sleep "$rem"
done
