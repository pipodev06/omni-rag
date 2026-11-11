#!/bin/sh
# Al arrancar el contenedor web (lo ejecuta el entrypoint de la imagen oficial de nginx desde /docker-entrypoint.d/):
# genera la lista de proxies de confianza a partir de REAL_IP_FROM (IPs o rangos CIDR separados por espacios o comas).
# Solo desde esas direcciones se aceptan X-Forwarded-For (IP del cliente) y X-Forwarded-Proto (http/https).
# Vacía = las redes privadas (Caddy, Nginx Proxy Manager o el túnel de Cloudflare en el mismo servidor).
set -eu
DEFAULT="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1 ::1 fc00::/7"
LIST=$(printf '%s' "${REAL_IP_FROM:-}" | tr ',' ' ')
[ -n "$(printf '%s' "$LIST" | tr -d ' ')" ] || LIST="$DEFAULT"

SERVER=/etc/nginx/real-ip.conf     # set_real_ip_from (dentro de server)
GEO=/etc/nginx/trusted-proxies.geo # entradas del bloque geo (desde un proxy de confianza = 1)
: >"$SERVER"
: >"$GEO"
n=0
for ip in $LIST; do
  # IPv4 o IPv6 con máscara opcional; cualquier otra cosa se ignora (no se mete texto libre en la configuración).
  if printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)(/[0-9]{1,3})?$'; then
    echo "set_real_ip_from $ip;" >>"$SERVER"
    echo "$ip 1;" >>"$GEO"
    n=$((n + 1))
  else
    echo "real-ip: se ignora «$ip» de REAL_IP_FROM (no es una IP ni un rango CIDR)" >&2
  fi
done
if [ -n "$(printf '%s' "${REAL_IP_FROM:-}" | tr -d ' ,')" ] && [ "$n" -eq 0 ]; then
  echo "real-ip: REAL_IP_FROM no tiene ninguna IP ni rango válido: corrígelo o déjalo vacío" >&2
  exit 1
fi
echo "real-ip: $n proxies de confianza${REAL_IP_FROM:+ (REAL_IP_FROM)}"
