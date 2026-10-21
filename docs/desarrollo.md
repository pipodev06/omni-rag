# Desarrollo

## Requisitos

- Node.js 22+ y pnpm 10 (`corepack enable`)
- Docker (para PostgreSQL, embeddings y Docling)

## Entorno local

Las dependencias (base de datos, embeddings, Docling) corren en Docker; la API, el worker y la web corren en tu máquina con recarga automática.

```bash
pnpm install
cp .env.example .env            # edita contraseñas y OPENROUTER_API_KEY
docker compose up -d db embeddings docling
```

Exporta las variables para los procesos locales (las URLs apuntan a `localhost` en lugar de a los nombres de los contenedores):

```bash
set -a; . ./.env; set +a
export DATABASE_URL="postgres://rag_owner:${POSTGRES_PASSWORD}@localhost:15432/rag"
export APP_DATABASE_URL="postgres://rag_app:${APP_DB_PASSWORD}@localhost:15432/rag"
export EMBEDDINGS_URL=http://localhost:18080 DOCLING_URL=http://localhost:15001 STORAGE_DIR=./data/uploads
```

En tres terminales (con esas variables):

```bash
pnpm dev:api      # API en http://localhost:3001 (aplica migraciones al arrancar)
pnpm dev:worker   # worker de ingesta
pnpm dev:web      # interfaz en http://localhost:5173 (redirige /api a :3001)
```

## Pruebas

```bash
pnpm typecheck    # TypeScript en api y web
pnpm test         # pruebas unitarias (no necesitan servicios)
```

Pruebas de integración de Row Level Security (necesitan PostgreSQL con pgvector; usan organizaciones temporales y las borran al terminar):

```bash
cd apps/api
RUN_DB_TESTS=1 DATABASE_URL=... APP_DATABASE_URL=... APP_DB_PASSWORD=... pnpm test
```

Prueba de punta a punta contra un sistema en marcha: ver [instalacion.md §6](instalacion.md#6-comprobar-la-instalación-con-la-prueba-de-humo).

| Archivo | Qué prueba |
|---|---|
| `apps/api/test/chunker.test.ts` | Fragmentación: títulos, tablas, solape, páginas, cortes |
| `apps/api/test/prompt.test.ts` | Formato del contexto, mensajes, consultas de seguimiento, citas |
| `apps/api/test/stream.test.ts` | Lectura de SSE, división por páginas, formatos admitidos |
| `apps/api/test/misc.test.ts` | Limitador de intentos de login |
| `apps/api/test/cache.test.ts` | Normalización de preguntas, números/códigos, clave de alcance y re-ranking |
| `apps/api/test/rls.integration.test.ts` | Aislamiento en la base de datos (se omite sin `RUN_DB_TESTS=1`) |

La integración continua (`.github/workflows/ci.yml`) ejecuta todo lo anterior, incluidas las pruebas de RLS, en cada *push* y *pull request*.

## Mapa del código (`apps/api/src`)

| Archivo | Responsabilidad |
|---|---|
| `config.ts` | Lee y valida las variables de entorno (zod) |
| `server.ts` / `worker.ts` | Arranque de la API y del worker |
| `app.ts` | Monta las rutas y el manejo de errores |
| `db/client.ts` | Conexiones `sqlOwner` / `sqlApp` y `withTenant()` |
| `db/migrate.ts`, `db/migrations/*.sql` | Migraciones (esquema, índices, RLS) |
| `auth/*` | Contraseñas (bcrypt), JWT (jose), middleware de sesión y roles |
| `ingest/formats.ts` | Extensiones admitidas y cómo se leen |
| `ingest/extract.ts` | Cliente de Docling y división por páginas |
| `ingest/chunker.ts` | Fragmentación consciente de Markdown (puro, probado) |
| `ingest/embeddings.ts` | Cliente de TEI con lotes y reintentos |
| `ingest/pipeline.ts` | Ingesta completa de un documento |
| `queue.ts` | Cola pg-boss |
| `rag/search.ts` | Búsqueda híbrida + RRF en SQL |
| `rag/prompt.ts` | Prompt del sistema, contexto y citas (puro, probado) |
| `rag/llm.ts` | Cliente de OpenRouter con streaming y respaldo entre modelos |
| `rag/rerank.ts` | Cliente del re-ranker (cross-encoder) y aplicación de puntuaciones |
| `rag/retrieve.ts` | Colecciones consultables + búsqueda híbrida + re-ranking |
| `rag/cache.ts` | Caché de respuestas: búsqueda, guardado e invalidación |
| `routes/*` | Endpoints HTTP |
| `scripts/*` | Primer administrador, `seed` y `reindex` |

## Interfaz web

Estructura de `apps/web/src`:

| Ruta | Contenido |
|---|---|
| `main.tsx` | Proveedores: tema, TanStack Query, tooltips, confirmaciones, router y notificaciones |
| `App.tsx` | Rutas (`/chat/:id`, `/documentos/:coleccion`, `/usuarios`…) con carga diferida por página |
| `api.ts` | Cliente de la API, streaming del chat y subida con progreso |
| `index.css` | Tema: variables de color (claro/oscuro), tipografía y radios |
| `components/ui/` | Componentes de shadcn/ui (generados; se pueden editar) |
| `components/` | Piezas propias: `AppLayout` (barra lateral), `common` (cabeceras, estados vacíos, iconos de archivo), `ConfirmProvider`, `chat/`, `documents/` |
| `pages/` | Una página por sección |

**Cambiar el color de marca:** edita `--primary` y `--ring` en `src/index.css`, tanto en `:root` (modo claro) como en `.dark` (modo oscuro). Los valores están en formato `oklch`. Un conversor como <https://oklch.com> sirve para pasar de HEX a `oklch`.

**Añadir un componente de shadcn/ui** (desde `apps/web`):

```bash
npx shadcn@latest add popover
```

Tras añadirlo, revisa que los imports apunten a `@/lib/utils`.

**Diálogos de confirmación:** usa `const confirm = useConfirm()` y `await confirm({ title, description, destructive: true })` en lugar de `window.confirm`. Para avisos, usa `toast.success(...)` / `toast.error(...)` de `sonner`.

## Convenciones

- **Todo acceso a datos de un cliente pasa por `withTenant()`.** `sqlOwner` solo se usa en login, plataforma, límites y migraciones.
- SQL siempre con *tagged templates* de `postgres` (parámetros, nunca concatenar).
- Los cambios de esquema van en una **nueva** migración `NNN_descripcion.sql`; nunca se edita una ya aplicada. Si una tabla nueva tiene datos de clientes: `tenant_id`, claves foráneas compuestas, `ENABLE ROW LEVEL SECURITY`, políticas y `GRANT` a `rag_app` (añádelo también a `GRANTS` en `db/migrate.ts`), más una prueba en `rls.integration.test.ts`.
- Mensajes de error y comentarios en español; nombres de código en inglés.

## Ideas para siguientes versiones

- Evaluación automática con un conjunto de preguntas y respuestas esperadas.
- Reescritura de preguntas ambiguas con el LLM (gasta cupo).
- Ingesta desde URLs, Google Drive o correo.
- Proveedor LLM configurable por organización (p. ej. modelos de pago sin retención de datos para clientes con documentos confidenciales).
- Invitaciones por email y recuperación de contraseña.
