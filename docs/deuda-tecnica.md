# Deuda técnica

Lo que falta probar o mejorar y no bloquea el uso. Lo pendiente de trabajo vive en [estado-del-proyecto.md](estado-del-proyecto.md).

## Probado el 2026-11-04 con Docker

- Migraciones 001–021 sobre una base vacía y sobre la local (019–021 aplicadas sin error); tests de integración de RLS con PostgreSQL real.
- Índice único de `backup_requests` (una sola orden pendiente), toma de órdenes con `SKIP LOCKED` y restricciones de `settings`.
- `backup.sh` en su imagen (Debian) con `cap_drop: ALL` + `DAC_OVERRIDE`, `FOWNER`: copia y verificación, ajuste leído de la base, orden «copia ahora», cambio de destino moviendo las copias, destino desconectado (sin escribir en otro sitio) y vuelta al reconectar.
- `b2-sync.sh` en la imagen de rclone (Alpine): espera sin credenciales, toma `b2.env` en menos de un minuto y no sube copias sin cifrar.

## Sin probar

- Subida real a B2 (hace falta una cuenta) y lectura con `rclone crypt` de lo ya subido.
- Un USB o NAS real (en la prueba el destino estaba en el mismo disco) y `mv` entre discos distintos con las capacidades recortadas.
- Docker no ve los discos montados después de arrancar el contenedor: tras conectar o desconectar uno puede hacer falta `docker compose restart backup`.
- Pantallas Sistema → Configuración y Copias en el navegador: reconfirmación con y sin 2FA, aviso de claves borradas, modal de cambio de destino y sondeo de órdenes.
- Correo de prueba con STARTTLS obligatorio y la prueba de conexión de cada proveedor con claves reales.

## Mejoras

- Mover muchas copias (decenas de GB) con `cmp` bloquea el bucle de `backup.sh` mientras dura: las copias programadas esperan.
- La recuperación de B2 al arrancar solo mira las copias de la base; los archivos subidos (`B2_SYNC_UPLOADS`) esperan a la siguiente hora.
- `TENANT_DAILY_QUESTION_LIMIT` solo siembra los planes iniciales: editarlo en la pantalla no cambia una instalación ya creada (lo dice su nota; el límite real se fija en Planes).
