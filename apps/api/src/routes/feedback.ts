import { Hono } from "hono";
import { z } from "zod";
import { withTenant } from "../db/client.js";
import { requireAuth, requireRole, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { invalidateForMessage } from "../rag/cache.js";
import { notFound } from "../lib/errors.js";
import { parse, UUID_RE } from "../lib/validate.js";

// ---------------------------------------------------------------------------
// Valorar respuestas (cualquier usuario, sobre sus propios mensajes)
// ---------------------------------------------------------------------------
export const feedbackRoutes = new Hono<AppEnv>();
feedbackRoutes.use("*", requireAuth);

const FeedbackBody = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().trim().max(2000).default(""),
});

/** Guarda (o cambia) la valoración de una respuesta. Un 👎 la saca de la caché. */
feedbackRoutes.put("/:id/feedback", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(FeedbackBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);

  await withTenant(ctx, async (tx) => {
    // RLS: solo encuentra mensajes del propio usuario.
    const [answer] = await tx<
      { conversation_id: string; content: string; sources: unknown; model: string | null; from_cache: boolean; cache_id: string | null; created_at: Date }[]
    >`SELECT conversation_id, content, sources, model, from_cache, cache_id, created_at
        FROM messages WHERE id = ${id} AND role = 'assistant'`;
    if (!answer) throw notFound("Respuesta no encontrada");
    const [question] = await tx<{ content: string }[]>`
      SELECT content FROM messages
       WHERE conversation_id = ${answer.conversation_id} AND role = 'user' AND created_at <= ${answer.created_at}
       ORDER BY created_at DESC LIMIT 1`;

    await tx`
      INSERT INTO message_feedback (tenant_id, user_id, message_id, rating, comment, question, answer, sources, model, from_cache)
      VALUES (${ctx.tenantId}, ${ctx.userId}, ${id}, ${body.rating}, ${body.comment}, ${question?.content ?? ""},
              ${answer.content}, ${tx.json(answer.sources as never)}, ${answer.model}, ${answer.from_cache})
      ON CONFLICT (message_id) DO UPDATE
        SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, resolved = false, updated_at = now()`;

    if (body.rating === -1) await invalidateForMessage(tx, id, answer.cache_id);
  });
  return c.json({ ok: true });
});

feedbackRoutes.delete("/:id/feedback", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  await withTenant(tenantCtx(c), (tx) => tx`DELETE FROM message_feedback WHERE message_id = ${id}`);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Calidad: revisión de valoraciones y estadísticas (administradores)
// ---------------------------------------------------------------------------
export const qualityRoutes = new Hono<AppEnv>();
qualityRoutes.use("*", requireAuth, requireRole("admin"));

qualityRoutes.get("/", async (c) => {
  const rating = c.req.query("rating");
  const status = c.req.query("status"); // "pending" | "all"
  const data = await withTenant(tenantCtx(c), async (tx) => {
    const [summary] = await tx`
      SELECT count(*) FILTER (WHERE rating = 1)::int AS positive,
             count(*) FILTER (WHERE rating = -1)::int AS negative,
             count(*) FILTER (WHERE rating = -1 AND NOT resolved)::int AS "pendingNegative"
        FROM message_feedback WHERE created_at > now() - interval '30 days'`;
    const [usage] = await tx`
      SELECT count(*) FILTER (WHERE kind = 'question')::int AS questions,
             count(*) FILTER (WHERE kind = 'cache_hit')::int AS "cacheHits"
        FROM usage_events WHERE created_at > now() - interval '30 days'`;
    const [cache] = await tx`SELECT count(*)::int AS entries FROM answer_cache`;
    const items = await tx`
      SELECT f.id, f.rating, f.comment, f.question, f.answer, f.sources, f.model, f.from_cache AS "fromCache",
             f.resolved, f.created_at AS "createdAt", u.name AS "userName", u.email AS "userEmail"
        FROM message_feedback f JOIN users u ON u.id = f.user_id
       WHERE (${rating ?? null}::smallint IS NULL OR f.rating = ${rating ?? null}::smallint)
         AND (${status ?? "all"} = 'all' OR NOT f.resolved)
       ORDER BY f.created_at DESC LIMIT 200`;
    return { summary, usage, cache, items };
  });
  return c.json(data);
});

const ResolveBody = z.object({ resolved: z.boolean() });

qualityRoutes.patch("/feedback/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const { resolved } = parse(ResolveBody, await c.req.json().catch(() => ({})));
  const [row] = await withTenant(tenantCtx(c), (tx) => tx`
    UPDATE message_feedback SET resolved = ${resolved}, updated_at = now() WHERE id = ${id} RETURNING id`);
  if (!row) throw notFound("Valoración no encontrada");
  return c.json({ ok: true });
});

/** Vacía la caché de respuestas de la organización. */
qualityRoutes.delete("/cache", async (c) => {
  const rows = await withTenant(tenantCtx(c), (tx) => tx`DELETE FROM answer_cache RETURNING id`);
  return c.json({ ok: true, deleted: rows.length });
});
