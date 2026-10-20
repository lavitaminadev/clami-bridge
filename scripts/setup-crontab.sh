#!/usr/bin/env bash
set -euo pipefail

# Instala la tarea de salud en el crontab de la cuenta, en cada despliegue.
#
# Reemplaza solamente sus propias lineas, reconocidas por el marcador, y conserva
# intactas las demas. Correrlo cuando no hubo cambios deja el crontab igual.
#
# Uso:  setup-crontab.sh [url-de-salud]
#
# La raiz de la aplicacion se deduce de la ubicacion de este archivo, no del
# directorio de trabajo: la linea del crontab necesita una ruta absoluta.
#
# La URL llega como argumento desde .cpanel.yml. Si no viene, se lee de
# ~/.clami-bridge-health-url, para quien prefiera no tener su dominio en un
# repositorio publico. Sin ninguna de las dos no se instala nada y se dice, sin
# detener el despliegue.

app_root="$(cd "$(dirname "$0")/.." && pwd)"
url_file="${CLAMI_BRIDGE_HEALTH_URL_FILE:-$HOME/.clami-bridge-health-url}"
marker="# clami-bridge:salud"

health_url="${1:-}"
if [ -z "$health_url" ]; then
  if [ ! -f "$url_file" ]; then
    echo "CRON: no se indico la URL de salud ni existe $url_file; no se instala la tarea."
    exit 0
  fi
  health_url="$(head -n 1 "$url_file")"
fi
health_url="$(printf %s "$health_url" | tr -d '[:space:]')"

case "$health_url" in
  https://*/health) : ;;
  *)
    echo "CRON: la URL de salud debe ser https y terminar en /health; no se instala." >&2
    exit 0
    ;;
esac

linea="*/5 * * * * /bin/bash $app_root/scripts/cpanel-healthcheck.sh $health_url >/dev/null $marker"

# `crontab -l` termina en error cuando la cuenta todavia no tiene crontab: eso no es
# una falla, es el primer despliegue.
actual="$(crontab -l 2>/dev/null || true)"
nuevo="$(printf '%s\n' "$actual" | grep -v -F "$marker" || true)"
nuevo="$(printf '%s\n%s\n' "$nuevo" "$linea" | sed '/^$/d')"

if [ "$actual" = "$nuevo" ]; then
  echo "CRON: la tarea de salud ya estaba instalada y sin cambios."
  exit 0
fi

printf '%s\n' "$nuevo" | crontab -
echo "CRON: tarea de salud instalada cada 5 minutos contra $health_url"
