# Omni RAG

**Omni RAG** es una plataforma **RAG** autoalojada y multi-organización: pregunta en lenguaje natural sobre tus documentos y recibe respuestas **con las fuentes citadas**. Software libre bajo [AGPL-3.0](LICENSE).

> 🚀 **En 3 comandos:** `git clone https://github.com/pipodev06/omni-rag.git && cd omni-rag` → `docker compose up -d` → abre http://localhost:8000 (detalle en [Cómo levantarlo](#-cómo-levantarlo)).

```
Pregunta ─▶ embedding local ─▶ búsqueda híbrida (solo en lo que el usuario puede ver)
         ─▶ fragmentos relevantes + pregunta ─▶ LLM ─▶ respuesta con citas [1][2]
```

## ✨ Qué hace

- 📄 **Todo tipo de documentos:** PDF (también escaneados, con OCR), Word, PowerPoint, Excel, CSV, HTML, Markdown, texto e imágenes.
- 📑 **Respuestas con citas:** cada fuente `[1]` abre el PDF en la página exacta con el texto resaltado.
- 🔎 **Búsqueda híbrida + re-ranking:** semántica (pgvector) + palabras clave, combinadas y reordenadas por un modelo local.
- 🏢 **Multi-organización aislada** en la base de datos (Row Level Security), con roles *administrador / editor / lector* y colecciones con acceso por usuario.

<details>
<summary>➕ <b>Todas las funciones</b></summary>

- ⚡ **Caché de respuestas:** lo repetido se responde al instante, sin gastar cupo del LLM y respetando permisos.
- ✨ **Resumen y preguntas sugeridas** por documento, y opción de preguntar solo sobre uno.
- 👍 **Valoraciones y Calidad:** los usuarios valoran respuestas y los administradores revisan las que fallan.
- 🔔 **Tiempo real:** el estado de los documentos se actualiza al instante.
- 🔐 **Seguridad:** 2FA (TOTP) opcional, auditoría de accesos y cambios, papelera de documentos y antivirus opcional (ClamAV).
- ✉️ **Invitaciones y recuperación de contraseña** por correo (o con enlace para copiar si no hay correo).
- 🔒 **Listo para producción solo con `.env`:** HTTPS automático, copias de seguridad diarias verificadas y mantenimiento automático.

</details>

## 🧱 Tecnologías

| Pieza | Tecnología |
|---|---|
| 🖥️ Interfaz | React 19 + Vite, shadcn/ui, TanStack Query; servida por nginx |
| ⚙️ API y worker | TypeScript, Node.js 22, [Hono](https://hono.dev); cola [pg-boss](https://github.com/timgit/pg-boss) (sin Redis) |
| 🗄️ Base de datos | PostgreSQL 17 + [pgvector](https://github.com/pgvector/pgvector) + Row Level Security |
| 📄 Documentos | [Docling](https://github.com/docling-project/docling-serve) (OCR, tablas, Office) |
| 🧩 Embeddings y re-ranking | [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference), 100 % local |
| 🤖 LLM | OpenRouter, Groq, Google, OpenAI, DeepSeek o un servidor propio, con respaldo automático |
| 🔒 HTTPS | [Caddy](https://caddyserver.com) con certificados automáticos |

## 📋 Requisitos

| Necesitas | Detalle |
|---|---|
| 🐳 Docker | Docker Compose v2, CPU x86-64 |
| 🔑 Clave de un LLM | Groq, Google AI Studio u OpenRouter tienen capas gratuitas |
| 💾 Memoria | De 6 a 16 GB según el perfil (tabla de abajo) |

| Perfil | vCPU | RAM | Para qué | Aplicarlo |
|---|---|---|---|---|
| Pequeño | 2 | 6 GB | 1–2 organizaciones, pocos usuarios; sin re-ranker | `bash deploy/perfil.sh pequeno` |
| **Mediano** ⭐ | 4 | 8 GB | 2–4 organizaciones, decenas de usuarios | `bash deploy/perfil.sh mediano` |
| Grande | 6 | 16 GB | ~4 organizaciones, ~20 usuarios a la vez, ingesta más rápida | `bash deploy/perfil.sh grande` |

Detalle por servicio y qué VPS contratar: [guia/requisitos.md](guia/requisitos.md).

## 🚀 Cómo levantarlo

```bash
git clone https://github.com/pipodev06/omni-rag.git && cd omni-rag
bash deploy/perfil.sh mediano          # opcional: pequeno | mediano | grande
docker compose up -d
docker compose logs api | grep -A2 "CONFIGURACIÓN INICIAL"   # código de un solo uso
```

1. Abre **http://localhost:8000**, escribe el código y crea tu superadministrador.
2. En *Organizaciones → Primeros pasos*, pon la clave del proveedor de modelos y crea la primera organización. ✅

> ⏳ El primer arranque tarda unos minutos: descarga ~4 GB entre imágenes y el modelo de embeddings. Estado: `curl http://localhost:8000/api/health`.

Guías: [instalación](guia/instalacion.md) · [configuración inicial](guia/configuracion-inicial.md).

## ⚙️ Configuración

El `.env` es **opcional**: sin él, las contraseñas internas se generan solas y el resto se configura en la web. Para fijar valores: `cp .env.example .env` ([referencia completa](guia/variables.md)).

| Variable | Para qué | Ejemplo de formato |
|---|---|---|
| `DOMAIN`, `COMPOSE_PROFILES`, `WEB_BIND` | Publicar con tu dominio y HTTPS | `rag.tuempresa.com` · `https` · `127.0.0.1` |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | Contraseñas de la base | `openssl rand -base64 48` |
| `JWT_SECRET` | Firma de sesiones y 2FA | texto aleatorio largo |
| `SMTP_*` | Invitaciones y recuperación de contraseña | servidor y credenciales SMTP |
| `BACKUP_*`, `B2_*` | Hora de las copias y copia cifrada en Backblaze B2 | `BACKUP_AT=03:00` |

**⚠️ Ojo con esto:**

| Si haces esto | Qué pasa |
|---|---|
| `docker compose restart` | No relee el `.env`: usa `docker compose up -d` |
| Cambiar `POSTGRES_PASSWORD` con datos ya creados | La web da 502 hasta correr `deploy/sync-db-password.sh` ([guia/operacion.md](guia/operacion.md)) |
| Cambiar `JWT_SECRET` | Todos cierran sesión y el 2FA deja de funcionar |
| Confiar en las copias para el `.env` | No lo incluyen: guarda aparte `JWT_SECRET`, la frase de cifrado y las claves de los proveedores |
| Usar modelos gratuitos | OpenRouter permite 50 peticiones al día y algunos proveedores pueden registrar los fragmentos enviados (embeddings y lectura de documentos son 100 % locales) |

## 🌐 Despliegue

En un VPS, pon `DOMAIN`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en el `.env` y ejecuta `docker compose up -d`: Caddy obtiene el certificado solo. Correo, copias fuera del servidor y restauración: [guia/produccion.md](guia/produccion.md). Arquitectura, permisos, API y desarrollo local: carpeta [guia/](guia/).

## 📜 Licencia

[AGPL-3.0](LICENSE): puedes usarlo, modificarlo y desplegarlo libremente; si lo ofreces como servicio por red, debes publicar el código de tu versión modificada bajo la misma licencia. [Contribuir](CONTRIBUTING.md) · [Reportar una vulnerabilidad](SECURITY.md)
