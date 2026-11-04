# Estado del proyecto

Actualizado el 2026-11-04. Fase: **cierre**.

## Hecho en el cierre (2026-11-04)

- Monitor sin falsa alerta de métricas al arrancar el worker; copias y subida a B2 perdidas se recuperan al arrancar.
- Una copia fallida ya no cuenta como reciente (`.dump.fallida`).
- Sistema → Copias: estado de las copias, carpeta externa y B2; «Hacer copia ahora»; «Cambiar destino» con la opción de llevar las copias existentes; alerta si el disco externo se desconecta.
- Sistema → Configuración: alertas, correo, límites y retención, modelos, internet y búsqueda editables, con reconfirmación de identidad y aviso por correo. Lo escrito en el `.env` manda.
- Endurecimiento tras la revisión de seguridad y 489 tests unitarios y de scripts.

## Pendiente

- Probar en el navegador las pantallas Configuración y Copias, y una subida real a B2 (ver [deuda-tecnica.md](deuda-tecnica.md)). Migraciones, integración con la base y scripts en sus contenedores ya están probados.
- En el servidor: rellenar `B2_KEY_ID`, `B2_APPLICATION_KEY` y `B2_BUCKET` (ahora también desde Sistema → Copias) o quitar `backblaze` de `COMPOSE_PROFILES`.
- Desplegar: `git pull`, `sh deploy/build.sh`, `docker compose up -d`.
- CI/CD: no hay; se crea solo si se pide.
