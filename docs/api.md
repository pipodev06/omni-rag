# Referencia de la API

Base: `http://localhost:8000/api` (a través de nginx) o `http://localhost:3001/api` (API directa en desarrollo).

**Autenticación:** el login devuelve una cookie `httpOnly` (navegador) y también un `token`. Desde scripts usa la cabecera `Authorization: Bearer <token>`.

**Errores:** siempre JSON `{ "error": "mensaje legible" }` con el código HTTP correspondiente (`400` datos inválidos, `401` sin sesión, `403` sin permiso, `404`, `409` duplicado, `413` demasiado grande, `429` límite, `502/503` dependencia caída).

## Salud

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| GET | `/health` | público | Estado de `database`, `embeddings`, `docling`, `reranker` (o `desactivado`) y si `openrouter` está configurado. `503` si la base de datos no responde. |

## Sesión — `/auth`

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` + cookie. Máx. 10 intentos / 15 min por IP y email. |
| POST | `/auth/logout` | — | Borra la cookie |
| GET | `/auth/me` | — | `{ user, tenant }` |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | `{ ok }` (mín. 10 caracteres) |

## Chat y búsqueda

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| POST | `/chat` | todos | Pregunta con respuesta en streaming (ver abajo) |
| POST | `/search` | todos | `{ query, collectionIds?, topK? }` → `{ results: SearchHit[] }`. **No usa el LLM.** |
| GET | `/conversations` | todos | Las 200 conversaciones más recientes del usuario |
| GET | `/conversations/:id` | dueño | `{ conversation, messages }` (con `sources` de cada respuesta) |
| DELETE | `/conversations/:id` | dueño | Borra la conversación |

### `POST /chat`

```json
{ "question": "¿Cuál es el plazo de preaviso?", "conversationId": "opcional", "collectionIds": ["opcional"] }
```

Responde `text/event-stream` con estos eventos:

| Evento | `data` (JSON) |
|---|---|
| `meta` | `{ conversationId, sources: Source[] }`: fragmentos recuperados |
| `token` | `"texto"`: trozo de la respuesta (repetido) |
| `done` | `{ messageId, model, sources, fromCache }`: `sources[i].cited` indica si la respuesta lo citó; `fromCache` si salió de la caché (sin LLM) |
| `error` | `{ message }` |

Antes de empezar el streaming puede responder JSON normal con `429` (límite diario), `404` (conversación) o `400`.

```bash
curl -N localhost:8000/api/chat -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"question":"¿Cuántos días de vacaciones hay?"}'
```

`Source`:
```json
{ "n": 1, "documentId": "…", "documentTitle": "Contrato", "heading": "Plazos",
  "pageStart": 2, "pageEnd": 3, "excerpt": "…", "cited": true }
```

`SearchHit` (`/search`): `chunkId, documentId, documentTitle, collectionId, heading, content, pageStart, pageEnd, score, vectorRank, keywordRank, distance, rerankScore` (`rerankScore` es `null` si el re-ranker está desactivado).

Los mensajes de `GET /conversations/:id` incluyen `fromCache` y `feedback` (`1`, `-1` o `null`).

## Valoraciones — `/messages`

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| PUT | `/messages/:id/feedback` | dueño del mensaje | `{ rating: 1 \| -1, comment? }`. Crea o cambia la valoración. Un `-1` borra la respuesta de la caché. |
| DELETE | `/messages/:id/feedback` | dueño del mensaje | Quita la valoración |

## Calidad — `/quality` (admin)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/quality?rating=-1&status=pending` | `{ summary: { positive, negative, pendingNegative }, usage: { questions, cacheHits }, cache: { entries }, items: [...] }`. `rating` (`1`/`-1`) y `status` (`pending`/`all`) son opcionales. |
| PATCH | `/quality/feedback/:id` | `{ resolved: boolean }`: marcar como revisada o reabrir |
| DELETE | `/quality/cache` | Vacía la caché de respuestas de la organización → `{ deleted }` |

## Documentos — `/documents`

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| GET | `/documents?collectionId=` | todos | Documentos visibles + `supportedExtensions` |
| GET | `/documents/:id` | todos | Un documento |
| GET | `/documents/:id/chunks` | todos | Fragmentos generados (para revisar la fragmentación) |
| GET | `/documents/:id/file` | todos | Descarga el original |
| POST | `/documents` | admin, editor | `multipart/form-data`: `collectionId` + uno o varios `file` |
| POST | `/documents/:id/reprocess` | admin, editor | Vuelve a indexar |
| DELETE | `/documents/:id` | admin, editor | Borra el documento, sus fragmentos y el archivo |

Respuesta de la subida (`201`):
```json
{ "results": [
  { "filename": "a.pdf", "id": "…", "status": "queued" },
  { "filename": "a-copia.pdf", "id": "…", "status": "duplicate", "reason": "Ya existe en esta colección" },
  { "filename": "virus.exe", "status": "rejected", "reason": "Formato no soportado…" } ] }
```

Estados de un documento: `pending` → `processing` → `ready` | `failed` (con `error`).

```bash
curl localhost:8000/api/documents -H "authorization: Bearer $TOKEN" \
  -F collectionId=<uuid> -F file=@contrato.pdf -F file=@manual.docx
```

## Colecciones — `/collections`

| Método | Ruta | Acceso | Cuerpo |
|---|---|---|---|
| GET | `/collections` | todos | → `{ collections: [{ id, name, description, documentCount, memberIds }] }` (solo las accesibles) |
| POST | `/collections` | admin | `{ name, description? }` |
| PATCH | `/collections/:id` | admin | `{ name?, description? }` |
| DELETE | `/collections/:id` | admin | Borra también sus documentos |
| PUT | `/collections/:id/members` | admin | `{ userIds: [] }` (reemplaza la lista) |

## Usuarios — `/users` (admin)

| Método | Ruta | Cuerpo |
|---|---|---|
| GET | `/users` | → `{ users: [{ id, email, name, role, isActive, lastLoginAt, collectionIds }] }` |
| POST | `/users` | `{ email, name, password, role, collectionIds? }` |
| PATCH | `/users/:id` | `{ name?, role?, isActive?, password? }` (no puedes quitarte el rol de admin ni desactivarte) |

## Consumo — `/usage` (admin)

`GET /usage` → `{ daily: [{ day, questions, cacheHits, promptTokens, completionTokens }], byModel: [{ model, questions }], totals: { documents, chunks, users } }` (últimos 30 días).

## Plataforma — `/platform` (superadministrador)

| Método | Ruta | Cuerpo |
|---|---|---|
| GET | `/platform/tenants` | → lista con nº de usuarios y documentos |
| POST | `/platform/tenants` | `{ name, slug, dailyQuestionLimit?, admin: { email, name, password } }` → crea la organización, su admin y la colección "General" |
| PATCH | `/platform/tenants/:id` | `{ name?, isActive?, dailyQuestionLimit? }` (`null` = límite global, `0` = sin límite) |

Desactivar una organización bloquea el acceso de todos sus usuarios de inmediato sin borrar datos.
