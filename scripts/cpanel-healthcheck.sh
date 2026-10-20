#!/usr/bin/env bash
set -euo pipefail

# Uso en Cron Jobs cPanel:
# /bin/bash /home/usuario-cpanel/repositories/clami-bridge/scripts/cpanel-healthcheck.sh https://catalogo.ejemplo.cl/health

health_url="${1:?Indica la URL HTTPS de /health como primer argumento}"
/usr/bin/curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null
