# Omni RAG

Plataforma RAG autoalojada y multi-organización: pregunta en lenguaje natural sobre tus documentos y recibe respuestas con las fuentes citadas.

> *English:* self-hosted, multi-tenant RAG platform (Hono API + worker + React/Vite, PostgreSQL + pgvector, Docling, local embeddings and re-ranking, pluggable LLM providers). The interface and documentation are in Spanish.

## Qué hace
- Lee PDF (también escaneados, con OCR), Word, PowerPoint, Excel, CSV, HTML, Markdown, texto e imágenes.
- Responde con citas `[1]` y abre el PDF en la página exacta con el texto citado resaltado.
- Búsqueda híbrida (semántica con pgvector + palabras clave) con re-ranking local; caché de respuestas que respeta permisos.
- Multi-organización aislada en la base de datos (RLS), con roles administrador, editor y lector, y colecciones con acceso por usuario.
- Resumen y preguntas sugeridas por documento, valoraciones de respuestas, auditoría, papelera, 2FA (TOTP), invitaciones por correo y antivirus opcional (ClamAV).
- Listo para producción solo con `.env`: HTTPS automático, copias de seguridad diarias verificadas y mantenimiento automático.

## Tecnologías
- Frontend: React 19 + Vite + shadcn/ui + TanStack Query, servido por nginx
- Backend: TypeScript + Node.js 22 + Hono (API y worker) · cola pg-boss · Docling · embeddings y re-ranking con Text Embeddings Inference
- Base de datos: PostgreSQL 17 + pgvector + Row Level Security
- LLM: OpenRouter, Groq, Google, OpenAI, DeepSeek o un servidor propio, con respaldo automático entre modelos
- Hosting: Docker Compose en tu servidor, con Caddy para HTTPS

## Requisitos
- Docker con Docker Compose v2 y CPU x86-64
- De 6 a 16 GB de RAM según el perfil (ver [guia/requisitos.md](guia/requisitos.md))
- La clave de un proveedor de modelos de lenguaje (hay capas gratuitas)

## Cómo levantarlo
1. `git clone https://github.com/pipodev06/omni-rag.git && cd omni-rag`
2. Opcional: aplica un perfil de tamaño con `bash deploy/perfil.sh pequeno|mediano|grande` (mediano recomendado: 4 vCPU, 8 GB).
3. `docker compose up -d` (el primer arranque descarga ~4 GB entre imágenes y modelo de embeddings).
4. `docker compose logs api | grep -A2 "CONFIGURACIÓN INICIAL"` para obtener el código de un solo uso.
5. Abre http://localhost:8000, escribe el código y crea tu superadministrador. En *Organizaciones → Primeros pasos* pon la clave del proveedor de modelos y crea la primera organización.

Estado: `curl http://localhost:8000/api/health`. Guía completa: [guia/instalacion.md](guia/instalacion.md) y [guia/configuracion-inicial.md](guia/configuracion-inicial.md).

## Configuración
El `.env` es **opcional**: sin él, las contraseñas internas se generan solas y el resto se configura en la web. Úsalo para fijar valores o para lo que no está en pantalla (`cp .env.example .env`). Referencia completa: [guia/variables.md](guia/variables.md).

| Variable | Para qué | Ejemplo de formato |
|---|---|---|
| `DOMAIN`, `COMPOSE_PROFILES`, `WEB_BIND` | Publicar con tu dominio y HTTPS automático | `rag.tuempresa.com` · `https` · `127.0.0.1` |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | Contraseñas de la base (solo cuentan al crear el volumen) | `openssl rand -base64 48` |
| `JWT_SECRET` | Firma de sesiones y 2FA (cambiarlo cierra todas las sesiones) | texto aleatorio largo |
| `SMTP_*` | Correo para invitaciones y recuperación de contraseña | servidor y credenciales SMTP |
| `BACKUP_*`, `B2_*` | Hora de las copias, copia cifrada fuera del servidor y subida a Backblaze B2 | `BACKUP_AT=03:00` |

Reglas clave:
- Aplica los cambios con `docker compose up -d`, no con `restart` (que no relee el `.env`).
- Si cambias `POSTGRES_PASSWORD` con datos ya creados, sincronízala con `deploy/sync-db-password.sh` (ver [guia/operacion.md](guia/operacion.md)).
- Las copias no incluyen el `.env`: guarda aparte `JWT_SECRET`, la frase de cifrado y las claves de los proveedores.
- Con modelos gratuitos, OpenRouter permite 50 peticiones al día (1000 si compraste 10 USD o más de créditos), y algunos proveedores gratuitos pueden registrar los fragmentos enviados. Los embeddings y la lectura de documentos son 100 % locales.

## Despliegue
En un VPS: pon `DOMAIN`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en `.env` y ejecuta `docker compose up -d`; Caddy obtiene el certificado solo. Correo, copias fuera del servidor y restauración: [guia/produccion.md](guia/produccion.md). Arquitectura, permisos, API y desarrollo local: carpeta [guia/](guia/).

## Licencia
[AGPL-3.0](LICENSE): puedes usarlo, modificarlo y desplegarlo libremente; si lo ofreces como servicio por red, debes publicar el código de tu versión modificada bajo la misma licencia. Para contribuir: [CONTRIBUTING.md](CONTRIBUTING.md). Las vulnerabilidades se reportan en privado: [SECURITY.md](SECURITY.md).
