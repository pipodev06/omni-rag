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

## 11. shadcn/ui + Tailwind CSS + Lucide para la interfaz

**Alternativas:** Flowbite React, MUI, Mantine, CSS propio (la primera versión).

**Decisión.** [shadcn/ui](https://ui.shadcn.com) sobre Tailwind CSS 4:
- los componentes se **copian al proyecto** (`apps/web/src/components/ui/`), así que se pueden modificar sin depender de la librería;
- se basan en **Radix UI**: accesibles con teclado y lector de pantalla (diálogos, menús, selectores);
- iconos de **Lucide**, notificaciones con **Sonner**, datos con **TanStack Query** y URLs reales con **React Router**.

Flowbite está más orientado a HTML/plantillas; MUI y Mantine imponen un estilo propio difícil de cambiar.

**Estilo: "neutro profesional".** Grises *zinc* y un único color de acento (índigo), tipografía Inter incluida en la imagen (sin llamadas a Google Fonts), modo claro, oscuro y automático. El acento se cambia en un solo sitio (ver [desarrollo.md](desarrollo.md#interfaz-web)).

## 12. Re-ranker `mmarco-mMiniLMv2` en lugar de `bge-reranker-v2-m3`

**Contexto.** La búsqueda híbrida recupera bien los candidatos, pero su orden no siempre es el mejor. Un *cross-encoder* lee la pregunta y cada fragmento juntos y los puntúa con más precisión.

**Medición** (CPU de 4 núcleos, 7 preguntas en español, 20 fragmentos de ~1.000 caracteres por pregunta):

| Modelo | Aciertos (top-1) | Tiempo por pregunta | RAM |
|---|---|---|---|
| `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | 7/7 | **~0,6 s** | ~1,9 GB |
| `BAAI/bge-reranker-v2-m3` | 7/7 | ~14 s | ~3 GB |

**Decisión.** `mmarco-mMiniLMv2` por defecto. `bge-reranker-v2-m3` es más preciso en casos difíciles, pero solo es viable con GPU (`RERANKER_MODEL`).

**Beneficio adicional.** Las puntuaciones del re-ranker separan muy bien lo relevante (≥ 0,1) de lo irrelevante (≈ 0,003), así que `RERANK_MIN_SCORE` decide de forma fiable cuándo responder "no encontré información" sin llamar al LLM.

## 13. Caché de respuestas en PostgreSQL (sin Redis)

**Alternativas:** Redis/Valkey, caché semántica "ingenua" por similitud.

**Decisión.** Tabla `answer_cache` en PostgreSQL:
- hereda el aislamiento por organización (RLS) y se invalida en la misma transacción que actualiza los documentos;
- el volumen es pequeño (miles de filas), así que la velocidad de Redis no aporta nada apreciable frente a la llamada al LLM que se ahorra;
- un servicio menos que operar.

**Reglas conservadoras.** Medimos que preguntas **distintas** pueden ser casi idénticas para el modelo de embeddings ("factura 2026-0457" vs "…0458": distancia 0,026, más cerca que dos paráfrasis reales). Por eso una respuesta solo se reutiliza si:
1. la pregunta normalizada es idéntica, o
2. la distancia es ≤ 0,015 **y** los números/códigos coinciden;

además del mismo conjunto de colecciones, sin historial de conversación (las preguntas de seguimiento dependen del contexto), y que no haya pasado `CACHE_TTL_HOURS`. Un 👎 borra la entrada.

**Consecuencia.** Se reutilizan menos respuestas que con una caché agresiva, pero nunca una respuesta equivocada por parecido superficial.

## 14. Tiempo real con LISTEN/NOTIFY + Server-Sent Events

**Alternativas:** consultar cada pocos segundos (versión anterior), WebSockets, Redis Pub/Sub.

**Decisión.** Un *trigger* en `documents` publica cada cambio de estado con `pg_notify`; la API mantiene una única conexión `LISTEN` y lo reenvía por **Server-Sent Events** a cada navegador, filtrando por organización y colecciones accesibles.
- SSE es unidireccional (justo lo que hace falta), funciona con la cookie de sesión y se reconecta solo.
- PostgreSQL ya está; no hace falta Redis para avisar de procesos distintos (el worker).
- Se mantiene una consulta de respaldo cada 20 s mientras haya documentos procesándose.

## 15. Visor con PDF.js (versión "legacy")

**Decisión.** El visor dibuja el PDF con PDF.js y localiza el fragmento citado en su capa de texto (`lib/highlight.ts`), tolerando mayúsculas, tildes, saltos de línea y formato Markdown. Se usa la compilación **legacy** de PDF.js: la estándar (v6) usa APIs de JavaScript muy recientes (`Map.getOrInsertComputed`) que todavía no tienen todos los navegadores, y fallaba en las pruebas. PDF.js (~1 MB) solo se descarga al abrir un PDF.

Para Word, Excel y otros formatos se muestra el texto extraído y el fragmento citado; convertirlos a PDF para la vista previa es una mejora posible (Docling o LibreOffice).

## 16. Resúmenes bajo demanda

Generar el resumen al subir cada documento gastaría el cupo diario del LLM aunque nadie lo leyera. Por eso se genera solo cuando alguien lo pide, se guarda en `documents` y se reutiliza (también sus preguntas sugeridas en la pantalla inicial del chat).

## 17. HTTPS con Caddy activado desde `.env`

**Alternativas:** Traefik, nginx + certbot, un proxy externo (Cloudflare).

**Decisión.** Caddy obtiene y renueva certificados de Let's Encrypt solo, con un `Caddyfile` de cuatro líneas. Va en un **perfil** de Docker Compose (`https`): en local no arranca; en producción se activa con `COMPOSE_PROFILES=https` y `DOMAIN=...`. La URL pública de los enlaces de correo (`APP_PUBLIC_URL`) y la cookie `Secure` se deducen solas, así que pasar a producción **no requiere cambiar código**.

## 18. Correo opcional, con enlaces para copiar

Exigir SMTP para dar de alta usuarios complicaría el uso en local. Si no hay SMTP, la API devuelve el enlace de invitación o de restablecimiento y la interfaz lo muestra para copiarlo y enviarlo por otro medio. Para probar los correos reales en local se incluye Mailpit (perfil `correo-pruebas`).

## 19. Auditoría escrita con la conexión del propietario

`audit_log` se inserta con `rag_owner` y `rag_app` solo puede leerla (con RLS, solo administradores). Así un error en una ruta no puede falsear ni borrar el registro, y escribir la auditoría nunca hace fallar la acción principal (los errores al registrar solo se anotan en el log). El mantenimiento diario (pg-boss, 03:15) borra lo que supera `AUDIT_RETENTION_DAYS`, los enlaces usados o caducados y la caché vencida.

## 20. Ajuste de memoria para equipos de 8 GB

Medido con el sistema completo: TEI reservaba memoria para lotes grandes que este uso no necesita. Con `--max-batch-tokens 4096` los embeddings bajan de 3,2 a 2,3 GB y el re-ranker de 1,9 a 1,6 GB, sin diferencia de velocidad apreciable. Docling llega a ~2,9 GB por conversión, así que por defecto procesa **un documento a la vez** (`DOCLING_WORKERS=1`). Resultado: ≈ 5,2 GB en reposo y 6,9 GB de pico. Ver [requisitos.md](requisitos.md).

## 21. Revisión con React Doctor

La interfaz se revisa con [React Doctor](https://www.npmjs.com/package/react-doctor) (`pnpm --filter @rag/web run doctor`). La primera pasada dio 63/100; se corrigieron: comprobar `res.ok` antes de leer la respuesta, valores de contexto memorizados, estados que no se reiniciaban si había error, claves estables en las listas del chat, búsquedas con `Set` en lugar de recorrer arrays y la división de páginas grandes (chat, documentos, calidad) en componentes y *hooks*. Puntuación actual: 100/100.

## 22. Acceso de soporte con una cuenta por organización

**Alternativas:** dar al superadministrador una conexión que se salte el RLS; permitir que su sesión cambie `tenant_id` sin más.

**Decisión.** Al entrar en una organización se usa una cuenta de soporte de esa organización enlazada al superadministrador (`support_for`), sin contraseña, válida solo dentro de su sesión. Saltarse el RLS rompería la garantía principal del sistema, y cambiar solo `tenant_id` fallaría con las claves foráneas compuestas (las conversaciones deben pertenecer a un usuario de la misma organización). Con la cuenta de soporte todo funciona como para un administrador normal, y cada acceso queda en la auditoría del cliente. Al entrar o salir se recarga la página para no mezclar datos ni avisos en tiempo real de dos organizaciones.

## 23. Cierre de sesión sin `queryClient.clear()`

Al cerrar sesión se borraba toda la caché de TanStack Query, incluida la consulta de sesión que observaban las rutas. Unas rutas seguían viendo la sesión anterior y otras ninguna, y la app saltaba sin fin entre `/login` y `/chat`. Ahora primero se marca la sesión como vacía y después se descartan solo los demás datos (`clearSession`). Además, cada página tiene un *error boundary*: si falta un archivo de la app tras una actualización, se recarga una vez (como mucho cada 30 s) y si no, muestra un botón **Recargar** en lugar de quedarse en blanco.

## 26. Proveedores de LLM configurables (OpenRouter por defecto)

**Contexto.** El cliente estaba escrito para OpenRouter (cabeceras, el parámetro `reasoning`, la validación de nombres contra su catálogo). Cambiar de proveedor o depender de uno solo era un riesgo.

**Decisión.** Un registro de proveedores (`lib/llmProviders.ts`) con dos «formas» de petición: `openrouter` y `openai` (compatible con OpenAI: Groq, Google, OpenAI, DeepSeek y servidores propios). Cada modelo de un plan lleva opcionalmente un prefijo `proveedor:modelo`; sin prefijo es OpenRouter, así que los planes anteriores no cambian. El respaldo entre modelos ya existente cruza proveedores. Se descartó (por ahora) un adaptador para Anthropic directo: usa otro formato y está disponible vía OpenRouter.

**Qué no se hizo:** el costo por modelo (punto 17 de la lista) no se mezcla con esto; si se hace, los precios por proveedor se escriben a mano en el plan, porque solo OpenRouter publica un catálogo de precios.

## 24. Planes por organización con una sola clave de OpenRouter

**Alternativas:** una clave de OpenRouter por organización; el modelo fijo en el `.env` para todos.

**Decisión.** Una única clave, del dueño de la plataforma, compartida por todas las organizaciones. Lo que cambia entre clientes es el **plan** (`plans`): modelos en orden con respaldo, preguntas por día, usuarios y documentos máximos. Se gestionan en **Organizaciones → Planes** y solo los ve el superadministrador (la tabla no se concede a `rag_app`). `tenants.plan_id` NULL = plan por defecto; `tenants.daily_question_limit` queda como excepción puntual que prevalece sobre el plan. El plan «Estándar» nace con `LLM_MODELS` y `TENANT_DAILY_QUESTION_LIMIT` del `.env`, que después dejan de leerse.

**Por qué.** Una clave por cliente multiplica los secretos a custodiar sin dar nada hasta que alguien pida traer su propia clave. Los modelos `:free` tienen un cupo por cuenta que comparten todas las organizaciones, por eso el formulario de planes avisa cuando se usan. Si algún día hace falta traer la propia clave, se añade `tenants.openrouter_key` cifrada y prevalece sobre la global.

## 25. Verificación en dos pasos propia (TOTP) y trazabilidad por cliente

**Alternativas:** una librería (`otpauth`, `speakeasy`) o un proveedor externo; hacerlo obligatorio para todos.

**Decisión.** TOTP de RFC 6238 implementado en `lib/totp.ts` (~100 líneas, comprobado con los vectores de la RFC), opcional por usuario y recomendado para el superadministrador. El secreto se guarda cifrado (AES-256-GCM, clave derivada de `JWT_SECRET`), cada código vale una sola vez (`totp_last_step`), hay 8 códigos de recuperación guardados como hash y el segundo paso tiene su propio límite de intentos. La contraseña correcta no abre sesión: devuelve un token de 5 minutos (`purpose: mfa`) que solo sirve para `/auth/login/totp`. Es opcional porque exigirlo antes de tener correo o soporte humano dejaría fuera a quien pierda el teléfono.

**Trazabilidad.** Los cambios hechos desde la plataforma (plan, límite diario, condiciones del plan) se registran también en la auditoría de la organización afectada, con el actor «Plataforma», para que el cliente pueda comprobar qué cambió y cuándo.
