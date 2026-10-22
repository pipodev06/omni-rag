#!/bin/sh
# =====================================================================
# Restablece la contraseña de un usuario (p. ej. el superadministrador) desde el servidor.
#
#   sh deploy/reset-password.sh admin                  # la pide dos veces, sin mostrarla
#   sh deploy/reset-password.sh admin --generar        # crea una aleatoria y la muestra una vez
#   sh deploy/reset-password.sh admin --quitar-2fa     # además quita su verificación en dos pasos
#
# Cierra las sesiones abiertas del usuario y queda en su auditoría. Solo funciona en la
# máquina donde corre Docker; nadie puede usarlo desde la web.
# =====================================================================
set -eu
cd "$(dirname "$0")/.."
exec docker compose exec api node dist/scripts/reset-password.js "$@"
