# Estado del proyecto

Actualizado el 2026-11-05. Fase: **cierre**.

## Hecho el 2026-11-05

- El CI publica las imágenes en GHCR (`omni-rag-api`, que usan la API y el worker, y `omni-rag-web`): `:latest` desde `main` y `:X.Y.Z` desde etiquetas `vX.Y.Z`. El compose las descarga (`OMNI_RAG_VERSION`) y sigue pudiendo construirlas con `--build`.
- Los datos viven en carpetas `./data` por defecto (como Immich o Nextcloud); el override de ejemplo solo trae la red del proxy y `docker-compose.volumenes.example.yml` sirve para desarrollo en Windows. El servidor solo necesita `docker-compose.yml` (imagen `omni-rag-ops` con los scripts). Mudanza desde volúmenes en [operacion.md](operacion.md#actualizar-desde-una-versión-con-volúmenes-de-docker).
- `scripts/import-env-settings.ts`: copia a la base los ajustes de la pantalla fijados en el `.env` para poder editarlos allí ([variables.md](variables.md)). Probado con tests unitarios; no en el servidor.
- Sistema: solo se miden los contenedores propios; Métricas y Alertas en pestañas separadas; una hora de gracia para la alerta de copia antigua al encender el servidor.
- Copias: eliminar una copia desde la pantalla (orden «delete», la más reciente no); B2 opcional («No configurado», sin alerta) y `backup-b2` siempre en marcha, sin perfil.
- Arranque sin `.env`: el servicio `init` genera los secretos; configuración inicial en la web con código de un solo uso; «Primeros pasos» en Organizaciones; guía [configuracion-inicial.md](configuracion-inicial.md).

## Hecho en el cierre (2026-11-04)

- Monitor sin falsa alerta de métricas al arrancar el worker; copias y subida a B2 perdidas se recuperan al arrancar.
- Una copia fallida ya no cuenta como reciente (`.dump.fallida`).
- Sistema → Copias: estado de las copias, carpeta externa y B2; «Hacer copia ahora»; «Cambiar destino» con la opción de llevar las copias existentes; alerta si el disco externo se desconecta.
- Sistema → Configuración: alertas, correo, límites y retención, modelos, internet y búsqueda editables, con reconfirmación de identidad y aviso por correo. Lo escrito en el `.env` manda.
- Endurecimiento tras la revisión de seguridad y 489 tests unitarios y de scripts.

## Pendiente

- Probar en el navegador las pantallas Configuración y Copias, y una subida real a B2 (ver [deuda-tecnica.md](deuda-tecnica.md)). Migraciones, integración con la base y scripts en sus contenedores ya están probados.
- Probar en el navegador la configuración inicial, Primeros pasos, la pestaña Alertas y el borrado de copias.
- B2 es opcional: en el servidor, configurarlo desde Sistema → Copias cuando haya claves; `backblaze` en `COMPOSE_PROFILES` ya no hace falta.
- Validar en el servidor la instalación desde cero con la carpeta mínima y los datos en `./data` (en Windows no se puede: PostgreSQL no arranca sobre carpetas).
- CI: pruebas, construcción y publicación de imágenes. No hay despliegue automático (CD) al servidor.
