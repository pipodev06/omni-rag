# Deuda técnica

Lo que falta probar o mejorar y no bloquea el uso. Lo pendiente de trabajo vive en [estado-del-proyecto.md](estado-del-proyecto.md).

## Sin probar en un entorno real (necesita Docker con la pila levantada)

- Migraciones 019–021 contra PostgreSQL: el `INSERT … ON CONFLICT` de `settings`, el índice único parcial de `backup_requests` y la carrera de dos órdenes a la vez (en los tests está simulada en memoria).
- `deploy/backup.sh` y `deploy/b2-sync.sh` dentro de sus contenedores (Debian y Alpine/BusyBox): los tests los ejecutan con `sh` real y programas simulados en Git Bash, no con `pg_dump`, `rclone`, `openssl` ni B2 reales. Probar una copia, una subida a B2 con datos ya existentes y un cambio de destino a un USB.
- Las capacidades del servicio `backup` (`cap_drop: ALL` + `DAC_OVERRIDE`, `FOWNER`): `mv` entre discos distintos podría necesitar `CHOWN`.
- Docker no ve los discos montados después de arrancar el contenedor: tras conectar o desconectar uno puede hacer falta `docker compose restart backup`.
- Pantallas Sistema → Configuración y Copias en el navegador: reconfirmación con y sin 2FA, aviso de claves borradas, modal de cambio de destino y sondeo de órdenes.
- Correo de prueba con STARTTLS obligatorio y la prueba de conexión de cada proveedor de modelos con claves reales.

## Mejoras

- Mover muchas copias (decenas de GB) con `cmp` bloquea el bucle de `backup.sh` mientras dura: las copias programadas esperan.
- La recuperación de B2 al arrancar solo mira las copias de la base; los archivos subidos (`B2_SYNC_UPLOADS`) esperan a la siguiente hora.
- `TENANT_DAILY_QUESTION_LIMIT` solo siembra los planes iniciales: editarlo en la pantalla no cambia una instalación ya creada (lo dice su nota; el límite real se fija en Planes).
