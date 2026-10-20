#!/usr/bin/env bash
set -euo pipefail

# Instala la tarea de salud en el crontab de la cuenta, en cada despliegue.
#
# Reemplaza solamente sus propias lineas, reconocidas por el marcador, y conserva
# intactas las demas. Correrlo cuando no hubo cambios deja el crontab igual.
#
# La URL no vive en el repositorio: se lee de un archivo de la cuenta, porque este
# repositorio es publico y el dominio es dato del hosting. Crear una sola vez:
#
#   echo "https://catalogo.midominio.cl/health" > ~/.clami-bridge-health-url
#
# Sin ese archivo el script no instala nada y lo dice, sin detener el despliegue.

app_root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
url_file="${CLAMI_BRIDGE_HEALTH_URL_FILE:-$HOME/.clami-bridge-health-url}"
marker="# clami-bridge:salud"

if [ ! -f "$url_file" ]; then
  echo "CRON: falta $url_file; no se instala la tarea de salud."
  exit 0
fi

health_url="$(head -n 1 "$url_file" | tr -d '[:space:]')"

case "$health_url" in
  https://*/health) : ;;
  *)
    echo "CRON: la URL de $url_file debe ser https y terminar en /health; no se instala." >&2
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
