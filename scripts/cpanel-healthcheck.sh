#!/usr/bin/env bash
set -euo pipefail

# Comprueba /health y no imprime nada mientras el servicio responda.
#
# Uso en Cron Jobs cPanel:
# /bin/bash /home/usuario-cpanel/repositories/clami-bridge/scripts/cpanel-healthcheck.sh https://catalogo.ejemplo.cl/health
#
# Guardar stdout en /dev/null y dejar stderr libre hace que cPanel envie correo
# solo cuando la comprobacion falla. Agregar `2>&1` silencia tambien esos avisos.
#
# Termina con codigo distinto de cero si el servicio no responde, si devuelve un
# estado de error o si tarda mas de 10 segundos.

health_url="${1:?Indica la URL HTTPS de /health como primer argumento}"

# La ruta de curl varia entre servidores; fijarla hacia un binario inexistente
# deja el cron fallando en silencio cada vez que corre.
curl_bin="$(command -v curl || true)"
if [ -z "$curl_bin" ]; then
  echo "SALUD: no se encontro curl en este servidor" >&2
  exit 1
fi

if ! body="$("$curl_bin" --fail --silent --show-error --max-time 10 "$health_url" 2>&1)"; then
  echo "SALUD: $health_url no respondio correctamente. $body" >&2
  exit 1
fi

# `{"ok":false}` llega con estado 503 y `--fail` ya lo detecta; esta comprobacion
# cubre el caso de que algo intermedio devuelva 200 con un cuerpo distinto.
case "$body" in
  *'"ok":true'*) exit 0 ;;
  *) echo "SALUD: respuesta inesperada de $health_url: $body" >&2; exit 1 ;;
esac
