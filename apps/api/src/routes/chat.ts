import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config } from "../config.js";
import { sqlOwner, withTenant, type TenantContext } from "../db/client.js";
import { requireAuth, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { embedQuery } from "../ingest/embeddings.js";
import { findCachedAnswer, markCacheHit, storeCachedAnswer } from "../rag/cache.js";
import { streamChat } from "../rag/llm.js";
import { buildMessages, citedSources, NO_CONTEXT_ANSWER, retrievalQuery, type ChatMessage } from "../rag/prompt.js";
import { resolveScope, retrieve, type RankedHit } from "../rag/retrieve.js";
import { HttpError, notFound } from "../lib/errors.js";
import { parse, UUID_RE } from "../lib/validate.js";

export const chatRoutes = new Hono<AppEnv>();
chatRoutes.use("*", requireAuth);

/** Fuente tal como se guarda con el mensaje y se envía al navegador. */
export interface Source {
  n: number;
  documentId: string;
  documentTitle: string;
  heading: string;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
  cited: boolean;
}

const toSources = (hits: RankedHit[]): Source[] =>
  hits.map((h, i) => ({
    n: i + 1,
    documentId: h.documentId,
    documentTitle: h.documentTitle,
    heading: h.heading,
    pageStart: h.pageStart,
    pageEnd: h.pageEnd,
    excerpt: h.content.length > 600 ? `${h.content.slice(0, 600)}…` : h.content,
    cited: false,
  }));

/** Comprueba el límite diario de llamadas al LLM (preguntas y resúmenes) de la organización. */
export async function checkDailyLimit(ctx: TenantContext): Promise<void> {
  const [tenant] = await sqlOwner<{ daily_question_limit: number | null }[]>`
    SELECT daily_question_limit FROM tenants WHERE id = ${ctx.tenantId}`;
  const limit = tenant?.daily_question_limit ?? config.TENANT_DAILY_QUESTION_LIMIT;
  if (limit === 0) return; // 0 = sin límite
  const [row] = await sqlOwner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM usage_events
     WHERE tenant_id = ${ctx.tenantId} AND kind IN ('question', 'summary')
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  if ((row?.n ?? 0) >= limit) {
    throw new HttpError(429, `Tu organización alcanzó el límite de ${limit} preguntas por día.`);
  }
}

const SearchBody = z.object({
  query: z.string().trim().min(1).max(2000),
  collectionIds: z.array(z.string().regex(UUID_RE)).max(100).optional(),
  documentIds: z.array(z.string().regex(UUID_RE)).max(50).optional(),
  topK: z.number().int().min(1).max(50).optional(),
});

/**
 * Búsqueda sin LLM: devuelve los fragmentos más relevantes (con re-ranking si
 * está activo). No consume cupo de OpenRouter; útil para calibrar la recuperación.
 */
chatRoutes.post("/search", async (c) => {
  const body = parse(SearchBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);
  const [vector, scope] = await Promise.all([embedQuery(body.query, c.req.raw.signal), resolveScope(ctx, body.collectionIds, body.documentIds)]);
  const results = await retrieve(ctx, { queryText: body.query, queryVector: vector, scope, topK: body.topK, signal: c.req.raw.signal });
  return c.json({ results });
});

const ChatBody = z.object({
  question: z.string().trim().min(1).max(4000),
  conversationId: z.string().regex(UUID_RE).optional(),
  collectionIds: z.array(z.string().regex(UUID_RE)).max(100).optional(),
  documentIds: z.array(z.string().regex(UUID_RE)).max(50).optional(),
});

/**
 * Pregunta al RAG. Responde con Server-Sent Events:
 *   event: meta    → { conversationId, sources }
 *   event: token   → fragmento de texto de la respuesta
 *   event: done    → { messageId, model, sources, fromCache }  (sources con `cited` marcado)
 *   event: error   → { message }
 */
chatRoutes.post("/chat", async (c) => {
  const body = parse(ChatBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);
  const user = c.get("user");
  const signal = c.req.raw.signal;

  // 1. Historial de la conversación (si continúa una existente).
  const history = body.conversationId
    ? await withTenant(ctx, async (tx) => {
        const [conv] = await tx`SELECT id FROM conversations WHERE id = ${body.conversationId!}`;
        if (!conv) throw notFound("Conversación no encontrada");
        const rows = await tx<ChatMessage[]>`
          SELECT role, content FROM (
            SELECT role, content, created_at FROM messages
             WHERE conversation_id = ${body.conversationId!}
             ORDER BY created_at DESC LIMIT ${config.HISTORY_MESSAGES}
          ) m ORDER BY created_at`;
        return [...rows];
      })
    : [];

  // 2. Embedding de la búsqueda y colecciones consultables.
  const query = retrievalQuery(body.question, history);
  const [vector, scope] = await Promise.all([embedQuery(query, signal), resolveScope(ctx, body.collectionIds, body.documentIds)]);
  const cacheable = config.CACHE_ENABLED && history.length === 0;

  // 3. ¿Ya se respondió esta misma pregunta con los mismos documentos?
  const cached = cacheable
    ? await withTenant(ctx, (tx) => findCachedAnswer(tx, { tenantId: ctx.tenantId, scope: scope.key, question: body.question, vector }))
    : null;

  // 4. Las respuestas nuevas cuentan para el límite diario (antes de guardar nada).
  if (!cached) await checkDailyLimit(ctx);

  // 5. Crear la conversación si es nueva y guardar la pregunta.
  const conversationId = await withTenant(ctx, async (tx) => {
    let convId = body.conversationId;
    if (!convId) {
      const title = body.question.length > 80 ? `${body.question.slice(0, 77)}…` : body.question;
      const [conv] = await tx<{ id: string }[]>`
        INSERT INTO conversations (tenant_id, user_id, title) VALUES (${ctx.tenantId}, ${user.id}, ${title})
        RETURNING id`;
      convId = conv!.id;
    }
    await tx`
      INSERT INTO messages (tenant_id, user_id, conversation_id, role, content)
      VALUES (${ctx.tenantId}, ${user.id}, ${convId}, 'user', ${body.question})`;
    await tx`UPDATE conversations SET updated_at = now() WHERE id = ${convId}`;
    return convId;
  });

  const saveAnswer = async (
    content: string,
    opts: { model: string | null; sources: Source[]; tokens?: [number | null, number | null]; cacheId?: string; usage?: "question" | "cache_hit" },
  ) =>
    withTenant(ctx, async (tx) => {
      const [msg] = await tx<{ id: string }[]>`
        INSERT INTO messages (tenant_id, user_id, conversation_id, role, content, sources, model, from_cache, cache_id)
        VALUES (${ctx.tenantId}, ${user.id}, ${conversationId}, 'assistant', ${content},
                ${tx.json(opts.sources as never)}, ${opts.model}, ${opts.cacheId !== undefined}, ${opts.cacheId ?? null})
        RETURNING id`;
      if (opts.usage) {
        await tx`
          INSERT INTO usage_events (tenant_id, user_id, kind, model, prompt_tokens, completion_tokens)
          VALUES (${ctx.tenantId}, ${user.id}, ${opts.usage}, ${opts.model},
                  ${opts.tokens?.[0] ?? null}, ${opts.tokens?.[1] ?? null})`;
      }
      return msg!.id;
    });

  // 6a. Respuesta desde la caché: no se llama al LLM ni consume cupo.
  if (cached) {
    const sources = cached.sources as Source[];
    await withTenant(ctx, (tx) => markCacheHit(tx, cached.id));
    const messageId = await saveAnswer(cached.answer, { model: cached.model, sources, cacheId: cached.id, usage: "cache_hit" });
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId, sources }) });
      await stream.writeSSE({ event: "token", data: JSON.stringify(cached.answer) });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId, model: cached.model, sources, fromCache: true }) });
    });
  }

  // 6b. Recuperación: búsqueda híbrida + re-ranking, respetando permisos.
  const hits = await retrieve(ctx, { queryText: query, queryVector: vector, scope, signal });
  const sources = toSources(hits);

  // 7. Respuesta en streaming.
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId, sources }) });

    if (hits.length === 0) {
      // Sin contexto no se llama al LLM: ahorra cupo y evita respuestas inventadas.
      await stream.writeSSE({ event: "token", data: JSON.stringify(NO_CONTEXT_ANSWER) });
      const messageId = await saveAnswer(NO_CONTEXT_ANSWER, { model: null, sources: [] });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId, model: null, sources: [], fromCache: false }) });
      return;
    }

    let answer = "";
    try {
      for await (const ev of streamChat(buildMessages(body.question, hits, history), signal)) {
        if (ev.type === "token") {
          answer += ev.text;
          await stream.writeSSE({ event: "token", data: JSON.stringify(ev.text) });
        } else {
          const cited = citedSources(answer);
          const finalSources = sources.map((s) => ({ ...s, cited: cited.has(s.n) }));
          const messageId = await saveAnswer(answer, {
            model: ev.model,
            sources: finalSources,
            tokens: [ev.promptTokens, ev.completionTokens],
            usage: "question",
          });
          if (cacheable) {
            await withTenant(ctx, (tx) =>
              storeCachedAnswer(tx, {
                tenantId: ctx.tenantId,
                scope: scope.key,
                collectionIds: scope.collectionIds,
                question: body.question,
                vector,
                answer,
                sources: finalSources,
                model: ev.model,
                messageId,
              }),
            ).catch((err) => console.warn("[cache] no se pudo guardar:", err));
          }
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({ messageId, model: ev.model, sources: finalSources, fromCache: false }),
          });
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof HttpError ? err.message : "Error generando la respuesta";
      console.error("[chat] error:", err);
      if (answer) await saveAnswer(`${answer}\n\n_(respuesta interrumpida)_`, { model: null, sources }).catch(() => {});
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
    }
  });
});

// ---------------------------------------------------------------------------
// Conversaciones (cada usuario ve solo las suyas; lo garantiza RLS)
// ---------------------------------------------------------------------------

chatRoutes.get("/conversations", async (c) => {
  const conversations = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM conversations ORDER BY updated_at DESC LIMIT 200`);
  return c.json({ conversations });
});

chatRoutes.get("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const data = await withTenant(tenantCtx(c), async (tx) => {
    const [conversation] = await tx`SELECT id, title, created_at AS "createdAt" FROM conversations WHERE id = ${id}`;
    if (!conversation) throw notFound("Conversación no encontrada");
    const messages = await tx`
      SELECT m.id, m.role, m.content, m.sources, m.model, m.from_cache AS "fromCache",
             m.created_at AS "createdAt", f.rating AS feedback
        FROM messages m LEFT JOIN message_feedback f ON f.message_id = m.id
       WHERE m.conversation_id = ${id} ORDER BY m.created_at`;
    return { conversation, messages };
  });
  return c.json(data);
});

chatRoutes.delete("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await withTenant(tenantCtx(c), (tx) => tx`DELETE FROM conversations WHERE id = ${id} RETURNING id`);
  if (!row) throw notFound("Conversación no encontrada");
  return c.json({ ok: true });
});
