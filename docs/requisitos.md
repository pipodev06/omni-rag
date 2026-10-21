# Requisitos y dimensionamiento

Las cifras de este documento están **medidas** con el sistema completo en marcha (CPU de 4 núcleos, sin GPU), salvo las marcadas como *estimadas*, que se calculan a partir de esas mediciones.

## Memoria por servicio

| Servicio | En reposo | Pico | Notas |
|---|---|---|---|
| `embeddings` (multilingual-e5-base) | 2,4 GB | 2,4 GB | Lotes de 4.096 tokens (ajustado para ahorrar ~0,9 GB) |
| `reranker` (mMiniLMv2) | 1,7 GB | 1,7 GB | Opcional |
| `docling` (lectura de documentos y OCR) | 1,0 GB | 2,6–2,9 GB | Pico con PDF de 30 páginas; **1 conversión a la vez** por defecto |
| `db` (PostgreSQL) | 0,1 GB | 0,3 GB | Crece con el volumen de datos |
| `api`, `worker`, `web`, `caddy`, `backup`, `mailpit` | < 0,1 GB cada uno | 0,1 GB | |
| **Total** | **≈ 5,2 GB** | **≈ 6,9 GB** | Pico: PDF de 30 páginas procesándose + una pregunta |

Tiempos de referencia con 4 núcleos: PDF de 30 páginas con tablas, ~65 s; imagen escaneada (OCR), ~6 s; re-ranking, ~0,6 s por pregunta. La respuesta del LLM depende de OpenRouter (normalmente 2–10 s).

## Tu equipo: 16 GB de RAM, 8 GB para Docker

La configuración por defecto **cabe en 8 GB** (pico medido de 6,9 GB). En Windows, Docker Desktop usa WSL 2: limita su memoria y añade una pequeña reserva de *swap* para picos puntuales.

Crea o edita `C:\Users\<tu-usuario>\.wslconfig`:

```ini
[wsl2]
memory=8GB
swap=4GB
processors=4
```

Después, en PowerShell: `wsl --shutdown` y vuelve a abrir Docker Desktop.

Valores en `.env` para 8 GB (son los de por defecto):

```
DOCLING_WORKERS=1
WORKER_CONCURRENCY=2
RERANKER_REPLICAS=1
```

### Perfiles según la memoria disponible

| Memoria para Docker | Configuración en `.env` | Calidad |
|---|---|---|
| **6 GB** | `RERANKER_URL=` y `RERANKER_REPLICAS=0` (sin re-ranker; pico estimado ≈ 5,2 GB) | Buena (búsqueda híbrida) |
| **8 GB** (recomendado local) | Por defecto | Muy buena (con re-ranking) |
| **12–16 GB** | `DOCLING_WORKERS=2` (2 documentos a la vez; pico estimado ≈ 9,5 GB) | Muy buena, ingesta más rápida |
| **16 GB o más** | Opcional: `EMBEDDING_MODEL=intfloat/multilingual-e5-large`, `EMBEDDING_DIM=1024` (ver [operacion.md](operacion.md#cambiar-el-modelo-de-embeddings)) | Máxima |

Los perfiles se cambian **solo en `.env`**, sin tocar código: `docker compose up -d`.

## Disco

| Concepto | Tamaño |
|---|---|
| Imágenes de Docker | ≈ 6 GB (la de Docling es la mayor) |
| Modelos (embeddings + re-ranker) | ≈ 1,6 GB |
| Base de datos | ≈ 10 KB por fragmento (texto, vector e índices). Un PDF de 20 páginas ≈ 40 fragmentos ≈ 0,4 MB; 1.000 documentos así ≈ 0,5 GB |
| Archivos originales | Lo que ocupen tus documentos |
| Copias de seguridad | 7 días × (base de datos + archivos), por defecto |

**Mínimo:** 20 GB libres. **Recomendado:** 40 GB + 2–3 veces el tamaño de tus documentos (por las copias).

## CPU

- **Mínimo:** 4 núcleos. **Recomendado:** 4–8 núcleos.
- No hace falta GPU: el LLM se usa por API (OpenRouter) y los modelos locales son pequeños.
- **Arquitectura x86-64 (Intel/AMD) obligatoria:** la imagen de embeddings (Text Embeddings Inference para CPU) no existe para ARM. En un VPS, evita los planes ARM (Ampere, Graviton…). En un Mac con Apple Silicon funciona con emulación, pero lento.

## ¿Qué VPS contratar cuando lo publiques?

| Plan | vCPU | RAM | Disco | Para qué |
|---|---|---|---|---|
| **Mínimo** | 4 | 8 GB | 80 GB SSD | Pocas organizaciones, decenas de usuarios, subidas ocasionales. Usa el perfil de 8 GB y añade 2–4 GB de *swap* en el servidor. |
| **Recomendado** | 4–8 | 16 GB | 160 GB SSD | Varias organizaciones y miles de documentos. Permite `DOCLING_WORKERS=2` y deja margen al sistema. |
| **Holgado** | 8 | 32 GB | 240 GB+ SSD | Muchos usuarios simultáneos, subidas masivas o modelos de embeddings más grandes. |

Recomendaciones:
- **x86-64**, no ARM (ver arriba). Mejor vCPU **dedicadas** que compartidas: el OCR y los embeddings usan CPU de forma intensiva.
- **Ubuntu 24.04 LTS** (o Debian 12) con Docker Engine y el plugin Compose.
- Proveedores habituales con planes de este tamaño a precio razonable: Hetzner, OVHcloud, Contabo, DigitalOcean, Vultr, Linode/Akamai. Compara precio por vCPU dedicada y ubicación cercana a tus usuarios (para cumplir protección de datos, mejor en la UE si tus clientes son europeos).
- Copias de seguridad **fuera del servidor**: copia periódicamente `./backups` a otro sitio (almacenamiento del proveedor, S3, otro servidor).
- El cuello de botella real suele ser el **cupo de OpenRouter** (1.000 peticiones/día con créditos), no el servidor. Ajusta los límites por organización (ver [operacion.md](operacion.md#límite-de-preguntas-por-organización)).

Cuando tengas el VPS y el dominio, sigue [produccion.md](produccion.md): solo hay que cambiar `.env`.

## Red

| Puerto | Uso | ¿Abierto a internet? |
|---|---|---|
| 80 y 443 | Caddy (HTTPS) | Sí, en producción |
| 8000 | Web sin HTTPS (desarrollo) | No en producción (`WEB_BIND=127.0.0.1`) |
| 15432, 18080, 15001 | Depuración (BD, embeddings, Docling) | No: escuchan solo en `127.0.0.1` |
| 8025 | Mailpit (solo pruebas) | No: solo `127.0.0.1` |

Salida a internet necesaria: OpenRouter (`openrouter.ai`), Hugging Face (descarga de modelos la primera vez), Let's Encrypt (certificados) y tu servidor SMTP.
