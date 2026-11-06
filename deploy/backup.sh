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
#
# Ajustes: cada valor sale, por este orden, de la variable de entorno (si no está vacía), de la tabla «settings» de la
# base (Sistema → Copias) o del valor por defecto de este script. Se releen cada minuto, sin reiniciar el contenedor.
# Órdenes de la pantalla (tabla «backup_requests», se leen cada minuto): hacer una copia ahora y cambiar la carpeta
# externa (BACKUP_DESTINATION, ruta relativa dentro de /targets, que es BACKUP_TARGETS_DIR del servidor).
# =====================================================================
set -eu

DEST=/backups
TARGETS=/targets
CLASSIC=/offsite
STATUS="$DEST/.estado.json"
SETTINGS=/tmp/settings.tsv
TAB=$(printf '\t')
export PGCONNECT_TIMEOUT=10
# Sin POSTGRES_PASSWORD en el archivo de entorno, la contraseña de rag_owner es la que generó el servicio «init».
# Se lee aquí (no en el entrypoint) para que también valga con «docker compose exec backup sh /backup.sh --once».
if [ -z "${PGPASSWORD:-}" ] && [ -r /secrets/postgres_password ]; then PGPASSWORD=$(cat /secrets/postgres_password); export PGPASSWORD; fi
mkdir -p "$DEST"
: > "$SETTINGS"

# Valores efectivos (los fija load_settings).
INTERVAL_HOURS=24; KEEP_DAYS=7; AT=""; TZ_EFF="<-05>5"; UPLOADS_TGZ=true; OFFSITE_ON=false; DEST_REL=""
WARNED=""
LAST_SCAN=0

# find, df y stat sobre un disco colgado (NFS caído, USB que falla) pueden quedarse bloqueados: con «timeout» si existe.
if command -v timeout >/dev/null 2>&1; then TMO="timeout 20"; else TMO=""; fi

psql_q() { psql -h db -U rag_owner -d rag -q -At "$@"; }

# Texto seguro para meter en JSON: sin comillas, barras invertidas ni caracteres de control.
jstr() { printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037'; }

# --- Lectura de ajustes ------------------------------------------------------------------------------------
dbval() { awk -F "$TAB" -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }' "$SETTINGS"; }
# PICKED = variable de entorno si no está vacía; si no, la fila de settings (puede quedar vacío = valor por defecto).
raw() { if [ -n "$2" ]; then PICKED="$2"; else PICKED=$(dbval "$1"); fi; }
bad() {
  case "$WARNED" in *"|$1|"*) ;; *) WARNED="$WARNED|$1|"; echo "[backup] AVISO: valor no válido en $1; se usa el valor por defecto" ;; esac
}
is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 5 ] && [ "$1" -gt 0 ]; }
set_uint() { # variable, clave, valor del entorno, defecto
  raw "$2" "$3"
  if [ -z "$PICKED" ]; then v="$4"; elif is_uint "$PICKED"; then v="$PICKED"; else bad "$2"; v="$4"; fi
  eval "$1=\$v"
}
set_bool() {
  raw "$2" "$3"
  case "$PICKED" in true|false) v="$PICKED" ;; '') v="$4" ;; *) bad "$2"; v="$4" ;; esac
  eval "$1=\$v"
}
valid_at() { case "$1" in [0-2][0-9]:[0-5][0-9]) [ "${1%%:*}" -le 23 ] ;; *) return 1 ;; esac; }
# Misma regla que la API: relativa, sin «..», sin «/» inicial, sin «.» suelto y solo letras, números, espacio y _ . - /
valid_path() {
  case "$1" in
    '') return 0 ;;
    /*|*..*|.|./*|*/./*|*/.|*[!A-Za-z0-9\ _./-]*) return 1 ;;
  esac
  [ "${#1}" -le 200 ]
}

load_settings() {
  if psql_q -c "SELECT key || E'\t' || (value #>> '{}') FROM settings WHERE value IS NOT NULL AND key IN ('BACKUP_AT','BACKUP_INTERVAL_HOURS','BACKUP_KEEP_DAYS','BACKUP_TZ','BACKUP_UPLOADS_TGZ','BACKUP_OFFSITE','BACKUP_DESTINATION')" > "$SETTINGS.new" 2>/dev/null; then
    mv "$SETTINGS.new" "$SETTINGS"
  else
    rm -f "$SETTINGS.new" # sin base (o sin tabla todavía): se conservan los últimos valores leídos
  fi
  set_uint INTERVAL_HOURS BACKUP_INTERVAL_HOURS "${BACKUP_INTERVAL_HOURS:-}" 24
  set_uint KEEP_DAYS BACKUP_KEEP_DAYS "${BACKUP_KEEP_DAYS:-}" 7
  set_bool UPLOADS_TGZ BACKUP_UPLOADS_TGZ "${BACKUP_UPLOADS_TGZ:-}" true
  set_bool OFFSITE_ON BACKUP_OFFSITE "${BACKUP_OFFSITE:-}" false
  raw BACKUP_AT "${BACKUP_AT:-}"
  if valid_at "$PICKED" || [ -z "$PICKED" ]; then AT="$PICKED"; else bad BACKUP_AT; AT=""; fi
  raw BACKUP_TZ "${BACKUP_TZ:-}"
  case "$PICKED" in
    '') TZ_EFF="<-05>5" ;;
    *[!A-Za-z0-9\<\>+:/_,.-]*) bad BACKUP_TZ; TZ_EFF="<-05>5" ;;
    *) TZ_EFF="$PICKED" ;;
  esac
  raw BACKUP_DESTINATION "${BACKUP_DESTINATION:-}"
  if valid_path "$PICKED"; then DEST_REL="$PICKED"; else bad BACKUP_DESTINATION; DEST_REL=""; fi
  # El disco recordado pertenece a un destino concreto: si el destino cambia, se vuelve a aprender.
  if [ "$DEST_REL" != "$DEST_DEV_FOR" ]; then DEST_DEV_FOR="$DEST_REL"; DEST_DEVICE=""; fi
}

# Segundos hasta la próxima vez que sean las HH:MM en la zona horaria efectiva.
secs_until() {
  now=$(TZ="$TZ_EFF" date +%H:%M:%S)
  echo "$1 $now" | awk '{ split($1, t, ":"); split($2, n, ":"); d = t[1] * 3600 + t[2] * 60 - (n[1] * 3600 + n[2] * 60 + n[3]); if (d <= 0) d += 86400; print d }'
}

# --- Destino externo ---------------------------------------------------------------------------------------
offsite_dir() { if [ -n "$DEST_REL" ]; then printf '%s' "$TARGETS/$DEST_REL"; else printf '%s' "$CLASSIC"; fi; }
dev_of() { $TMO stat -c %d "$1" 2>/dev/null || true; }
# Identidad de un archivo o carpeta (disco:inodo). Dos rutas distintas (enlaces simbólicos) pueden ser lo mismo.
ident_of() { $TMO stat -L -c '%d:%i' "$1" 2>/dev/null || true; }
# 0 si las dos rutas son el mismo archivo o carpeta, o si no se puede saber (ante la duda, se trata como el mismo).
same_thing() { a=$(ident_of "$1"); b=$(ident_of "$2"); [ -z "$a" ] || [ -z "$b" ] || [ "$a" = "$b" ]; }

# Lista de destinos permitidos para la pantalla: /backups/.destinos.json (hasta 2 niveles, máx. 100).
# «available» es false si /targets está vacío y en el mismo disco que /backups (BACKUP_TARGETS_DIR sin definir).
scan_targets() {
  avail=false; list=""
  if [ -d "$TARGETS" ]; then
    back_dev=$(dev_of "$DEST"); root_dev=$(dev_of "$TARGETS")
    [ "$root_dev" = "$back_dev" ] || avail=true
    dirs=$($TMO find "$TARGETS" -mindepth 1 -maxdepth 2 -type d ! -path '*/.*' ! -path '*/$*' ! -path '*/System Volume Information*' ! -path '*/lost+found*' 2>/dev/null | sort | head -n 100 || true)
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      rel="${d#"$TARGETS"/}"
      valid_path "$rel" || continue
      w=false; [ ! -w "$d" ] || w=true
      same=false; [ "$(dev_of "$d")" != "$back_dev" ] || same=true
      free=$($TMO df -Pk "$d" 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }' || true)
      item=$(printf '{"path":"%s","sameDisk":%s,"freeBytes":%s,"writable":%s}' "$rel" "$same" "${free:-0}" "$w")
      list="${list:+$list,}$item"
    done <<EOF
$dirs
EOF
    [ -z "$list" ] || avail=true
  fi
  printf '{"root":"%s","available":%s,"dirs":[%s]}\n' "$TARGETS" "$avail" "$list" > "$DEST/.destinos.json.tmp" || return 0
  if cmp -s "$DEST/.destinos.json.tmp" "$DEST/.destinos.json" 2>/dev/null; then rm -f "$DEST/.destinos.json.tmp"; else mv "$DEST/.destinos.json.tmp" "$DEST/.destinos.json" || true; fi
}

# ¿Está conectado el destino externo? Nunca se copia a otro sitio: sin destino, la copia local sigue y se avisa.
# Pone OFFSITE_ERROR (texto fijo, sin secretos) y devuelve 1 si hay problema.
dest_check() {
  OFFSITE_ERROR=""
  [ -n "$DEST_REL" ] || return 0
  d="$TARGETS/$DEST_REL"
  if [ ! -d "$d" ]; then
    OFFSITE_ERROR="el destino externo no está conectado: no existe $d"
    return 1
  fi
  dev=$(dev_of "$d")
  if [ -n "$DEST_DEVICE" ] && [ "$dev" != "$DEST_DEVICE" ]; then
    OFFSITE_ERROR="el destino externo no está conectado: la carpeta $d ya no está en el mismo disco que antes (si cambiaste el disco, vuelve a elegir el destino en Sistema → Copias)"
    return 1
  fi
  DEST_DEVICE="$dev"
  if [ ! -w "$d" ]; then
    OFFSITE_ERROR="el destino externo no admite escritura: $d"
    return 1
  fi
}

# Archivos de copia de una carpeta: solo los que tienen EXACTAMENTE el nombre que ponemos nosotros (nunca otros archivos del usuario).
BACKUP_NAMES="db_????-??-??_????.dump db_????-??-??_????.dump.enc uploads_????-??-??_????.tgz uploads_????-??-??_????.tgz.enc"
backup_files() {
  for pat in $BACKUP_NAMES; do find "$1" -maxdepth 1 -type f -name "$pat" 2>/dev/null || true; done | sort
}
# Borra de una carpeta las copias (y los volcados fallidos) de más de KEEP_DAYS días; solo con nuestro nombre exacto.
prune_old() {
  for pat in $BACKUP_NAMES db_????-??-??_????.dump.fallida; do
    find "$1" -maxdepth 1 -type f -name "$pat" -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
  done
}
files_bytes() {
  [ -n "$1" ] || { echo 0; return 0; }
  printf '%s\n' "$1" | while IFS= read -r f; do stat -c %s "$f"; done | awk '{ s += $1 } END { printf "%.0f", s }'
}

# Copia las copias verificadas a una carpeta EXTERNA al servidor (disco USB, NAS, carpeta
# sincronizada con la nube…). Si hay BACKUP_ENCRYPTION_PASSPHRASE se cifran con AES-256
# antes de salir de aquí: contienen los datos de todos los clientes.
offsite() {
  [ "$OFFSITE_ON" = "true" ] || { OFFSITE_ERROR=""; return 0; }
  # Destino desconectado: no se escribe en ninguna carpeta alternativa; la copia local ya está hecha.
  if ! dest_check; then echo "[backup] AVISO: $OFFSITE_ERROR"; return 0; fi
  dir=$(offsite_dir)
  [ -d "$dir" ] || { echo "[backup] AVISO: BACKUP_OFFSITE=true pero $dir no existe"; return 1; }
  for f in "$@"; do
    name=$(basename "$f")
    if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
      openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "$f" -out "$dir/$name.enc.tmp" \
        && mv "$dir/$name.enc.tmp" "$dir/$name.enc" || { rm -f "$dir/$name.enc.tmp"; return 1; }
    else
      cp "$f" "$dir/$name.tmp" && mv "$dir/$name.tmp" "$dir/$name" || { rm -f "$dir/$name.tmp"; return 1; }
    fi
  done
  prune_old "$dir"
  if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then how="cifrada"; else how="SIN cifrar"; fi
  echo "[backup] copia enviada a la carpeta externa ($how)"
}

# --- Estado para la pantalla --------------------------------------------------------------------------------
# Estado de la última copia para la pantalla Sistema → Copias (lo lee el worker). Sin secretos: solo fechas y textos fijos.
status_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$STATUS" 2>/dev/null | head -n 1 || true; }
LAST_ERROR=""
COUNTS=""
OFFSITE_ERROR=""
# Una copia manual (--once) conserva lo que anotó el proceso principal.
NEXT_AT=$(status_field nextAt)
ATTEMPT_AT=$(status_field attemptAt)
LAST_ERROR=$(status_field error)
COUNTS=$(status_field counts)
DEST_DEVICE=$(status_field destDevice)
DEST_DEV_FOR=$(status_field destination)
save_status() {
  ok=true; [ -z "$LAST_ERROR" ] || ok=false
  encrypted=false; [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] || encrypted=true
  printf '{"attemptAt":"%s","ok":%s,"error":"%s","counts":"%s","at":"%s","intervalHours":%s,"nextAt":"%s","offsite":%s,"encrypted":%s,"keepDays":%s,"offsiteError":"%s","destination":"%s","destDevice":"%s"}\n' \
    "$ATTEMPT_AT" "$ok" "$(jstr "$LAST_ERROR")" "$(jstr "$COUNTS")" "$AT" "$INTERVAL_HOURS" "$NEXT_AT" \
    "$([ "$OFFSITE_ON" = "true" ] && echo true || echo false)" "$encrypted" "$KEEP_DAYS" \
    "$(jstr "$OFFSITE_ERROR")" "$(jstr "$DEST_REL")" "$(jstr "$DEST_DEVICE")" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS" || true
}

# --- Copia -------------------------------------------------------------------------------------------------
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
  # Espacio libre en /backups: al menos el doble de la última copia (base + archivos).
  last="$(ls -t "$DEST"/db_*.dump 2>/dev/null | head -n 1 || true) $(ls -t "$DEST"/uploads_*.tgz 2>/dev/null | head -n 1 || true)"
  last_bytes=$(files_bytes "$(printf '%s
' $last)")
  free=$($TMO df -Pk "$DEST" 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }' || true)
  if [ -n "$free" ] && [ "$free" -lt $(( last_bytes * 2 )) ]; then
    fail "no hay espacio suficiente en la carpeta de copias: libres $((free / 1048576)) MB, hacen falta al menos $((last_bytes * 2 / 1048576)) MB (el doble de la última copia)"
    return 1
  fi
  pg_dump -h db -U rag_owner -d rag -Fc -f "$DEST/db_$ts.dump.tmp" || { fail "pg_dump no pudo volcar la base de datos"; return 1; }
  mv "$DEST/db_$ts.dump.tmp" "$DEST/db_$ts.dump" || { fail "no se pudo guardar el volcado (¿disco lleno?)"; return 1; }
  files=""
  if [ "$UPLOADS_TGZ" = "true" ]; then
    tar czf "$DEST/uploads_$ts.tgz.tmp" -C /uploads . || { fail "no se pudo empaquetar los archivos subidos (¿disco lleno?)"; return 1; }
    mv "$DEST/uploads_$ts.tgz.tmp" "$DEST/uploads_$ts.tgz" || { fail "no se pudo guardar el paquete de archivos"; return 1; }
    files="$DEST/uploads_$ts.tgz"
  fi
  verify "$DEST/db_$ts.dump" "$files" || { fail "la copia no se pudo restaurar en la base de prueba"; return 1; }
  offsite "$DEST/db_$ts.dump" $files || { LAST_ERROR="la copia local está bien, pero no se pudo copiar a la carpeta externa"; echo "[backup] ERROR: $LAST_ERROR"; }
  prune_old "$DEST"
  if [ -n "$files" ]; then size="$(du -h "$files" | cut -f1) archivos"; else size="archivos aparte (BACKUP_UPLOADS_TGZ=false)"; fi
  echo "[backup] copia $ts terminada: $(du -h "$DEST/db_$ts.dump" | cut -f1) base de datos, $size"
  save_status
  [ -z "$LAST_ERROR" ]
}

# --- Órdenes de la pantalla ---------------------------------------------------------------------------------
sql_text() { printf '%s' "$1" | sed "s/'/''/g"; }
finish_request() { # id, ok (true/false), mensaje fijo y legible, sin secretos
  psql_q -c "UPDATE backup_requests SET finished_at = now(), ok = $2, message = '$(sql_text "$3")' WHERE id = $1" >/dev/null 2>&1 || true
}

# Cambia la carpeta externa. Pone REQ_OK y REQ_MSG. Si algo falla, no cambia el ajuste ni borra nada.
do_destination() { # ruta relativa («» = carpeta clásica), mover (true/false)
  new="$1"; move="$2"; REQ_OK=false
  while [ "${new%/}" != "$new" ]; do new="${new%/}"; done
  if ! valid_path "$new"; then REQ_MSG="Ruta no válida: solo letras, números, espacios y . _ - / dentro de la carpeta de destinos"; return 0; fi
  if [ -n "${BACKUP_DESTINATION:-}" ]; then REQ_MSG="El destino está fijado con BACKUP_DESTINATION en el .env del servidor; quítalo de ahí para cambiarlo desde la pantalla"; return 0; fi
  from=$(offsite_dir)
  if [ -n "$new" ]; then
    to="$TARGETS/$new"
    scan_targets
    if ! grep -q '"available":true' "$DEST/.destinos.json" 2>/dev/null; then REQ_MSG="No hay carpetas de destino disponibles: define BACKUP_TARGETS_DIR en el .env del servidor y reinicia"; return 0; fi
    if [ ! -d "$to" ]; then
      # Solo se crea el último nivel: si falta la carpeta superior, probablemente el disco no está conectado.
      mkdir "$to" 2>/dev/null || { REQ_MSG="No se pudo crear la carpeta: la carpeta superior no existe o no se puede escribir"; return 0; }
    fi
  else
    to="$CLASSIC"
    [ -d "$to" ] || { REQ_MSG="La carpeta clásica de copias externas no está disponible"; return 0; }
  fi
  probe="$to/.prueba-escritura.$$"
  if ! { : > "$probe"; } 2>/dev/null; then REQ_MSG="La carpeta no admite escritura"; return 0; fi
  rm -f "$probe"
  same_dest=false; [ "$to" != "$from" ] || same_dest=true
  # Dos rutas distintas pueden ser la misma carpeta (enlace simbólico, otro montaje): mover ahí borraría las copias.
  if [ "$move" = "true" ] && [ "$same_dest" = "false" ] && [ -d "$from" ] && same_thing "$from" "$to"; then
    REQ_MSG="El origen y el destino son la misma carpeta (o no se pudo comprobar); no se movió nada"; return 0
  fi
  # Espacio: lo que se mueve, o al menos la última copia.
  if [ "$move" = "true" ] && [ "$same_dest" = "false" ] && [ -d "$from" ]; then
    list=$(backup_files "$from"); need=$(files_bytes "$list")
  else
    list=""
    last="$(ls -t "$DEST"/db_*.dump 2>/dev/null | head -n 1 || true) $(ls -t "$DEST"/uploads_*.tgz 2>/dev/null | head -n 1 || true)"
    need=$(files_bytes "$(printf '%s\n' $last)")
  fi
  free=$(df -Pk "$to" 2>/dev/null | awk 'NR == 2 { printf "%.0f", $4 * 1024 }' || true)
  free="${free:-0}"
  need=$(( need + need / 10 ))
  if [ "$free" -lt "$need" ]; then REQ_MSG="No hay espacio suficiente en el destino: libres $((free / 1048576)) MB, hacen falta $((need / 1048576)) MB"; return 0; fi
  # Llevar las copias existentes: copiar todo, comprobar y solo entonces (con el ajuste ya guardado) borrar lo antiguo.
  moved=0
  if [ "$move" = "true" ] && [ "$same_dest" = "false" ]; then
    [ -d "$from" ] || { REQ_MSG="La carpeta de origen no está disponible; no se movió nada (desmarca «llevar las copias existentes» para cambiar igual)"; return 0; }
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      name=$(basename "$f")
      if ! cp "$f" "$to/$name.tmp" 2>/dev/null || ! mv "$to/$name.tmp" "$to/$name" 2>/dev/null; then
        rm -f "$to/$name.tmp"; REQ_MSG="No se pudo copiar $name al destino; no se borró nada"; return 0
      fi
      if [ "$(stat -c %s "$f")" != "$(stat -c %s "$to/$name")" ] || ! cmp -s "$f" "$to/$name"; then
        REQ_MSG="La copia de $name no coincide con el original; no se borró nada"; return 0
      fi
      moved=$((moved + 1))
    done <<EOF
$list
EOF
  fi
  psql_q -c "INSERT INTO settings (key, value, updated_by) VALUES ('BACKUP_DESTINATION', to_jsonb('$new'::text), 'backup') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret = NULL, updated_at = now(), updated_by = 'backup'" >/dev/null 2>&1 \
    || { REQ_MSG="No se pudo guardar el destino en la base; no se borró nada"; return 0; }
  if [ "$moved" -gt 0 ]; then
    # Antes de cada borrado, el original y su copia no pueden ser el mismo archivo.
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      ! same_thing "$f" "$to/$(basename "$f")" || continue
      rm -f "$f"
    done <<EOF
$list
EOF
  fi
  DEST_REL="$new"; DEST_DEV_FOR="$new"; DEST_DEVICE=""
  [ -z "$new" ] || DEST_DEVICE=$(dev_of "$to")
  OFFSITE_ERROR=""
  if [ "$same_dest" = "true" ]; then REQ_MSG="Destino confirmado: ${new:-carpeta clásica}"; else REQ_MSG="Destino cambiado a ${new:-la carpeta clásica}. Copias movidas: $moved"; fi
  if [ -n "$new" ] && [ "$(dev_of "$to")" = "$(dev_of "$DEST")" ]; then REQ_MSG="$REQ_MSG. Aviso: está en el mismo disco que el servidor, no protege si el disco se pierde"; fi
  REQ_OK=true
  echo "[backup] $REQ_MSG"
}

# Borra una copia (base y archivos de esa fecha) de ./backups y de la carpeta externa. Pone REQ_OK y REQ_MSG.
# La más reciente no se borra: siempre queda al menos una. En B2 sigue hasta caducar (b2-sync copia, no sincroniza).
do_delete() { # AAAA-MM-DD_HHMM
  st="$1"; REQ_OK=false
  case "$st" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9]) ;;
    *) REQ_MSG="Copia no válida"; return 0 ;;
  esac
  newest=$(ls -t "$DEST"/db_????-??-??_????.dump 2>/dev/null | head -n 1 || true)
  if [ "$newest" = "$DEST/db_$st.dump" ]; then REQ_MSG="La copia más reciente no se puede borrar: siempre queda al menos una"; return 0; fi
  n=0
  for dir in "$DEST" "$(offsite_dir)"; do
    [ -d "$dir" ] || continue
    for f in "$dir/db_$st.dump" "$dir/db_$st.dump.enc" "$dir/db_$st.dump.fallida" "$dir/uploads_$st.tgz" "$dir/uploads_$st.tgz.enc"; do
      [ -f "$f" ] || continue
      rm -f "$f" && n=$((n + 1))
    done
  done
  if [ "$n" -eq 0 ]; then REQ_MSG="No se encontró la copia $st"; return 0; fi
  REQ_OK=true; REQ_MSG="Copia $st borrada ($n archivo(s)). En Backblaze B2 se conserva hasta caducar"
  echo "[backup] $REQ_MSG"
}

# Atiende las órdenes pendientes (máximo 5 por vuelta). La fila se toma con UPDATE … RETURNING para no repetirla.
process_requests() {
  # Una orden de copia que nadie atendió en 6 h ya no tiene sentido (el servicio estuvo parado): se cierra como caducada.
  psql_q -c "UPDATE backup_requests SET finished_at = now(), ok = false, message = 'Caducada: no se atendió en 6 horas' WHERE started_at IS NULL AND finished_at IS NULL AND created_at < now() - interval '6 hours'" >/dev/null 2>&1 || true
  n=0
  while [ "$n" -lt 5 ]; do
    n=$((n + 1))
    row=$(psql_q -F "$TAB" -c "UPDATE backup_requests SET started_at = now() WHERE id = (SELECT id FROM backup_requests WHERE started_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, kind, COALESCE(payload->>'path', ''), COALESCE(payload->>'moveExisting', 'false'), COALESCE(payload->>'stamp', '')" 2>/dev/null | head -n 1 || true)
    [ -n "$row" ] || return 0
    id=$(printf '%s' "$row" | cut -f1); kind=$(printf '%s' "$row" | cut -f2)
    rpath=$(printf '%s' "$row" | cut -f3); rmove=$(printf '%s' "$row" | cut -f4); rstamp=$(printf '%s' "$row" | cut -f5)
    is_uint "$id" || return 0
    case "$kind" in
      backup)
        echo "[backup] orden $id: copia ahora"
        if backup; then finish_request "$id" true "Copia terminada y verificada"
        else finish_request "$id" false "La copia no terminó bien: ${LAST_ERROR:-error desconocido}"; fi
        LAST_RUN=$(date +%s)
        ;;
      destination)
        echo "[backup] orden $id: cambiar destino"
        REQ_OK=false; REQ_MSG="Orden no procesada"
        do_destination "$rpath" "$rmove" || true
        finish_request "$id" "$REQ_OK" "$REQ_MSG"
        ;;
      delete)
        echo "[backup] orden $id: borrar la copia $rstamp"
        REQ_OK=false; REQ_MSG="Orden no procesada"
        do_delete "$rstamp" || true
        finish_request "$id" "$REQ_OK" "$REQ_MSG"
        ;;
      *) finish_request "$id" false "Tipo de orden desconocido" ;;
    esac
    save_status
  done
}

# Vuelta de mantenimiento (cada minuto): ajustes, destinos, estado del destino y órdenes.
tick() {
  load_settings
  # La lista de destinos se recalcula cada 5 min (find y df sobre discos externos cuestan); do_destination la refresca al llegar una orden.
  now_s=$(date +%s)
  if [ $(( now_s - LAST_SCAN )) -ge 300 ]; then scan_targets; LAST_SCAN=$now_s; fi
  if [ "$OFFSITE_ON" = "true" ]; then dest_check || true; else OFFSITE_ERROR=""; fi
  process_requests
}

# --- Programación -----------------------------------------------------------------------------------------
LAST_RUN=0
NEXT_EPOCH=0
schedule_next() {
  if [ -n "$AT" ]; then NEXT_EPOCH=$(( $(date +%s) + $(secs_until "$AT") ))
  else NEXT_EPOCH=$(( LAST_RUN + INTERVAL_HOURS * 3600 )); fi
  if [ "$NEXT_EPOCH" -gt 86400 ]; then NEXT_AT=$(date -Iseconds -d "@$NEXT_EPOCH" 2>/dev/null || true); else NEXT_AT=""; fi
}

if [ "${1:-}" = "--once" ]; then
  load_settings
  scan_targets
  backup
  exit $?
fi

# Esperar a que la base de datos acepte conexiones.
until pg_isready -h db -U rag_owner -d rag >/dev/null 2>&1; do sleep 2; done
# Una orden que quedó a medias por un reinicio se cierra como fallida; si no, la pantalla no dejaría pedir otra.
psql_q -c "UPDATE backup_requests SET finished_at = now(), ok = false, message = 'Interrumpida: el servicio de copias se reinició' WHERE started_at IS NOT NULL AND finished_at IS NULL" >/dev/null 2>&1 || true

load_settings
if [ -n "$AT" ]; then
  # Si el servidor no estaba en marcha a la hora fijada, la copia de ese día se hace ahora.
  if [ -z "$(find "$DEST" -maxdepth 1 -name 'db_*.dump' -mmin -1440 2>/dev/null)" ]; then
    echo "[backup] la última copia tiene más de 24 h (o no hay ninguna): se hace una ahora"
    backup || echo "[backup] ERROR en la copia (se reintentará a las $AT)"
    LAST_RUN=$(date +%s)
  fi
fi

SIG=""
while true; do
  tick || true
  new_sig="$AT|$INTERVAL_HOURS|$TZ_EFF"
  if [ "$new_sig" != "$SIG" ]; then
    SIG="$new_sig"; schedule_next
    if [ -n "$AT" ]; then echo "[backup] próxima copia a las $AT (hora local; ahora son $(TZ="$TZ_EFF" date +%H:%M)), dentro de $(( (NEXT_EPOCH - $(date +%s)) / 60 )) min"
    else echo "[backup] una copia cada $INTERVAL_HOURS h"; fi
  fi
  if [ "$(date +%s)" -ge "$NEXT_EPOCH" ]; then
    backup || echo "[backup] ERROR en la copia (se reintentará en el próximo ciclo)"
    LAST_RUN=$(date +%s)
    schedule_next
  fi
  save_status
  rem=$(( NEXT_EPOCH - $(date +%s) ))
  [ "$rem" -ge 1 ] || rem=1
  [ "$rem" -le 60 ] || rem=60
  sleep "$rem"
done
