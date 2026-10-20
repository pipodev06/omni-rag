import { config } from "../config.js";

/**
 * Cliente de Text Embeddings Inference (TEI) de Hugging Face, que corre como
 * contenedor en el mismo docker compose. Es gratis, privado y sin límites de uso.
 * API: POST /embed { inputs: string[], truncate, normalize } -> number[][]
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedBatch(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const url = `${config.EMBEDDINGS_URL.replace(/\/$/, "")}/embed`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs, truncate: true, normalize: true }),
        signal,
      });
      if (res.ok) {
        const vectors = (await res.json()) as number[][];
        for (const v of vectors) {
          if (v.length !== config.EMBEDDING_DIM) {
            throw new Error(
              `El modelo devolvió vectores de ${v.length} dimensiones pero EMBEDDING_DIM=${config.EMBEDDING_DIM}. ` +
                "Revisa EMBEDDING_MODEL / EMBEDDING_DIM (ver docs/operacion.md).",
            );
          }
        }
        return vectors;
      }
      // 429/503: el servicio está ocupado o cargando el modelo; reintentar.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`Servicio de embeddings respondió HTTP ${res.status}: ${await res.text()}`);
      }
      lastError = new Error(`Servicio de embeddings respondió HTTP ${res.status}`);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof Error && err.message.includes("dimensiones")) throw err;
      lastError = err;
    }
    await sleep(500 * 2 ** attempt);
  }
  throw new Error(`No se pudo contactar el servicio de embeddings: ${String(lastError)}`);
}

/** Calcula embeddings de muchos textos en lotes. */
export async function embedMany(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += config.EMBEDDING_BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + config.EMBEDDING_BATCH_SIZE), signal)));
  }
  return out;
}

/** Embedding de una pregunta (con el prefijo de consulta que exigen modelos como E5). */
export async function embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  const [v] = await embedBatch([`${config.EMBEDDING_QUERY_PREFIX}${text}`], signal);
  return v!;
}
