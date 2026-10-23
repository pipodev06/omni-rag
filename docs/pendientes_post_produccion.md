# Pendientes para después de producción

Tareas que conviene hacer una vez que el sistema ya está en uso, o que dependen de tener un segundo servidor. No bloquean abrir el servicio a clientes. La numeración es la de [pendientes.md](pendientes.md).

| # | Qué | Cuándo | Tipo |
|---|---|---|---|
| 44 | **Ensayar la restauración completa en un servidor limpio** (otro VPS o una máquina virtual): clonar el repositorio, crear el `.env` con los mismos `JWT_SECRET`, `BACKUP_ENCRYPTION_PASSPHRASE` y claves, bajar la copia de Backblaze y seguir [«Restaurar en un servidor limpio»](operacion.md#restaurar-en-un-servidor-limpio-desde-backblaze). Ya se probó por separado restaurar la base de datos y los archivos desde Backblaze; falta el recorrido completo, con la aplicación arrancando y un usuario entrando con su 2FA. Repetirlo cada 6 meses o tras cambiar de proveedor de copias | Cuando haya un segundo servidor, y antes de tener datos de clientes que no se puedan perder | Tú |

## Cómo marcar una tarea como hecha

Tacha la fila (`~~…~~`), anota la fecha y el resultado, y muévela a la sección «Hecho» de este archivo.

## Hecho

_(nada todavía)_
