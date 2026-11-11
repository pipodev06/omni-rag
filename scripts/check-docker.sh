#!/usr/bin/env bash
# Verifica los compose de un proyecto con salida mínima. Uso: scripts/check-docker.sh <carpeta> [--fast]
#   Valida cada docker-compose*.yml / compose*.yml con `docker compose config -q`.
#   Avisa (no falla) si un servicio publica un puerto fuera de 127.0.0.1: en el homelab los servicios
#   entran por la red externa del proxy y no publican puertos.
#   --fast no cambia nada: es rápido de por sí (se acepta para que todos los check-* se llamen igual).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/_check-lib.sh"
DIR="${1:?uso: $0 <carpeta> [--fast]}"
cd "$ROOT/$DIR" || exit 2
NAME="${DIR//\//-}"; [ "$DIR" = . ] && NAME=app   # apps/api → apps-api: el log va directo en .check/

if ! command -v docker >/dev/null 2>&1; then
  echo "AVISO docker no está instalado: no se validaron los compose"; finish
fi

# El principal se valida solo; los parciales (override, ejemplos) se combinan con él, como los usa Docker.
MAIN=""
for m in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do [ -f "$m" ] && { MAIN="$m"; break; }; done
found=0
for f in docker-compose*.yml docker-compose*.yaml compose*.yml compose*.yaml; do
  [ -f "$f" ] || continue
  found=1
  base="${f%.*}"
  if [ -n "$MAIN" ] && [ "$f" != "$MAIN" ]; then
    step "$NAME-$base" 15 -- docker compose -f "$MAIN" -f "$f" config -q
    continue
  fi
  step "$NAME-$base" 15 -- docker compose -f "$f" config -q
  # Puertos publicados fuera de 127.0.0.1 (sobre la config normalizada).
  docker compose -f "$f" config 2>/dev/null | awk -v f="$f" '
    /^  [A-Za-z0-9_.-]+:$/ && svc_block { svc=$1; sub(":","",svc) }
    /^services:$/ { svc_block=1; next }
    /^[A-Za-z]/ && !/^services:$/ { svc_block=0 }
    /^ +- (mode|target|host_ip|published|protocol):/ { host="" }
    /host_ip:/ { host=$2 }
    /published:/ { if (host != "127.0.0.1") printf "AVISO %s: el servicio %s publica el puerto %s fuera de 127.0.0.1 (¿debería ir por la red del proxy?)\n", f, svc, $2 }
  '
done
[ "$found" -eq 0 ] && echo "AVISO no hay archivos compose en $DIR"
finish
