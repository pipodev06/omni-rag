# Referencia de la API

Base: `http://localhost:8000/api` (a través de nginx) o `http://localhost:3001/api` (API directa en desarrollo).

**Autenticación:** el login devuelve una cookie `httpOnly` (navegador) y también un `token`. Desde scripts usa la cabecera `Authorization: Bearer <token>`.

**Errores:** siempre JSON `{ "error": "mensaje legible" }` con el código HTTP correspondiente (`400` datos inválidos, `401` sin sesión, `403` sin permiso, `404`, `409` duplicado, `413` demasiado grande, `429` límite, `502/503` dependencia caída). Cada respuesta lleva la cabecera `X-Request-Id` (y los `500` también el campo `requestId`): sirve para localizar la petición en los registros. Las peticiones sin sesión válida tienen un tope por IP (`IP_RATE_LIMIT_PER_MIN`); al superarlo responden `429` con `Retry-After: 60`.

## Salud

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| GET | `/quota` | cualquier usuario | `{ used, limit, level, warnPercent, user }`: preguntas de hoy de la organización frente al límite de su plan; `user` = `{ used, limit, level }` con la cuota personal si el plan la define, o `null`. `level`: `ok`, `warn` (desde `QUOTA_WARN_PERCENT` %), `full` o `unlimited` |
| GET | `/health` | público | Estado de `database`, `embeddings`, `reranker` (o `desactivado`) y si `openrouter` está configurado. `llm` lista los proveedores de LLM configurados (vacío = el chat no puede responder). `antivirus` es `ok`, `desactivado` o el motivo del fallo. `docling` aparece como «aislado»: vive en una red interna que solo alcanza el worker, y su estado se ve con `docker compose ps`. `503` si la base de datos no responde. |

## Sesión — `/auth`

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/login` | `{ login, password }` (`login` = usuario o email; también se acepta `email`) | `{ token, user }` + cookie. Máx. 10 intentos / 15 min por IP y usuario. |
| POST | `/auth/logout` | — | Cierra la sesión: la marca como cerrada en el servidor (el token deja de valer) y borra la cookie |
| GET | `/auth/me` | — | `{ user, tenant, support, mfaSetupRequired }`. `tenant` = `{ name, slug, isPlatform }`: `isPlatform` es `true` para la organización interna «Plataforma», donde vive el superadministrador. `support` = `{ name, username }` del superadministrador si la sesión es de soporte, o `null` |
| POST | `/auth/exit-support` | — | Sale del modo soporte y vuelve a la sesión del superadministrador: `{ token, user }` + cookie |
| POST | `/auth/change-password` | `{ newPassword, code? }` | `{ ok }` (mín. 10 caracteres). No pide la contraseña anterior; con 2FA activo exige `code` (TOTP o de recuperación). Cierra las demás sesiones |
| GET | `/auth/config` | — | `{ emailEnabled }` (si hay SMTP configurado) |
| POST | `/auth/login/totp` | `{ mfaToken, code }`: segundo paso si `/auth/login` devolvió `{ mfaRequired: true, mfaToken }` (el token dura 5 min y no abre sesión). `code` = 6 dígitos de la app o un código de recuperación | Igual que el login. Máx. 5 intentos / 15 min por usuario. Un código TOTP no se puede reutilizar |
| POST | `/auth/logout-all` | — | Cierra todas las sesiones del usuario (incluida la actual). Un `401` posterior = la sesión se cerró |
| GET | `/auth/sessions` | sesión | Dispositivos con la cuenta abierta → `{ sessions: [{ id, createdAt, lastSeenAt, ip, userAgent, current }] }`. No disponible en modo soporte || DELETE | `/auth/sessions/:id` | sesión | Cierra una sesión concreta de la persona (`404` si no existe o es de otra) → `{ ok, current }`; si es la actual, borra la cookie. Auditoría `auth.session_revoked` |
| POST | `/auth/totp/setup` | — | `{ secret, otpauthUrl }`: empieza la configuración (aún inactiva) |
| POST | `/auth/totp/enable` | `{ code }` | `{ recoveryCodes[] }` (8, solo se muestran esta vez): confirma y activa el 2FA |
| POST | `/auth/totp/disable` | `{ password, code }` | Desactiva el 2FA (contraseña + código TOTP o de recuperación) |
| POST | `/auth/forgot` | `{ login }` (usuario o email) | `{ ok }` siempre (no revela si la cuenta existe). Envía un enlace si hay SMTP y la cuenta tiene email. Máx. 5 / hora por IP y usuario |
| GET | `/auth/link?token=` | — | `{ kind: "invite" \| "reset", username, email, name }` o `404` si caducó o ya se usó |
| POST | `/auth/link` | `{ token, password, name? }` | Fija la contraseña (y el nombre en invitaciones), invalida el enlace e inicia sesión: `{ token, user }` + cookie |

## Chat y búsqueda

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| POST | `/chat` | todos | Pregunta con respuesta en streaming (ver abajo) |
| POST | `/search` | todos | `{ query, collectionIds?, topK? }` → `{ results: SearchHit[] }`. **No usa el LLM.** |
| GET | `/conversations?q=` | todos | Las 200 conversaciones más recientes del usuario. Con `q` filtra por el título o el texto de los mensajes (sin distinguir mayúsculas; `%` y `_` se buscan literalmente) |
| PATCH | `/conversations/:id` | dueño | `{ title }`: renombra la conversación (1-120 caracteres) |
| GET | `/conversations/:id` | dueño | `{ conversation, messages }` (con `sources` de cada respuesta) |
| GET | `/conversations/:id/export` | dueño | Descarga la conversación en Markdown (`text/markdown`, adjunto): preguntas, respuestas y las fuentes citadas de cada una. Máx. 20 por minuto |
| DELETE | `/conversations/:id` | dueño | Borra la conversación |

### `POST /chat`

```json
{ "question": "¿Cuál es el plazo de preaviso?", "conversationId": "opcional", "collectionIds": ["opcional"], "documentIds": ["opcional"] }
```

`documentIds` limita la búsqueda a esos documentos ("preguntar sobre este documento"). También lo acepta `/search`.

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
| GET | `/quality?rating=-1&status=pending` | `{ summary: { positive, negative, pendingNegative }, usage: { questions, cacheHits }, cache: { entries }, items: [...] }`. `rating` (`1`/`-1`) y `status` (`pending`/`resolved`/`all`) son opcionales. |
| PATCH | `/quality/feedback/:id` | `{ resolved: boolean }`: marcar como revisada o reabrir |
| DELETE | `/quality/cache` | Vacía la caché de respuestas de la organización → `{ deleted }` |

## Documentos — `/documents`

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| GET | `/documents/events` | todos | **Server-Sent Events** con los cambios de estado de los documentos visibles: `event: document` → `{ op, documentId, collectionId, title, status, error, mine }`. También envía `ready` al conectar y `ping` cada 25 s. |
| GET | `/documents/suggestions?documentId=` | todos | Hasta 8 preguntas sugeridas (de los resúmenes generados) → `{ suggestions: [{ documentId, documentTitle, question }] }` |
| POST | `/documents/:id/summary` | todos (con acceso) | Genera o regenera el resumen y las preguntas sugeridas con el LLM. **Cuenta para el límite diario.** → `{ summary, suggestedQuestions, summaryModel }` |
| GET | `/documents?collectionId=` | todos | Documentos visibles + `supportedExtensions` |
| GET | `/documents/:id` | todos | Un documento, con `summary`, `suggestedQuestions`, `summaryModel` y `summaryAt` |
| GET | `/documents/:id/chunks` | todos | Fragmentos generados (para revisar la fragmentación) |
| GET | `/documents/:id/file` | todos | Descarga el original |
| POST | `/documents` | admin, editor | `multipart/form-data`: `collectionId` + uno o varios `file` |
| PATCH | `/documents/:id` | admin, editor | `{ title }`: cambia el título mostrado (no el archivo). Vacía la caché de respuestas de la colección. Los fragmentos conservan el título antiguo en su texto de búsqueda hasta que se reprocese |
| DELETE | `/documents/:id` | admin, editor | Manda el documento a la **papelera** (deja de verse y de contar para el plan; se conserva `TRASH_RETENTION_DAYS` días). Con `TRASH_RETENTION_DAYS=0` lo elimina del todo |
| POST | `/documents/bulk-delete` | admin, editor | `{ ids: [...] }` (1-200): manda varios documentos a la papelera → `{ deleted, notFound }`. Solo afecta a los que el usuario puede editar; el resto cuenta en `notFound`. Una sola entrada de auditoría (`document.bulk_deleted`). Máx. 10 llamadas por minuto |
| GET | `/documents/trash` | admin, editor | Documentos de la papelera → `{ documents: [{ id, collectionId, collectionName, title, filename, sizeBytes, deletedAt, deletedBy, purgeAt }], retentionDays }` |
| POST | `/documents/restore` | admin, editor | `{ ids: [...] }` (1-200): saca documentos de la papelera → `{ restored, skipped, reason }`. Los que no caben en el tope de documentos del plan se quedan en la papelera (`reason` lo explica). Auditoría `document.restored` |
| POST | `/documents/purge` | admin | `{ ids: [...] }` (1-200) o `{ all: true }`: elimina definitivamente (archivo incluido) documentos que están en la papelera → `{ purged }`. Auditoría `document.purged` |
| POST | `/documents/move` | admin, editor | `{ ids: [...] (1-200), collectionId }`: mueve documentos y sus fragmentos a otra colección sin reprocesarlos → `{ moved, skipped: [{ id, title, reason }] }`. Exige acceso a ambas colecciones (`404` si no tiene acceso al destino). Se omiten (con motivo) los que se están procesando, ya están en el destino o duplicarían un archivo allí. Vacía la caché de las colecciones afectadas. Máx. 20 por minuto |
| POST | `/documents/reprocess` | admin, editor | `{ ids: [...] (1-200) }`: vuelve a procesar varios → `{ reprocessed, skipped }` (se omiten los que ya están en cola o procesándose). Máx. 10 por minuto |
| POST | `/documents/:id/reprocess` | admin, editor | Vuelve a indexar uno |

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
| GET | `/users` | → `{ users: [{ id, username, email, name, role, totpEnabled, isActive, lastLoginAt, pendingInvite, collectionIds }] }` |
| POST | `/users` | `{ username, email?, name, password?, role, collectionIds? }`. `email` es opcional. Sin `password` se crea una **invitación** (requiere `email`): → `{ id, inviteUrl, emailSent }` |
| POST | `/users/:id/totp/reset` | Quita el 2FA de un usuario (perdió el teléfono). No aplica a superadministradores |
| POST | `/users/:id/link` | Genera un enlace nuevo (invitación si aún no la aceptó, o restablecer contraseña) → `{ url, kind, emailSent }`. Anula los enlaces anteriores |
| PATCH | `/users/:id` | `{ name?, username?, email? (null = quitarlo), role?, isActive?, password? }` (no puedes quitarte el rol de admin ni desactivarte) |

## Consumo — `/usage` (admin)

`GET /usage` → `{ daily: [{ day, questions, cacheHits, promptTokens, completionTokens }], byModel: [{ model, questions }], totals: { documents, chunks, users } }` (últimos 30 días).

`GET /usage` incluye `plan: { name, dailyQuestionLimit, userDailyQuestionLimit, maxUsers, maxDocuments, usedToday }` con los topes de la organización.

## Plataforma — `/platform` (superadministrador)

| Método | Ruta | Cuerpo |
|---|---|---|
| GET | `/platform/tenants` | → las organizaciones de clientes (la interna «Plataforma» no se lista) `{ tenants: [{ id, name, slug, isActive, dailyQuestionLimit, planId, planName, planDailyQuestionLimit, users, documents, questions30d, createdAt }] }`. `dailyQuestionLimit` es la excepción puntual (`null` = rige el plan) |
| GET | `/platform/plans` | → `{ plans: [{ id, name, description, llmModels, dailyQuestionLimit, userDailyQuestionLimit, maxUsers, maxDocuments, isDefault, tenants }] }` |
| POST | `/platform/plans` | `{ name, description?, llmModels[], dailyQuestionLimit, userDailyQuestionLimit\|null, maxUsers\|null, maxDocuments\|null }` → `{ id }` |
| PUT | `/platform/plans/:id` | Mismo cuerpo: reemplaza el plan. En este y en el POST, cada modelo de `llmModels` debe existir en el catálogo público de OpenRouter (`400` con los nombres que no existen); si el catálogo no responde, no se bloquea |
| POST | `/platform/plans/:id/default` | Marca el plan que reciben las organizaciones nuevas y las que no tienen plan |
| DELETE | `/platform/plans/:id` | `409` si lo usa alguna organización; no se puede borrar el plan por defecto |
| POST | `/platform/tenants` | `{ name, slug, dailyQuestionLimit?, planId?, admin: { username, email?, name, password? } }` → crea la organización, su admin y la colección "General". Sin `password`, el admin recibe una invitación (`inviteUrl`, `emailSent`) |
| POST | `/platform/tenants/:id/enter` | — → entra en la organización como soporte (rol admin) y cambia la cookie de sesión. Queda en su auditoría (`support.entered`) |
| DELETE | `/platform/tenants/:id` | `{ confirmSlug }`: borra la organización y todos sus datos. Exige que esté desactivada y que `confirmSlug` coincida con su identificador. «Plataforma» no se puede modificar, desactivar ni borrar (`400`), ni tampoco la organización en la que estás (sal del modo soporte antes) |
| PATCH | `/platform/tenants/:id` | `{ name?, slug?, isActive?, dailyQuestionLimit?, planId? }` (`dailyQuestionLimit`: `null` = el del plan, `0` = sin límite) |

## Auditoría — `/audit` (admin)

`GET /audit?category=&userId=&before=&limit=` → `{ items: [{ id, action, userId, userLabel, targetType, targetId, details, ip, createdAt }], nextBefore }`.

- `category`: `auth`, `user`, `collection`, `document`, `quality` o `tenant` (prefijo de `action`, p. ej. `document.deleted`).
- Paginación hacia atrás: pasa `before=<nextBefore>` para la página siguiente (`limit` máx. 200, por defecto 50).
- Cada administrador ve solo lo de su organización (RLS).

Desactivar una organización bloquea el acceso de todos sus usuarios de inmediato sin borrar datos.
