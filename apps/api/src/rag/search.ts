import { config } from "../config.js";
import { toPgVector, type Tx } from "../db/client.js";
import { setting } from "../lib/settings.js";

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
 * Términos de la pregunta que parecen códigos o identificadores (llevan algún dígito: INC502635, 502635, F-2024-17).
 * La búsqueda por palabras solo encuentra palabras completas y la semántica no entiende de códigos, así que estos se
 * buscan además como texto dentro del fragmento (índice de trigramas). Se escapan los comodines de LIKE.
 */
export function identifierTerms(text: string): string[] {
  const terms = text.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  // Solo números cortos (2024, 1.1) aparecen en casi todos los documentos y el índice apenas filtra: se exige alguna
  // letra o, si es solo de dígitos, 5 o más.
  const codes = terms
    .map((t) => t.replace(/[.\-/_]+$/, ""))
    .filter((t) => /\p{N}/u.test(t) && (/\p{L}/u.test(t) ? t.length >= 3 : t.replace(/\D/g, "").length >= 5));
  return [...new Set(codes.map((t) => t.toLowerCase()))].slice(0, 3).map((t) => t.replace(/[\\%_]/g, "\\$&"));
}

/**
 * Búsqueda híbrida = semántica (pgvector, distancia coseno) + palabras clave
 * (búsqueda de texto completo de PostgreSQL, también por prefijo) + códigos
 * (texto dentro del fragmento, con trigramas), combinadas con Reciprocal Rank
 * Fusion: score = Σ 1 / (60 + posición en cada lista).
 *
 * Debe ejecutarse dentro de withTenant(): las políticas RLS garantizan que
 * solo se consideren trozos de colecciones a las que el usuario tiene acceso.
 */
export async function hybridSearch(tx: Tx, opts: SearchOptions): Promise<SearchHit[]> {
  const topK = opts.topK ?? setting("RETRIEVAL_TOP_K");
  const candidates = opts.candidates ?? config.RETRIEVAL_CANDIDATES;
  const collections = opts.collectionIds && opts.collectionIds.length > 0 ? opts.collectionIds : null;
  const documents = opts.documentIds && opts.documentIds.length > 0 ? opts.documentIds : null;
  const vector = toPgVector(opts.queryVector);
  const codes = identifierTerms(opts.queryText);
  // Un OR por término (y no ILIKE ANY) para que PostgreSQL use el índice de trigramas.
  const codeMatch = codes.length
    ? codes.map((t) => tx`c.content ILIKE ${`%${t}%`}`).reduce((a, b) => tx`${a} OR ${b}`)
    : tx`false`;

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
    q0 AS (
      -- Convierte la pregunta en una consulta OR ("contrato | garantía | plazo")
      -- para que no haga falta que aparezcan todas las palabras.
      SELECT nullif(replace(plainto_tsquery(${config.FTS_LANGUAGE}::regconfig, ${opts.queryText})::text, '&', '|'), '') AS t
    ),
    q AS (
      -- Además, cada palabra de 3 letras o más vale como prefijo ('inc':* encuentra INC502635). La coincidencia
      -- exacta puntúa el doble para que no la tapen las palabras que solo empiezan igual.
      -- El prefijo se arma lexema a lexema (citado y escapado) para que siempre sea un tsquery válido.
      SELECT t::tsquery AS query,
             (SELECT string_agg('''' || replace(replace(l, '\\', '\\\\'), '''', '''''') || '''' || CASE WHEN length(l) >= 3 THEN ':*' ELSE '' END, ' | ')
                FROM unnest(tsvector_to_array(to_tsvector(${config.FTS_LANGUAGE}::regconfig, ${opts.queryText}))) l)::tsquery AS prefix
        FROM q0 WHERE t IS NOT NULL
    ),
    kw AS (
      SELECT id, row_number() OVER (ORDER BY rank DESC) AS rnk
        FROM (
          SELECT c.id, 2 * ts_rank_cd(c.tsv, q.query) + ts_rank_cd(c.tsv, q.prefix) AS rank
            FROM chunks c, q
           WHERE c.tsv @@ q.prefix
             AND c.tenant_id = app_tenant_id()
             AND (${collections}::uuid[] IS NULL OR c.collection_id = ANY(${collections}::uuid[]))
             AND (${documents}::uuid[] IS NULL OR c.document_id = ANY(${documents}::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.id = c.document_id AND x.deleted_at IS NOT NULL)
           ORDER BY rank DESC
           LIMIT ${candidates}
        ) s
    ),
    code AS (
      -- Códigos buscados como texto dentro del fragmento (ver identifierTerms).
      -- Se corta antes de numerar (sin ORDER BY) para no ordenar todas las coincidencias.
      SELECT id, row_number() OVER () AS rnk
        FROM (
          SELECT c.id
            FROM chunks c
           WHERE (${codeMatch})
             AND c.tenant_id = app_tenant_id()
             AND (${collections}::uuid[] IS NULL OR c.collection_id = ANY(${collections}::uuid[]))
             AND (${documents}::uuid[] IS NULL OR c.document_id = ANY(${documents}::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.id = c.document_id AND x.deleted_at IS NOT NULL)
           LIMIT ${candidates}
        ) s
    ),
    fused AS (
      SELECT id, sum(1.0 / (${RRF_K} + rnk)) AS score,
             min(vector_rank) AS vector_rank, min(keyword_rank) AS keyword_rank, min(dist) AS distance
        FROM (
          SELECT id, rnk, rnk AS vector_rank, NULL::bigint AS keyword_rank, dist FROM vec
          UNION ALL SELECT id, rnk, NULL, rnk, NULL FROM kw
          UNION ALL SELECT id, rnk, NULL, rnk, NULL FROM code
        ) u
       GROUP BY id
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
