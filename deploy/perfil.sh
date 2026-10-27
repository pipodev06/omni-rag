#!/usr/bin/env bash
# =====================================================================
# Aplica un perfil de tamaño (deploy/perfiles/<nombre>.env) al .env: un bloque entre las marcas «# >>> perfil» y
# «# <<< perfil». Ejecutarlo otra vez lo sustituye; las variables del bloque ganan sobre las mismas escritas antes.
#
#   bash deploy/perfil.sh pequeno   2 vCPU ·  6 GB
#   bash deploy/perfil.sh mediano   4 vCPU ·  8 GB
#   bash deploy/perfil.sh grande    6 vCPU · 16 GB
#   bash deploy/perfil.sh quitar    borra el bloque (vuelve a los valores por defecto)
#
# Después: docker compose up -d. No lee ni muestra el contenido del .env. Si compartes el servidor con otros servicios,
# mira deploy/autotune.sh, que además descuenta lo que ellos usan.
# =====================================================================
set -eu
cd "$(dirname "$0")/.."

START="# >>> perfil"
END="# <<< perfil"
name="${1:-}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
strip_block() { awk -v s="$START" -v e="$END" 'index($0, s) == 1 {skip=1} !skip {print} index($0, e) == 1 {skip=0}' .env; }

case "$name" in
  pequeno | mediano | grande | quitar) ;;
  -h | --help | --ayuda) usage; exit 0 ;;
  *) usage; exit 1 ;;
esac
[ -f .env ] || { echo "No hay .env: cópialo antes con  cp .env.example .env"; exit 1; }

cp .env .env.bak-perfil
tmp=$(mktemp)
strip_block > "$tmp"
if [ "$name" != quitar ]; then
  { cat "$tmp"; echo "$START ($name)"; cat "deploy/perfiles/$name.env"; echo "$END"; } > .env
  echo "Perfil «$name» escrito en .env (copia anterior en .env.bak-perfil; contiene tus secretos, bórrala si no la necesitas)."
else
  cat "$tmp" > .env
  echo "Perfil quitado de .env (copia anterior en .env.bak-perfil)."
fi
rm -f "$tmp"
echo "Aplica con: docker compose up -d"
