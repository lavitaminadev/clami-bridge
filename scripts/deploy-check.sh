#!/usr/bin/env bash
set -euo pipefail

# Guardas para Git Deployment. No ejecuta migraciones ni toca WordPress.
app_root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
home_dir="${HOME:?HOME no definido}"

case "$app_root/" in
  "$home_dir/public_html/"*)
    echo "ABORTADO: la aplicación Node no puede desplegarse dentro de public_html." >&2
    exit 1
    ;;
esac

for required in app.js server.js package.json scripts/check-project-files.sh; do
  if [ ! -f "$app_root/$required" ]; then
    echo "ABORTADO: falta artefacto requerido: $required" >&2
    exit 1
  fi
done

/bin/bash "$app_root/scripts/check-project-files.sh" "$app_root"

# Este proyecto no tiene dependencias de producción: no invocar npm evita churn de
# inodos y no arriesga reemplazar el symlink node_modules de CloudLinux.
# Si se agregan dependencias, este deploy se detiene: primero hay que configurar
# NODE_BIN_DIR con la ruta real del Node Selector y añadir un paso npm install seguro.
if grep -q '"dependencies"[[:space:]]*:' "$app_root/package.json" || grep -q '"optionalDependencies"[[:space:]]*:' "$app_root/package.json"; then
  echo "ABORTADO: se agregaron dependencias; configurar NODE_BIN_DIR y el deploy antes de instalar." >&2
  exit 1
fi

/bin/bash "$app_root/scripts/check-project-files.sh" "$app_root"

mkdir -p "$app_root/tmp"
touch "$app_root/tmp/restart.txt"
echo "OK: controles de despliegue terminados. Verificar /health antes de instalar cron."
