# Requisitos y dimensionamiento

Las cifras de este documento están **medidas** con el sistema completo en marcha (CPU de 4 núcleos, sin GPU), salvo las marcadas como *estimadas*, que se calculan a partir de esas mediciones.

## Memoria por servicio

| Servicio | En reposo | Pico | Notas |
|---|---|---|---|
| `embeddings` (multilingual-e5-base) | 2,4 GB | 2,4 GB | Lotes de 4.096 tokens (ajustado para ahorrar ~0,9 GB) |
| `reranker` (mMiniLMv2) | 1,7 GB | 1,7 GB | Opcional |
| `docling` (lectura de documentos y OCR) | 1,0 GB | 2,6–2,9 GB | Pico con PDF de 30 páginas; **1 conversión a la vez** por defecto |
| `db` (PostgreSQL) | 0,1 GB | 0,3 GB | Crece con el volumen de datos |
| `clamav` (antivirus, **opcional**) | ~1,0 GB | 2,0 GB | Perfil `antivirus`; descarga ~300 MB de firmas al arrancar. Con 8 GB para Docker, al activarlo desactiva el `reranker` o sube la memoria de Docker |
| `api`, `worker`, `web`, `caddy`, `backup`, `mailpit` | < 0,1 GB cada uno | 0,1 GB | |
| **Total** | **≈ 5,2 GB** | **≈ 6,9 GB** | Pico: PDF de 30 páginas procesándose + una pregunta |

Tiempos de referencia con 4 núcleos: PDF de 30 páginas con tablas, ~65 s; imagen escaneada (OCR), ~6 s; re-ranking, ~0,6 s por pregunta. La respuesta del LLM depende de OpenRouter (normalmente 2–10 s).

## Perfiles de tamaño

Tres perfiles ya calculados en `deploy/perfiles/`. Se aplican al `.env` con `bash deploy/perfil.sh <nombre>` (escribe un bloque entre las marcas `# >>> perfil` y `# <<< perfil`; `quitar` lo borra) y después `docker compose up -d`.

| Perfil | vCPU / RAM | Para qué | Qué cambia respecto a los valores por defecto |
|---|---|---|---|
| **Pequeño** | 2 / 6 GB | 1–2 organizaciones, pocos usuarios, subidas ocasionales | Sin re-ranker (`RERANKER_URL=`, `RERANKER_REPLICAS=0`), `WORKER_CONCURRENCY=1`, embeddings y Docling limitados a 2 CPU. Pico estimado ≈ 5,2 GB |
| **Mediano** (recomendado) | 4 / 8 GB | 2–4 organizaciones, decenas de usuarios | Valores por defecto, con la CPU de los modelos limitada a 4. Pico medido ≈ 6,9 GB |
| **Grande** | 6 / 16 GB | ~4 organizaciones, ~20 usuarios activos a la vez | `DOCLING_WORKERS=2` (2 documentos a la vez), `WORKER_CONCURRENCY=4`; embeddings y re-ranker a 4 CPU, Docling a 6. Pico estimado ≈ 9,5 GB |

Notas para elegir:
- **Pequeño es el mínimo viable.** Con 2 vCPU el OCR y los PDF largos tardan varios minutos, y con 6 GB conviene añadir 2–4 GB de *swap* en el servidor.
- **Los usuarios activos casi no pesan en el servidor.** Mientras el LLM responde (por API) no se gasta CPU local; lo que cuesta es la búsqueda (embedding y re-ranking, ~1 s de CPU por pregunta) y, sobre todo, **procesar documentos**. Si subes mucho contenido a la vez, sube de perfil antes que por el número de usuarios.
- **El otro tope es el proveedor del LLM:** con modelos gratuitos de OpenRouter son 50 peticiones al día (1.000 con créditos). Ajusta los límites por plan y organización (ver [operacion.md](operacion.md#límite-de-preguntas-por-organización)).
- Las cifras de **pico** del perfil Mediano son medidas (tabla de arriba); las de Pequeño y Grande son **estimadas** a partir de ellas, no medidas. Para comprobar el tuyo, usa `deploy/loadtest.mjs` (ver [operacion.md](operacion.md)) y `docker stats --no-stream`.
- **16 GB o más:** opcionalmente `EMBEDDING_MODEL=intfloat/multilingual-e5-large` y `EMBEDDING_DIM=1024` (ver [operacion.md](operacion.md#cambiar-el-modelo-de-embeddings)) para la máxima calidad.
- Los perfiles se pueden retocar a mano en el `.env`; `deploy/perfil.sh` solo sustituye su propio bloque.
- Si el servidor **es compartido** con otros servicios, `deploy/autotune.sh` hace algo parecido midiendo el hardware y descontando lo que usan los demás contenedores (ver [operacion.md](operacion.md#autoajuste-de-recursos)). No uses los dos a la vez: gana el bloque que quede más abajo en el `.env`.

### Docker Desktop en Windows

Docker Desktop usa WSL 2: limita su memoria. Crea o edita `C:\Users\<tu-usuario>\.wslconfig` según el perfil (aquí, el mediano):

```ini
[wsl2]
memory=8GB
swap=4GB
processors=4
```

Después, en PowerShell: `wsl --shutdown` y vuelve a abrir Docker Desktop.

## La memoria depende de los hilos (medido)

Los modelos de búsqueda reservan memoria por hilo de CPU: unos **0,2 GB por hilo**. Medido en una CPU de 6 núcleos y 12 hilos con todo en marcha: embeddings 4,1 GB y re-ranker 3,5 GB, frente a 2,4 y 1,7 GB con 4 núcleos. Si no se limita, en una máquina con muchos hilos los modelos ocupan más de lo necesario y sin ir más rápido. `deploy/autotune.sh` calcula los límites según tu hardware y los demás contenedores del servidor (ver [operacion.md](operacion.md#autoajuste-de-recursos)); con `--simular=ram=8,hilos=4` ves qué haría en otro servidor antes de migrar.

Fórmulas usadas (re-ranker y embeddings, por CPU asignada): `re-ranker ≈ 950 + 205·CPU MB` · `embeddings ≈ 1550 + 215·CPU MB`.

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

Los mismos tres perfiles, con disco: **Pequeño** 2 vCPU · 6 GB · 60 GB SSD; **Mediano** 4 vCPU · 8 GB · 80 GB SSD; **Grande** 6 vCPU · 16 GB · 160 GB SSD (240 GB o más con muchos documentos o subidas masivas).

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
