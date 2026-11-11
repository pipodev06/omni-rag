# docker-compose.yml explicado

El `docker-compose.yml` va sin comentarios, como el de cualquier otro servicio: esta página explica cada parte. Se descarga de GitHub y, como mucho, se le añade la red de tu proxy (ver abajo); el resto de lo propio de cada servidor va en el `.env` (opcional).

```bash
docker compose up -d          # arranca todo; sin .env vale todo por defecto
docker compose logs api       # el código de la configuración inicial sale aquí
```

## Lo que se cambia en el `.env`

| Para… | Variables | Por defecto |
|---|---|---|
| Publicar con dominio | `DOMAIN`, `WEB_BIND=127.0.0.1` | `localhost`, todas las IP |
| Cambiar puertos | `WEB_PORT`, `DB_PORT`, `EMBEDDINGS_PORT`, `MAILPIT_PORT` | 8000, 15432, 18080, 8025 |
| Servicios opcionales | `COMPOSE_PROFILES=https,antivirus,correo-pruebas` | ninguno |
| Fijar una versión | `OMNI_RAG_VERSION=1.2.0` | `latest` |
| Limitar recursos | `*_CPUS`, `*_MEM_LIMIT`, `*_CPU_SHARES` (los calcula `deploy/autotune.sh`) | sin límite |

Todas las variables, con su explicación: [variables.md](variables.md).

## Red del proxy

Si tu proxy corre en Docker (Nginx Proxy Manager, Traefik…) en su propia red, la web tiene que estar también en ella para que la alcance por nombre (`rag-web-1`, puerto `80`). Se declara en tu copia del `docker-compose.yml`, con el nombre que tenga esa red en tu servidor:

```yaml
services:
  web:
    # … lo que ya trae …
    networks: [default, red]   # «red» = el nombre de la red de tu proxy (docker network ls)

networks:
  # … las que ya trae (ingest, docker) …
  red:
    external: true
```

El compose oficial no la trae porque `external: true` obliga a que la red exista: en una máquina sin esa red, `docker compose up` fallaría («network … declared as external, but could not be found»). Al descargar una versión nueva del compose, vuelve a añadir esas líneas (igual que con cualquier plantilla oficial que adaptas, como la de Immich).

## Servicios

| Servicio | Imagen | Qué hace |
|---|---|---|
| `db` | `omni-rag-ops` (parte de `pgvector/pgvector:pg17`) | PostgreSQL 17 con pgvector. Antes de arrancar ejecuta `init-secrets.sh` (ver abajo). Puerto `127.0.0.1:15432`, solo desde el propio servidor |
| `embeddings` | `text-embeddings-inference:cpu-1.8` | Convierte texto en vectores para buscar por significado. Local, gratis y sin límite. Lotes de 4.096 tokens: misma calidad con ~2,3 GB de RAM en vez de ~3,2 GB. Puerto `127.0.0.1:18080` para depurar |
| `reranker` | `text-embeddings-inference:cpu-1.8` | Reordena los resultados leyendo pregunta y fragmento juntos (~1,6 GB, ~0,6 s por pregunta en CPU). Se desactiva con `RERANKER_URL=` y `RERANKER_REPLICAS=0` |
| `docling` | `docling-serve-cpu:v1.37.0` | Convierte PDF, Office, HTML e imágenes (con OCR) en texto. Cada conversión simultánea puede usar ~3 GB: `DOCLING_WORKERS=1` cabe en 8 GB. Tiempo máximo por documento: `DOCLING_TIMEOUT_SECONDS` (900) |
| `api` | `omni-rag-api` | API HTTP. Aplica las migraciones de la base al arrancar |
| `worker` | `omni-rag-api` | Procesa los documentos en segundo plano, vigila el sistema (alertas cada 5 minutos) y toma las métricas de los contenedores cada minuto |
| `web` | `omni-rag-web` | La interfaz (nginx), que además pasa `/api` a la API. Puerto `WEB_BIND:WEB_PORT` (8000). Proxies de confianza para la IP del cliente: `REAL_IP_FROM` |
| `docker-filter` | `omni-rag-api` (`dist/dockerFilter.js`) | Entre el worker y `docker-proxy`: solo responde por los contenedores de este proyecto y solo con consumo, topes, reinicios y salud (ver Seguridad) |
| `docker-proxy` | `wollomatic/socket-proxy:1.13.1` | Lee el socket de Docker con lista blanca de solo lectura; solo atiende a `docker-filter` (ver Seguridad) |
| `backup` | `omni-rag-ops` | Copias de la base y de los archivos en `./backups`, verificadas restaurándolas en una base temporal |
| `backup-b2` | `omni-rag-ops` | Sube las copias cifradas a Backblaze B2. Siempre en marcha; sin claves espera sin hacer nada |
| `clamav` | `clamav/clamav:1.4` | Antivirus (perfil `antivirus`, con `CLAMAV_HOST=clamav`). ~2 GB de RAM; descarga ~300 MB de firmas al arrancar, por eso necesita internet. Acepta archivos de hasta `CLAMAV_MAX_SIZE` (100M; clamd trae 25 MB) |
| `caddy` | `caddy:2.11-alpine` | HTTPS automático con Let's Encrypt (perfil `https`, con `DOMAIN`). Su configuración va dentro del compose (`configs:`): comprime, añade `Strict-Transport-Security`, quita la cabecera `Server` y no retiene las respuestas del chat (`flush_interval -1`), que llegan en streaming |
| `mailpit` | `axllent/mailpit:v1.31` | Correo de pruebas (perfil `correo-pruebas`): captura los correos sin enviarlos. Bandeja en `127.0.0.1:8025` |

### Primer arranque (`db`)

Antes de iniciar PostgreSQL, `db` ejecuta `/init-secrets.sh` (de `deploy/`, dentro de la imagen `omni-rag-ops`):

1. Si faltan, genera `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET` y la frase de cifrado de las copias (`backup_passphrase`) en `./data/secretos` (64 caracteres al azar, solo lectura para el usuario 1000). Lo escrito en el `.env` manda sobre ellos.
2. Deja `./data/uploads` y `./data/copias-config` a nombre del usuario 1000 (el de la API y el worker), porque Docker crea las carpetas como root.
3. Arranca PostgreSQL con la contraseña del `.env` o la generada. Solo cuenta al crear la base.

Va dentro de `db`, y no en un servicio aparte, para que no quede un contenedor terminado: Dockge marca «finalizado» un stack con un contenedor parado. Los demás servicios esperan a que `db` esté sano (`pg_isready`).

### Detalles de la API y el worker

- `env_file` con `required: false`: el `.env` es opcional.
- `DATABASE_URL` y `APP_DATABASE_URL` van vacías a propósito: la API las arma con las contraseñas del `.env` o las de `./data/secretos` y el host `db`. Así una URL de desarrollo del `.env` no se cuela en el contenedor.
- `BACKUP_ENCRYPTION_PASSPHRASE` también en la API y el worker (como en `backup` y `backup-b2`): así todos ven la misma frase aunque se exporte en el shell en vez de en el `.env`.
- `DOCKER_PROXY_URL`: dirección de `docker-filter` para las métricas de Sistema; vacía, sin métricas.
- `DOCKER_UPSTREAM_URL` (fija en `docker-filter`): dirección de `docker-proxy`.
- El worker tiene `cpu_shares` (`WORKER_CPU_SHARES`): con competencia, la ingesta cede CPU a las búsquedas y a otros servicios del servidor.
- El worker lee `./backups` y `./data/copias-estado` en solo lectura (para el monitor y la pantalla Copias) y escribe `./data/copias-config` (los ajustes de B2 guardados en la pantalla, que lee `backup-b2`).

### Copias (`backup` y `backup-b2`)

- Los ajustes de copias llegan vacíos si no están en el `.env`: solo mandan si tienen valor. Si no, se usan los de *Sistema → Copias* o los valores por defecto de `deploy/backup.sh`.
- `PGPASSWORD` y `BACKUP_ENCRYPTION_PASSPHRASE` vacías: `backup.sh` usa las de `./data/secretos`.
- `/offsite`: carpeta externa (`BACKUP_OFFSITE_DIR`; disco, NAS o carpeta sincronizada), solo con `BACKUP_OFFSITE=true`. `/targets`: discos entre los que se elige el destino en la pantalla (`BACKUP_TARGETS_DIR`). Sin definirlas son volúmenes vacíos (`backups-offsite`, `backups-targets`) y la pantalla no ofrece cambiar de destino.
- `backup` corre como root sin el resto de privilegios: solo `DAC_OVERRIDE` (leer y escribir archivos de otros usuarios) y `FOWNER` (conservar fechas y permisos de lo copiado).
- `backup-b2` necesita `BACKUP_OFFSITE=true` y la frase de cifrado: sin cifrar no sube nada. No monta `./data/secretos` (sale a internet): la frase generada le llega en `./data/copias-config/b2.env` (0600), que escribe el worker junto a las claves de B2. Arranca después del worker.

## Datos (`./data`)

Todo en carpetas junto al compose: ningún `docker prune` las toca. Detalle y copias: [operacion.md](operacion.md#dónde-viven-los-datos).

| Carpeta | Contenido |
|---|---|
| `./data/postgres` | Base de datos |
| `./data/uploads` | Archivos subidos |
| `./data/secretos` | Contraseñas internas, `JWT_SECRET` y la frase de cifrado de las copias (no van en las copias: guárdala aparte) |
| `./data/modelos` | Modelos de embeddings y re-ranker (se descargan una vez) |
| `./data/copias-config`, `./data/copias-estado` | Ajustes y estado de las copias externas |
| `./data/clamav`, `./data/caddy` | Firmas del antivirus y certificados (solo con sus perfiles) |
| `./backups` | Copias de seguridad |

En Windows (desarrollo), PostgreSQL no arranca sobre carpetas: `cp docker-compose.volumenes.example.yml docker-compose.override.yml` usa volúmenes de Docker con los mismos nombres de siempre (`rag_pgdata`…). Con volúmenes, un `docker volume prune` sin contenedores borra los datos.

## Redes

| Red | Para qué |
|---|---|
| `default` | La normal entre servicios |
| `ingest` | Interna, sin salida a internet: Docling procesa archivos de usuarios (no confiables), así que solo el worker le habla y no llega a la base ni a internet |
| `docker` | Interna, sin salida a internet: solo el worker y `docker-filter` |
| `docker-socket` | Interna, sin salida a internet: solo `docker-filter` y `docker-proxy` (el worker no la ve) |

## Seguridad

- **Todos los servicios** (también los de perfiles): `no-new-privileges` y `cap_drop: ALL`, con solo las capacidades que su arranque necesita, probadas con la imagen real:

  | Servicio | Capacidades | Para qué |
  |---|---|---|
  | `db` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | `initdb`, dueño 1000 de las carpetas de node y cambio al usuario `postgres` |
  | `web` | `CHOWN`, `SETGID`, `SETUID`, `NET_BIND_SERVICE` | nginx: puerto 80 y procesos hijos como `nginx` |
  | `caddy` | `NET_BIND_SERVICE` | puertos 80 y 443 |
  | `clamav` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | prepara sus carpetas y baja al usuario `clamav` |
  | `backup` | `DAC_OVERRIDE`, `FOWNER` | copias de archivos de otros dueños |
  | `backup-b2` | `DAC_READ_SEARCH` | solo leer el `b2.env` que escribe el worker (0600) |
  | `api`, `worker`, `docker-filter`, `docker-proxy`, `embeddings`, `reranker`, `docling`, `mailpit` | ninguna | |

  Si una imagen nueva no arranca («Operation not permitted»), se agrega solo la capacidad que pide su error, nunca `privileged`.
- `docker-filter`: la lista blanca de `docker-proxy` solo puede filtrar la forma de la ruta, no de quién es el contenedor. El filtro responde solo por los contenedores del propio proyecto de compose (el suyo, por su etiqueta `com.docker.compose.project`) y de cada respuesta deja solo los campos que usan Sistema y el monitor (consumo, topes, reinicios, OOM, salud y etiquetas de compose): nunca variables de entorno, montajes ni redes. Cualquier otra ruta, método o contenedor recibe 403. No usa la base ni secretos, sistema de archivos de solo lectura, 64 MB de RAM y como mucho 64 consultas a la vez (más: 429). El aislamiento principal es la red: el worker no está en `docker-socket`. **Al actualizar desde una versión sin `docker-filter`, recrea el stack entero** (`docker compose pull && docker compose up -d`, sin nombrar servicios): recrear solo algunos dejaría el `docker-proxy` anterior en la red `docker`. Para comprobarlo: `docker network inspect <proyecto>_docker` no debe listar `docker-proxy`. Si en el mismo servidor hay varias instalaciones, dale a cada una un nombre de proyecto distinto (`-p` o `COMPOSE_PROJECT_NAME`).
- `docker-proxy`: lista blanca exacta de solo lectura (GET a `/info`, `/containers/json` y `/containers/<id>/stats|json`; cualquier otra ruta o método se rechaza), solo atiende a `docker-filter` por la red `docker-socket`, red interna, imagen mínima sin shell, sistema de archivos de solo lectura y 32 MB de RAM. Es el único contenedor con tope fijo porque es el único que toca el socket de Docker (quien lo controla maneja todos los contenedores del servidor, como root): si fallara o lo saturaran, no puede comerse la RAM del servidor; Docker lo reinicia y, como mucho, Sistema se queda un minuto sin métricas. Le sobra: usa ~15 MB (pico ~18 MB). Los demás no llevan tope fijo porque su consumo depende del trabajo (modelos, Docling, base) y un tope podría cortarlos. Con Docker rootless o Podman, cambia `DOCKER_SOCKET`; para no usar root, `DOCKER_PROXY_USER=65534:<gid del grupo docker>`.
- Puertos de depuración (base de datos, embeddings, Mailpit) solo en `127.0.0.1`.

## Recursos

`embeddings`, `reranker`, `docling` y `worker` aceptan `*_CPUS`, `*_MEM_LIMIT` y `*_CPU_SHARES` (0 / 1024 = sin límite y peso normal); los calcula `deploy/autotune.sh` según el hardware. Limitar la CPU de los modelos también reduce su memoria (~0,2 GB por núcleo que no usan); pasados los núcleos reales casi no ganan velocidad. Docling tiene `oom_score_adj` (`DOCLING_OOM_SCORE_ADJ`): si se agota la memoria, el sistema lo cierra antes que a los modelos de búsqueda o a otros servicios.

## DNS

Los contenedores que salen a internet (modelos, proveedores de LLM, correo, antivirus, B2) usan `DNS_PRIMARY` y `DNS_SECONDARY` (1.1.1.1 y 8.8.8.8, por IPv4): no dependen del DNS del servidor, que a veces es solo IPv6. En una red con DNS propio, cámbialos.

## Imágenes y construcción

`omni-rag-api` (API y worker), `omni-rag-web` y `omni-rag-ops` (db, backup y backup-b2) las publica el CI en GHCR; `docker compose pull` las descarga. Cada una conserva su `build:` para construirlas desde el código con `docker compose up -d --build` (desarrollo, o un servidor sin acceso a GHCR).
