import { config } from "../config.js";
import { withTenant, type TenantContext } from "../db/client.js";
import { scopeKey } from "./cache.js";
import { applyRerank, rerank, rerankerEnabled, rerankText } from "./rerank.js";
import { hybridSearch, type SearchHit } from "./search.js";

export interface RetrievalScope {
  /** Colecciones en las que se busca (las accesibles ∩ el filtro pedido). */
  collectionIds: string[];
  /** Documentos concretos (vacío = todos los de esas colecciones). */
  documentIds: string[];
  /** Clave del conjunto anterior, para la caché. */
  key: string;
}

/** Colecciones que el usuario puede consultar, opcionalmente restringidas a un filtro. */
export async function resolveScope(
  ctx: TenantContext,
  requested?: string[] | null,
  requestedDocuments?: string[] | null,
): Promise<RetrievalScope> {
  return withTenant(ctx, async (tx) => {
    const accessible = await tx<{ id: string }[]>`SELECT id FROM collections`;
    let ids = accessible.map((r) => r.id);
    if (requested && requested.length > 0) ids = ids.filter((id) => requested.includes(id));
    let documentIds: string[] = [];
    if (requestedDocuments && requestedDocuments.length > 0) {
      // Solo documentos visibles (RLS) dentro de las colecciones elegidas.
      const docs = await tx<{ id: string }[]>`
        SELECT id FROM documents WHERE id = ANY(${requestedDocuments}::uuid[]) AND collection_id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`;
      documentIds = docs.map((d) => d.id);
      if (documentIds.length === 0) ids = []; // ninguno accesible → no buscar nada
    }
    const key = documentIds.length ? scopeKey([...ids, "docs", ...[...documentIds].sort()]) : scopeKey(ids);
    return { collectionIds: ids, documentIds, key };
  });
}

export type RankedHit = SearchHit & { rerankScore: number | null };

/**
 * Recuperación completa:
 *  1. búsqueda híbrida (dentro de la transacción con RLS);
 *  2. re-ranking con el cross-encoder (fuera de la transacción);
 *  3. se quedan los RETRIEVAL_TOP_K mejores con puntuación ≥ RERANK_MIN_SCORE.
 * Sin re-ranker, se usa directamente el orden de la búsqueda híbrida.
 */
export async function retrieve(
  ctx: TenantContext,
  opts: { queryText: string; queryVector: number[]; scope: RetrievalScope; topK?: number; signal?: AbortSignal },
): Promise<RankedHit[]> {
  const topK = opts.topK ?? config.RETRIEVAL_TOP_K;
  if (opts.scope.collectionIds.length === 0) return [];
  const useReranker = rerankerEnabled();

  const candidates = await withTenant(ctx, (tx) =>
    hybridSearch(tx, {
      queryText: opts.queryText,
      queryVector: opts.queryVector,
      collectionIds: opts.scope.collectionIds,
      documentIds: opts.scope.documentIds,
      topK: useReranker ? Math.max(config.RERANK_CANDIDATES, topK) : topK,
    }),
  );
  if (!useReranker) return candidates.map((h) => ({ ...h, rerankScore: null }));

  const scores = await rerank(
    opts.queryText,
    candidates.map((h) => rerankText(h)),
    opts.signal,
  );
  if (!scores) return candidates.slice(0, topK).map((h) => ({ ...h, rerankScore: null }));
  return applyRerank(candidates, scores, topK, config.RERANK_MIN_SCORE);
}
