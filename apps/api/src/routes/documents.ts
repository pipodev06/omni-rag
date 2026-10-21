import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { withTenant } from "../db/client.js";
import { requireAuth, requireRole, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { formatFor, SUPPORTED_EXTENSIONS } from "../ingest/formats.js";
import { enqueueIngest } from "../queue.js";
import { invalidateCollections } from "../rag/cache.js";
import { readStoredFile, removeStored, safeFilename, saveFile } from "../storage/local.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { UUID_RE } from "../lib/validate.js";

export const documentRoutes = new Hono<AppEnv>();
documentRoutes.use("*", requireAuth);

const DOC_FIELDS = `
  d.id, d.collection_id AS "collectionId", d.title, d.filename, d.mime_type AS "mimeType",
  d.size_bytes::float8 AS "sizeBytes", d.status, d.error, d.page_count AS "pageCount",
  d.chunk_count AS "chunkCount", d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

const idParam = (id: string) => {
  if (!UUID_RE.test(id)) throw notFound("Documento no encontrado");
  return id;
};

/** Lista de documentos visibles (opcionalmente de una colección). */
documentRoutes.get("/", async (c) => {
  const collectionId = c.req.query("collectionId");
  if (collectionId && !UUID_RE.test(collectionId)) throw badRequest("collectionId inválido");
  const documents = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT ${tx.unsafe(DOC_FIELDS)}, u.name AS "createdBy"
      FROM documents d LEFT JOIN users u ON u.id = d.created_by
     WHERE (${collectionId ?? null}::uuid IS NULL OR d.collection_id = ${collectionId ?? null}::uuid)
     ORDER BY d.created_at DESC
     LIMIT 1000`);
  return c.json({ documents, supportedExtensions: SUPPORTED_EXTENSIONS });
});

documentRoutes.get("/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const [doc] = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT ${tx.unsafe(DOC_FIELDS)} FROM documents d WHERE d.id = ${id}`);
  if (!doc) throw notFound("Documento no encontrado");
  return c.json({ document: doc });
});

/** Trozos de un documento (útil para revisar cómo se fragmentó). */
documentRoutes.get("/:id/chunks", async (c) => {
  const id = idParam(c.req.param("id"));
  const chunks = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT chunk_index AS "index", heading, content, page_start AS "pageStart", page_end AS "pageEnd"
      FROM chunks WHERE document_id = ${id} ORDER BY chunk_index LIMIT 2000`);
  return c.json({ chunks });
});

/** Descarga el archivo original. */
documentRoutes.get("/:id/file", async (c) => {
  const id = idParam(c.req.param("id"));
  const [doc] = await withTenant(tenantCtx(c), (tx) => tx<{ storage_key: string; filename: string; mime_type: string }[]>`
    SELECT storage_key, filename, mime_type FROM documents WHERE id = ${id}`);
  if (!doc) throw notFound("Documento no encontrado");
  const data = await readStoredFile(doc.storage_key);
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": doc.mime_type,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "x-content-type-options": "nosniff",
    },
  });
});

/**
 * Sube uno o varios archivos (multipart/form-data):
 *   - collectionId: colección destino
 *   - file: uno o más archivos
 * Los archivos se guardan y se encolan para procesarse en segundo plano.
 */
documentRoutes.post(
  "/",
  requireRole("admin", "editor"),
  bodyLimit({
    maxSize: config.MAX_UPLOAD_MB * 1024 * 1024 * 10, // varios archivos por petición
    onError: () => {
      throw new HttpError(413, "La subida es demasiado grande");
    },
  }),
  async (c) => {
    const form = await c.req.parseBody({ all: true });
    const collectionId = form.collectionId;
    if (typeof collectionId !== "string" || !UUID_RE.test(collectionId)) throw badRequest("Falta collectionId");
    const raw = form.file;
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (files.length === 0) throw badRequest("No se recibió ningún archivo (campo 'file')");

    const ctx = tenantCtx(c);
    const user = c.get("user");
    const results: { filename: string; id?: string; status: "queued" | "duplicate" | "rejected"; reason?: string }[] = [];

    for (const file of files) {
      const filename = safeFilename(file.name);
      const format = formatFor(filename);
      if (!format) {
        results.push({ filename, status: "rejected", reason: `Formato no soportado. Admitidos: ${SUPPORTED_EXTENSIONS.join(", ")}` });
        continue;
      }
      if (file.size > config.MAX_UPLOAD_MB * 1024 * 1024) {
        results.push({ filename, status: "rejected", reason: `Supera ${config.MAX_UPLOAD_MB} MB` });
        continue;
      }
      if (file.size === 0) {
        results.push({ filename, status: "rejected", reason: "Archivo vacío" });
        continue;
      }

      const data = new Uint8Array(await file.arrayBuffer());
      const sha256 = createHash("sha256").update(data).digest("hex");
      const id = randomUUID();
      const storageKey = `${ctx.tenantId}/${id}/${filename}`;
      const title = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || filename;

      const inserted = await withTenant(ctx, async (tx) => {
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM documents WHERE collection_id = ${collectionId} AND sha256 = ${sha256}`;
        if (existing) return { duplicateOf: existing.id };
        // Comprueba acceso a la colección (RLS ya lo impone; esto da un mensaje claro).
        const [col] = await tx`SELECT id FROM collections WHERE id = ${collectionId}`;
        if (!col) throw notFound("Colección no encontrada o sin acceso");
        await saveFile(storageKey, data);
        await tx`
          INSERT INTO documents (id, tenant_id, collection_id, title, filename, mime_type, size_bytes,
                                 sha256, storage_key, created_by)
          VALUES (${id}, ${ctx.tenantId}, ${collectionId}, ${title}, ${filename}, ${format.mime},
                  ${file.size}, ${sha256}, ${storageKey}, ${user.id})`;
        return { duplicateOf: null };
      }).catch(async (err) => {
        await removeStored(`${ctx.tenantId}/${id}`).catch(() => {});
        throw err;
      });

      if (inserted.duplicateOf) {
        results.push({ filename, id: inserted.duplicateOf, status: "duplicate", reason: "Ya existe en esta colección" });
        continue;
      }
      await enqueueIngest({ tenantId: ctx.tenantId, documentId: id });
      results.push({ filename, id, status: "queued" });
    }

    return c.json({ results }, 201);
  },
);

/** Vuelve a procesar un documento (p. ej. tras cambiar el modelo de embeddings). */
documentRoutes.post("/:id/reprocess", requireRole("admin", "editor"), async (c) => {
  const id = idParam(c.req.param("id"));
  const ctx = tenantCtx(c);
  const [doc] = await withTenant(ctx, (tx) => tx`
    UPDATE documents SET status = 'pending', error = NULL, updated_at = now()
     WHERE id = ${id} RETURNING id`);
  if (!doc) throw notFound("Documento no encontrado");
  await enqueueIngest({ tenantId: ctx.tenantId, documentId: id });
  return c.json({ ok: true });
});

documentRoutes.delete("/:id", requireRole("admin", "editor"), async (c) => {
  const id = idParam(c.req.param("id"));
  const ctx = tenantCtx(c);
  const doc = await withTenant(ctx, async (tx) => {
    const [d] = await tx<{ collection_id: string }[]>`DELETE FROM documents WHERE id = ${id} RETURNING collection_id`;
    if (d) await invalidateCollections(tx, [d.collection_id]);
    return d;
  });
  if (!doc) throw notFound("Documento no encontrado");
  await removeStored(`${ctx.tenantId}/${id}`);
  return c.json({ ok: true });
});
