# Operación y mantenimiento

## Comandos habituales

```bash
docker compose ps                    # estado de los servicios
docker compose logs -f api worker    # registros en vivo
docker compose restart api worker    # reiniciar tras cambiar .env
docker compose down                  # parar (los datos se conservan en volúmenes)
docker compose up -d --build         # actualizar tras un git pull
curl localhost:8000/api/health       # estado de dependencias
```

Volúmenes con datos:

| Volumen | Contenido | ¿Copia de seguridad? |
|---|---|---|
| `rag_pgdata` | Base de datos (usuarios, documentos, vectores, conversaciones) | **Sí** |
| `rag_uploads` | Archivos originales subidos | **Sí** |
| `rag_hf-cache` | Modelo de embeddings descargado | No (se vuelve a descargar) |

## Copias de seguridad

El servicio `backup` hace una copia automática cada `BACKUP_INTERVAL_HOURS` horas (24 por defecto) en la carpeta **`./backups`** del proyecto y conserva `BACKUP_KEEP_DAYS` días (7):

```
backups/db_2026-10-21_0300.dump       # base de datos (pg_dump)
backups/uploads_2026-10-21_0300.tgz   # archivos originales
```

Copia inmediata (por ejemplo, antes de actualizar):

```bash
docker compose exec backup sh /backup.sh --once
docker compose logs backup          # ver el resultado de las copias
```

**Cada copia se verifica sola:** nada más hacerla, el servicio la restaura en una base temporal (`rag_restore_test`), cuenta usuarios, documentos y fragmentos, comprueba que el archivo de subidas se puede leer y borra la base temporal. En `docker compose logs backup` debe aparecer `VERIFICADA`; si aparece `ERROR`, la copia no sirve y hay que investigarlo antes de fiarse de ella.

**Segunda copia fuera del servidor:** con `BACKUP_OFFSITE=true` (y `BACKUP_OFFSITE_DIR`) cada copia verificada se copia además a una carpeta externa, cifrada si defines `BACKUP_ENCRYPTION_PASSPHRASE` (ver [produccion.md](produccion.md#6-copias-de-seguridad-fuera-del-servidor)). Por defecto está desactivada.

> La carpeta `./backups` está en el mismo disco: cópiala también **fuera del servidor** (ver [produccion.md](produccion.md#6-copias-de-seguridad-fuera-del-servidor)).

### Restaurar una copia

Con el sistema parado salvo `db` (sustituye la fecha):

```bash
docker compose stop api worker web backup
docker compose exec -T db pg_restore -U rag_owner -d rag --clean --if-exists < backups/db_AAAA-MM-DD_HHMM.dump
docker run --rm -v rag_uploads:/data -v "$PWD/backups":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/uploads_AAAA-MM-DD_HHMM.tgz -C /data"
docker compose up -d
```

> En un servidor nuevo, `pg_restore` mostrará avisos `role "rag_app" does not exist`. Son normales: al arrancar, la API crea el usuario `rag_app` con `APP_DB_PASSWORD` y vuelve a aplicar sus permisos.

### Restaurar en un servidor limpio (desde Backblaze)

Para cuando se pierde el servidor. **Las copias no incluyen el `.env`**: guarda aparte (gestor de contraseñas) al menos `JWT_SECRET` (con otro, los 2FA guardados dejan de funcionar y todas las sesiones caducan), `BACKUP_ENCRYPTION_PASSPHRASE` (sin ella no se abren las copias), las claves de los proveedores de LLM, las `B2_*` y los ajustes de embeddings (`EMBEDDING_*`: los vectores guardados deben coincidir con el modelo).

1. **Instala** Docker y git, clona el repositorio y crea el `.env` con los mismos `JWT_SECRET`, `DOMAIN`, claves y ajustes de embeddings. `POSTGRES_PASSWORD` y `APP_DB_PASSWORD` pueden ser nuevas.
2. **Baja las copias** más recientes (un `db_…dump.enc` y el `uploads_…tgz.enc` de la misma fecha) desde la web de Backblaze a una carpeta `restore/`, o con rclone:
   ```bash
   mkdir restore
   docker compose run --rm --no-deps -v "$PWD/restore:/restore" --entrypoint sh backup-b2 -c 'rclone lsl "b2:$B2_BUCKET/$B2_PATH"'   # ver qué hay
   docker compose run --rm --no-deps -v "$PWD/restore:/restore" --entrypoint sh backup-b2 -c 'rclone copy "b2:$B2_BUCKET/$B2_PATH" /restore --include "*_AAAA-MM-DD_HHMM.*"'
   ```
   (Requiere `COMPOSE_PROFILES=backblaze` y las `B2_*` en el `.env`.)
3. **Descifra** (pide la frase) y comprueba que los archivos sirven:
   ```bash
   cd restore
   openssl enc -d -aes-256-cbc -pbkdf2 -in db_AAAA-MM-DD_HHMM.dump.enc -out db.dump
   openssl enc -d -aes-256-cbc -pbkdf2 -in uploads_AAAA-MM-DD_HHMM.tgz.enc -out uploads.tgz
   pg_restore -l db.dump | head -5 ; tar tzf uploads.tgz | head -5 ; cd ..
   ```
4. **Levanta todo vacío** (`sh deploy/build.sh`, o `docker compose up -d --build`) y para lo que escribe datos:
   ```bash
   docker compose stop api worker web backup backup-b2
   ```
5. **Restaura la base y los archivos**:
   ```bash
   docker compose exec -T db pg_restore -U rag_owner -d rag --clean --if-exists --no-owner < restore/db.dump
   docker run --rm -v rag_uploads:/data -v "$PWD/restore":/restore alpine sh -c "rm -rf /data/* && tar xzf /restore/uploads.tgz -C /data"
   ```
6. **Arranca** con `docker compose up -d` (la API aplica las migraciones que falten) y **comprueba**: `curl http://localhost:8000/api/health`; entra con tu usuario de siempre (la contraseña del `SEED_ADMIN_*` ya no vale: se restauró la base real); confirma que el 2FA acepta tu código; abre un documento y haz una pregunta.
7. **Borra `restore/`** (`rm -rf restore`): contiene todos los datos sin cifrar.
8. Si el dominio es nuevo, actualiza el DNS o el túnel antes de dar el servicio por recuperado.

**Si los archivos se copian de forma incremental (`B2_SYNC_UPLOADS=true`)** no hay `uploads_….tgz.enc`: salta la parte de archivos de los pasos 2 y 3 y sustituye el `tar` del paso 5 por esto (rclone los baja ya descifrados):

```bash
mkdir restore-archivos
docker compose run --rm -v "$PWD/restore-archivos:/restore" backup-b2 --restore /restore
docker run --rm -v rag_uploads:/data -v "$PWD/restore-archivos":/restore alpine sh -c "rm -rf /data/* && cp -a /restore/. /data/"
rm -rf restore-archivos
```

Haz este ensayo una vez con una copia real, en otra máquina o en otra carpeta, antes de necesitarlo.

## Reprocesar varios documentos a la vez

Con las casillas de **Documentos**, elige los documentos y pulsa **Reprocesar** en la barra de selección (hasta 200). Útil con los que fallaron o tras cambiar el modelo de embeddings. Los que ya están en cola o procesándose se omiten para no duplicar trabajo.

## Papelera de documentos

Borrar un documento (uno o varios, desde **Documentos**) **no lo elimina**: lo manda a la **Papelera** (botón arriba a la derecha de Documentos, para administradores y editores). Mientras está allí no aparece en las colecciones, no sale en las respuestas del chat ni cuenta para el límite de documentos del plan, pero su archivo, sus fragmentos y sus vectores se conservan, así que **restaurarlo es inmediato** y no hay que procesarlo de nuevo.

- **Restaurar:** botón *Restaurar* en la fila, o varias casillas y *Restaurar*. Si el plan ya está lleno de documentos, los que no caben se quedan en la papelera y el aviso lo explica.
- **Eliminar definitivamente / Vaciar papelera:** solo administradores. Borra también el archivo y no se puede deshacer.
- **Caducidad:** a los `TRASH_RETENTION_DAYS` días (30 por defecto) la limpieza diaria lo elimina del todo. Con `TRASH_RETENTION_DAYS=0` no hay papelera y borrar elimina al instante, como antes.
- Subir el mismo archivo que está en la papelera de esa colección avisa de que hay que restaurarlo desde allí; mover documentos tampoco admite un archivo que ya esté en el destino, ni siquiera en su papelera.
- Queda en la auditoría: *Envió a la papelera*, *Restauró* y *Eliminó definitivamente*.
- Borrar una **colección** o una **organización** sí elimina todo, papelera incluida.
- Las copias de seguridad contienen también los documentos de la papelera hasta que se eliminan del todo; la papelera cubre los errores del día a día y las copias, los desastres.

### Cuánto tiempo se puede recuperar algo

Con la copia incremental a Backblaze (`B2_SYNC_UPLOADS=true`) cada cosa caduca por una razón distinta. **Ningún archivo caduca por ser antiguo**: un documento subido hace un año que sigue en la aplicación sigue en Backblaze.

| Qué | Dónde | Cuánto se conserva |
|---|---|---|
| Documento borrado en la aplicación | Papelera (se restaura con un clic) | `TRASH_RETENTION_DAYS` días (30) |
| Archivo que ya salió de la papelera, o que se reemplazó | `archive/AAAA-MM-DD` en Backblaze (se recupera con `--restore`) | `B2_KEEP_DAYS` días (30) **desde que se borró**, no desde que se subió |
| Archivos que existen hoy | `current` en Backblaze | Mientras existan |
| Base de datos | Una copia por día, en el servidor y en Backblaze | 7 días en el servidor (`BACKUP_KEEP_DAYS`) y 30 en Backblaze (`B2_KEEP_DAYS`) |

Un documento borrado queda recuperable unos **60 días** en total: 30 en la papelera y, cuando sale de ella y su archivo se borra del disco, otros 30 en `archive`. Pasado ese plazo no hay forma de recuperarlo. Para ampliar el margen sube `TRASH_RETENTION_DAYS` y `B2_KEEP_DAYS`; solo ocupa el espacio de lo que se haya borrado. Para volver a un estado anterior de la **base de datos** (documentos, usuarios, conversaciones) hay que restaurar una de sus copias diarias: se puede elegir cualquiera de los últimos 30 días.

## Borrar varios documentos a la vez

En **Documentos**, marca las casillas de la primera columna (la casilla de la cabecera selecciona todos los que ves, también tras buscar). Aparece una barra con **Enviar a la papelera** y **Quitar selección**; al pulsarlo se pide confirmación con los nombres. Se envían hasta 200 de una vez a la [papelera](#papelera-de-documentos), la caché de respuestas de las colecciones afectadas se vacía y queda **una sola entrada** en la auditoría («Envió varios documentos a la papelera», con la cantidad y los primeros nombres). La selección se vacía al cambiar de colección. Se pueden recuperar desde la papelera mientras no caduquen.

## Ordenar y filtrar la lista de documentos

En **Documentos**, pulsa el título de una columna (Documento, Estado, Tamaño, Páginas, Fragmentos, Subido) para ordenar; vuelve a pulsarlo para invertir el orden. Con *Estado* los que tienen error quedan arriba. Junto al buscador hay dos filtros: por **estado** (Listos, En proceso, Con error) y por **tipo** de archivo (solo los que existen en la colección); el icono del embudo los quita. Todo se hace en el navegador sobre los documentos de la colección y se reinicia al cambiar de colección.

## Mover documentos a otra colección

En **Documentos**, menú ⋮ del documento → **Mover a otra colección**; o marca varios con las casillas y pulsa **Mover** en la barra de selección. Conserva el título, el resumen y los fragmentos ya calculados (no se vuelve a procesar), y deja de verlo quien solo tenía acceso a la colección de origen. Reglas:

- Hay que ser administrador o editor **con acceso a las dos colecciones**; un editor no puede mover a una colección que no ve.
- El documento debe estar en estado *Listo*: mientras se procesa, el menú aparece desactivado.
- Si el mismo archivo ya está en la colección de destino, no se mueve (evita duplicados).
- Los que no se pueden mover (en proceso, ya en el destino, archivo duplicado allí) se omiten y el aviso dice cuáles y por qué; los demás se mueven.
- Queda en la auditoría («Movió documentos a otra colección», con cantidad y destino) y vacía la caché de respuestas de ambas colecciones.

No existe «copiar»: un documento pertenece a una sola colección. Para tenerlo en dos, hay que subirlo en la segunda.

## Reprocesar documentos

Hace falta después de cambiar `CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS` o el modelo de embeddings, o para reintentar documentos fallidos:

```bash
docker compose exec api node dist/scripts/reindex.js            # todos
docker compose exec api node dist/scripts/reindex.js mi-cliente # una organización (slug)
docker compose exec api node dist/scripts/reindex.js --failed   # solo los fallidos
```

Un documento concreto también se puede reprocesar desde la interfaz (botón ↻).

## Cambiar el modelo de embeddings

Los vectores de un modelo **no son compatibles** con los de otro, así que hay que regenerarlos todos.

**Mismo número de dimensiones** (p. ej. otro modelo de 768):
1. Cambia `EMBEDDING_MODEL` (y los prefijos si el modelo no es de la familia E5).
2. `docker compose up -d embeddings api worker`
3. Reprocesa todo (ver arriba).

**Distinto número de dimensiones** (p. ej. `BAAI/bge-m3`, 1024, que admite fragmentos más largos):
1. En `.env`:
   ```
   EMBEDDING_MODEL=BAAI/bge-m3
   EMBEDDING_DIM=1024
   EMBEDDING_QUERY_PREFIX=
   EMBEDDING_PASSAGE_PREFIX=
   ```
2. Cambia la columna (se borran los vectores actuales):
   ```bash
   docker compose exec -T db psql -U rag_owner -d rag <<'SQL'
   BEGIN;
   DELETE FROM chunks;
   DROP INDEX chunks_embedding_hnsw;
   ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1024);
   CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
   COMMIT;
   SQL
   ```
3. `docker compose up -d embeddings api worker` y reprocesa todo.

Modelos multilingües recomendados:

| Modelo | Dim. | Máx. tokens | Prefijos | Notas |
|---|---|---|---|---|
| `intfloat/multilingual-e5-small` | 384 | 512 | `query: ` / `passage: ` | El más rápido en CPU |
| `intfloat/multilingual-e5-base` | 768 | 512 | `query: ` / `passage: ` | **Por defecto**: buen equilibrio |
| `intfloat/multilingual-e5-large` | 1024 | 512 | `query: ` / `passage: ` | Mejor calidad, ~3 veces más lento |
| `BAAI/bge-m3` | 1024 | 8192 | ninguno | Fragmentos largos; más pesado |

## Calibrar la búsqueda

`POST /api/search` devuelve los resultados **sin llamar al LLM** (no gasta cupo), con:
- `vectorRank` / `keywordRank`: posición en cada lista (`null` = no apareció);
- `distance`: distancia coseno (0 = idéntico).

```bash
TOKEN=$(curl -s localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"login":"admin","password":"..."}' | jq -r .token)
curl -s localhost:8000/api/search -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"¿plazo de preaviso?"}' | jq '.results[] | {distance, vectorRank, keywordRank, documentTitle, heading}'
```

| Parámetro | Por defecto | Efecto |
|---|---|---|
| `RETRIEVAL_MAX_DISTANCE` | `0.25` | Por encima de esta distancia un fragmento no cuenta como resultado semántico. Con `multilingual-e5-base`, los fragmentos relevantes suelen estar entre 0,10 y 0,18 y los que no tienen relación por encima de 0,22. **Cada modelo tiene su escala**: mide preguntas relevantes e irrelevantes antes de ajustarlo. Si es muy bajo, el sistema dirá "no encontré información" demasiado a menudo. |
| `RETRIEVAL_TOP_K` | `6` | Fragmentos que se envían al LLM. Más da más contexto pero más tokens. |
| `RETRIEVAL_CANDIDATES` | `40` | Candidatos de cada lista antes de la fusión. |
| `CHUNK_SIZE_CHARS` | `1200` | Tamaño de los fragmentos. El modelo E5 lee como máximo 512 tokens (unos 1.800 caracteres en español), así que no conviene superar ~1.500. |
| `FTS_LANGUAGE` | `spanish` | Idioma de la búsqueda por palabras (raíces, palabras vacías). Cambiarlo requiere una migración nueva. |

## Re-ranking

El servicio `reranker` reordena los candidatos de la búsqueda con un modelo *cross-encoder* (lee pregunta y fragmento juntos). Es la mejora de calidad más importante, pero usa ~1,9 GB de RAM y ~0,6 s por pregunta en CPU.

| Parámetro | Por defecto | Efecto |
|---|---|---|
| `RERANKER_MODEL` | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | Con GPU, `BAAI/bge-reranker-v2-m3` es más preciso (en CPU tarda ~14 s; ver [decisiones.md §12](decisiones.md#12-re-ranker-mmarco-mminilmv2-en-lugar-de-bge-reranker-v2-m3)) |
| `RERANK_CANDIDATES` | `20` | Candidatos de la búsqueda híbrida que se reordenan. Más = mejor recall, más lento. |
| `RERANK_MIN_SCORE` | `0.02` | Puntuación mínima (0–1). Lo irrelevante puntúa ≈ 0,003 y lo relevante ≥ 0,1. Si ningún fragmento la alcanza, se responde "no encontré información" sin llamar al LLM. |

`POST /api/search` muestra `rerankScore` para cada resultado: úsalo para calibrar.

**Desactivarlo** (equipos con poca RAM), en `.env`:

```
RERANKER_URL=
RERANKER_REPLICAS=0
```

y `docker compose up -d`. Sin re-ranker se usa el orden de la búsqueda híbrida, y si el servicio falla temporalmente, la API sigue funcionando con ese orden.

## Caché de respuestas

Las primeras preguntas de cada conversación se guardan con su respuesta. Si alguien vuelve a preguntar lo mismo sobre los mismos documentos, se responde al instante y **sin gastar cupo** del LLM; la interfaz lo indica con "Respuesta guardada".

| Parámetro | Por defecto | Efecto |
|---|---|---|
| `CACHE_ENABLED` | `true` | Activa o desactiva la caché |
| `CACHE_TTL_HOURS` | `168` | Antigüedad máxima de una respuesta reutilizable (7 días) |
| `CACHE_MAX_DISTANCE` | `0.015` | Cuánto puede diferir una pregunta para considerarla igual. **No lo subas mucho:** con `multilingual-e5-base`, "factura 2026-0457" y "factura 2026-0458" están a 0,026. Por eso, además, los números y códigos deben coincidir. |

La caché se vacía sola en estos casos:
- al terminar de procesar, reprocesar o borrar un documento de la colección;
- al borrar la colección;
- cuando alguien marca la respuesta con 👎.

Para vaciarla a mano (por ejemplo, tras cambiar de modelo LLM o el prompt), usa **Calidad → Vaciar caché**.

## Valoraciones y página Calidad

Los usuarios valoran cada respuesta con 👍/👎 (el 👎 admite motivos y un comentario). En **Calidad**, los administradores ven:
- satisfacción, respuestas pendientes de revisar y porcentaje respondido desde caché (30 días);
- cada valoración con su pregunta, respuesta, fuentes y comentario, y la opción "Marcar revisada".

Un 👎 suele significar que falta un documento, que está desactualizado o que la información está dispersa. Revisa las fuentes citadas y, si hace falta, sube o actualiza el documento: la caché de esa colección se invalida sola.

## Resúmenes y preguntas sugeridas

Se generan **bajo demanda** (Documentos → abrir → Resumen → *Generar resumen*) porque cada uno es una llamada al LLM y **cuenta para el límite diario** de la organización. Cualquier usuario con acceso al documento puede generarlo; el resultado lo ven todos. Las preguntas sugeridas aparecen en la pantalla inicial del chat.

## Avisos en tiempo real

La interfaz recibe los cambios de estado de los documentos por `GET /api/documents/events` (Server-Sent Events). Si pones otro proxy delante (Caddy, Traefik, Cloudflare…), desactiva el *buffering* para `/api/` y permite conexiones largas; si no, los avisos llegarán tarde (la lista se refresca igualmente cada 20 s mientras haya documentos procesándose).

## Proveedores de LLM (OpenRouter, Groq, Google, OpenAI, DeepSeek, servidor propio)

El sistema habla con cualquier proveedor que ofrezca el formato «compatible con OpenAI». Configura **al menos uno** en el `.env` (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, o `LLM_CUSTOM_BASE_URL` para Ollama/vLLM) y aplica con `docker compose up -d`. Puedes tener **varios a la vez**.

**Qué proveedor usa cada modelo:** cada modelo de un plan se escribe con un prefijo de proveedor o sin él:

| Se escribe | Proveedor |
|---|---|
| `google/gemma-4-31b-it:free` (sin prefijo) | OpenRouter (o `LLM_DEFAULT_PROVIDER`) |
| `groq:openai/gpt-oss-120b` | Groq |
| `google:gemini-3.5-flash` | Google (Gemini) |
| `openai:gpt-4o-mini` | OpenAI |
| `deepseek:deepseek-chat` | DeepSeek |
| `custom:llama3.1:8b` | Servidor propio |

Los planes que ya tenías siguen funcionando sin cambios: sin prefijo es OpenRouter. En *Organizaciones → Planes* puedes mezclar, por ejemplo: primero un modelo de Groq y, **si falla o está saturado, uno de Google o de OpenRouter**. El respaldo cruza proveedores, así que ya no dependes de uno solo.

**Detalles que conviene saber**
- Al guardar un plan se comprueba que el proveedor tenga clave en el `.env` y que el modelo exista en su catálogo (si el catálogo no responde, no se bloquea).
- En *Consumo → Modelos usados* los modelos de OpenRouter salen como siempre y los demás con su prefijo (`groq:…`).
- Los tokens se leen de la respuesta del proveedor, así que valen para cualquiera. Si un servidor no los informa, quedan en blanco (no afecta a las respuestas).
- Una clave rechazada en un proveedor (401/403) hace pasar al siguiente modelo de otro proveedor; si era la única, el chat responde que la clave no es válida.
- **Claude directo (Anthropic) todavía no**: usa otro formato. Mientras tanto está disponible a través de OpenRouter (`anthropic/claude-…`).
- Con un servidor propio en Docker, `localhost` es el propio contenedor: usa `http://host.docker.internal:11434/v1` (Ollama en tu equipo) o el nombre de un servicio del compose.
- `GET /api/health` muestra `llm: [...]` con los proveedores configurados; vacío = el chat no puede responder.
- **Ver qué modelos puedes usar:** `docker compose exec -T api node dist/scripts/models.js groq google` lista el catálogo de cada proveedor con tus claves (sin argumentos, todos menos OpenRouter). Con `--probar` envía un mensaje mínimo a cada modelo y dice cuáles responden de verdad: aparecer en el catálogo no garantiza que sirva (Google lista modelos que dan 404 y los planes gratuitos tienen topes de tokens por minuto; en Groq gratuito puede hacer falta bajar `LLM_MAX_TOKENS`; DeepSeek exige saldo). Evita los modelos Gemma de Google para el chat: devuelven su razonamiento (`<thought>`) en la respuesta.
  Opciones para acotar la prueba (se combinan): `--ok` muestra solo los que responden, del más rápido al más lento; `--max-ms=1000` solo los que responden en menos de ese tiempo; `--filtro=gemini` solo los modelos con ese texto en el nombre (se aplica antes de probar, así ahorra tiempo y cuota); `--gratis` en OpenRouter, solo los gratuitos; `--forzar` permite probar más de 60 de una vez. Ejemplo: `… models.js google groq --max-ms=1500`. Con OpenRouter hay que acotar siempre (`openrouter --gratis --max-ms=3000`): tiene cientos de modelos.

## Modelos gratuitos de OpenRouter

Al guardar un plan (*Organizaciones → Planes*) se comprueba que cada modelo exista en el catálogo público de OpenRouter, y se rechazan los nombres mal escritos con su lista (p. ej. falta el `:free`). El catálogo se guarda una hora en memoria; si OpenRouter no responde, no se bloquea el guardado.

- Si las respuestas fallan con *"Los modelos gratuitos están saturados…"*, espera unos minutos, añade más modelos de respaldo al plan o pasa la organización a un plan con modelo de pago.
- Si un modelo deja de existir, se salta automáticamente (aparece `[llm] … falló (404)` en los registros). Actualiza la lista con los disponibles en <https://openrouter.ai/models?max_price=0>.
- El modelo usado en cada respuesta aparece bajo la respuesta y en **Consumo → Modelos usados**.

## Verificación en dos pasos (opcional)

Cada usuario puede activarla en **Mi cuenta → Verificación en dos pasos**. Para el superadministrador está recomendada.

- **Funciona en local, sin dominio, HTTPS ni correo.** El código lo calcula la app autenticadora (Google Authenticator, Aegis, 1Password…) a partir de un secreto compartido. Solo hace falta que el **reloj del servidor** sea correcto; con un desfase de más de ~30 s los códigos fallan.
- **Activar:** escanea el QR (o escribe la clave), confirma con el primer código y guarda los **8 códigos de recuperación** (se muestran una vez).
- **Entrar:** usuario y contraseña, y después el código de 6 dígitos. Un código no se puede reutilizar; con 5 fallos en 15 minutos se bloquea el intento.
- **Perdí el teléfono:** entra con un código de recuperación (cada uno sirve una vez) y vuelve a configurarlo. Si un usuario normal lo perdió todo, su administrador lo quita en **Usuarios → Quitar verificación en dos pasos**.
- **Superadministrador sin teléfono ni códigos:** nadie puede quitárselo desde la aplicación. Se hace en la base de datos: `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery_hashes = '{}' WHERE username = '<tu usuario>';`
- **Cuidado con `JWT_SECRET`:** el secreto TOTP se guarda cifrado con una clave derivada de él. Si lo cambias, el 2FA de todos queda inservible y hay que quitarlo y volver a activarlo.
- No aplica a las cuentas de soporte (entras con tu sesión de superadministrador).

## Límite de preguntas por organización

- Cada organización tiene un **plan** (**Organizaciones → Planes**) que fija el límite diario, los modelos y los topes de usuarios y documentos. `TENANT_DAILY_QUESTION_LIMIT` solo da el valor inicial del plan «Estándar» la primera vez que se crea.
- Excepción puntual: **Organizaciones → Límite diario** (vacío = el del plan; 0 = sin límite).
- Los administradores de cada organización ven su uso frente a los topes del plan en **Consumo**.
- **Tope por usuario (opcional):** un plan puede limitar las preguntas por día de **cada usuario** (*Organizaciones → Planes → Preguntas por día por usuario*), para que una sola persona no agote el cupo de todos. Al alcanzarlo, esa persona no puede preguntar más hoy aunque a la organización le queden. Cuenta preguntas y resúmenes (no las respuestas servidas desde la caché) y se reinicia a las 00:00 UTC.
- **Aviso en el chat:** cuando la organización llega al `QUOTA_WARN_PERCENT` % (80 por defecto) de su límite diario, todos sus usuarios ven sobre el cuadro de escritura «ha usado X de N preguntas de hoy»; al llegar al tope, el aviso pasa a rojo. Si el plan tiene tope por usuario, cada persona ve además su propio aviso. Se actualiza tras cada pregunta y no aparece en planes sin límite (0).
- **Aviso por correo:** además, con SMTP configurado, los administradores de la organización que tengan email reciben un correo **una sola vez al día** al llegar al `QUOTA_WARN_PERCENT` % y otro al agotar el límite (tabla `quota_notices`). Sin SMTP solo funciona el aviso del chat. Es el límite de la organización; la cuota personal solo avisa en el chat.
- Solo cuentan las preguntas que llegan al LLM. Las respuestas "no encontré información" no cuentan. El día se cuenta en UTC.

Reparte el cupo de OpenRouter (1.000 al día con créditos) entre tus clientes con este límite.

## Cambiar contraseñas de la base de datos

**Rotación automática (recomendada):** un solo comando cambia `POSTGRES_PASSWORD` y `APP_DB_PASSWORD` por contraseñas nuevas al azar, sin pasos manuales ni mostrarlas:

```bash
sh deploy/rotate-db-password.sh --dry-run   # solo muestra lo que haría
sh deploy/rotate-db-password.sh             # la rotación real
```

Guarda una copia del `.env` (`.env.bak-FECHA`), cambia la contraseña dentro de la base, escribe las nuevas en el `.env`, recrea los servicios y espera a que la API responda. **Si la API no responde, vuelve atrás sola** (restaura el `.env` y la contraseña anterior). Los servicios se reinician unos segundos. Cuando compruebes que todo va bien, borra el respaldo: `rm .env.bak-*` (contiene las contraseñas anteriores). Conviene rotarlas cada cierto tiempo y siempre que alguien con acceso al servidor deje el equipo. Las contraseñas nuevas solo viven en el `.env`: no hace falta que las veas.

**A mano**, si prefieres elegirlas tú:

- `APP_DB_PASSWORD`: cámbiala en `.env` y ejecuta `docker compose up -d api worker` (la API la aplica al arrancar).
- `POSTGRES_PASSWORD` (después del primer arranque): la base conserva la contraseña con la que se creó, así que hay que igualarla. Cambia el valor en `.env` y ejecuta:
  ```bash
  docker compose up -d db
  docker compose exec -T db sh < deploy/sync-db-password.sh
  docker compose up -d api worker backup
  ```
  El script usa la variable del propio contenedor: no muestra ni te pide la contraseña. Si la API ya está en bucle con `password authentication failed`, es exactamente esto.

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `health` → `embeddings: fetch failed` | El modelo aún se está descargando o cargando | `docker compose logs -f embeddings`; espera a `Ready` |
| `docker compose ps` → `docling` en `starting` o `unhealthy` | Docling arrancando (tarda 20–60 s) o caído | Espera; revisa `docker compose logs docling`. Los documentos subidos se procesan cuando esté `healthy` |
| La API no arranca y el log dice `no es una URL de PostgreSQL válida` | Falta o está mal `POSTGRES_PASSWORD` / `APP_DB_PASSWORD` | Revisa el `.env`. Las contraseñas con `/`, `+` o `=` (de `openssl rand -base64`) son válidas: la API las codifica sola |
| La API no arranca: «La base de datos rechazó la contraseña de POSTGRES_PASSWORD» (o `password authentication failed`) | La base conserva la contraseña con la que se creó el volumen y el `.env` ya no coincide | `docker compose exec -T db sh < deploy/sync-db-password.sh` y luego `docker compose up -d api worker backup` (ver «Cambiar contraseñas de la base de datos») |
| Documento en *Error*: "Docling no extrajo texto" | Archivo protegido con contraseña, dañado o vacío | Ábrelo y guárdalo de nuevo / quita la protección |
| Documento en *Error*: "dimensiones" | `EMBEDDING_DIM` no coincide con el modelo | Ver "Cambiar el modelo de embeddings" |
| Documentos atascados en *En cola* | El worker no está en marcha | `docker compose ps worker`; `docker compose logs worker` |
| Chat: "La clave de OpenRouter no es válida" | `OPENROUTER_API_KEY` vacía o incorrecta | Corrígela en `.env` y ejecuta `docker compose up -d api` |
| Chat: "No endpoints found matching your data policy" (en registros) | La privacidad de OpenRouter bloquea los proveedores gratuitos | [instalacion.md §3](instalacion.md#3-clave-y-privacidad-en-openrouter) |
| Chat: "límite de N preguntas por día" | Límite de la organización | Ajusta el límite (ver arriba) |
| Siempre "No encontré información" | `RERANK_MIN_SCORE` demasiado alto, `RETRIEVAL_MAX_DISTANCE` demasiado bajo o documentos sin procesar | Revisa `rerankScore` y `distance` con `/api/search` |
| `health` → `reranker: fetch failed` | El modelo se está descargando o no hay RAM suficiente | `docker compose logs reranker`; si sale `Killed`/`137`, falta memoria: desactívalo (ver "Re-ranking") |
| El visor muestra "No se pudo mostrar el PDF" | PDF protegido con contraseña o dañado | Descarga el original; reprocesa el documento si lo sustituyes |
| "El texto citado no está en esta página" | El fragmento empieza en una página y sigue en la siguiente, o es una tabla | Usa las flechas de página; el resaltado se calcula en cada página |
| Los documentos no cambian de estado solos | Un proxy acumula la conexión en vivo | Ver "Avisos en tiempo real" |
| Respuesta "guardada" desactualizada | Se cambió el documento fuera del sistema o el prompt/modelo | Márcala con 👎 o usa Calidad → Vaciar caché |
| Las respuestas no llegan en streaming detrás de otro proxy | El proxy acumula la respuesta | Desactiva el *buffering* para `/api/chat` |
| PDF escaneado con texto incorrecto | OCR con idioma equivocado | Ajusta `DOCLING_OCR_LANGS` y reprocesa |
| `ports are not available … bind: Intento de acceso a un socket no permitido` (Windows) o `address already in use` | El puerto está ocupado (p. ej. un PostgreSQL instalado) o reservado por Windows/Hyper-V | Cambia `WEB_PORT`, `DB_PORT`, o `EMBEDDINGS_PORT` en `.env`. En Windows, los rangos reservados se ven con `netsh interface ipv4 show excludedportrange protocol=tcp` |
| El invitado dice que el enlace "no es válido o ha caducado" | Caducó, ya se usó o se generó uno más nuevo | Usuarios → ⋮ → *Reenviar invitación* |
| No llegan los correos | SMTP mal configurado o bloqueado por spam | `docker compose logs api \| grep correo`; revisa `SMTP_*`, SPF/DKIM; prueba con Mailpit |
| Caddy no obtiene el certificado | DNS aún sin propagar o puertos 80/443 cerrados | `docker compose logs caddy`; comprueba el registro A y el cortafuegos |
| Tras actualizar, una página muestra "Hay una versión nueva de la aplicación" | La pestaña tenía abierta la versión anterior | Pulsa **Recargar** (la app intenta recargarse sola una vez) |
| `password authentication failed for user "rag_owner"` | Se cambió `POSTGRES_PASSWORD` después del primer arranque | Ver "Cambiar contraseñas de la base de datos" |

## Restablecer la contraseña del superadministrador

Si no puedes entrar (olvidaste la contraseña, o cambiaste `SEED_ADMIN_PASSWORD` en el `.env` después del primer arranque: ese valor solo se usa con la base vacía), restablécela **desde el servidor**:

```bash
docker compose exec api node dist/scripts/reset-password.js admin
```

Te pide la nueva contraseña dos veces, sin mostrarla. Variantes:

| Comando | Qué hace |
|---|---|
| `... reset-password.js admin --generar` | Crea una contraseña aleatoria y la muestra una sola vez (no hace falta terminal). |
| `... reset-password.js admin --quitar-2fa` | Además quita su verificación en dos pasos (perdió el teléfono y los códigos). |
| `sh deploy/reset-password.sh admin` | Atajo equivalente desde la carpeta del proyecto. |

Cierra todas las sesiones abiertas de ese usuario y deja constancia en su auditoría («Consola del servidor»). Vale para cualquier usuario, no solo el superadmin. En Windows, si Git Bash dice *«the input device is not a TTY»*, ejecútalo desde PowerShell o con `winpty` delante. No existe forma de hacerlo desde la web: hace falta acceso al servidor.

## Usuarios: invitaciones y contraseñas

- **Invitar** (Usuarios → Nuevo usuario → *Enviar invitación*): se crea el usuario sin contraseña y se genera un enlace de un solo uso (caduca en `INVITE_EXPIRES_HOURS`, 72 h). Si hay SMTP se envía por correo; siempre se muestra al administrador para que pueda copiarlo.
- **Reenviar invitación / enlace para restablecer**: menú ⋮ del usuario. Cada enlace nuevo anula el anterior.
- **¿Olvidaste la contraseña?** (pantalla de login): requiere SMTP y que la cuenta tenga email. Se puede pedir con el usuario o con el email. Responde lo mismo exista o no la cuenta, para no revelar quién la tiene. Los usuarios sin email (o si no hay SMTP) piden a un administrador que restablezca su contraseña desde *Usuarios → Definir contraseña*. El enlace caduca en `RESET_EXPIRES_MINUTES` (60 min).
- Los enlaces solo se guardan como hash SHA-256 en la base de datos.

## Borrar una organización

**Organizaciones → ⋮ → Borrar definitivamente.** Solo aparece en organizaciones ya **desactivadas** (primero se desactiva) y pide escribir su identificador. Borra usuarios, documentos, fragmentos, conversaciones, caché, auditoría y los archivos subidos. No se puede deshacer, y queda constancia (`tenant.deleted`, con nombre, usuarios y documentos) en la auditoría de tu organización.

> Las **copias de seguridad** conservan sus datos hasta que caducan (`BACKUP_KEEP_DAYS`, 7 por defecto). Si un cliente exige el borrado total, elimina también las copias anteriores de `./backups`.

## Cambiar el nombre o el identificador de una organización

**Organizaciones → ⋮ → Renombrar** (cambia el nombre y el identificador). `SEED_TENANT_NAME` y `SEED_TENANT_SLUG` del `.env` solo dan los valores iniciales (primer arranque); después se cambian aquí. El identificador (`slug`) es el nombre técnico: minúsculas, números y guiones, único. Solo se muestra y se pide para confirmar un borrado; no aparece en URLs ni en rutas de archivos, así que cambiarlo no afecta a usuarios ni documentos.

## Entrar en una organización como soporte

El superadministrador puede ver y gestionar cualquier organización con su propio usuario: **Organizaciones → ⋮ → Entrar como soporte**. Arriba aparece un aviso con **Volver a mi organización**. Se entra con permisos de administrador y queda registrado en la auditoría del cliente (categoría *Soporte*). Detalles en [permisos.md](permisos.md#acceso-de-soporte-del-superadministrador).

## Auditoría

Página **Auditoría** (administradores): inicios de sesión (también los fallidos), invitaciones, cambios de rol y de acceso, documentos subidos/borrados, resúmenes, vaciados de caché, organizaciones… con fecha, usuario, detalles e IP. Se conserva `AUDIT_RETENTION_DAYS` días (365).

## Registros estructurados

Los registros de la API y del worker son **una línea JSON por evento** (`LOG_FORMAT=json`, por defecto): hora, nivel (`info`/`warn`/`error`), mensaje, `component` (`api`, `llm`, `ingest`, `monitor`…) y, si procede, el error con su traza. Cada petición HTTP deja una línea `http` con método, ruta, estado, duración en milisegundos, IP y, con sesión, `userId` y `tenantId`; no se guarda la query ni el cuerpo. Todas las líneas generadas durante una petición llevan su `requestId`, que el cliente también recibe en la cabecera `X-Request-Id` (y en el cuerpo de los errores 500): si alguien reporta un fallo, con ese código se encuentra todo lo que pasó.

Para leerlos sin el prefijo de Docker y filtrarlos con `jq`:

```bash
docker compose logs --no-log-prefix api | jq -c 'select(.level=="error")'              # solo errores
docker compose logs --no-log-prefix api | jq -c 'select(.requestId=="a1b2c3d4")'       # una petición concreta
docker compose logs --no-log-prefix api | jq -c 'select(.msg=="http" and .status>=500)' # respuestas 5xx
docker compose logs --no-log-prefix api | jq -c 'select(.msg=="http" and .ms>2000)'     # peticiones lentas
docker compose logs --no-log-prefix api | jq -c 'select(.component=="llm")'             # fallos de los modelos
```

Con `LOG_FORMAT=text` vuelve el formato anterior, legible a simple vista.

## Límite por IP y 2FA de administradores

- **Límite por IP:** a las peticiones que **no traen una sesión válida** se les aplica un tope por IP (`IP_RATE_LIMIT_PER_MIN`, 120 por minuto; `0` lo desactiva). Frena escaneos, intentos de adivinar enlaces de invitación o restablecimiento e inundación de la API. Quien ya inició sesión no cuenta (tiene límites por usuario) y `/api/health` queda fuera. Pasado el tope, esa IP recibe `429` con `Retry-After: 60`. Tras un proxy se usa la IP real que pone nginx o el túnel en `X-Forwarded-For`.
- **2FA de administradores:** es **opcional por usuario**. Con `REQUIRE_ADMIN_2FA=true` pasa a ser obligatorio para todos los administradores de organización (hasta activarlo solo pueden entrar a *Mi cuenta*). El superadministrador se rige por `REQUIRE_SUPERADMIN_2FA` (obligatorio con dominio real). Por defecto, a nadie más se le obliga.

## Monitorización y alertas

El worker revisa **cada 5 minutos**:

| Comprobación | Se considera un problema cuando… |
|---|---|
| Disco de archivos | queda menos del `ALERT_DISK_FREE_PERCENT` % libre (15) |
| Cola de documentos | hay documentos en cola o procesándose desde hace más de `ALERT_QUEUE_MINUTES` minutos (30): worker caído o Docling atascado |
| Copias de seguridad | la copia más reciente en `./backups` tiene más de `ALERT_BACKUP_HOURS` horas (36), o no hay ninguna |
| Modelo de lenguaje | en los últimos 15 minutos fallaron 3 o más preguntas y ninguna se contestó (claves vencidas, cuota agotada) |

Cada problema avisa **una vez al empezar**, recuerda **cada 24 horas** mientras siga y avisa de nuevo **al resolverse**. Con `ALERT_EMAIL=tu@correo.com` (varios, separados por comas) y SMTP configurado llega por correo; sin eso solo queda en los registros (`docker compose logs worker | grep monitor`). La comprobación de copias necesita que el worker vea `./backups` (ya está montada en solo lectura).

Esto no sustituye a un monitor externo: si se cae todo el servidor no puede avisarte. Para eso añade un servicio gratuito (UptimeRobot, Better Stack…) que consulte `https://tu-dominio/api/health` cada minuto.

## Mantenimiento automático

El worker ejecuta cada día a las 03:15 (UTC) una limpieza: auditoría más antigua que la retención, enlaces usados o caducados, respuestas en caché vencidas y documentos que llevan más de `TRASH_RETENTION_DAYS` días en la papelera. No requiere intervención.

## Seguridad del despliegue

- **Secretos:** si `DOMAIN` es un dominio real, la API no arranca con `JWT_SECRET`, `APP_DB_PASSWORD` o `POSTGRES_PASSWORD` iguales a los del `.env.example` o demasiado cortos (mínimo 32, 16 y 16), ni crea el primer administrador con la contraseña de ejemplo. En local (sin dominio) no se exige. Genera claves con `openssl rand -base64 48`.
- **Archivos subidos:** además de la extensión y el tamaño, se comprueba que el contenido corresponda al formato (firma de PDF, Office e imágenes; sin bytes nulos en los de texto). Un ejecutable renombrado a `.pdf` se rechaza con el motivo en el resultado de la subida.
- **Antivirus (opcional, ClamAV):** analiza cada archivo en el momento de subirlo y rechaza los infectados («Contiene un virus (firma)»), dejando constancia en la auditoría (`document.infected`). Para activarlo, en el `.env` añade `antivirus` a `COMPOSE_PROFILES` (p. ej. `COMPOSE_PROFILES=https,antivirus`) y pon `CLAMAV_HOST=clamav`; luego `docker compose up -d`. La primera vez descarga la imagen y las firmas (~300 MB; las actualiza solo cada día). **Falla cerrado:** si el antivirus está activado y no responde, las subidas se rechazan en vez de aceptarse sin analizar; `/api/health` muestra su estado. Consume ~1-2 GB de RAM (ver [requisitos](requisitos.md)). Los archivos que ya estaban subidos no se vuelven a analizar. Para probarlo sin riesgo, usa el archivo de prueba estándar EICAR (inofensivo; tu antivirus del equipo puede avisar al guardarlo en disco).
- **Docling aislado:** el conversor procesa archivos de usuarios, así que vive en una red interna (`ingest`) sin salida a internet ni acceso a la base de datos; solo el worker llega a él. No publica ningún puerto en tu máquina. Para depurarlo: `docker compose exec worker wget -qO- http://docling:5001/health`.
- **Contenedores de la API y el worker:** sin privilegios nuevos y sin capacidades de Linux (`no-new-privileges`, `cap_drop: ALL`).
- **Prompt injection:** los fragmentos de los documentos van entre `<documentos>` como datos y, después de ellos, el prompt recuerda que no son instrucciones. Antes de entrar en el prompt, todo texto ajeno (contenido, títulos, secciones y la pregunta) se limpia: se neutralizan las etiquetas de cierre y apertura en todas sus variantes (mayúsculas, espacios, atributos, signos de ancho completo, entidades HTML y caracteres invisibles), las marcas de plantillas de chat (`<|im_start|>`, `[INST]`, `<<SYS>>`, `<start_of_turn>`…), las cabeceras falsas `[n] Documento:` y los separadores `---` que imitarían otro fragmento, y se eliminan los controles bidireccionales («Trojan Source»). Una batería de pruebas con documentos hostiles (`apps/api/test/injection.test.ts`) lo comprueba. No es infalible (ningún modelo lo es): una orden en lenguaje natural dentro de un documento sigue llegando al modelo como dato y depende de que la obedezca o no; por eso las respuestas muestran siempre las fuentes citadas. En la pantalla, las imágenes de las respuestas no se cargan y cada enlace muestra su dominio, para que una respuesta manipulada no pueda filtrar datos por la dirección.
- **Sesiones revocables:** cambiar la contraseña, restablecerla (enlace o administrador), quitar el 2FA a un usuario o pulsar **Mi cuenta → Cerrar todas las sesiones** invalida todas las sesiones anteriores de ese usuario al instante. Al cambiar tu propia contraseña, la sesión actual se renueva y las demás se cierran.
- **Límites por usuario** (no por IP, que se puede falsear): 20 preguntas, 60 búsquedas, 30 subidas y 10 resúmenes por minuto. Se suman al límite diario de cada plan. Al pasarlos, la API responde `429`.
- **2FA del superadministrador:** `REQUIRE_SUPERADMIN_2FA` = `auto` (por defecto: **se exige solo cuando `DOMAIN` es un dominio real**; en local nunca se te pide), `true` (siempre) o `false` (nunca; se puede, pero no se recomienda en producción). Si está activo y la cuenta aún no tiene 2FA, la plataforma solo la deja ir a **Mi cuenta** hasta activarlo (la API responde `403` con `code: mfa_setup_required` al resto de rutas). Para un administrador normal sigue siendo opcional.
- **Aviso de modo soporte:** cada entrada y salida queda en la auditoría del cliente (`support.entered`); no hay aviso aparte porque el único que puede entrar eres tú.
- **Cabeceras de seguridad** (nginx, `apps/web/security-headers.conf`): `Content-Security-Policy` estricta (solo recursos del propio sitio; el visor de PDF usa un worker propio), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin` y `Permissions-Policy` sin cámara, micrófono ni geolocalización. `Strict-Transport-Security` la añade Caddy con HTTPS. Si añades un recurso externo (fuentes, analítica), hay que permitirlo en esa CSP.
- **Dependencias:** el CI ejecuta `pnpm audit --audit-level=high` y falla con vulnerabilidades altas o críticas; Dependabot abre un PR semanal agrupado (npm, GitHub Actions y las imágenes Docker). Para revisarlo a mano: `pnpm audit`.
- **Aislamiento entre organizaciones:** las pruebas de Row Level Security corren siempre en el CI (`RUN_DB_TESTS=1` con PostgreSQL). Si algún cambio rompe el aislamiento, no se puede fusionar.
- **nginx y la API:** nginx vuelve a resolver el nombre `api` cada 5 s; si recreas la API ya no hace falta reiniciar `web` (antes daba `502 Bad Gateway`).

## Lista para producción

Ver la lista completa en [produccion.md](produccion.md#lista-de-comprobación).
