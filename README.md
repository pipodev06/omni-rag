# Omni RAG

**Omni RAG** es un sistema **RAG (Retrieval-Augmented Generation)** multi-cliente para hacer preguntas en lenguaje natural sobre tus documentos y obtener respuestas **con las fuentes citadas**. Software libre bajo [AGPL-3.0](LICENSE).

> *English:* Omni RAG is a self-hosted, multi-tenant RAG platform (Hono API + worker + React/Vite, PostgreSQL + pgvector, Docling, local embeddings and re-ranking, pluggable LLM providers). The interface and documentation are in Spanish. Quick start below; sizing profiles in [docs/requisitos.md](docs/requisitos.md).

- 📄 **Todo tipo de documentos:** PDF (también escaneados, con OCR), Word, PowerPoint, Excel, CSV, HTML, Markdown, texto e imágenes.
- 🏢 **Multi-cliente con permisos:** cada organización está aislada a nivel de base de datos (Row Level Security de PostgreSQL), con roles *administrador / editor / lector* y colecciones con acceso por usuario.
- 🔎 **Búsqueda híbrida + re-ranking:** semántica (pgvector) + palabras clave (texto completo de PostgreSQL), combinadas con *Reciprocal Rank Fusion* y reordenadas por un modelo *cross-encoder* local.
- ⚡ **Caché de respuestas:** las preguntas repetidas se responden al instante sin gastar cupo del LLM, respetando permisos.
- 👍 **Valoraciones y página de Calidad:** los usuarios valoran respuestas y los administradores revisan las que fallan.
- 📑 **Visor con la cita resaltada:** al pulsar una fuente se abre el PDF en la página exacta con el texto citado marcado.
- 🔔 **Tiempo real:** el estado de los documentos se actualiza al instante y avisa cuando un documento está listo.
- ✨ **Resumen y preguntas sugeridas** por documento, y opción de preguntar solo sobre un documento concreto.
- 🆓 **Coste cero en modelos:** embeddings **locales** (gratis, privados, sin límites) y LLMs **gratuitos de OpenRouter** con cambio automático de modelo si uno falla.
- 🛡️ **Antivirus opcional (ClamAV)** que analiza cada archivo al subirlo.
- 🔐 **Verificación en dos pasos (TOTP)** opcional, con códigos de recuperación.
- ✉️ **Invitaciones y recuperación de contraseña** por email (o con enlace para copiar si no hay correo configurado).
- 📜 **Auditoría:** registro de accesos, cambios de usuarios, permisos y documentos, visible para los administradores.
- 🔒 **Listo para producción solo con `.env`:** HTTPS automático con Caddy al poner tu dominio, copias de seguridad diarias y mantenimiento automático.
- 🐳 **Todo en Docker:** un solo `docker compose up`.

```
Pregunta ─▶ embedding local ─▶ búsqueda híbrida (solo en lo que el usuario puede ver)
         ─▶ fragmentos relevantes + pregunta ─▶ LLM (OpenRouter, Groq, Google…) ─▶ respuesta con citas [1][2]
```

---

## Inicio rápido

Requisitos: **Docker** con Docker Compose v2, CPU x86-64, una clave gratuita de [OpenRouter](https://openrouter.ai/keys) y, según el tamaño que necesites, entre 6 y 16 GB de RAM (ver [Elige el tamaño](#elige-el-tamaño-de-tu-servidor)).

```bash
git clone https://github.com/pipodev06/omni-rag.git && cd omni-rag
cp .env.example .env
#   Edita .env: contraseñas, JWT_SECRET, SEED_ADMIN_USERNAME/PASSWORD y la clave de un proveedor de LLM (p. ej. OPENROUTER_API_KEY)
docker compose up -d --build
```

Opcional, antes del `up`: aplica un perfil de tamaño con `bash deploy/perfil.sh mediano` (ver abajo).

Abre **http://localhost:8000** e inicia sesión con `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`.

> El primer arranque tarda unos minutos: se descargan las imágenes (~3 GB, sobre todo Docling) y el modelo de embeddings (~1 GB).
> Comprueba el estado con `curl http://localhost:8000/api/health`.

Guía completa paso a paso: **[docs/instalacion.md](docs/instalacion.md)**.

**¿Publicarlo con tu dominio?** No hay que tocar código: pon `DOMAIN=rag.tuempresa.com`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en `.env` y vuelve a arrancar. Caddy obtiene el certificado HTTPS solo. Ver **[docs/produccion.md](docs/produccion.md)**.

---

## Elige el tamaño de tu servidor

Tres perfiles ya calculados. Se aplican con un comando y se pueden cambiar cuando quieras:

| Perfil | vCPU | RAM | Para qué | Aplicarlo |
|---|---|---|---|---|
| **Pequeño** | 2 | 6 GB | 1–2 organizaciones, pocos usuarios. Sin re-ranker; los PDF largos tardan varios minutos | `bash deploy/perfil.sh pequeno` |
| **Mediano** (recomendado) | 4 | 8 GB | 2–4 organizaciones, decenas de usuarios | `bash deploy/perfil.sh mediano` |
| **Grande** | 6 | 16 GB | ~4 organizaciones, ~20 usuarios activos a la vez, ingesta más rápida | `bash deploy/perfil.sh grande` |

Después, `docker compose up -d`. Detalle por servicio, qué cambia cada perfil, disco y VPS recomendados: **[docs/requisitos.md](docs/requisitos.md)**. Si compartes el servidor con otros servicios, [`deploy/autotune.sh`](docs/operacion.md#autoajuste-de-recursos) calcula los límites descontando lo que ellos usan.

---

## Cómo se usa

1. **Organizaciones (superadministrador):** crea una organización por cliente, con su primer administrador. Con **Entrar como soporte** accedes a cualquiera de ellas con tu propio usuario (queda en su auditoría).
2. **Documentos (administrador/editor):** crea colecciones (carpetas) y arrastra archivos. Se procesan en segundo plano: *En cola → Procesando → Listo*. Desde el menú ⋮ de cada documento puedes renombrarlo o moverlo a otra colección, y con las casillas de la tabla puedes mover, reprocesar o borrar varios a la vez. Las columnas ordenan y hay filtros por estado y tipo.
3. **Usuarios (administrador):** crea editores y lectores con usuario y contraseña (el email es opcional: con él puedes invitarlos y pueden recuperar su contraseña) y dales acceso a las colecciones que correspondan. En **Auditoría** ves quién hizo qué.
4. **Chat (todos):** pregunta. En la barra lateral puedes buscar conversaciones (por título o contenido) y renombrarlas. La respuesta cita las fuentes `[1]`; despliégalas y pulsa **Ver en el documento** para abrir el PDF en la página citada con el texto resaltado.
5. **Resumen:** en Documentos, abre un archivo → pestaña **Resumen** → *Generar resumen*. Sus preguntas sugeridas aparecen en el chat, y *Preguntar sobre este documento* limita la conversación a ese archivo.

---

## Cambiar la configuración (`.env`)

Toda la configuración de infraestructura (claves, dominio, correo, copias de seguridad…) vive en el archivo `.env`. La lista completa, con valores por defecto y cuándo se aplica cada una, está en [docs/variables.md](docs/variables.md). Tres reglas para no tropezar:

### 1. Aplica los cambios con `docker compose up -d`, no con `restart`

```bash
docker compose up -d
```

Docker recrea solo los servicios cuyos valores cambiaron. **`docker compose restart` no relee el `.env`**: reinicia el contenedor con las variables que ya tenía. Si lo que cambiaste es código (no el `.env`), añade `--build`: `docker compose up -d --build`.

Un `#` al inicio de una línea la anula: esa variable usa su valor por defecto (el mismo que trae `.env.example`).

### 2. Algunas variables solo cuentan la primera vez

| Variable | Qué ocurre si la cambias más tarde |
|---|---|
| `SEED_ADMIN_*` | **Nada.** Solo se usan con la base de datos vacía (primer arranque). La contraseña, en *Mi cuenta*, o con `docker compose exec api node dist/scripts/reset-password.js admin` si no puedes entrar. |
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

## Papelera de documentos

Borrar un documento lo manda a la **Papelera** (botón en *Documentos*): deja de verse y de contar para el plan, pero se conserva `TRASH_RETENTION_DAYS` días (30 por defecto, `0` = sin papelera) y se **restaura con un clic**, sin reprocesarlo. Eliminar definitivamente o vaciar la papelera es solo del administrador. Detalle en [docs/operacion.md](docs/operacion.md#papelera-de-documentos).

---

## Copias de seguridad

Funcionan solas, sin configurar nada: cada 24 h (o a la hora que elijas) se guarda en `./backups` un volcado de la base de datos y, por defecto, un `.tgz` con los archivos subidos; se conservan 7 días y cada copia se **verifica restaurándola** en una base temporal. Para que sobrevivan a la pérdida del servidor hay dos pasos opcionales:

| Qué quieres | Variables del `.env` |
|---|---|
| **Hora fija** (hora de Perú por defecto) en vez de «cada N horas» | `BACKUP_AT=03:00` y, para la subida a Backblaze, `B2_AT=04:00` (después de la copia). Zona distinta: `BACKUP_TZ`. |
| **Segunda copia cifrada fuera del servidor** | `BACKUP_OFFSITE=true`, `BACKUP_OFFSITE_DIR=…` y `BACKUP_ENCRYPTION_PASSPHRASE=<frase>` (guárdala aparte: sin ella no se restaura nada) |
| **Subirla a Backblaze B2** | `COMPOSE_PROFILES=backblaze` y `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` (clave limitada al bucket, con permiso de lectura y escritura) |
| **Archivos subidos incrementales** (recomendado con muchos GB): solo sube lo nuevo, cifrado, y guarda 30 días lo que se borra | `BACKUP_UPLOADS_TGZ=false` y `B2_SYNC_UPLOADS=true` |

Las copias **no incluyen el `.env`**: guarda aparte `JWT_SECRET` (sin él el 2FA deja de funcionar), la frase de cifrado, las claves de los proveedores de LLM y las `B2_*`. Pasos completos y restauración en un servidor limpio: [docs/produccion.md](docs/produccion.md#6-copias-de-seguridad-fuera-del-servidor) y [docs/operacion.md](docs/operacion.md#restaurar-en-un-servidor-limpio-desde-backblaze).

---

## Documentación

| Documento | Contenido |
|---|---|
| [docs/investigacion-rag.md](docs/investigacion-rag.md) | Qué es un RAG, cómo funciona, técnicas y la investigación previa a este proyecto |
| [docs/arquitectura.md](docs/arquitectura.md) | Componentes, flujos de ingesta y consulta, modelo de datos |
| [docs/permisos.md](docs/permisos.md) | Organizaciones, roles, colecciones y cómo garantiza el aislamiento la base de datos |
| [docs/requisitos.md](docs/requisitos.md) | RAM, CPU y disco medidos; perfiles para 6/8/16 GB y qué VPS contratar |
| [docs/instalacion.md](docs/instalacion.md) | Instalación paso a paso y configuración de OpenRouter |
| [docs/variables.md](docs/variables.md) | Referencia de todas las variables del `.env`: qué hace cada una, su valor por defecto y cuándo se aplica |
| [docs/produccion.md](docs/produccion.md) | Publicar con dominio y HTTPS, correo SMTP y copias fuera del servidor |
| [docs/operacion.md](docs/operacion.md) | Copias de seguridad, usuarios e invitaciones, auditoría, cambio de modelos, calibración y problemas frecuentes |
| [docs/api.md](docs/api.md) | Referencia de la API HTTP |
| [docs/desarrollo.md](docs/desarrollo.md) | Desarrollo local, pruebas y estructura del código |
| [docs/decisiones.md](docs/decisiones.md) | Decisiones técnicas y por qué (TypeScript vs Python, pgvector, etc.) |
| [docs/pendientes.md](docs/pendientes.md) | Mejoras pendientes y lo ya hecho, numeradas |
| [docs/posibles_mejoras.md](docs/posibles_mejoras.md) | Ideas que pueden o no agregarse, agrupadas por tema |
| [docs/pendientes_post_produccion.md](docs/pendientes_post_produccion.md) | Tareas para después de salir a producción (ensayo de restauración completa) |

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
| LLM | [OpenRouter](https://openrouter.ai) (modelos `:free` incluidos), Groq, Google, OpenAI, DeepSeek o un servidor propio, con respaldo automático entre modelos y proveedores |
| HTTPS | [Caddy](https://caddyserver.com) con certificados automáticos de Let's Encrypt (perfil `https`) |
| Correo | SMTP con nodemailer (opcional; Mailpit para pruebas locales) |
| Interfaz | React 19 + Vite, [shadcn/ui](https://ui.shadcn.com) (Radix + Tailwind CSS 4), iconos [Lucide](https://lucide.dev), TanStack Query, React Router; servida por nginx |

## Estructura

```
omni-rag/
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

## Contribuir y seguridad

Guía en [CONTRIBUTING.md](CONTRIBUTING.md). Las vulnerabilidades se reportan en privado: [SECURITY.md](SECURITY.md).

## Licencia

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). Puedes usar, modificar y desplegar Omni RAG libremente; si lo ofreces a otros como servicio por red, debes poner a su disposición el código fuente de tu versión modificada bajo la misma licencia.
