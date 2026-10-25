# Referencia de variables de entorno

Todas se definen en el archivo `.env` (cópialo de `.env.example`, que trae cada una con su comentario). Esta página es el índice completo: qué hace cada variable, su valor por defecto y cuándo se aplica un cambio.

**Cómo aplicar un cambio:** `docker compose up -d`. Un simple `restart` **no relee** el `.env`. Si cambiaste código y no solo el `.env`, usa `sh deploy/build.sh`. Un `#` al inicio de la línea la anula y se usa el valor por defecto. Las reglas y excepciones (variables que solo cuentan la primera vez, contraseñas de la base de datos) están en el [README](../README.md#cambiar-la-configuración-env).

**Columna «Aplica»:** *up* = basta `docker compose up -d`; *1.ª vez* = solo con la base de datos vacía; *reproc.* = hay que reprocesar los documentos para que afecte a los ya cargados.

**Secretos:** `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, las `*_API_KEY`, `SMTP_PASSWORD`, `BACKUP_ENCRYPTION_PASSPHRASE`, `B2_APPLICATION_KEY` y `SEED_ADMIN_PASSWORD` no se comparten ni se suben a git. Guárdalas también en un gestor de contraseñas: las copias de seguridad **no** incluyen el `.env`.

## Base de datos y acceso

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `POSTGRES_PASSWORD` | — (obligatoria) | Contraseña del usuario `rag_owner` de PostgreSQL. Se rota con `sh deploy/rotate-db-password.sh` | Ver [README, regla 3](../README.md#3-las-contraseñas-de-la-base-de-datos-tienen-un-paso-extra) |
| `APP_DB_PASSWORD` | — (obligatoria) | Contraseña del usuario `rag_app` (el que usa la aplicación, sujeto a RLS) | up (la API la aplica sola) |
| `JWT_SECRET` | — (obligatoria, 32+ caracteres) | Firma las sesiones y cifra los secretos del 2FA. Con dominio real debe ser fuerte | up (cierra todas las sesiones y **rompe el 2FA ya guardado**) |
| `JWT_EXPIRES_IN` | `12h` | Duración de una sesión | up |
| `COOKIE_SECURE` | `auto` | Cookie solo por HTTPS: `auto` (según el acceso), `true`, `false`. Con `DOMAIN` real siempre es segura | up |
| `REQUIRE_SUPERADMIN_2FA` | `auto` | 2FA obligatorio al superadministrador: `auto` = solo con dominio real | up |
| `REQUIRE_ADMIN_2FA` | `false` | 2FA obligatorio a todos los administradores de organización (`false` = opcional) | up |
| `IP_RATE_LIMIT_PER_MIN` | `120` | Peticiones por minuto y por IP de quien no ha iniciado sesión (`0` = sin límite) | up |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies delante del nginx de la web: `1` = Caddy o un nginx; `2` = túnel de Cloudflare + Nginx Proxy Manager; `0` = acceso directo. Si es menor que la realidad, todos los usuarios salen con la IP del proxy y comparten el límite por IP; si es mayor, la IP se puede falsificar | up |
| `SEED_ADMIN_USERNAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | `admin`, `admin@example.com`, — | Primer superadministrador, que vive en la organización interna «Plataforma» (no es un cliente). El email es opcional. `SEED_TENANT_*` ya no se usan | 1.ª vez |

## Dominio, HTTPS y puertos

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `DOMAIN` | vacío | Dominio público (`rag.tuempresa.com`). Activa las comprobaciones de producción: secretos fuertes, cookie segura y 2FA del superadministrador. Obligatorio también con tu propio nginx o túnel | up |
| `COMPOSE_PROFILES` | vacío | Servicios opcionales, separados por comas: `https` (Caddy), `antivirus`, `backblaze`, `correo-pruebas` | up |
| `APP_PUBLIC_URL` | `https://DOMAIN` o `http://localhost:8000` | URL de los enlaces de los correos | up |
| `APP_NAME` | `Omni RAG` | Nombre que aparece en los correos y en la app del autenticador | up |
| `WEB_BIND` | `0.0.0.0` | IP donde escucha la web. En producción tras proxy o Caddy: `127.0.0.1` | up |
| `WEB_PORT` | `8000` | Puerto de la web | up |
| `DB_PORT` | `15432` | Puerto de PostgreSQL (solo en `127.0.0.1`, para depurar) | up |
| `EMBEDDINGS_PORT` | `18080` | Puerto del servicio de embeddings (solo `127.0.0.1`) | up |
| `MAILPIT_PORT` | `8025` | Bandeja de pruebas (solo con el perfil `correo-pruebas`) | up |

## Correo

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `SMTP_HOST` | vacío | Servidor SMTP. Vacío = sin correo: los enlaces de invitación se copian a mano | up |
| `SMTP_PORT` | `587` | Puerto (`587` con STARTTLS, `465` con TLS directo) | up |
| `SMTP_SECURE` | `false` | `true` si el puerto es 465 | up |
| `SMTP_USER`, `SMTP_PASSWORD` | vacío | Credenciales (con Gmail, una contraseña de aplicación) | up |
| `SMTP_FROM` | `Omni RAG <no-reply@localhost>` | Remitente. Con Gmail debe ser la misma cuenta | up |
| `INVITE_EXPIRES_HOURS` | `72` | Validez de un enlace de invitación | up |
| `RESET_EXPIRES_MINUTES` | `60` | Validez de un enlace de restablecimiento de contraseña | up |

Para probarlo: `docker compose exec api node dist/scripts/test-email.js tu@correo.com`.

## Proveedores de LLM y planes

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | vacío | Clave de cada proveedor. Basta una; los modelos de cada plan indican cuál se usa | up |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Dirección de OpenRouter (solo si usas un espejo) | up |
| `LLM_CUSTOM_BASE_URL`, `LLM_CUSTOM_API_KEY` | vacío | Servidor propio compatible con OpenAI (Ollama, vLLM…); la dirección termina en `/v1` | up |
| `LLM_DEFAULT_PROVIDER` | `openrouter` | Proveedor de los modelos escritos sin prefijo | up |
| `LLM_MODELS` | tres modelos gratuitos de OpenRouter | Modelos del plan «Estándar» inicial. **Después se editan en *Organizaciones → Planes*** | 1.ª vez |
| `TENANT_DAILY_QUESTION_LIMIT` | `200` | Preguntas por día del plan «Estándar» inicial. Después se edita en la pantalla | 1.ª vez |
| `LLM_TEMPERATURE` | `0.2` | Creatividad de las respuestas (0 a 2). Bajo = más literal | up |
| `LLM_MAX_TOKENS` | `2048` | Largo máximo de cada respuesta. Con Groq gratis puede hacer falta bajarlo | up |
| `QUOTA_WARN_PERCENT` | `80` | % del límite diario a partir del cual se avisa en el chat y por correo | up |

Para ver qué modelos funcionan con tus claves: `docker compose exec -T api node dist/scripts/models.js groq google --ok` (más opciones en [operacion.md](operacion.md#proveedores-de-llm-openrouter-groq-google-openai-deepseek-servidor-propio)).

## Documentos, embeddings y búsqueda

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `MAX_UPLOAD_MB` | `50` | Tamaño máximo de un archivo subido. Cloudflare gratis corta peticiones de más de 100 MB | up |
| `CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS` | `1200`, `200` | Tamaño de los fragmentos y solape entre ellos | reproc. |
| `DOCLING_TIMEOUT_SECONDS` | `900` | Tiempo máximo para procesar un documento | up |
| `DOCLING_OCR_LANGS` | `es,en` | Idiomas del OCR de documentos escaneados | up |
| `DOCLING_DO_OCR` | `true` | OCR de imágenes y escaneos. Con `false` los PDF digitales se procesan más rápido, pero los escaneados salen sin texto | reproc. |
| `DOCLING_TABLE_MODE` | `accurate` | Detección de tablas: `accurate` (fiel) o `fast` (más rápida, menos precisa en tablas complejas) | reproc. |
| `DOCLING_WORKERS` | `1` | Hilos de Docling | up |
| `WORKER_CONCURRENCY` | `2` | Documentos que el worker procesa a la vez | up |
| `EMBEDDING_MODEL`, `EMBEDDING_DIM` | `intfloat/multilingual-e5-base`, `768` | Modelo de embeddings y su dimensión | reproc. y recrear los fragmentos ([operacion.md](operacion.md#cambiar-el-modelo-de-embeddings)) |
| `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_PASSAGE_PREFIX` | `query: `, `passage: ` | Prefijos que exige E5; vacíos para otros modelos (bge-m3) | reproc. |
| `EMBEDDING_BATCH_SIZE` | `16` | Fragmentos por llamada al servicio de embeddings | up |
| `RETRIEVAL_TOP_K` | `6` | Fragmentos que se envían al modelo | up |
| `RETRIEVAL_CANDIDATES` | `40` | Candidatos que recupera la búsqueda híbrida | up |
| `RETRIEVAL_MAX_DISTANCE` | `0.25` | Distancia máxima para que un fragmento cuente (0 = idéntico) | up |
| `FTS_LANGUAGE` | `spanish` | Idioma de la búsqueda por palabras | reproc. |
| `HISTORY_MESSAGES` | `6` | Mensajes anteriores de la conversación que se envían al modelo | up |
| `RERANKER_URL`, `RERANKER_REPLICAS`, `RERANKER_MODEL` | vacío, `1`, `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | Modelo local que reordena resultados. Para desactivarlo (poca RAM): `RERANKER_URL` vacío y `RERANKER_REPLICAS=0` | up |
| `RERANK_CANDIDATES`, `RERANK_MIN_SCORE` | `20`, `0.02` | Candidatos que se reordenan y puntuación mínima para usarlos. **No bajes los candidatos para ganar velocidad**: con 12 en vez de 20, solo el 56 % de los 6 resultados coincide | up |
| `RERANK_PARALLEL` | `1` | Re-rankings que se hacen a la vez; el resto espera su turno en fila. Con 6 preguntas simultáneas, antes 4 agotaban el tiempo y perdían el re-ranking; ahora ninguna | up |
| `RERANK_MAX_CHARS` | `0` (texto completo) | Recorta cada candidato a N caracteres antes de re-rankear: más rápido pero cambia los resultados (ver [operacion.md](operacion.md#prueba-de-carga)) | up |
| `CACHE_ENABLED`, `CACHE_TTL_HOURS`, `CACHE_MAX_DISTANCE` | `true`, `168`, `0.015` | Caché de respuestas a preguntas repetidas | up |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_SECONDS`, `CLAMAV_MAX_SIZE` | vacío, `3310`, `60`, `100M` | Antivirus opcional (perfil `antivirus`, host `clamav`). `CLAMAV_MAX_SIZE` debe superar `MAX_UPLOAD_MB` | up |

### Reparto de recursos (los calcula `deploy/autotune.sh`)

Límites de CPU y memoria de los servicios pesados, para no ahogar a otros contenedores del servidor. Vacíos o en su valor por defecto = sin límite (como antes). No hace falta escribirlos a mano: `bash deploy/autotune.sh --aplicar` los calcula según el hardware y los deja en un bloque del `.env` (ver [operacion.md](operacion.md#autoajuste-de-recursos)).

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `RERANKER_CPUS`, `EMBEDDINGS_CPUS`, `DOCLING_CPUS` | `0` (sin límite) | Máximo de CPU que puede usar cada servicio (admite decimales: `2.5`). Limitarla también baja su memoria (~0,2 GB por CPU) | up |
| `RERANKER_MEM_LIMIT`, `EMBEDDINGS_MEM_LIMIT`, `DOCLING_MEM_LIMIT` | `0` (sin límite) | Memoria máxima (`2478m`, `3g`). Si un servicio la supera, se reinicia solo él y no el resto | up |
| `RERANKER_CPU_SHARES`, `EMBEDDINGS_CPU_SHARES`, `DOCLING_CPU_SHARES`, `WORKER_CPU_SHARES` | `1024` | Peso de CPU frente a los demás contenedores (1024 = igual que el resto). Solo importa cuando hay competencia | up |
| `DOCLING_OOM_SCORE_ADJ` | `0` | Con valor alto (`500`), si el servidor se queda sin memoria, el sistema cierra primero a Docling | up |

## Retención, copias de seguridad y alertas

| Variable | Por defecto | Qué hace | Aplica |
|---|---|---|---|
| `AUDIT_RETENTION_DAYS` | `365` | Días que se guarda la auditoría | up |
| `TRASH_RETENTION_DAYS` | `30` | Días que un documento borrado queda en la papelera (`0` = sin papelera) | up |
| `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP_DAYS` | `24`, `7` | Cada cuántas horas se copia y cuántos días se conservan en el servidor | up |
| `BACKUP_AT`, `BACKUP_TZ` | vacío, `<-05>5` (Perú) | Hora fija de la copia (`03:00`) y su zona horaria | up |
| `BACKUP_UPLOADS_TGZ` | `true` | Incluir un `.tgz` de los archivos en la copia diaria. `false` si se usa la copia incremental | up |
| `BACKUP_OFFSITE`, `BACKUP_OFFSITE_DIR` | `false`, `./backups-offsite` | Segunda copia en una carpeta externa al disco | up |
| `BACKUP_ENCRYPTION_PASSPHRASE` | vacío | Frase para cifrar las copias que salen del servidor. **Sin ella no se pueden restaurar** | up |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` | vacío | Backblaze B2: clave limitada al bucket y su **nombre** (no el ID). Requiere `COMPOSE_PROFILES=backblaze` | up |
| `B2_PATH` | `omni-rag` | Carpeta dentro del bucket | up |
| `B2_AT`, `B2_INTERVAL_HOURS` | vacío, `6` | Hora fija de la subida (`04:00`) o cada cuántas horas | up |
| `B2_SYNC_UPLOADS` | `false` | Subir los archivos de forma incremental y cifrada | up |
| `B2_KEEP_DAYS` | `30` | Días que se conserva en Backblaze lo borrado y las copias de la base | up |
| `ALERT_EMAIL` | vacío | Correo(s) para las alertas de monitorización, separados por comas. Vacío = solo en los registros | up |
| `ALERT_DISK_FREE_PERCENT`, `ALERT_QUEUE_MINUTES`, `ALERT_BACKUP_HOURS` | `15`, `30`, `36` | Umbrales de las alertas: disco libre, documentos atascados y antigüedad de la última copia | up |
| `LOG_FORMAT` | `json` | Registros: `json` (una línea por evento) o `text` | up |

## Internas (las fija `docker-compose.yml`; normalmente no se tocan)

`DATABASE_URL`, `APP_DATABASE_URL` (se arman con las contraseñas de arriba), `DOCLING_URL`, `EMBEDDINGS_URL`, `STORAGE_DIR` (`/data/uploads`), `BACKUP_DIR` (`/backups`), `NODE_ENV` y `PORT` (`3001`). Solo importan si ejecutas la API fuera de Docker (ver [desarrollo.md](desarrollo.md)).
