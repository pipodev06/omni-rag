# Estado del proyecto

Actualizado el 2026-11-05. Fase: **cierre**.

## Hecho el 2026-11-05

- El CI publica las imágenes en GHCR (`omni-rag-api`, que usan la API y el worker, y `omni-rag-web`): `:latest` desde `main` y `:X.Y.Z` desde etiquetas `vX.Y.Z`. El compose las descarga (`OMNI_RAG_VERSION`) y sigue pudiendo construirlas con `--build`.
- `docker-compose.override.example.yml` trae, además de la red del proxy, los datos en carpetas `./data` para servidores que se limpian con `prune`. Guía de mudanza en [operacion.md](operacion.md#pasar-los-datos-a-carpetas).

## Hecho en el cierre (2026-11-04)

- Monitor sin falsa alerta de métricas al arrancar el worker; copias y subida a B2 perdidas se recuperan al arrancar.
- Una copia fallida ya no cuenta como reciente (`.dump.fallida`).
- Sistema → Copias: estado de las copias, carpeta externa y B2; «Hacer copia ahora»; «Cambiar destino» con la opción de llevar las copias existentes; alerta si el disco externo se desconecta.
- Sistema → Configuración: alertas, correo, límites y retención, modelos, internet y búsqueda editables, con reconfirmación de identidad y aviso por correo. Lo escrito en el `.env` manda.
- Endurecimiento tras la revisión de seguridad y 489 tests unitarios y de scripts.

## Pendiente

- Probar en el navegador las pantallas Configuración y Copias, y una subida real a B2 (ver [deuda-tecnica.md](deuda-tecnica.md)). Migraciones, integración con la base y scripts en sus contenedores ya están probados.
- En el servidor: rellenar `B2_KEY_ID`, `B2_APPLICATION_KEY` y `B2_BUCKET` (ahora también desde Sistema → Copias) o quitar `backblaze` de `COMPOSE_PROFILES`.
- Tras el primer push con el nuevo CI: comprobar que se publicaron los paquetes y hacerlos públicos en GitHub (Packages → omni-rag-api / omni-rag-web → Package settings → Change visibility), o el servidor necesitará `docker login ghcr.io`.
- En el servidor: pasar los datos de los volúmenes a `./data` ([operacion.md](operacion.md#pasar-los-datos-a-carpetas)) y desplegar con `git pull`, `docker compose pull`, `docker compose up -d`. Sin probar todavía en el servidor.
- CI: pruebas, construcción y publicación de imágenes. No hay despliegue automático (CD) al servidor.
