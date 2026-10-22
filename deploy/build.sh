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
# =====================================================================
set -eu
cd "$(dirname "$0")/.."

docker build --network host -f apps/api/Dockerfile -t rag-api .
docker tag rag-api rag-worker
docker build --network host -f apps/web/Dockerfile -t rag-web .

docker compose up -d
