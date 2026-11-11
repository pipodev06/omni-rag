#!/usr/bin/env bash
# Verifica un paquete Node (web o API) con salida mínima. Uso: scripts/check-node.sh <carpeta|.> [--fast]
#   --fast  fase de desarrollo: typecheck + lint, sin tests ni build
# Corre los scripts que existan en package.json: typecheck, lint, test, build.
# Sin script "typecheck" pero con tsconfig.json, corre `tsc --noEmit` (vite build NO revisa tipos).
set -u
source "$(dirname "${BASH_SOURCE[0]}")/_check-lib.sh"
DIR="${1:?uso: $0 <carpeta|.> [--fast]}"
FAST=0; [ "${2:-}" = "--fast" ] && FAST=1
cd "$ROOT/$DIR" || exit 2
NAME="${DIR//\//-}"; [ "$DIR" = . ] && NAME=app   # apps/api → apps-api: el log va directo en .check/
# En un monorepo el lockfile está en la raíz, no en la carpeta del paquete.
PM=npm; { [ -f pnpm-lock.yaml ] || [ -f "$ROOT/pnpm-lock.yaml" ]; } && PM=pnpm
has() { node -e "const s=require('./package.json').scripts||{}; process.exit(s[process.argv[1]]?0:1)" "$1"; }
for s in typecheck lint test build; do
  if [ "$FAST" -eq 1 ] && { [ "$s" = build ] || [ "$s" = test ]; }; then continue; fi
  if has "$s"; then
    step "$NAME-$s" 25 -- $PM run "$s"
  elif [ "$s" = typecheck ] && [ -f tsconfig.json ]; then
    # Con "references" (plantilla Vite moderna) hace falta -b; sin ellas, -p evita dejar un .tsbuildinfo suelto.
    if grep -q '"references"' tsconfig.json; then TSC="tsc -b"; else TSC="tsc -p tsconfig.json --noEmit"; fi
    # npm exec se queda con flags como -p (--package) si no van tras "--".
    if [ "$PM" = npm ]; then step "$NAME-typecheck" 25 -- npm exec -- $TSC; else step "$NAME-typecheck" 25 -- $PM exec $TSC; fi
  else
    echo "--   $NAME-$s (no hay script)"
  fi
done
[ "$FAST" -eq 0 ] && warn_skips "$NAME-test"
finish
