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

```bash
# Base de datos
docker compose exec -T db pg_dump -U rag_owner -Fc rag > backup-$(date +%F).dump
# Archivos originales
docker run --rm -v rag_uploads:/data -v "$PWD":/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .
```

Restaurar (con el sistema parado salvo `db`):

```bash
docker compose up -d db
docker compose exec -T db pg_restore -U rag_owner -d rag --clean --if-exists < backup-AAAA-MM-DD.dump
docker run --rm -v rag_uploads:/data -v "$PWD":/backup alpine tar xzf /backup/uploads-AAAA-MM-DD.tgz -C /data
docker compose up -d
```

> En un servidor nuevo, `pg_restore` mostrará avisos `role "rag_app" does not exist`. Son normales: al arrancar, la API crea el usuario `rag_app` con `APP_DB_PASSWORD` y vuelve a aplicar sus permisos.

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
  -d '{"email":"admin@example.com","password":"..."}' | jq -r .token)
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

## Modelos gratuitos de OpenRouter

- Si las respuestas fallan con *"Los modelos gratuitos están saturados…"*, espera unos minutos o añade más modelos a `LLM_MODELS`.
- Si un modelo deja de existir, se salta automáticamente (aparece `[llm] … falló (404)` en los registros). Actualiza la lista con los disponibles en <https://openrouter.ai/models?max_price=0>.
- El modelo usado en cada respuesta aparece bajo la respuesta y en **Consumo → Modelos usados**.

## Límite de preguntas por organización

- Global: `TENANT_DAILY_QUESTION_LIMIT` (0 = sin límite).
- Por organización: **Organizaciones → Límite diario** (vacío = global).
- Solo cuentan las preguntas que llegan al LLM. Las respuestas "no encontré información" no cuentan. El día se cuenta en UTC.

Reparte el cupo de OpenRouter (1.000 al día con créditos) entre tus clientes con este límite.

## Cambiar contraseñas de la base de datos

- `APP_DB_PASSWORD`: cámbiala en `.env` y ejecuta `docker compose up -d api worker` (la API la aplica al arrancar).
- `POSTGRES_PASSWORD` (después del primer arranque):
  ```bash
  docker compose exec db psql -U rag_owner -d rag -c "ALTER ROLE rag_owner PASSWORD 'nueva'"
  # luego cámbiala en .env y reinicia: docker compose up -d
  ```

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `health` → `embeddings: fetch failed` | El modelo aún se está descargando o cargando | `docker compose logs -f embeddings`; espera a `Ready` |
| `health` → `docling: fetch failed` | Docling arrancando (tarda 20–60 s) | Espera; revisa `docker compose logs docling` |
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
| `ports are not available … bind: Intento de acceso a un socket no permitido` (Windows) o `address already in use` | El puerto está ocupado (p. ej. un PostgreSQL instalado) o reservado por Windows/Hyper-V | Cambia `WEB_PORT`, `DB_PORT`, `EMBEDDINGS_PORT` o `DOCLING_PORT` en `.env`. En Windows, los rangos reservados se ven con `netsh interface ipv4 show excludedportrange protocol=tcp` |
| `password authentication failed for user "rag_owner"` | Se cambió `POSTGRES_PASSWORD` después del primer arranque | Ver "Cambiar contraseñas de la base de datos" |

## Lista para producción

- [ ] Contraseñas y `JWT_SECRET` aleatorios y distintos; `.env` fuera del control de versiones (ya está en `.gitignore`).
- [ ] HTTPS delante de `:8000` y `COOKIE_SECURE=true`.
- [ ] Contraseña del superadministrador cambiada tras el primer acceso.
- [ ] Copias de seguridad automáticas (base de datos y `rag_uploads`) guardadas fuera del servidor y restauración probada.
- [ ] Créditos de OpenRouter (1.000 peticiones al día) y límites por organización ajustados.
- [ ] Política de privacidad de OpenRouter revisada y aceptada por los clientes.
- [ ] Cortafuegos: solo 443 (o 8000) abierto; los puertos de `db`, `embeddings` y `docling` ya escuchan solo en `127.0.0.1`.
- [ ] Monitorización de `GET /api/health` y del espacio en disco.
