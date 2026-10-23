import { config } from "../config.js";
import { toPgVector, type Tx } from "../db/client.js";

export interface SearchHit {
  chunkId: number;
  documentId: string;
  documentTitle: string;
  collectionId: string;
  heading: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
  distance: number | null;
}

export interface SearchOptions {
  queryText: string;
  queryVector: number[];
  /** Limitar a estas colecciones (además de las restricciones de permisos). */
  collectionIds?: string[] | null;
  /** Limitar a estos documentos ("preguntar sobre este documento"). */
  documentIds?: string[] | null;
  topK?: number;
  candidates?: number;
}

/** Constante estándar de Reciprocal Rank Fusion. */
const RRF_K = 60;

/**
 * Búsqueda híbrida = semántica (pgvector, distancia coseno) + palabras clave
 * (búsqueda de texto completo de PostgreSQL), combinadas con Reciprocal Rank
 * Fusion: score = Σ 1 / (60 + posición en cada lista).
 *
 * Debe ejecutarse dentro de withTenant(): las políticas RLS garantizan que
 * solo se consideren trozos de colecciones a las que el usuario tiene acceso.
 */
export async function hybridSearch(tx: Tx, opts: SearchOptions): Promise<SearchHit[]> {
  const topK = opts.topK ?? config.RETRIEVAL_TOP_K;
  const candidates = opts.candidates ?? config.RETRIEVAL_CANDIDATES;
  const collections = opts.collectionIds && opts.collectionIds.length > 0 ? opts.collectionIds : null;
  const documents = opts.documentIds && opts.documentIds.length > 0 ? opts.documentIds : null;
  const vector = toPgVector(opts.queryVector);

  // Con filtros (RLS / colección), el escaneo iterativo de pgvector >= 0.8
  // sigue buscando en el índice HNSW hasta encontrar suficientes resultados.
  await tx`
    SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true),
           set_config('hnsw.ef_search', ${String(Math.max(100, candidates * 2))}, true)`;

  const rows = await tx<
    {
      chunk_id: string;
      document_id: string;
      document_title: string;
      collection_id: string;
      heading: string;
      content: string;
      page_start: number | null;
      page_end: number | null;
      score: number;
      vector_rank: number | null;
      keyword_rank: number | null;
      distance: number | null;
    }[]
  >`
    WITH vec AS (
      SELECT id, dist, row_number() OVER (ORDER BY dist) AS rnk
        FROM (
          SELECT c.id, c.embedding <=> ${vector}::vector AS dist
            FROM chunks c
           WHERE c.tenant_id = app_tenant_id()
             AND (${collections}::uuid[] IS NULL OR c.collection_id = ANY(${collections}::uuid[]))
             AND (${documents}::uuid[] IS NULL OR c.document_id = ANY(${documents}::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.id = c.document_id AND x.deleted_at IS NOT NULL)
           ORDER BY c.embedding <=> ${vector}::vector
           LIMIT ${candidates}
        ) s
       WHERE dist <= ${config.RETRIEVAL_MAX_DISTANCE}
    ),
    q AS (
      -- Convierte la pregunta en una consulta OR ("contrato | garantía | plazo")
      -- para que no haga falta que aparezcan todas las palabras.
      SELECT nullif(replace(plainto_tsquery(${config.FTS_LANGUAGE}::regconfig, ${opts.queryText})::text, '&', '|'), '')::tsquery AS query
    ),
    kw AS (
      SELECT id, row_number() OVER (ORDER BY rank DESC) AS rnk
        FROM (
          SELECT c.id, ts_rank_cd(c.tsv, q.query) AS rank
            FROM chunks c, q
           WHERE q.query IS NOT NULL
             AND c.tsv @@ q.query
             AND c.tenant_id = app_tenant_id()
             AND (${collections}::uuid[] IS NULL OR c.collection_id = ANY(${collections}::uuid[]))
             AND (${documents}::uuid[] IS NULL OR c.document_id = ANY(${documents}::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.id = c.document_id AND x.deleted_at IS NOT NULL)
           ORDER BY rank DESC
           LIMIT ${candidates}
        ) s
    ),
    fused AS (
      SELECT coalesce(vec.id, kw.id) AS id,
             coalesce(1.0 / (${RRF_K} + vec.rnk), 0) + coalesce(1.0 / (${RRF_K} + kw.rnk), 0) AS score,
             vec.rnk AS vector_rank, kw.rnk AS keyword_rank, vec.dist AS distance
        FROM vec FULL OUTER JOIN kw ON kw.id = vec.id
    )
    SELECT c.id AS chunk_id, c.document_id, d.title AS document_title, c.collection_id,
           c.heading, c.content, c.page_start, c.page_end,
           f.score::float8 AS score, f.vector_rank::int AS vector_rank,
           f.keyword_rank::int AS keyword_rank, f.distance::float8 AS distance
      FROM fused f
      JOIN chunks c ON c.id = f.id
      JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL
     ORDER BY f.score DESC
     LIMIT ${topK}
  `;

  return rows.map((r) => ({
    chunkId: Number(r.chunk_id),
    documentId: r.document_id,
    documentTitle: r.document_title,
    collectionId: r.collection_id,
    heading: r.heading,
    content: r.content,
    pageStart: r.page_start,
    pageEnd: r.page_end,
    score: r.score,
    vectorRank: r.vector_rank,
    keywordRank: r.keyword_rank,
    distance: r.distance,
  }));
}
