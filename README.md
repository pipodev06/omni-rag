# RAG Project

Sistema **RAG (Retrieval-Augmented Generation)** multi-cliente para hacer preguntas en lenguaje natural sobre tus documentos y obtener respuestas **con las fuentes citadas**.

- 📄 **Todo tipo de documentos:** PDF (también escaneados, con OCR), Word, PowerPoint, Excel, CSV, HTML, Markdown, texto e imágenes.
- 🏢 **Multi-cliente con permisos:** cada organización está aislada a nivel de base de datos (Row Level Security de PostgreSQL), con roles *administrador / editor / lector* y colecciones con acceso por usuario.
- 🔎 **Búsqueda híbrida + re-ranking:** semántica (pgvector) + palabras clave (texto completo de PostgreSQL), combinadas con *Reciprocal Rank Fusion* y reordenadas por un modelo *cross-encoder* local.
- ⚡ **Caché de respuestas:** las preguntas repetidas se responden al instante sin gastar cupo del LLM, respetando permisos.
- 👍 **Valoraciones y página de Calidad:** los usuarios valoran respuestas y los administradores revisan las que fallan.
- 📑 **Visor con la cita resaltada:** al pulsar una fuente se abre el PDF en la página exacta con el texto citado marcado.
- 🔔 **Tiempo real:** el estado de los documentos se actualiza al instante y avisa cuando un documento está listo.
- ✨ **Resumen y preguntas sugeridas** por documento, y opción de preguntar solo sobre un documento concreto.
- 🆓 **Coste cero en modelos:** embeddings **locales** (gratis, privados, sin límites) y LLMs **gratuitos de OpenRouter** con cambio automático de modelo si uno falla.
- 🔐 **Verificación en dos pasos (TOTP)** opcional, con códigos de recuperación.
- ✉️ **Invitaciones y recuperación de contraseña** por email (o con enlace para copiar si no hay correo configurado).
- 📜 **Auditoría:** registro de accesos, cambios de usuarios, permisos y documentos, visible para los administradores.
- 🔒 **Listo para producción solo con `.env`:** HTTPS automático con Caddy al poner tu dominio, copias de seguridad diarias y mantenimiento automático.
- 🐳 **Todo en Docker:** un solo `docker compose up`.

```
Pregunta ─▶ embedding local ─▶ búsqueda híbrida (solo en lo que el usuario puede ver)
         ─▶ fragmentos relevantes + pregunta ─▶ LLM gratuito (OpenRouter) ─▶ respuesta con citas [1][2]
```

---

## Inicio rápido

Requisitos: **Docker** con Docker Compose v2, **8 GB de RAM** para Docker (pico medido ≈ 6,9 GB; ver [requisitos](docs/requisitos.md)), CPU x86-64 de 4 núcleos y una clave gratuita de [OpenRouter](https://openrouter.ai/keys).

```bash
git clone <este-repositorio> rag-project && cd rag-project
cp .env.example .env
#   Edita .env: contraseñas, JWT_SECRET, SEED_ADMIN_USERNAME/PASSWORD y OPENROUTER_API_KEY
docker compose up -d --build
```

Abre **http://localhost:8000** e inicia sesión con `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`.

> El primer arranque tarda unos minutos: se descargan las imágenes (~3 GB, sobre todo Docling) y el modelo de embeddings (~1 GB).
> Comprueba el estado con `curl http://localhost:8000/api/health`.

Guía completa paso a paso: **[docs/instalacion.md](docs/instalacion.md)**.

**¿Publicarlo con tu dominio?** No hay que tocar código: pon `DOMAIN=rag.tuempresa.com`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en `.env` y vuelve a arrancar. Caddy obtiene el certificado HTTPS solo. Ver **[docs/produccion.md](docs/produccion.md)**.

---

## Cómo se usa

1. **Organizaciones (superadministrador):** crea una organización por cliente, con su primer administrador. Con **Entrar como soporte** accedes a cualquiera de ellas con tu propio usuario (queda en su auditoría).
2. **Documentos (administrador/editor):** crea colecciones (carpetas) y arrastra archivos. Se procesan en segundo plano: *En cola → Procesando → Listo*.
3. **Usuarios (administrador):** crea editores y lectores con usuario y contraseña (el email es opcional: con él puedes invitarlos y pueden recuperar su contraseña) y dales acceso a las colecciones que correspondan. En **Auditoría** ves quién hizo qué.
4. **Chat (todos):** pregunta. La respuesta cita las fuentes `[1]`; despliégalas y pulsa **Ver en el documento** para abrir el PDF en la página citada con el texto resaltado.
5. **Resumen:** en Documentos, abre un archivo → pestaña **Resumen** → *Generar resumen*. Sus preguntas sugeridas aparecen en el chat, y *Preguntar sobre este documento* limita la conversación a ese archivo.

---

## Cambiar la configuración (`.env`)

Toda la configuración de infraestructura (claves, dominio, correo, copias de seguridad…) vive en el archivo `.env`. Tres reglas para no tropezar:

### 1. Aplica los cambios con `docker compose up -d`, no con `restart`

```bash
docker compose up -d
```

Docker recrea solo los servicios cuyos valores cambiaron. **`docker compose restart` no relee el `.env`**: reinicia el contenedor con las variables que ya tenía. Si lo que cambiaste es código (no el `.env`), añade `--build`: `docker compose up -d --build`.

Un `#` al inicio de una línea la anula: esa variable usa su valor por defecto (el mismo que trae `.env.example`).

### 2. Algunas variables solo cuentan la primera vez

| Variable | Qué ocurre si la cambias más tarde |
|---|---|
| `SEED_ADMIN_*`, `SEED_TENANT_*` | **Nada.** Solo se usan con la base de datos vacía (primer arranque). La organización se edita en *Organizaciones → ⋮ → Editar*; la contraseña, en *Mi cuenta*, o con `docker compose exec api node dist/scripts/reset-password.js admin` si no puedes entrar. |
| `LLM_MODELS`, `TENANT_DAILY_QUESTION_LIMIT` | **Nada.** Solo siembran el plan «Estándar». Después se editan en *Organizaciones → Planes*. |
| `EMBEDDING_MODEL`, `EMBEDDING_DIM` | Hay que recrear los fragmentos y reprocesar todos los documentos (ver [operacion.md](docs/operacion.md#cambiar-el-modelo-de-embeddings)). |
| `JWT_SECRET` | Se aplica, pero **todos cierran sesión y el 2FA de todos deja de funcionar**. Cámbialo solo si hace falta. |
| El resto (`OPENROUTER_API_KEY`, `SMTP_*`, `BACKUP_*`, límites, `DOMAIN`…) | Se aplican con `docker compose up -d`. |

### 3. Las contraseñas de la base de datos tienen un paso extra

PostgreSQL guarda la contraseña con la que **se creó el volumen**. Si cambias `POSTGRES_PASSWORD` en un sistema que ya tiene datos, la base sigue con la anterior, la API no puede conectar y la web muestra **502**. Se arregla igualándolas:

```bash
docker compose up -d db
docker compose exec -T db sh < deploy/sync-db-password.sh
docker compose up -d api worker backup
```

El script usa la variable del propio contenedor: no muestra ni te pide la contraseña. `APP_DB_PASSWORD` no necesita ese paso (la API la aplica sola al arrancar). En un sistema nuevo y vacío tampoco hace falta: la contraseña se fija al crear el volumen.

> Si la API muestra *«La base de datos rechazó la contraseña de POSTGRES_PASSWORD»*, es exactamente este caso.

Las contraseñas pueden llevar cualquier carácter, incluidos `/`, `+` y `=` (los que genera `openssl rand -base64 48`).

---

## Documentación

| Documento | Contenido |
|---|---|
| [docs/investigacion-rag.md](docs/investigacion-rag.md) | Qué es un RAG, cómo funciona, técnicas y la investigación previa a este proyecto |
| [docs/arquitectura.md](docs/arquitectura.md) | Componentes, flujos de ingesta y consulta, modelo de datos |
| [docs/permisos.md](docs/permisos.md) | Organizaciones, roles, colecciones y cómo garantiza el aislamiento la base de datos |
| [docs/requisitos.md](docs/requisitos.md) | RAM, CPU y disco medidos; perfiles para 6/8/16 GB y qué VPS contratar |
| [docs/instalacion.md](docs/instalacion.md) | Instalación paso a paso y configuración de OpenRouter |
| [docs/produccion.md](docs/produccion.md) | Publicar con dominio y HTTPS, correo SMTP y copias fuera del servidor |
| [docs/operacion.md](docs/operacion.md) | Copias de seguridad, usuarios e invitaciones, auditoría, cambio de modelos, calibración y problemas frecuentes |
| [docs/api.md](docs/api.md) | Referencia de la API HTTP |
| [docs/desarrollo.md](docs/desarrollo.md) | Desarrollo local, pruebas y estructura del código |
| [docs/decisiones.md](docs/decisiones.md) | Decisiones técnicas y por qué (TypeScript vs Python, pgvector, etc.) |

---

## Tecnologías

| Pieza | Tecnología |
|---|---|
| API y worker | TypeScript, Node.js 22, [Hono](https://hono.dev) |
| Base de datos | PostgreSQL 17 + [pgvector](https://github.com/pgvector/pgvector) (HNSW) + Row Level Security |
| Cola de trabajos | [pg-boss](https://github.com/timgit/pg-boss) (sobre PostgreSQL, sin Redis) |
| Lectura de documentos | [Docling](https://github.com/docling-project/docling-serve) (OCR, tablas, Office…) |
| Embeddings | [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) + `intfloat/multilingual-e5-base` |
| Re-ranking | TEI + `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (multilingüe, ~0,6 s por pregunta en CPU) |
| Caché | Tabla `answer_cache` en PostgreSQL (sin Redis) |
| LLM | Modelos `:free` de [OpenRouter](https://openrouter.ai) con respaldo automático |
| HTTPS | [Caddy](https://caddyserver.com) con certificados automáticos de Let's Encrypt (perfil `https`) |
| Correo | SMTP con nodemailer (opcional; Mailpit para pruebas locales) |
| Interfaz | React 19 + Vite, [shadcn/ui](https://ui.shadcn.com) (Radix + Tailwind CSS 4), iconos [Lucide](https://lucide.dev), TanStack Query, React Router; servida por nginx |

## Estructura

```
rag-project/
├── docker-compose.yml        # todo el sistema
├── .env.example              # configuración (cópialo a .env)
├── apps/
│   ├── api/                  # API + worker (TypeScript)
│   │   ├── src/
│   │   │   ├── db/           # conexión, migraciones SQL (esquema + RLS)
│   │   │   ├── auth/         # contraseñas, JWT, middleware de roles
│   │   │   ├── ingest/       # extracción (Docling), fragmentación, embeddings, pipeline
│   │   │   ├── rag/          # búsqueda híbrida, prompt, cliente OpenRouter
│   │   │   ├── routes/       # endpoints HTTP
│   │   │   ├── server.ts     # arranque de la API
│   │   │   └── worker.ts     # arranque del worker de ingesta
│   │   └── test/             # pruebas unitarias y de integración (RLS)
│   └── web/                  # interfaz React (shadcn/ui + Tailwind)
├── deploy/                   # Caddyfile y script de copias de seguridad
├── scripts/smoke-test.mjs    # prueba de punta a punta contra un sistema en marcha
└── docs/                     # documentación
```

## ⚠️ Importante sobre los modelos gratuitos

- **Límites:** OpenRouter permite **50 peticiones/día** con modelos gratuitos, o **1.000/día** si alguna vez compraste ≥ 10 USD de créditos (los créditos no se gastan con modelos gratis). El sistema también limita las preguntas por organización (`TENANT_DAILY_QUESTION_LIMIT`).
- **Privacidad:** algunos proveedores gratuitos pueden registrar o usar los textos enviados. En cada pregunta se envían **fragmentos de los documentos** al LLM. Revisa la configuración de privacidad de tu cuenta de OpenRouter antes de usar documentos confidenciales ([docs/instalacion.md](docs/instalacion.md#3-clave-y-privacidad-en-openrouter)).
- Los **embeddings** y la **lectura de documentos** son 100 % locales: esos datos nunca salen de tu servidor.

## Licencia

Uso privado del propietario del repositorio.
