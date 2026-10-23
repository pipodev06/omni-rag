#!/bin/sh
# =====================================================================
# Rota las contraseñas de la base de datos (POSTGRES_PASSWORD y APP_DB_PASSWORD) sin pasos manuales.
#
#   sh deploy/rotate-db-password.sh            # rota las dos
#   sh deploy/rotate-db-password.sh --dry-run  # solo muestra qué haría, sin tocar nada
#
# Qué hace, en orden:
#   1. Guarda una copia del .env (.env.bak-FECHA, solo legible por ti).
#   2. Genera contraseñas nuevas al azar (48 caracteres hexadecimales: sin símbolos que den problemas).
#   3. Cambia la contraseña del rol rag_owner dentro de la base de datos (por la entrada estándar: no aparece
#      en la lista de procesos ni en el historial).
#   4. Escribe las nuevas en el .env y recrea los servicios (docker compose up -d). La API aplica sola la de rag_app.
#   5. Espera a que /api/health responda. Si no responde, VUELVE ATRÁS: restaura el .env y la contraseña anterior.
# Nunca imprime las contraseñas. Cuando compruebes que todo funciona, borra el respaldo del .env (contiene las
# contraseñas anteriores): rm .env.bak-*
# =====================================================================
set -eu

cd "${RAG_DIR:-$(dirname "$0")/..}"
ENV_FILE=".env"
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

[ -f "$ENV_FILE" ] || { echo "No encuentro $ENV_FILE en $(pwd). Ejecuta el script desde la carpeta del proyecto."; exit 1; }
docker compose ps -q --status running db 2>/dev/null | grep -q . || { echo "El contenedor db no está en marcha: docker compose up -d db"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "Falta openssl para generar contraseñas aleatorias."; exit 1; }

# Lee una variable del .env sin mostrarla (quita comillas si las tiene).
getvar() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^["'"'"']//; s/["'"'"']$//'; }
setvar() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
# Cambia la contraseña del rol dueño dentro de la base; la contraseña viaja por stdin.
set_owner_password() { printf "ALTER ROLE rag_owner PASSWORD '%s';\n" "$1" | docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U rag_owner -d rag >/dev/null; }
healthy() {
  i=0
  while [ "$i" -lt "${HEALTH_RETRIES:-40}" ]; do
    docker compose exec -T -e HEALTH_URL="${HEALTH_URL:-}" api node -e "fetch(process.env.HEALTH_URL||'http://localhost:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 3
  done
  return 1
}

OLD_OWNER=$(getvar POSTGRES_PASSWORD)
[ -n "$OLD_OWNER" ] || { echo "POSTGRES_PASSWORD no está en el .env: no sé con qué contraseña está creada la base."; exit 1; }
NEW_OWNER=$(openssl rand -hex 24)
NEW_APP=$(openssl rand -hex 24)

if $DRY_RUN; then
  echo "[simulacro] Copiaría $ENV_FILE a $ENV_FILE.bak-<fecha>"
  echo "[simulacro] Cambiaría la contraseña de rag_owner en la base y POSTGRES_PASSWORD / APP_DB_PASSWORD en el .env (48 caracteres hexadecimales nuevos)"
  echo "[simulacro] Recrearía los servicios con «docker compose up -d» y esperaría a /api/health; si falla, volvería atrás."
  exit 0
fi

BACKUP="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP" && chmod 600 "$BACKUP"
echo "Copia del .env guardada en $BACKUP"

rollback() {
  echo "ERROR: la API no respondió con las contraseñas nuevas. Volviendo atrás…"
  cp "$BACKUP" "$ENV_FILE"
  set_owner_password "$OLD_OWNER" || echo "AVISO: no pude restaurar la contraseña anterior de rag_owner; usa deploy/sync-db-password.sh."
  docker compose up -d >/dev/null 2>&1 || true
  echo "Se restauró el .env y la contraseña anterior. Revisa: docker compose logs api"
  exit 1
}

set_owner_password "$NEW_OWNER"
setvar POSTGRES_PASSWORD "$NEW_OWNER"
setvar APP_DB_PASSWORD "$NEW_APP"
echo "Contraseñas cambiadas. Recreando servicios…"
docker compose up -d >/dev/null 2>&1 || rollback
healthy || rollback

echo "Listo: POSTGRES_PASSWORD y APP_DB_PASSWORD rotadas y la API responde."
echo "Cuando confirmes que todo funciona, borra el respaldo (tiene las contraseñas anteriores): rm $BACKUP"
