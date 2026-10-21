#!/bin/sh
# =====================================================================
# Sincroniza la contraseña del rol `rag_owner` de PostgreSQL con POSTGRES_PASSWORD.
#
# La base de datos guarda la contraseña con la que se CREÓ el volumen; cambiar
# POSTGRES_PASSWORD en el .env después no la actualiza y la API deja de conectar
# («password authentication failed»). Este script la iguala a la del .env.
#
# Se ejecuta dentro del contenedor `db` (no muestra ni guarda la contraseña):
#   docker compose up -d db
#   docker compose exec -T db sh < deploy/sync-db-password.sh
#   docker compose up -d api worker backup
# =====================================================================
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD" -U rag_owner -d rag <<'SQL'
ALTER ROLE rag_owner PASSWORD :'pw';
SQL
echo "rag_owner sincronizado con POSTGRES_PASSWORD. Ahora: docker compose up -d api worker backup"
