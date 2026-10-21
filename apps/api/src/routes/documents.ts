import { createHash, randomUUID } from "node:crypto";
import { audit } from "../lib/audit.js";
import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { config } from "../config.js";
import { sqlOwner, withTenant } from "../db/client.js";
import { subscribeDocumentEvents } from "../lib/documentEvents.js";
import { completeChat } from "../rag/llm.js";
import { buildSummaryMessages, parseSummary } from "../rag/summary.js";
import { checkDailyLimit } from "./chat.js";
import { requireAuth, requireRole, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { contentMatchesFormat, formatFor, SUPPORTED_EXTENSIONS } from "../ingest/formats.js";
import { enqueueIngest } from "../queue.js";
import { invalidateCollections } from "../rag/cache.js";
import { readStoredFile, removeStored, safeFilename, saveFile, titleFromFilename } from "../storage/local.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { userRateLimit } from "../lib/limits.js";
import { documentSlots } from "../lib/plans.js";
import { parse, UUID_RE } from "../lib/validate.js";

export const documentRoutes = new Hono<AppEnv>();
documentRoutes.use("*", requireAuth);

/**
 * Avisos en tiempo real (Server-Sent Events) de cambios de estado de los
 * documentos que el usuario puede ver. Lo usa la interfaz para actualizarse
 * sin consultar periódicamente y para avisar cuando un documento está listo.
 */
documentRoutes.get("/events", (c) => {
  const user = c.get("user");
  const ctx = tenantCtx(c);
  return streamSSE(c, async (stream) => {
    let accessible = new Set<string>();
    const refreshAccess = async () => {
      const rows = await withTenant(ctx, (tx) => tx<{ id: string }[]>`SELECT id FROM collections`);
      accessible = new Set(rows.map((r) => r.id));
    };
    await refreshAccess();

    const unsubscribe = await subscribeDocumentEvents((e) => {
      if (e.tenantId !== user.tenantId) return;
      if (user.role !== "admin" && !accessible.has(e.collectionId)) return;
      void stream.writeSSE({
        event: "document",
        data: JSON.stringify({
          op: e.op,
          documentId: e.documentId,
          collectionId: e.collectionId,
          title: e.title,
          status: e.status,
          error: e.error,
          mine: e.createdBy === user.id,
        }),
      }).catch(() => {}); // conexión cerrada: se ignora
    });
    stream.onAbort(unsubscribe);

    await stream.writeSSE({ event: "ready", data: "{}" });
    // Mantener viva la conexión (proxies) y refrescar los permisos cada minuto.
    let ticks = 0;
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(25_000);
      await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      if (++ticks % 2 === 0) await refreshAccess().catch(() => {});
    }
    unsubscribe();
  });
});

/** Preguntas sugeridas (de los resúmenes generados) para la pantalla inicial del chat. */
documentRoutes.get("/suggestions", async (c) => {
  const documentId = c.req.query("documentId");
  if (documentId && !UUID_RE.test(documentId)) throw badRequest("documentId inválido");
  const suggestions = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT d.id AS "documentId", d.title AS "documentTitle", q AS question
      FROM documents d, unnest(d.suggested_questions) AS q
     WHERE d.status = 'ready' AND (${documentId ?? null}::uuid IS NULL OR d.id = ${documentId ?? null}::uuid)
     ORDER BY random() LIMIT 8`);
  return c.json({ suggestions });
});

const DOC_FIELDS = `
  d.id, d.collection_id AS "collectionId", d.title, d.filename, d.mime_type AS "mimeType",
  d.size_bytes::float8 AS "sizeBytes", d.status, d.error, d.page_count AS "pageCount",
  d.chunk_count AS "chunkCount", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
  (d.summary IS NOT NULL) AS "hasSummary"`;

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
    SELECT ${tx.unsafe(DOC_FIELDS)}, d.summary, d.suggested_questions AS "suggestedQuestions",
           d.summary_model AS "summaryModel", d.summary_at AS "summaryAt"
      FROM documents d WHERE d.id = ${id}`);
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
  userRateLimit(30, 60_000, "subidas"),
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
    const slots = await documentSlots(ctx.tenantId);
    let left = slots.left;

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
      if (left !== null && left <= 0) {
        results.push({ filename, status: "rejected", reason: `Tu plan permite hasta ${slots.max} documentos` });
        continue;
      }

      const data = new Uint8Array(await file.arrayBuffer());
      if (!contentMatchesFormat(format.ext, data)) {
        results.push({ filename, status: "rejected", reason: `El contenido no corresponde a un archivo ${format.ext}` });
        continue;
      }
      const sha256 = createHash("sha256").update(data).digest("hex");
      const id = randomUUID();
      const storageKey = `${ctx.tenantId}/${id}/${filename}`;
      const title = titleFromFilename(file.name) || filename;

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
      if (left !== null) left -= 1;
      await enqueueIngest({ tenantId: ctx.tenantId, documentId: id });
      await audit(c, "document.uploaded", { targetType: "document", targetId: id, details: { filename, collectionId, size: file.size } });
      results.push({ filename, id, status: "queued" });
    }

    return c.json({ results }, 201);
  },
);

/**
 * Genera (o regenera) el resumen y las preguntas sugeridas con el LLM.
 * Consume una llamada del límite diario de la organización.
 */
documentRoutes.post("/:id/summary", userRateLimit(10, 60_000, "resúmenes"), async (c) => {
  const id = idParam(c.req.param("id"));
  const ctx = tenantCtx(c);
  const { doc, chunks } = await withTenant(ctx, async (tx) => {
    const [d] = await tx<{ title: string; status: string; tenant_id: string }[]>`
      SELECT title, status, tenant_id FROM documents WHERE id = ${id}`;
    if (!d) throw notFound("Documento no encontrado");
    if (d.status !== "ready") throw badRequest("El documento todavía no está listo");
    const rows = await tx<{ heading: string; content: string }[]>`
      SELECT heading, content FROM chunks WHERE document_id = ${id} ORDER BY chunk_index LIMIT 40`;
    return { doc: d, chunks: rows };
  });

  const plan = await checkDailyLimit(ctx);
  const result = await completeChat(buildSummaryMessages(doc.title, chunks), plan.llmModels, c.req.raw.signal);
  const { summary, questions } = parseSummary(result.text);

  // El acceso ya se comprobó arriba con RLS; se guarda con la conexión propietaria
  // para que también los lectores (que no pueden editar documentos) puedan generarlo.
  await sqlOwner`
    UPDATE documents SET summary = ${summary}, suggested_questions = ${questions}::text[],
           summary_model = ${result.model}, summary_at = now()
     WHERE id = ${id} AND tenant_id = ${doc.tenant_id}`;
  await withTenant(ctx, (tx) => tx`
    INSERT INTO usage_events (tenant_id, user_id, kind, model, prompt_tokens, completion_tokens)
    VALUES (${ctx.tenantId}, ${ctx.userId}, 'summary', ${result.model}, ${result.promptTokens}, ${result.completionTokens})`);

  await audit(c, "document.summary", { targetType: "document", targetId: id, details: { title: doc.title } });
  return c.json({ summary, suggestedQuestions: questions, summaryModel: result.model });
});

const RenameBody = z.object({ title: z.string().trim().min(1).max(200) });

/**
 * Cambia el título con el que se muestra el documento. El archivo original no cambia.
 * Los fragmentos ya indexados conservan el título antiguo en su texto de búsqueda
 * hasta que se reprocese el documento (el efecto es mínimo); la caché de respuestas
 * de la colección se vacía para que las citas muestren el título nuevo.
 */
documentRoutes.patch("/:id", requireRole("admin", "editor"), async (c) => {
  const id = idParam(c.req.param("id"));
  const body = parse(RenameBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);
  const doc = await withTenant(ctx, async (tx) => {
    const [d] = await tx<{ collection_id: string }[]>`
      UPDATE documents SET title = ${body.title}, updated_at = now() WHERE id = ${id} RETURNING collection_id`;
    if (d) await invalidateCollections(tx, [d.collection_id]);
    return d;
  });
  if (!doc) throw notFound("Documento no encontrado");
  await audit(c, "document.renamed", { targetType: "document", targetId: id, details: { title: body.title } });
  return c.json({ ok: true });
});

/** Vuelve a procesar un documento (p. ej. tras cambiar el modelo de embeddings). */
documentRoutes.post("/:id/reprocess", requireRole("admin", "editor"), async (c) => {
  const id = idParam(c.req.param("id"));
  const ctx = tenantCtx(c);
  const [doc] = await withTenant(ctx, (tx) => tx`
    UPDATE documents SET status = 'pending', error = NULL, updated_at = now()
     WHERE id = ${id} RETURNING id`);
  if (!doc) throw notFound("Documento no encontrado");
  await enqueueIngest({ tenantId: ctx.tenantId, documentId: id });
  await audit(c, "document.reprocessed", { targetType: "document", targetId: id });
  return c.json({ ok: true });
});

documentRoutes.delete("/:id", requireRole("admin", "editor"), async (c) => {
  const id = idParam(c.req.param("id"));
  const ctx = tenantCtx(c);
  const doc = await withTenant(ctx, async (tx) => {
    const [d] = await tx<{ collection_id: string; filename: string }[]>`
      DELETE FROM documents WHERE id = ${id} RETURNING collection_id, filename`;
    if (d) await invalidateCollections(tx, [d.collection_id]);
    return d;
  });
  if (!doc) throw notFound("Documento no encontrado");
  await removeStored(`${ctx.tenantId}/${id}`);
  await audit(c, "document.deleted", { targetType: "document", targetId: id, details: { filename: doc.filename } });
  return c.json({ ok: true });
});
