<div align="center">

# Omni RAG

Pregunta sobre tus documentos y recibe respuestas con las fuentes citadas. Autoalojado y multi-organización.

![React](https://img.shields.io/badge/React-19-087ea4)
![Node.js](https://img.shields.io/badge/Node.js-22-5fa04e)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17%20%2B%20pgvector-4169e1)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ed)
![Licencia](https://img.shields.io/badge/licencia-AGPL--3.0-2da44e)

[Funciones](#funciones) · [Instalación](#instalación) · [Configuración](#configuración) · [Despliegue](#despliegue) · [Guías](guia/)

</div>

## Funciones

| Documentos | Respuestas |
|---|---|
| PDF (también escaneados, con OCR) · Word · PowerPoint · Excel · CSV · HTML · Markdown · texto · imágenes · resumen y preguntas sugeridas por documento | Cada cita `[1]` abre el PDF en la página exacta con el texto resaltado · búsqueda híbrida (semántica + palabras clave) con re-ranking local · caché de respuestas |
| **Organizaciones** | **Seguridad** |
| Aisladas en la base de datos (Row Level Security) · roles administrador, editor y lector · colecciones con acceso por usuario · invitaciones y recuperación de contraseña por correo | 2FA (TOTP) opcional · auditoría de accesos y cambios · papelera de documentos · antivirus opcional (ClamAV) |
| **Calidad** | **Producción** |
| Los usuarios valoran respuestas y los administradores revisan las que fallan · estado de los documentos en tiempo real | HTTPS automático · copias de seguridad diarias verificadas · mantenimiento automático, todo con solo el `.env` |

Los embeddings y la lectura de documentos corren 100 % en tu servidor; solo la pregunta y los fragmentos relevantes van al LLM.

## Tecnologías

| Pieza | Tecnología |
|---|---|
| Interfaz | React 19 + Vite, shadcn/ui, TanStack Query; servida por nginx |
| API y worker | TypeScript, Node.js 22, [Hono](https://hono.dev); cola [pg-boss](https://github.com/timgit/pg-boss) (sin Redis) |
| Base de datos | PostgreSQL 17 + [pgvector](https://github.com/pgvector/pgvector) + Row Level Security |
| Documentos | [Docling](https://github.com/docling-project/docling-serve) (OCR, tablas, Office) |
| Embeddings y re-ranking | [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference), local |
| LLM | OpenRouter, Groq, Google, OpenAI, DeepSeek o un servidor propio, con respaldo automático |
| HTTPS | [Caddy](https://caddyserver.com) con certificados automáticos |

## Instalación

Necesitas Docker Compose v2 (CPU x86-64) y la clave de un LLM (Groq, Google AI Studio y OpenRouter tienen capas gratuitas).

```bash
git clone https://github.com/pipodev06/omni-rag.git && cd omni-rag
bash deploy/perfil.sh mediano          # opcional: pequeno | mediano | grande
docker compose up -d
docker compose logs api | grep -A2 "CONFIGURACIÓN INICIAL"   # código de un solo uso
```

1. Abre http://localhost:8000, escribe el código y crea tu superadministrador.
2. En *Organizaciones → Primeros pasos*, pon la clave del proveedor de modelos y crea la primera organización.

El primer arranque tarda unos minutos: descarga ~4 GB entre imágenes y el modelo de embeddings. Estado: `curl http://localhost:8000/api/health`.

| Perfil | vCPU | RAM | Para qué |
|---|---|---|---|
| `pequeno` | 2 | 6 GB | 1–2 organizaciones, pocos usuarios; sin re-ranker |
| `mediano` (recomendado) | 4 | 8 GB | 2–4 organizaciones, decenas de usuarios |
| `grande` | 6 | 16 GB | ~4 organizaciones, ~20 usuarios a la vez, ingesta más rápida |

Más detalle: [instalación](guia/instalacion.md) · [configuración inicial](guia/configuracion-inicial.md) · [requisitos y VPS](guia/requisitos.md).

## Configuración

El `.env` es opcional: sin él, las contraseñas internas se generan solas y el resto se configura en la web. Para fijar valores: `cp .env.example .env` ([referencia completa](guia/variables.md)).

| Variable | Para qué |
|---|---|
| `DOMAIN`, `COMPOSE_PROFILES`, `WEB_BIND` | Publicar con tu dominio y HTTPS |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | Contraseñas de la base (`openssl rand -base64 48`) |
| `JWT_SECRET` | Firma de sesiones y 2FA |
| `SMTP_*` | Invitaciones y recuperación de contraseña |
| `BACKUP_*`, `B2_*` | Hora de las copias y copia cifrada en Backblaze B2 |

> [!WARNING]
> - `docker compose restart` no relee el `.env`: usa `docker compose up -d`.
> - Cambiar `POSTGRES_PASSWORD` con datos ya creados da 502 hasta correr `deploy/sync-db-password.sh` ([operación](guia/operacion.md)).
> - Cambiar `JWT_SECRET` cierra todas las sesiones y desactiva el 2FA.
> - Las copias no incluyen el `.env`: guarda aparte `JWT_SECRET`, la frase de cifrado y las claves de los proveedores.
> - Con modelos gratuitos, OpenRouter permite 50 peticiones al día y algunos proveedores pueden registrar los fragmentos enviados.

## Despliegue

En un VPS, pon `DOMAIN`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en el `.env` y ejecuta `docker compose up -d`: Caddy obtiene el certificado solo. Correo, copias fuera del servidor y restauración: [producción](guia/produccion.md). Arquitectura, permisos, API y desarrollo local: carpeta [guia/](guia/).

## Licencia

[AGPL-3.0](LICENSE): puedes usarlo, modificarlo y desplegarlo libremente; si lo ofreces como servicio por red, debes publicar el código de tu versión modificada bajo la misma licencia.

[Contribuir](CONTRIBUTING.md) · [Reportar una vulnerabilidad](SECURITY.md)
