#!/bin/sh
# =====================================================================
# Construye las imágenes con la red del servidor y levanta todo.
# Úsalo cuando «docker compose up -d --build» falla con EAI_AGAIN (no resuelve registry.npmjs.org):
# pasa si el DNS del servidor es solo IPv6, porque la red de build por defecto de Docker no lo alcanza.
# «build: network: host» en el compose no sirve: compose lo ejecuta con buildx bake, que exige un permiso
# (--allow=network.host) que no puede pasar. «docker build --network host» no lo necesita.
#
#   sh deploy/build.sh
#
# Las imágenes se llaman rag-api, rag-worker y rag-web (proyecto de Docker «rag»); al existir ya,
# «docker compose up -d» no vuelve a construirlas. El worker usa el mismo Dockerfile que la API.
#
# Para enlaces lentos usa descargas de pnpm más prudentes (menos en paralelo, más reintentos). Se pueden cambiar:
#   PNPM_NETWORK_CONCURRENCY=8 PNPM_FETCH_RETRIES=4 sh deploy/build.sh
# =====================================================================
set -eu
cd "$(dirname "$0")/.."

PNPM_NETWORK_CONCURRENCY="${PNPM_NETWORK_CONCURRENCY:-4}"
PNPM_FETCH_RETRIES="${PNPM_FETCH_RETRIES:-8}"

# Aviso temprano: sin DNS el build se queda minutos reintentando antes de fallar.
if command -v getent >/dev/null 2>&1 && ! getent hosts registry.npmjs.org >/dev/null 2>&1; then
  echo "AVISO: este servidor no resuelve registry.npmjs.org; el build fallará con EAI_AGAIN." >&2
  echo "       Fija un DNS por IPv4 en el servidor (docs/instalacion.md → «Si el build falla con EAI_AGAIN»)." >&2
fi

ARGS="--build-arg PNPM_NETWORK_CONCURRENCY=$PNPM_NETWORK_CONCURRENCY --build-arg PNPM_FETCH_RETRIES=$PNPM_FETCH_RETRIES"

# shellcheck disable=SC2086
docker build --network host $ARGS -f apps/api/Dockerfile -t rag-api .
docker tag rag-api rag-worker
# shellcheck disable=SC2086
docker build --network host $ARGS -f apps/web/Dockerfile -t rag-web .

docker compose up -d
