#!/usr/bin/env bash
set -euo pipefail

# Guard simple antes/después de deploy. Comprueba solo el proyecto, no inventa
# una cuota global de inodos que el hosting no exponga a la cuenta.
app_root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
max_files="${MAX_PROJECT_FILES:-4000}"
count="$(find "$app_root" -xdev -type f -print | wc -l | tr -d '[:space:]')"

if [ "$count" -gt "$max_files" ]; then
  echo "ABORTADO: el proyecto tiene $count archivos; máximo permitido: $max_files." >&2
  exit 1
fi

echo "OK: $count archivos en el proyecto (máximo $max_files)."
