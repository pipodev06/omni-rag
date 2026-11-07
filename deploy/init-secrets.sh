#!/bin/sh
# =====================================================================
# Primer arranque: genera las contraseñas internas de la base (rag_owner y rag_app), la clave de las sesiones
# (JWT_SECRET) y la frase que cifra las copias externas y las de Backblaze B2 (backup_passphrase) si aún no existen, para que Omni RAG arranque sin archivo de entorno. Lo ejecuta el servicio db justo
# antes de iniciar PostgreSQL (los demás servicios esperan a que la base esté lista); si los archivos ya están, no
# cambia nada. Una variable escrita en el archivo de entorno siempre manda sobre ellos.
#
# Se guardan en ./data/secretos. No van en las copias de seguridad:
# guarda esa carpeta (o sus valores) en un lugar seguro, porque sin JWT_SECRET no se pueden leer las claves de API
# guardadas en la pantalla ni el 2FA de los usuarios, y sin backup_passphrase no se abren las copias cifradas (en
# Sistema → Copias se puede ver para guardarla en un gestor de contraseñas).
# =====================================================================
set -eu
umask 077
DIR="${SECRETS_DIR:-/secrets}"
for f in postgres_password app_db_password jwt_secret backup_passphrase; do
  [ ! -s "$DIR/$f" ] || continue
  # 32 bytes al azar en hexadecimal: 64 caracteres, sin símbolos que rompan una URL.
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$DIR/$f.tmp"
  [ "$(wc -c < "$DIR/$f.tmp")" -eq 64 ] || { rm -f "$DIR/$f.tmp"; echo "[init] no se pudo generar $f" >&2; exit 1; }
  mv "$DIR/$f.tmp" "$DIR/$f"
  echo "[init] generado $f"
done
# Los leen la API y el worker (usuario node, 1000); db y backup los leen como root.
chown 1000:1000 "$DIR/postgres_password" "$DIR/app_db_password" "$DIR/jwt_secret" "$DIR/backup_passphrase" 2>/dev/null || true
chmod 0400 "$DIR/postgres_password" "$DIR/app_db_password" "$DIR/jwt_secret" "$DIR/backup_passphrase"
echo "[init] secretos listos"

# Carpetas de ./data que escribe el usuario node (archivos subidos, ajustes de copias): Docker las crea como root al
# montarlas por primera vez. Solo se cambia la carpeta de arriba, y solo si no es ya de node (no recorre los archivos).
for d in /prepare/*; do
  [ -d "$d" ] || continue
  [ "$(stat -c %u "$d")" = 1000 ] || { chown 1000:1000 "$d" && echo "[init] $(basename "$d"): dueño node"; }
done
