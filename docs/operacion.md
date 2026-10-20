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
| Siempre "No encontré información" | `RETRIEVAL_MAX_DISTANCE` demasiado bajo o documentos sin procesar | Revisa con `/api/search` |
| Las respuestas no llegan en streaming detrás de otro proxy | El proxy acumula la respuesta | Desactiva el *buffering* para `/api/chat` |
| PDF escaneado con texto incorrecto | OCR con idioma equivocado | Ajusta `DOCLING_OCR_LANGS` y reprocesa |
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
