# Arquitectura

## Vista general

```
                         Navegador
                             │  http://localhost:8000  (local)
                             │  https://tu-dominio     (producción)
                             ▼
                ┌──────────────────────────┐
                │ caddy (solo con DOMAIN)  │  HTTPS automático
                └────────────┬─────────────┘
                             ▼
                ┌──────────────────────────┐
                │ web (nginx + React)      │  sirve la interfaz y
                │                          │  redirige /api/* a la API
                └────────────┬─────────────┘
                             ▼
┌──────────────────────────────────────────────┐        ┌───────────────────────┐
│ api (Node.js + Hono, TypeScript)             │───────▶│ OpenRouter (internet) │
│  · login, usuarios, colecciones, documentos  │ stream │ modelos :free con     │
│  · búsqueda híbrida + chat en streaming      │◀───────│ respaldo automático   │
│  · caché de respuestas, valoraciones         │        └───────────────────────┘
└───────┬──────────────┬────────────────┬──────┘
        │ encola       │ re-ranking     │ consultas (rol rag_app, con RLS)
        │ trabajos     ▼                │
        │      ┌──────────────────────┐ │
        │      │ reranker (TEI)       │ │
        │      │ mmarco-mMiniLMv2     │ │
        │      └──────────────────────┘ │
        ▼                               ▼
┌────────────────────┐   ┌──────────────────────────────────────────┐
│ worker (TypeScript)│──▶│ db: PostgreSQL 17 + pgvector              │
│ procesa documentos │   │  · datos, vectores, texto completo, RLS   │
└──┬──────────┬──────┘   │  · cola de trabajos (esquema pgboss)      │
   │          │          └──────────────────────────────────────────┘
   ▼          ▼
┌─────────┐ ┌────────────────────────────┐   volumen "uploads":
│ docling │ │ embeddings (TEI)           │   archivos originales
│ OCR,    │ │ multilingual-e5-base (CPU) │
│ Office… │ └────────────────────────────┘
└─────────┘
```

| Servicio | Imagen | Función | Expuesto |
|---|---|---|---|
| `web` | `apps/web/Dockerfile` (nginx) | Interfaz y proxy a la API | `:8000` |
| `api` | `apps/api/Dockerfile` | API HTTP; aplica migraciones al arrancar | interno |
| `worker` | igual que `api` (`node dist/worker.js`) | Ingesta en segundo plano | interno |
| `db` | `pgvector/pgvector:pg17` | Base de datos y cola | `127.0.0.1:15432` |
| `embeddings` | `text-embeddings-inference:cpu-1.8` | Texto → vector | `127.0.0.1:18080` |
| `reranker` | `text-embeddings-inference:cpu-1.8` | Reordena candidatos (cross-encoder) | interno |
| `docling` | `docling-serve-cpu:v1.37.0` | Archivo → Markdown | `127.0.0.1:15001` |
| `backup` | `pgvector/pgvector:pg17` + `deploy/backup.sh` | Copia diaria de la base de datos y los archivos en `./backups` | — |
| `caddy` | `caddy:2.11-alpine` (perfil `https`) | HTTPS con certificado automático delante de `web` | `:80`, `:443` |
| `mailpit` | `axllent/mailpit` (perfil `correo-pruebas`) | Buzón falso para probar correos en local | `127.0.0.1:8025` |

`caddy` y `mailpit` solo arrancan si su perfil está en `COMPOSE_PROFILES` (`.env`). En producción, `WEB_BIND=127.0.0.1` hace que a `web` solo se llegue a través de Caddy.

Los puertos marcados como `127.0.0.1` solo son accesibles desde la propia máquina (para depurar).

## Flujo de ingesta

```
POST /api/documents (multipart)
  │ 1. valida extensión y tamaño, calcula SHA-256 (detecta duplicados por colección)
  │ 2. guarda el archivo en /data/uploads/<organización>/<documento>/<archivo>
  │ 3. inserta fila en `documents` con estado "pending"
  │ 4. encola el trabajo "ingest-document" (pg-boss)
  ▼
worker
  │ 5. estado → "processing"
  │ 6. extracción:
  │      .txt .md .json → lectura directa
  │      resto          → Docling (API asíncrona: enviar, consultar estado, obtener Markdown)
  │                       con OCR (es, en) y marcador de salto de página
  │ 7. fragmentación (chunker.ts): por títulos/párrafos/tablas, ~1200 caracteres, 200 de solape
  │ 8. embeddings por lotes: "passage: <título> — <sección>\n\n<texto>"
  │ 9. en una transacción: borra los trozos anteriores e inserta los nuevos
  │ 10. estado → "ready" (o "failed" con el error tras 3 intentos)
```

Al terminar, se borran de la caché las respuestas que dependían de esa colección.

## Avisos en tiempo real

```
worker / API cambia documents.status
  │ trigger notify_document_event()  →  pg_notify('document_events', {…})
  ▼
API: una conexión LISTEN document_events (lib/documentEvents.ts)
  │ filtra por organización y colecciones accesibles de cada usuario
  ▼
GET /api/documents/events (Server-Sent Events, ping cada 25 s)
  ▼
Navegador (useDocumentEvents): refresca listas y avisa "«X» está listo"
```

Funciona aunque el cambio lo haga otro proceso (el worker), sin Redis ni WebSockets. Si la conexión se corta, el navegador reconecta solo y la lista se refresca; además hay una consulta de respaldo cada 20 s mientras haya documentos procesándose.

Si el worker falla en un paso transitorio (Docling ocupado, embeddings arrancando), pg-boss reintenta con espera exponencial (2 reintentos). Mientras tanto el documento muestra `Reintentando: …`.

## Flujo de consulta (chat)

```
POST /api/chat { question, conversationId?, collectionIds? }
  │ 1. si continúa una conversación, lee los últimos 6 mensajes
  │ 2. texto de búsqueda: la pregunta (+ la anterior si es un seguimiento corto)
  │    embedding local "query: <texto>" y colecciones consultables (accesibles ∩ filtro)
  │ 3. ¿primera pregunta? → busca en la caché (misma organización y mismas colecciones,
  │    pregunta idéntica o casi idéntica con los mismos números) → si hay, responde ya
  │ 4. si no hay caché: comprueba el límite diario de la organización
  │ 5. crea la conversación si es nueva y guarda la pregunta
  │ 6. búsqueda híbrida dentro de withTenant() → RLS filtra por organización y colecciones
  │        a) top 40 por distancia coseno (índice HNSW, distancia ≤ RETRIEVAL_MAX_DISTANCE)
  │        b) top 40 por texto completo (tsvector "spanish", consulta en modo OR)
  │        c) fusión RRF: score = Σ 1/(60 + posición) → top 20 candidatos
  │ 7. re-ranking (cross-encoder): puntúa los 20, descarta < RERANK_MIN_SCORE → top 6
  │ 8. ¿0 resultados? → respuesta fija "no encontré información" (no se llama al LLM)
  │ 9. prompt: reglas + historial + <documentos>[1]…[6]</documentos> + pregunta
  │ 10. OpenRouter en streaming; si un modelo falla antes de responder, se prueba el siguiente
  ▼
Server-Sent Events: meta (fuentes) → token… → done (fuentes citadas, modelo, fromCache) | error
  │ 11. guarda la respuesta, las fuentes y el consumo; si era primera pregunta, la guarda en caché
```

## Modelo de datos

```
tenants ─┬─< users ─< user_tokens (invitación / restablecer)
         ├─< collections ─┬─< collection_members >─ users
         │                └─< documents ─< chunks (embedding vector(768), tsv tsvector)
         ├─< conversations ─< messages (sources jsonb) ─── message_feedback (👍/👎)
         ├─< answer_cache (embedding, collection_ids[])
         ├─< usage_events
         └─< audit_log
```

| Tabla | Contenido |
|---|---|
| `tenants` | Organizaciones (clientes); límite diario opcional |
| `users` | Usuarios con rol `admin`/`editor`/`viewer`; `is_superadmin` para el dueño de la plataforma |
| `collections` | Carpetas de documentos |
| `collection_members` | Qué editores/lectores ven cada colección |
| `documents` | Archivo subido, estado de procesamiento, nº de páginas y trozos |
| `chunks` | Fragmentos con texto, sección, páginas, `embedding` y `tsv` (generado) |
| `conversations`, `messages` | Historial de chat privado de cada usuario, con las fuentes |
| `usage_events` | Una fila por respuesta: `question` (LLM, con tokens) o `cache_hit` (desde caché) |
| `answer_cache` | Respuestas reutilizables, con su alcance (colecciones) y el embedding de la pregunta |
| `message_feedback` | Valoraciones 👍/👎 con copia de pregunta, respuesta y fuentes para los administradores |
| `user_tokens` | Enlaces de invitación y de restablecer contraseña: solo se guarda el hash SHA-256, de un solo uso y con caducidad. La API normal (`rag_app`) no tiene acceso |
| `audit_log` | Registro de acciones (accesos, usuarios, colecciones, documentos, calidad, organizaciones) con usuario, IP y detalles |

`documents` incluye además `summary`, `suggested_questions`, `summary_model` y `summary_at` (resumen generado bajo demanda).

Todas las tablas llevan `tenant_id` y claves foráneas **compuestas** `(id, tenant_id)`, de modo que es imposible enlazar filas de organizaciones distintas. Detalles en [permisos.md](permisos.md).

Índices principales:
- `chunks_embedding_hnsw`: HNSW con `vector_cosine_ops` para la búsqueda semántica.
- `chunks_tsv_gin`: GIN sobre el `tsvector` para la búsqueda por palabras.

## Seguridad

- **Contraseñas** con bcrypt (12 rondas). El login limita a 10 intentos cada 15 minutos por IP y email, y tarda lo mismo exista o no el email.
- **Enlaces de invitación y restablecimiento** aleatorios (256 bits), guardados como hash, de un solo uso y con caducidad (`INVITE_EXPIRES_HOURS`, `RESET_EXPIRES_MINUTES`). "¿Olvidaste la contraseña?" responde lo mismo exista o no el email.
- **HTTPS** con Caddy y cabecera HSTS; la cookie se marca `Secure` automáticamente cuando la petición llega por HTTPS (`COOKIE_SECURE=auto`).
- **Auditoría** de las acciones importantes en `audit_log`, borrada tras `AUDIT_RETENTION_DAYS`.
- **Sesión** con JWT (HS256) en una cookie `httpOnly` + `SameSite=Lax`; también se acepta `Authorization: Bearer` para scripts. En cada petición se comprueba en la base de datos que el usuario y su organización siguen activos y cuál es su rol actual.
- **Aislamiento** por Row Level Security (ver [permisos.md](permisos.md)).
- **Inyección de instrucciones:** el prompt indica al modelo que el contenido de los documentos son datos, no órdenes.
- **Archivos:** nombre saneado, extensión permitida, tamaño máximo, rutas confinadas al directorio de almacenamiento y descarga con `Content-Disposition: attachment`.
- **Cabeceras** de seguridad HTTP (`hono/secure-headers`).

## Escalabilidad

| Escala | Qué hacer |
|---|---|
| Decenas–miles de documentos (objetivo) | La configuración por defecto es suficiente. |
| Ingesta más rápida | Subir `WORKER_CONCURRENCY` y `DOCLING_WORKERS`; usar la imagen GPU de TEI/Docling si hay GPU. |
| Millones de fragmentos | Ajustar `hnsw.ef_search`, más RAM para PostgreSQL y particionar `chunks` por organización. |
| Varias instancias de la API | Funciona (estado en PostgreSQL); el limitador de login es por instancia. |
