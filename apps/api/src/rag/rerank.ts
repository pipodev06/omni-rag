import { config } from "../config.js";
import { Semaphore } from "../lib/semaphore.js";

/**
 * Cliente del re-ranker (Text Embeddings Inference con un modelo cross-encoder).
 * A diferencia de los embeddings, el cross-encoder lee la pregunta y el fragmento
 * JUNTOS, por lo que juzga la relevancia con mucha más precisión.
 * API: POST /rerank { query, texts, truncate } -> [{ index, score }] (score 0–1)
 */
export const rerankerEnabled = () => config.RERANKER_URL.trim() !== "";

// El re-ranking usa toda la CPU: varias llamadas a la vez se estorban y terminan todas tarde. Se atienden en fila.
const slots = new Semaphore(config.RERANK_PARALLEL);

/** Devuelve una puntuación por texto (mismo orden que `texts`), o null si no está disponible. */
export async function rerank(query: string, texts: string[], signal?: AbortSignal): Promise<number[] | null> {
  if (!rerankerEnabled() || texts.length === 0) return null;
  try {
    // El tiempo de espera (15 s) corre desde que le toca el turno, no desde que se pide: la fila no agota a nadie.
    return await slots.run(async () => {
      const res = await fetch(`${config.RERANKER_URL.replace(/\/$/, "")}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, texts, truncate: true }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ranked = (await res.json()) as { index: number; score: number }[];
      const scores = new Array<number>(texts.length).fill(0);
      for (const r of ranked) scores[r.index] = r.score;
      return scores;
    }, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    // Si el re-ranker falla, se sigue con el orden de la búsqueda híbrida.
    console.warn(`[rerank] no disponible, se usa el orden híbrido: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Aplica las puntuaciones: ordena de mayor a menor, descarta las que no
 * alcanzan `minScore` y se queda con `topK`. Puro, para poder probarlo.
 */
export function applyRerank<T>(items: T[], scores: number[], topK: number, minScore: number): (T & { rerankScore: number })[] {
  return items
    .map((item, i) => ({ ...item, rerankScore: scores[i] ?? 0 }))
    .filter((x) => x.rerankScore >= minScore)
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, topK);
}

/**
 * Texto de un candidato para el re-ranker: título, sección y contenido, recortado a `maxChars` (0 = completo).
 * Recortar acelera el re-ranking (cuesta CPU en proporción al texto) pero cambia qué fragmentos salen primero:
 * ver la tabla de mediciones en docs/operacion.md.
 */
export function rerankText(h: { documentTitle: string; heading: string; content: string }, maxChars = config.RERANK_MAX_CHARS): string {
  const text = `${[h.documentTitle, h.heading].filter(Boolean).join(" — ")}\n${h.content}`;
  return maxChars > 0 ? text.slice(0, maxChars) : text;
}
