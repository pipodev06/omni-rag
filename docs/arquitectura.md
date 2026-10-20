# Arquitectura

## Vista general

```
                         Navegador
                             │  http://localhost:8000
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
└───────┬───────────────────────┬──────────────┘        └───────────────────────┘
        │ encola trabajos       │ consultas (rol rag_app, con RLS)
        ▼                       ▼
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
| `db` | `pgvector/pgvector:pg17` | Base de datos y cola | `127.0.0.1:5432` |
| `embeddings` | `text-embeddings-inference:cpu-1.8` | Texto → vector | `127.0.0.1:8080` |
| `docling` | `docling-serve-cpu:v1.37.0` | Archivo → Markdown | `127.0.0.1:5001` |

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

Si el worker falla en un paso transitorio (Docling ocupado, embeddings arrancando), pg-boss reintenta con espera exponencial (2 reintentos). Mientras tanto el documento muestra `Reintentando: …`.

## Flujo de consulta (chat)

```
POST /api/chat { question, conversationId?, collectionIds? }
  │ 1. límite diario de la organización (usage_events)
  │ 2. crea o recupera la conversación, lee los últimos 6 mensajes y guarda la pregunta
  │ 3. texto de búsqueda: la pregunta (+ la anterior si es un seguimiento corto)
  │ 4. embedding local "query: <texto>"
  │ 5. búsqueda híbrida dentro de withTenant() → RLS filtra por organización y colecciones
  │        a) top 40 por distancia coseno (índice HNSW, distancia ≤ RETRIEVAL_MAX_DISTANCE)
  │        b) top 40 por texto completo (tsvector "spanish", consulta en modo OR)
  │        c) fusión RRF: score = Σ 1/(60 + posición) → top 6
  │ 6. ¿0 resultados? → respuesta fija "no encontré información" (no se llama al LLM)
  │ 7. prompt: reglas + historial + <documentos>[1]…[6]</documentos> + pregunta
  │ 8. OpenRouter en streaming; si un modelo falla antes de responder, se prueba el siguiente
  ▼
Server-Sent Events: meta (fuentes) → token… → done (fuentes citadas, modelo) | error
  │ 9. guarda la respuesta, las fuentes y el consumo (tokens) en la base de datos
```

## Modelo de datos

```
tenants ─┬─< users ──────────────┐
         ├─< collections ─┬─< collection_members >─ users
         │                └─< documents ─< chunks (embedding vector(768), tsv tsvector)
         ├─< conversations ─< messages (sources jsonb)
         └─< usage_events
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
| `usage_events` | Una fila por pregunta respondida por el LLM (modelo, tokens) |

Todas las tablas llevan `tenant_id` y claves foráneas **compuestas** `(id, tenant_id)`, de modo que es imposible enlazar filas de organizaciones distintas. Detalles en [permisos.md](permisos.md).

Índices principales:
- `chunks_embedding_hnsw`: HNSW con `vector_cosine_ops` para la búsqueda semántica.
- `chunks_tsv_gin`: GIN sobre el `tsvector` para la búsqueda por palabras.

## Seguridad

- **Contraseñas** con bcrypt (12 rondas). El login limita a 10 intentos cada 15 minutos por IP y email, y tarda lo mismo exista o no el email.
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
