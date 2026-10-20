# Decisiones técnicas

Registro de las decisiones importantes, con sus alternativas y consecuencias. Si alguna cambia, añade una entrada nueva en lugar de borrar la anterior.

## 1. TypeScript en lugar de Python

**Contexto.** Python domina el ecosistema de IA. TypeScript es el lenguaje preferido del propietario.

**Análisis por partes del sistema:**

| Parte | Mejor opción |
|---|---|
| API, usuarios, permisos, chat en streaming | TypeScript (trabajo web clásico; mismo lenguaje que la interfaz) |
| Llamadas a OpenRouter y a embeddings | Empate (son llamadas HTTP) |
| Base de datos y búsqueda vectorial | Empate (SQL) |
| **Leer "todo tipo de documentos"** | **Python** (Docling, Unstructured…) |
| Evaluación (RAGAS) | Python, aunque hay alternativas |
| Entrenar modelos | Python, pero no se entrena nada |

**Decisión.** Todo el código propio en TypeScript. La extracción de documentos se delega al **contenedor oficial de Docling** (Python), al que se llama por HTTP. Así se aprovecha lo mejor de Python sin mantener código Python.

**Consecuencia.** Si en el futuro se necesitan técnicas de investigación que solo existen en Python, se pueden añadir como otro servicio HTTP.

## 2. PostgreSQL + pgvector como única base de datos

**Alternativas:** Qdrant, Weaviate, Milvus, ChromaDB, Pinecone.

**Decisión.** pgvector. Permisos, documentos, vectores, búsqueda de texto completo y cola de trabajos en una sola base de datos, con transacciones y Row Level Security.

**Consecuencias.**
- ✅ El filtro de permisos se aplica en la misma consulta que la búsqueda vectorial.
- ✅ Una sola cosa que respaldar y operar.
- ⚠️ A partir de decenas de millones de vectores, una base vectorial dedicada sería más rápida. No es el caso de uso previsto.

## 3. Embeddings locales (TEI + multilingual-e5-base)

**Alternativas:** embeddings gratuitos de OpenRouter, o de pago (OpenAI, Voyage, Cohere).

**Decisión.** Modelo local en un contenedor de Hugging Face Text Embeddings Inference ("opción B"):
- gratis y **sin límites** (la ingesta de miles de documentos no gasta el cupo diario de OpenRouter);
- **privado**: el contenido nunca sale del servidor;
- funciona solo con CPU (~3 GB de RAM).

`multilingual-e5-base` (768 dimensiones) ofrece buen español con un coste razonable en CPU. Se puede cambiar (ver [operacion.md](operacion.md#cambiar-el-modelo-de-embeddings)).

## 4. LLM gratuito de OpenRouter con respaldo entre modelos

**Requisito:** solo modelos gratuitos por API.

**Decisión.** Cliente propio, sin SDK, compatible con la API de OpenAI y con una lista ordenada de modelos (`LLM_MODELS`). Si un modelo falla **antes** de emitir texto (429, 5xx, retirado), se prueba el siguiente.

**Consecuencias.**
- Los modelos gratuitos cambian: la lista se mantiene en `.env` sin tocar el código.
- Límite diario por organización para repartir el cupo de la cuenta.
- Si no hay fragmentos relevantes, no se llama al LLM.

## 5. Docling para la extracción

**Alternativas:** `pdf-parse`/`mammoth` en Node (sin OCR ni tablas fiables), Unstructured (más pesado), Apache Tika (sin estructura Markdown).

**Decisión.** `docling-serve` con OCR (español e inglés), tablas en modo preciso y marcador de salto de página para citar números de página. Se usa su API asíncrona para documentos largos. Los formatos de texto plano se leen directamente.

**Versión fijada** (`v1.37.0`) para que una actualización no cambie el comportamiento sin aviso.

## 6. Cola de trabajos con pg-boss

**Alternativas:** BullMQ (requiere Redis), procesar en la propia petición.

**Decisión.** pg-boss, que guarda la cola en PostgreSQL: un servicio menos, reintentos con espera exponencial y la ingesta separada de la API.

## 7. Autenticación propia en lugar de una librería de auth

**Alternativas:** Better Auth, Auth.js, Keycloak.

**Decisión.** Implementación pequeña y explícita (bcrypt + JWT en cookie `httpOnly`), porque el modelo de permisos (organización → rol → colecciones → RLS) es específico y se quería que la identidad en la base de datos fuera trivial de seguir. El rol se vuelve a leer de la base de datos en cada petición.

**Consecuencia.** No incluye recuperación de contraseña por email ni inicio de sesión con Google/Microsoft. Si se necesitan, conviene evaluar Better Auth o Keycloak.

## 8. React + Vite (SPA) en lugar de Next.js

En la planificación inicial se propuso Next.js. Como la interfaz no necesita renderizado en servidor ni SEO, una SPA con Vite servida por nginx es más simple: un contenedor estático, sin servidor Node para el frontend, y nginx actúa además de proxy de `/api` (mismo origen → cookies sin CORS).

## 9. Archivos en un volumen local en lugar de MinIO/S3

En la planificación inicial se propuso MinIO. Para un único servidor, un volumen de Docker es suficiente y evita otro servicio. El acceso está encapsulado en `storage/local.ts` (tres funciones), así que pasar a S3 más adelante es un cambio pequeño.

## 10. Aislamiento con Row Level Security y claves compuestas

**Decisión.** Además de los controles en el código, la base de datos impone el aislamiento:
- usuario de aplicación `rag_app` sin privilegio para saltarse RLS;
- contexto por transacción (`app.tenant_id`, `app.user_id`, `app.role`);
- claves foráneas compuestas `(id, tenant_id)`.

**Consecuencia.** Un error en una consulta no puede filtrar datos entre clientes. Coste: cada tabla nueva necesita sus políticas (ver convenciones en [desarrollo.md](desarrollo.md#convenciones)).
