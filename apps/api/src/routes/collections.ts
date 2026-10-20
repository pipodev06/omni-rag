import { Hono } from "hono";
import { z } from "zod";
import { withTenant } from "../db/client.js";
import { requireAuth, requireRole, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { removeStored } from "../storage/local.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { parse, UUID_RE } from "../lib/validate.js";

/**
 * Colecciones = carpetas de documentos. Cada usuario ve solo las colecciones
 * de las que es miembro (los administradores ven todas las de su organización).
 */
export const collectionRoutes = new Hono<AppEnv>();
collectionRoutes.use("*", requireAuth);

collectionRoutes.get("/", async (c) => {
  const collections = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT col.id, col.name, col.description, col.created_at AS "createdAt",
           (SELECT count(*)::int FROM documents d WHERE d.collection_id = col.id) AS "documentCount",
           (SELECT coalesce(array_agg(m.user_id), '{}') FROM collection_members m
             WHERE m.collection_id = col.id) AS "memberIds"
      FROM collections col
     ORDER BY col.name`);
  return c.json({ collections });
});

const CollectionBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
});

const uniqueName = (err: { code?: string }) => {
  if (err.code === "23505") throw new HttpError(409, "Ya existe una colección con ese nombre");
  throw err;
};

collectionRoutes.post("/", requireRole("admin"), async (c) => {
  const body = parse(CollectionBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);
  const [row] = await withTenant(ctx, (tx) => tx<{ id: string }[]>`
    INSERT INTO collections (tenant_id, name, description)
    VALUES (${ctx.tenantId}, ${body.name}, ${body.description})
    RETURNING id`).catch(uniqueName);
  return c.json({ id: row!.id }, 201);
});

collectionRoutes.patch("/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(CollectionBody.partial(), await c.req.json().catch(() => ({})));
  const [row] = await withTenant(tenantCtx(c), (tx) => tx`
    UPDATE collections SET name = coalesce(${body.name ?? null}, name),
                           description = coalesce(${body.description ?? null}, description)
     WHERE id = ${id} RETURNING id`).catch(uniqueName);
  if (!row) throw notFound("Colección no encontrada");
  return c.json({ ok: true });
});

collectionRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const ctx = tenantCtx(c);
  const docs = await withTenant(ctx, async (tx) => {
    const files = await tx<{ id: string }[]>`SELECT id FROM documents WHERE collection_id = ${id}`;
    const [row] = await tx`DELETE FROM collections WHERE id = ${id} RETURNING id`;
    if (!row) throw notFound("Colección no encontrada");
    return files;
  });
  // Los trozos y documentos se borran en cascada; aquí se borran los archivos.
  await Promise.all(docs.map((d) => removeStored(`${ctx.tenantId}/${d.id}`)));
  return c.json({ ok: true, deletedDocuments: docs.length });
});

const MembersBody = z.object({ userIds: z.array(z.string().regex(UUID_RE)).max(10_000) });

/** Reemplaza la lista de miembros de una colección. */
collectionRoutes.put("/:id/members", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const { userIds } = parse(MembersBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);
  await withTenant(ctx, async (tx) => {
    const [col] = await tx`SELECT id FROM collections WHERE id = ${id}`;
    if (!col) throw notFound("Colección no encontrada");
    await tx`DELETE FROM collection_members WHERE collection_id = ${id}`;
    for (const uid of new Set(userIds)) {
      await tx`INSERT INTO collection_members (tenant_id, collection_id, user_id) VALUES (${ctx.tenantId}, ${id}, ${uid})`;
    }
  }).catch((err: { code?: string }) => {
    if (err.code === "23503") throw badRequest("Algún usuario no existe");
    throw err;
  });
  return c.json({ ok: true });
});
