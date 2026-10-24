#!/usr/bin/env bash
# =====================================================================
# Autoajuste de recursos: detecta el hardware (RAM, hilos, núcleos, swap) y los demás contenedores del servidor, y calcula
# cuánta CPU y memoria puede usar Omni RAG sin ahogar a los otros servicios. Si cambias de máquina, vuelve a ejecutarlo.
#
#   bash deploy/autotune.sh                          muestra la propuesta (no cambia nada)
#   bash deploy/autotune.sh --aplicar                la escribe en el .env (con copia en .env.bak-autotune)
#   bash deploy/autotune.sh --quitar                 borra el bloque del .env (vuelve a «sin límites»)
#   bash deploy/autotune.sh --simular=ram=8,hilos=4  qué haría con otro hardware (ram en GB; opciones: hilos, nucleos,
#                                                    swap en GB, otros en MB = memoria de los demás contenedores)
#   --compartido | --dedicado                        fuerza el modo (por defecto: «compartido» si hay otros contenedores)
#   --sin-reranker                                   si no cabe con re-ranker, lo desactiva (por defecto solo avisa)
#
# Lo que calcula (se aplica con «docker compose up -d»):
#   - CPU y memoria máximas del re-ranker, los embeddings y Docling. Limitar la CPU también reduce la memoria del modelo
#     (~0,2 GB por hilo) y, pasados los núcleos reales, casi no cuesta velocidad (medido: re-ranker de 20 fragmentos,
#     2 CPU 2,4 s · 4 CPU 2,0 s · 6 CPU 1,85 s · sin límite con 8 hilos 2,15 s).
#   - Pesos de CPU: bajo contención, la ingesta de documentos cede a las búsquedas, y Omni RAG cede a los demás servicios.
#   - Docling con prioridad alta de cierre: si falta memoria, se cierra él antes que los modelos u otros contenedores.
# No lee ni muestra el contenido del .env: solo escribe (o quita) su bloque entre marcas. No cambia el sistema: el swap y
# el «swappiness» solo se recomiendan, con los comandos.
# =====================================================================
set -eu
cd "$(dirname "$0")/.."

START="# >>> autotune"
END="# <<< autotune"
OS_RESERVE_MB=1024    # sistema operativo y Docker
SAFETY_PCT=10         # margen de seguridad sobre la RAM total
OTHERS_HEADROOM=125   # los demás contenedores fluctúan: se les reserva un 25 % más de lo medido

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

APPLY=0; REMOVE=0; SIM=""; MODE=""; NO_RERANKER=0
for a in "$@"; do
  case "$a" in
    --aplicar) APPLY=1 ;;
    --quitar) REMOVE=1 ;;
    --compartido) MODE=compartido ;;
    --dedicado) MODE=dedicado ;;
    --sin-reranker) NO_RERANKER=1 ;;
    --simular=*) SIM="${a#--simular=}" ;;
    -h | --help | --ayuda) usage; exit 0 ;;
    *) echo "Opción desconocida: $a"; usage; exit 1 ;;
  esac
done

strip_block() { awk -v s="$START" -v e="$END" 'index($0, s) == 1 {skip=1} !skip {print} index($0, e) == 1 {skip=0}' .env; }

if [ "$REMOVE" = 1 ]; then
  [ -f .env ] || { echo "No hay .env."; exit 1; }
  grep -q "^$START" .env || { echo "El .env no tiene bloque de autoajuste."; exit 0; }
  cp .env .env.bak-autotune
  tmp=$(mktemp); strip_block > "$tmp"; cat "$tmp" > .env; rm -f "$tmp"
  echo "Bloque de autoajuste quitado (copia anterior en .env.bak-autotune). Aplica con: docker compose up -d"
  exit 0
fi

# ---------------------------------------------------------------- detección (o simulación)
meminfo_mb() { awk -v k="$1:" '$1 == k {printf "%d", $2 / 1024}' /proc/meminfo; }
clamp() { local v=$1 lo=$2 hi=$3; [ "$v" -lt "$lo" ] && v=$lo; [ "$v" -gt "$hi" ] && v=$hi; echo "$v"; }

SWAPPINESS=""; OTHERS_COUNT=0; OTHERS_MB=0
if [ -n "$SIM" ]; then
  RAM_MB=0; THREADS=0; CORES=0; SWAP_MB=0
  IFS=',' read -ra pairs <<< "$SIM"
  for p in "${pairs[@]}"; do
    k=${p%%=*}; v=${p#*=}
    case "$k" in
      ram) RAM_MB=$((v * 1024)) ;;
      hilos) THREADS=$v ;;
      nucleos) CORES=$v ;;
      swap) SWAP_MB=$((v * 1024)) ;;
      otros) OTHERS_MB=$v; [ "$v" -gt 0 ] && OTHERS_COUNT=1 ;;
      *) echo "Parámetro de --simular desconocido: $k (usa ram, hilos, nucleos, swap, otros)"; exit 1 ;;
    esac
  done
  [ "$RAM_MB" -gt 0 ] && [ "$THREADS" -gt 0 ] || { echo "--simular necesita al menos ram=GB e hilos=N"; exit 1; }
  [ "$CORES" -gt 0 ] || CORES=$THREADS
  SOURCE="simulado"
else
  SOURCE="detectado"
  RAM_MB=$(meminfo_mb MemTotal); SWAP_MB=$(meminfo_mb SwapTotal)
  THREADS=$(nproc)
  CORES=$(LC_ALL=C lscpu 2>/dev/null | awk -F: '/^Core\(s\) per socket/ {c = $2 + 0} /^Socket\(s\)/ {s = $2 + 0} END {if (c * s > 0) print c * s}')
  CORES=${CORES:-$THREADS}
  [ -r /proc/sys/vm/swappiness ] && SWAPPINESS=$(cat /proc/sys/vm/swappiness)
  if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
    d_mb=$(($(docker info --format '{{.MemTotal}}') / 1048576)); [ "$d_mb" -gt 0 ] && [ "$d_mb" -lt "$RAM_MB" ] && RAM_MB=$d_mb
    d_cpu=$(docker info --format '{{.NCPU}}'); [ "$d_cpu" -gt 0 ] && [ "$d_cpu" -lt "$THREADS" ] && THREADS=$d_cpu
    [ "$CORES" -gt "$THREADS" ] && CORES=$THREADS
    # Memoria de los contenedores que NO son de este proyecto (docker stats no cuenta la caché de archivos).
    own=$(docker compose ps -aq 2> /dev/null | cut -c1-12 | tr '\n' ' ')
    read -r OTHERS_COUNT OTHERS_MB < <(docker stats --no-stream --format '{{.ID}}|{{.MemUsage}}' 2> /dev/null | awk -F'|' -v own="$own" '
      function mb(s,   n, u) { n = s + 0; u = s; gsub(/[0-9.]/, "", u)
        if (u == "GiB") return n * 1024; if (u == "MiB") return n; if (u == "KiB") return n / 1024
        if (u == "GB") return n * 953.67; if (u == "MB") return n * 0.9537; if (u == "kB") return n / 1048.6; return n / 1048576 }
      index(own, $1) == 0 { split($2, a, " / "); c++; t += mb(a[1]) }
      END { printf "%d %d\n", c, t }') || true
    OTHERS_COUNT=${OTHERS_COUNT:-0}; OTHERS_MB=${OTHERS_MB:-0}
  fi
fi
[ -n "$MODE" ] || { [ "$OTHERS_COUNT" -gt 0 ] && MODE=compartido || MODE=dedicado; }

# ---------------------------------------------------------------- presupuesto de memoria de Omni RAG
SAFETY_MB=$((RAM_MB * SAFETY_PCT / 100))
OTHERS_EFF=0; [ "$MODE" = compartido ] && OTHERS_EFF=$((OTHERS_MB * OTHERS_HEADROOM / 100))
BUDGET_MB=$((RAM_MB - OS_RESERVE_MB - SAFETY_MB - OTHERS_EFF))

# ---------------------------------------------------------------- CPU deseada
if [ "$THREADS" -le 2 ]; then
  RR=$THREADS; DOC=$THREADS                                   # no hay nada que reservar
elif [ "$MODE" = compartido ]; then
  RR=$(clamp $(((CORES * 67 + 50) / 100)) 2 6); DOC=$(clamp $(((CORES * 50 + 50) / 100)) 1 4)
else
  RR=$(clamp "$CORES" 2 6); DOC=$(clamp "$CORES" 1 6)
fi
[ "$RR" -gt "$THREADS" ] && RR=$THREADS
EMB=$RR

# ---------------------------------------------------------------- reparto de la memoria, por prioridad
# Primero los modelos de búsqueda (lo que el usuario nota al preguntar) y la base de datos; a Docling, lo que sobre.
# Memoria medida: re-ranker ≈ 950 + 205 MB por CPU · embeddings ≈ 1550 + 215 MB por CPU · resto ≈ 650 MB.
WORKERS=1
DOC_MIN=1500; DOC_GOOD=2500; DOC_MAX=3800   # Docling: mínimo viable · cómodo (la mayoría de PDF) · pico con un PDF de 30 páginas con tablas
FIXED_MB=650                                 # base de datos, API, worker, web y copias
models_mb() { local rr=$((950 + 205 * RR)); [ "$NO_RERANKER" = 1 ] && rr=0; echo $((rr + 1550 + 215 * EMB + FIXED_MB)); }
# Si Docling no tiene un margen cómodo, se baja primero la CPU de los embeddings (solo importa al ingerir) y después la del re-ranker.
while [ $((BUDGET_MB - $(models_mb))) -lt "$DOC_GOOD" ]; do
  if [ "$EMB" -gt 2 ]; then EMB=$((EMB - 1))
  elif [ "$RR" -gt 3 ]; then RR=$((RR - 1))
  elif [ "$EMB" -gt 1 ]; then EMB=$((EMB - 1))
  elif [ "$RR" -gt 2 ]; then RR=$((RR - 1))
  else break; fi
done
MODELS_MB=$(models_mb); ROOM_MB=$((BUDGET_MB - MODELS_MB))
FITS=1; [ "$ROOM_MB" -lt "$DOC_MIN" ] && FITS=0
# Con la máquina para Omni RAG, núcleos de sobra y memoria para dos conversiones cómodas, Docling procesa dos documentos a la vez.
if [ "$MODE" = dedicado ] && [ "$CORES" -ge 8 ] && [ "$ROOM_MB" -ge $((2 * DOC_GOOD)) ]; then WORKERS=2; DOC_CAP=$((2 * DOC_MAX)); else DOC_CAP=$DOC_MAX; fi
DOC_LIMIT=$(clamp "$ROOM_MB" "$DOC_MIN" "$DOC_CAP")

RR_MB=$((950 + 205 * RR)); EMB_MB=$((1550 + 215 * EMB))
RR_LIMIT=$((RR_MB * 14 / 10)); EMB_LIMIT=$((EMB_MB * 14 / 10))
if [ "$MODE" = compartido ]; then SEARCH_SHARES=512; INGEST_SHARES=256; else SEARCH_SHARES=2048; INGEST_SHARES=512; fi
if [ "$THREADS" -le 4 ]; then WORKER_CONC=1; else WORKER_CONC=2; fi

# ---------------------------------------------------------------- informe
echo "== Hardware ($SOURCE) =="
printf "  RAM ........ %s MB · swap %s MB%s\n" "$RAM_MB" "$SWAP_MB" "${SWAPPINESS:+ (swappiness $SWAPPINESS)}"
printf "  CPU ........ %s hilos · %s núcleos\n" "$THREADS" "$CORES"
if [ "$MODE" = compartido ]; then
  printf "  Otros ...... %s contenedores usando %s MB  → modo COMPARTIDO (se les deja margen)\n" "$OTHERS_COUNT" "$OTHERS_MB"
else
  echo "  Otros ...... ninguno  → modo DEDICADO"
fi
echo
echo "== Presupuesto de memoria para Omni RAG =="
printf "  %s (RAM) - %s (sistema) - %s (margen %s%%)" "$RAM_MB" "$OS_RESERVE_MB" "$SAFETY_MB" "$SAFETY_PCT"
[ "$MODE" = compartido ] && printf " - %s (otros +25%%)" "$OTHERS_EFF"
printf " = %s MB\n" "$BUDGET_MB"
printf "  Reparto: re-ranker %s MB (%s CPU) · embeddings %s MB (%s CPU) · base de datos y resto %s MB · Docling hasta %s MB\n" \
  "$([ "$NO_RERANKER" = 1 ] && echo 0 || echo "$RR_MB")" "$([ "$NO_RERANKER" = 1 ] && echo 0 || echo "$RR")" "$EMB_MB" "$EMB" "$FIXED_MB" "$DOC_LIMIT"
printf "  → %s\n" "$([ "$FITS" = 1 ] && echo "CABE" || echo "NO CABE: faltan $((DOC_MIN - ROOM_MB)) MB para el mínimo de Docling (${DOC_MIN} MB)")"
echo
BLOCK="$START (generado por deploy/autotune.sh el $(date +%F) · RAM ${RAM_MB} MB, ${THREADS} hilos / ${CORES} núcleos, modo ${MODE})
RERANKER_CPUS=$RR
RERANKER_CPU_SHARES=$SEARCH_SHARES
RERANKER_MEM_LIMIT=${RR_LIMIT}m
EMBEDDINGS_CPUS=$EMB
EMBEDDINGS_CPU_SHARES=$SEARCH_SHARES
EMBEDDINGS_MEM_LIMIT=${EMB_LIMIT}m
DOCLING_CPUS=$DOC
DOCLING_CPU_SHARES=$INGEST_SHARES
DOCLING_MEM_LIMIT=${DOC_LIMIT}m
DOCLING_OOM_SCORE_ADJ=500
DOCLING_WORKERS=$WORKERS
WORKER_CONCURRENCY=$WORKER_CONC
WORKER_CPU_SHARES=$INGEST_SHARES"
if [ "$NO_RERANKER" = 1 ]; then BLOCK="$BLOCK
RERANKER_URL=
RERANKER_REPLICAS=0"; fi
BLOCK="$BLOCK
$END"
echo "== Propuesta (bloque del .env) =="
echo "$BLOCK" | sed 's/^/  /'
echo

# ---------------------------------------------------------------- avisos
WARN=0
if [ "$FITS" = 0 ]; then
  WARN=1
  echo "AVISO: Omni RAG no cabe en el presupuesto, ni con la CPU mínima de los modelos: el pico de un PDF podría dejar sin memoria"
  echo "       al servidor. Opciones: más RAM; liberar memoria de otros servicios; o --sin-reranker (menos calidad de búsqueda,"
  echo "       libera ~1,4 GB y la CPU que más consume)."
elif [ "$DOC_LIMIT" -lt 2900 ]; then
  WARN=1
  echo "AVISO: Docling queda limitado a $DOC_LIMIT MB. Un PDF muy grande (30 páginas con tablas llega a ~2.900 MB) puede superarlo: se"
  echo "       reinicia solo Docling (no el resto) y ese documento falla. Súbelos en tandas o amplía la RAM. El swap ayuda."
fi
if [ "$SWAP_MB" -lt 2048 ] && [ -z "$SIM" ]; then
  WARN=1
  echo "AVISO: casi no hay swap ($SWAP_MB MB). Con poca RAM, los picos de Docling pueden cerrar procesos. Para crear 4 GB:"
  echo "       sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
  echo "       echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab"
fi
if [ -n "$SWAPPINESS" ] && [ "$SWAPPINESS" -gt 20 ]; then
  WARN=1
  echo "AVISO: swappiness=$SWAPPINESS manda a swap los modelos inactivos y la primera búsqueda tras un rato se vuelve lenta. Recomendado 10:"
  echo "       echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system"
fi
if [ "$THREADS" -le 2 ]; then
  WARN=1
  echo "AVISO: con 2 hilos o menos no se puede reservar CPU para otros servicios; las búsquedas con re-ranker serán lentas."
fi
[ "$WARN" = 1 ] && echo

# ---------------------------------------------------------------- aplicar
if [ "$APPLY" = 1 ]; then
  [ -f .env ] || { echo "No existe .env (cópialo de .env.example primero)."; exit 1; }
  cp .env .env.bak-autotune
  tmp=$(mktemp); strip_block > "$tmp"; [ -n "$(tail -c1 "$tmp")" ] && echo >> "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"
  printf '%s\n' "$BLOCK" >> .env
  echo "Escrito en .env (copia anterior en .env.bak-autotune; contiene tus secretos, bórrala si no la necesitas)."
  echo "Las variables de este bloque ganan sobre las mismas escritas antes en el .env. Aplica con:  docker compose up -d"
else
  echo "Esto es solo la propuesta. Para escribirla en el .env:  bash deploy/autotune.sh --aplicar"
fi
