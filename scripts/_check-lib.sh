# Biblioteca común de los scripts check-*: salida MÍNIMA, log completo en .check/ (ahorra tokens).
# Uso dentro de un script: step <nombre> <max_lineas_si_falla> -- comando...   y al final: finish
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/.check"
FAILED=0

step() {
  local name="$1" max="$2"; shift 3
  local log="$ROOT/.check/$name.log" t0=$SECONDS
  if "$@" >"$log" 2>&1; then
    echo "OK   $name ($((SECONDS - t0))s)"
  else
    FAILED=1
    echo "FAIL $name ($((SECONDS - t0))s) -> .check/$name.log"
    grep -v '^\s*$' "$log" | grep -iE 'error|fail|panic' | head -n "$max"
  fi
}

# Avisa si hubo tests saltados en el log indicado (tests de BD sin su variable se saltan en silencio).
warn_skips() {
  local log="$ROOT/.check/$1.log" n
  n="$(grep -ciE -- '--- SKIP|skipped|\bskip\b' "$log" 2>/dev/null || true)"
  [ "${n:-0}" -gt 0 ] && echo "AVISO $1: $n lineas con tests saltados; revisa .check/$1.log (¿falta la variable de la BD de test?)"
  return 0
}

finish() {
  [ "$FAILED" -eq 0 ] && echo "RESULTADO: OK" || echo "RESULTADO: FALLO"
  exit "$FAILED"
}
