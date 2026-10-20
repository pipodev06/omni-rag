# Investigación: ¿qué es un RAG y cómo funciona?

Este documento resume la investigación hecha antes de construir el proyecto y explica los conceptos que usa el código.

## 1. El problema

Un modelo de lenguaje (LLM) como GPT, Claude, Gemma o Llama solo sabe lo que aprendió durante su entrenamiento:

- no conoce **tus documentos** (contratos, manuales, políticas internas…);
- no sabe nada posterior a su **fecha de corte**;
- cuando no sabe algo, a menudo **inventa** una respuesta convincente (alucinación).

## 2. La solución: Retrieval-Augmented Generation

**RAG** = *generación aumentada con recuperación*. Antes de responder, el sistema **busca** en tu base de datos los fragmentos de texto relevantes para la pregunta y se los entrega al LLM junto con ella. El modelo responde **basándose en esos fragmentos** y los cita.

> Es como un examen a libro abierto: el modelo no memoriza tus documentos; en cada pregunta busca la página correcta y responde a partir de ella.

| | Ajuste fino (fine-tuning) | RAG |
|---|---|---|
| Coste | Alto (GPU, entrenamiento) | Bajo |
| Actualizar información | Reentrenar | Subir el documento |
| Citar fuentes | No | Sí |
| Alucinaciones | Siguen ocurriendo | Muy reducidas |
| Permisos por usuario | Imposible | Filtrar la búsqueda |

## 3. Las dos fases de un RAG

### Fase A — Ingesta (al subir un documento)

```
Documento ──▶ 1. Extraer texto ──▶ 2. Fragmentar ──▶ 3. Embeddings ──▶ 4. Guardar en BD
 (PDF, Word…)    (Docling, OCR)     (chunks)          (vectores)        (pgvector)
```

1. **Extracción:** convertir el archivo en texto limpio. Lo difícil son los PDF escaneados (necesitan OCR), las tablas y el formato de Office. Aquí se usa **Docling**, que devuelve Markdown con títulos y tablas.
2. **Fragmentación (chunking):** dividir el texto en trozos de unos cientos de palabras. Si son demasiado grandes, la búsqueda pierde precisión; si son demasiado pequeños, pierden contexto. Se respetan secciones y párrafos y se solapan un poco entre sí.
3. **Embeddings:** un modelo convierte cada trozo en un **vector** (una lista de números; aquí 768) que representa su significado. Textos con significado parecido quedan cerca entre sí, aunque usen palabras distintas ("tarifa de envío" ≈ "coste de despacho").
4. **Almacenamiento:** el vector, el texto y sus metadatos (documento, página, sección, organización) se guardan en la base de datos con un índice para buscar rápido.

### Fase B — Consulta (en cada pregunta)

```
Pregunta ──▶ embedding ──▶ búsqueda de los trozos más cercanos ──▶ prompt ──▶ LLM ──▶ respuesta con citas
```

1. La pregunta se convierte en vector con **el mismo modelo** de embeddings.
2. Se buscan los fragmentos más cercanos (**similitud coseno**), solo entre los que el usuario tiene permiso para ver.
3. Se arma un *prompt*: instrucciones + fragmentos numerados + pregunta.
4. El LLM redacta la respuesta citando los fragmentos (`[1]`, `[2]`…).

## 4. Técnicas que mejoran la calidad

| Técnica | Qué resuelve | ¿En este proyecto? |
|---|---|---|
| Fragmentación por estructura (títulos, párrafos, tablas) | Trozos coherentes | ✅ `ingest/chunker.ts` |
| Solapamiento entre trozos | No perder contexto en los cortes | ✅ 200 caracteres |
| Cabecera contextual (título + sección en el embedding) | Trozos que solos son ambiguos | ✅ `embeddingText()` |
| **Búsqueda híbrida** (vectores + palabras clave) | Nombres propios, códigos y números que la búsqueda semántica falla | ✅ `rag/search.ts` |
| Reciprocal Rank Fusion | Combinar listas de resultados sin calibrar puntuaciones | ✅ |
| Filtros por metadatos/permisos dentro de la búsqueda | Que el LLM nunca vea datos no autorizados | ✅ RLS |
| Umbral de distancia | No llamar al LLM si no hay nada relevante | ✅ `RETRIEVAL_MAX_DISTANCE` |
| Citas obligatorias y "di que no lo sabes" | Reducir alucinaciones | ✅ `rag/prompt.ts` |
| Contexto de conversación | Preguntas de seguimiento ("¿y el básico?") | ✅ historial + consulta enriquecida |
| Re-ranking con modelo *cross-encoder* | Reordenar los candidatos con más precisión | ⏳ futuro |
| Reescritura de la pregunta con LLM | Preguntas ambiguas | ⏳ futuro (gasta cupo del LLM) |
| *Agentic RAG* / *GraphRAG* | Preguntas complejas que cruzan muchos documentos | ⏳ futuro |

## 5. Cómo se mide la calidad

Hay que evaluar dos cosas por separado:

- **Recuperación:** ¿el fragmento correcto aparece entre los primeros resultados? Se mide con *recall@k* y *MRR*. En este proyecto se puede revisar sin gastar cupo del LLM con `POST /api/search`, que muestra cada resultado con su posición semántica, su posición por palabras clave y su distancia.
- **Generación:** ¿la respuesta es fiel a los fragmentos y responde la pregunta? Herramientas como RAGAS, DeepEval o promptfoo lo automatizan.

Recomendación: preparar entre 30 y 100 preguntas reales con su respuesta esperada y repetirlas cada vez que se cambie la configuración.

## 6. Bases de datos vectoriales consideradas

| Opción | Tipo | Valoración para este proyecto |
|---|---|---|
| **PostgreSQL + pgvector** | Relacional con vectores | ✅ **Elegida.** Una sola base para usuarios, permisos, documentos y vectores; SQL; RLS para multi-cliente; búsqueda de texto completo incluida. Escala bien hasta millones de fragmentos. |
| ChromaDB | Vectorial embebida | Buena para prototipos; sin permisos ni multi-cliente robusto. |
| Qdrant / Weaviate / Milvus | Vectoriales dedicadas | Muy rápidas a gran escala, pero implican otra base de datos que sincronizar con los permisos. |
| Pinecone | SaaS | De pago y los datos salen del servidor. |

Para "decenas o miles" de documentos (unos 10.000–500.000 fragmentos), pgvector con índice HNSW responde en milisegundos.

## 7. Decisiones derivadas de los requisitos

Requisitos del proyecto: todo tipo de documentos, de decenas a miles, **solo modelos gratuitos por API (OpenRouter)**, Docker local, **clientes con permisos distintos** y preferencia por TypeScript.

- **TypeScript** para todo el código propio. La única parte donde Python es claramente superior (leer documentos) se cubre con el **contenedor oficial de Docling**, al que se llama por HTTP. Ver [decisiones.md](decisiones.md#1-typescript-en-lugar-de-python).
- **Embeddings locales** (opción "B"): los embeddings gratuitos de OpenRouter tienen límites de uso y de longitud y algunos proveedores retienen los datos. Un modelo pequeño en Docker es gratis, privado y no tiene límites.
- **LLM gratuito de OpenRouter** con lista de modelos de respaldo, porque los modelos gratuitos se saturan y se retiran sin aviso.
- **Aislamiento en la base de datos** (RLS), no solo en el código.

### Datos sobre OpenRouter (octubre de 2026)

- Modelos gratuitos: identificadores terminados en `:free`; **20 peticiones/minuto** y **50/día**, o **1.000/día** tras comprar al menos 10 USD de créditos alguna vez (es permanente).
- Los modelos gratuitos se saturan en horas punta y se retiran sin aviso.
- La API es compatible con la de OpenAI (`/chat/completions`, streaming SSE).

Fuentes:
- [OpenRouter — Free LLM APIs Compared (2026)](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/)
- [TrueFoundry — OpenRouter rate limits](https://www.truefoundry.com/es/blog/openrouter-rate-limits-your-free-tier-depends-on-what-youve-already-paid)
- [OpenRouter — Embeddings API](https://openrouter.ai/docs/api-reference/embeddings)
- [Docling Serve — uso](https://github.com/docling-project/docling-serve/blob/main/docs/usage.md)
- [pgvector](https://github.com/pgvector/pgvector)
