import { config } from "../config.js";
import { toPgVector, withTenant, type TenantContext } from "../db/client.js";
import { readStoredFile } from "../storage/local.js";
import { chunkDocument, embeddingText } from "./chunker.js";
import { embedMany } from "./embeddings.js";
import { extractText } from "./extract.js";

/**
 * Procesa un documento de punta a punta:
 *   archivo → texto (Docling) → trozos → embeddings → tabla `chunks`.
 *
 * Se ejecuta en el worker. Usa una identidad de sistema con rol "admin"
 * dentro de la organización del documento (las políticas RLS siguen
 * impidiendo tocar datos de otras organizaciones).
 */
export async function ingestDocument(
  tenantId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<{ chunks: number }> {
  const ctx: TenantContext = { tenantId, userId: null, role: "admin" };

  const doc = await withTenant(ctx, async (tx) => {
    const [d] = await tx<{ id: string; title: string; filename: string; storage_key: string }[]>`
      UPDATE documents SET status = 'processing', error = NULL, updated_at = now()
       WHERE id = ${documentId}
      RETURNING id, title, filename, storage_key`;
    return d;
  });
  if (!doc) {
    console.warn(`[ingest] documento ${documentId} no existe (¿borrado?), se omite`);
    return { chunks: 0 };
  }

  const started = Date.now();
  const file = await readStoredFile(doc.storage_key);
  const extracted = await extractText(doc.filename, file, signal);
  const chunks = chunkDocument(extracted.pages, {
    chunkSize: config.CHUNK_SIZE_CHARS,
    overlap: config.CHUNK_OVERLAP_CHARS,
  });
  if (chunks.length === 0) throw new Error("El documento no contiene texto extraíble");

  const vectors = await embedMany(
    chunks.map((c) => embeddingText(config.EMBEDDING_PASSAGE_PREFIX, doc.title, c)),
    signal,
  );

  // Reemplazo atómico: si algo falla, el documento conserva sus trozos anteriores.
  await withTenant(ctx, async (tx) => {
    const [current] = await tx<{ collection_id: string }[]>`
      SELECT collection_id FROM documents WHERE id = ${documentId} FOR UPDATE`;
    if (!current) return; // borrado mientras se procesaba

    await tx`DELETE FROM chunks WHERE document_id = ${documentId}`;
    const BATCH = 200;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      await tx`
        INSERT INTO chunks (tenant_id, collection_id, document_id, chunk_index, heading, content,
                            page_start, page_end, embedding)
        SELECT ${tenantId}, ${current.collection_id}, ${documentId}, x.idx, x.heading, x.content,
               x.page_start, x.page_end, x.embedding::vector
          FROM unnest(
                 ${slice.map((c) => c.index)}::int[],
                 ${slice.map((c) => c.heading)}::text[],
                 ${slice.map((c) => c.content)}::text[],
                 ${slice.map((c) => c.pageStart)}::int[],
                 ${slice.map((c) => c.pageEnd)}::int[],
                 ${slice.map((_, j) => toPgVector(vectors[i + j]!))}::text[]
               ) AS x(idx, heading, content, page_start, page_end, embedding)`;
    }
    await tx`
      UPDATE documents
         SET status = 'ready', error = NULL, chunk_count = ${chunks.length},
             page_count = ${extracted.pageCount}, updated_at = now()
       WHERE id = ${documentId}`;
  });

  console.log(
    `[ingest] ${doc.filename}: ${chunks.length} trozos, ${extracted.pageCount ?? "-"} páginas, ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return { chunks: chunks.length };
}

/** Marca el documento como fallido (o pendiente de reintento) con un mensaje legible. */
export async function markIngestError(
  tenantId: string,
  documentId: string,
  message: string,
  willRetry: boolean,
): Promise<void> {
  await withTenant({ tenantId, userId: null, role: "admin" }, async (tx) => {
    await tx`
      UPDATE documents
         SET status = ${willRetry ? "pending" : "failed"},
             error = ${willRetry ? `Reintentando: ${message}` : message},
             updated_at = now()
       WHERE id = ${documentId}`;
  });
}
