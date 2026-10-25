import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config } from "../config.js";
import { sqlOwner, withTenant, type TenantContext } from "../db/client.js";
import { requireAuth, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { embedQuery } from "../ingest/embeddings.js";
import { findCachedAnswer, markCacheHit, storeCachedAnswer } from "../rag/cache.js";
import { streamChat } from "../rag/llm.js";
import { conversationToMarkdown, exportFilename, type ExportMessage } from "../rag/export.js";
import { buildMessages, citedSources, foldShouting, NO_CONTEXT_ANSWER, retrievalQuery, type ChatMessage } from "../rag/prompt.js";
import { searchWeb, webSearchEnabled, type WebResult } from "../lib/webSearch.js";
import { resolveScope, retrieve, type RankedHit } from "../rag/retrieve.js";
import { HttpError, notFound } from "../lib/errors.js";
import { userRateLimit } from "../lib/limits.js";
import { notifyQuota } from "../lib/quotaNotice.js";
import { getTenantPlan, questionsToday, quotaLevel, type TenantPlan } from "../lib/plans.js";
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
  /** Solo en resultados de internet (modo híbrido): `documentId` va vacío y `heading` lleva el dominio. */
  kind?: "web";
  url?: string;
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

const toWebSources = (results: WebResult[], offset: number): Source[] =>
  results.map((r, i) => ({
    n: offset + i + 1,
    documentId: "",
    documentTitle: r.title,
    heading: new URL(r.url).hostname.replace(/^www\./, ""),
    pageStart: null,
    pageEnd: null,
    excerpt: r.snippet,
    cited: false,
    kind: "web",
    url: r.url,
  }));

/**
 * Comprueba el límite diario de llamadas al LLM (preguntas y resúmenes) de la organización
 * según su plan. Devuelve el plan, que indica con qué modelos responder.
 */
export async function checkDailyLimit(ctx: TenantContext): Promise<TenantPlan> {
  const plan = await getTenantPlan(ctx.tenantId);
  // Tope personal (si el plan lo define): una sola persona no puede agotar el cupo de toda la organización.
  const own = plan.userDailyQuestionLimit;
  if (own !== null && ctx.userId && (await questionsToday(ctx.tenantId, ctx.userId)) >= own) {
    throw new HttpError(429, `Alcanzaste tu límite personal de ${own} preguntas por día. Se renueva a las 00:00 UTC.`);
  }
  const limit = plan.dailyQuestionLimit;
  if (limit === 0) return plan; // 0 = sin límite
  if ((await questionsToday(ctx.tenantId)) >= limit) {
    throw new HttpError(429, `Tu organización alcanzó el límite de ${limit} preguntas por día de su plan ${plan.name}.`);
  }
  return plan;
}

/**
 * Cuota diaria de la organización, para avisar en el chat antes de llegar al tope.
 * La puede ver cualquier usuario: es quien gasta las preguntas.
 */
chatRoutes.get("/quota", async (c) => {
  const ctx = tenantCtx(c);
  const [plan, used] = await Promise.all([getTenantPlan(ctx.tenantId), questionsToday(ctx.tenantId)]);
  const limit = plan.dailyQuestionLimit;
  const own = plan.userDailyQuestionLimit;
  const ownUsed = own === null || !ctx.userId ? 0 : await questionsToday(ctx.tenantId, ctx.userId);
  return c.json({
    used,
    limit,
    level: quotaLevel(used, limit, config.QUOTA_WARN_PERCENT),
    warnPercent: config.QUOTA_WARN_PERCENT,
    // Cuota personal: solo si el plan la define.
    user: own === null ? null : { used: ownUsed, limit: own, level: quotaLevel(ownUsed, own, config.QUOTA_WARN_PERCENT) },
    // El interruptor «Buscar también en internet» del chat: el plan lo permite y hay un buscador configurado.
    webSearch: plan.webSearch && webSearchEnabled(),
  });
});

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
chatRoutes.post("/search", userRateLimit(60, 60_000, "búsquedas"), async (c) => {
  const body = parse(SearchBody, await c.req.json().catch(() => ({})));
  const ctx = tenantCtx(c);
  const query = foldShouting(body.query);
  const [vector, scope] = await Promise.all([embedQuery(query, c.req.raw.signal), resolveScope(ctx, body.collectionIds, body.documentIds)]);
  const results = await retrieve(ctx, { queryText: query, queryVector: vector, scope, topK: body.topK, signal: c.req.raw.signal });
  return c.json({ results });
});

const ChatBody = z.object({
  question: z.string().trim().min(1).max(4000),
  conversationId: z.string().regex(UUID_RE).optional(),
  collectionIds: z.array(z.string().regex(UUID_RE)).max(100).optional(),
  documentIds: z.array(z.string().regex(UUID_RE)).max(50).optional(),
  /** Buscar también en internet (modo híbrido). Solo si el plan lo permite y hay buscador configurado. */
  webSearch: z.boolean().optional(),
});

/**
 * Pregunta al RAG. Responde con Server-Sent Events:
 *   event: meta    → { conversationId, sources }
 *   event: token   → fragmento de texto de la respuesta
 *   event: done    → { messageId, model, sources, fromCache }  (sources con `cited` marcado)
 *   event: error   → { message }
 */
chatRoutes.post("/chat", userRateLimit(20, 60_000, "preguntas"), async (c) => {
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
  // Con internet la respuesta depende de resultados que cambian: no se busca ni se guarda en la caché.
  const wantsWeb = body.webSearch === true && webSearchEnabled();
  const cacheable = config.CACHE_ENABLED && history.length === 0 && !wantsWeb;

  // 3. ¿Ya se respondió esta misma pregunta con los mismos documentos?
  const cached = cacheable
    ? await withTenant(ctx, (tx) => findCachedAnswer(tx, { tenantId: ctx.tenantId, scope: scope.key, question: body.question, vector }))
    : null;

  // 4. Las respuestas nuevas cuentan para el límite diario (antes de guardar nada).
  const plan = cached ? null : await checkDailyLimit(ctx);

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
  // 6c. Internet (modo híbrido): solo se envía la pregunta, nunca fragmentos de los documentos. Si el buscador falla, se
  // responde solo con los documentos y se avisa.
  const useWeb = wantsWeb && plan?.webSearch === true;
  let webFailed = false;
  const web = useWeb
    ? await searchWeb(query, signal).catch((err) => {
        webFailed = true;
        console.warn("[web] la búsqueda falló:", err instanceof Error ? err.message : err);
        return [];
      })
    : [];
  const sources = [...toSources(hits), ...toWebSources(web, hits.length)];

  // 7. Respuesta en streaming.
  return streamSSE(c, async (stream) => {
    // `web`: si se buscó en internet y si el buscador falló (la interfaz lo avisa; se responde solo con los documentos).
    await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId, sources, web: { used: useWeb, failed: webFailed } }) });

    if (hits.length === 0 && web.length === 0) {
      // Sin contexto no se llama al LLM: ahorra cupo y evita respuestas inventadas.
      await stream.writeSSE({ event: "token", data: JSON.stringify(NO_CONTEXT_ANSWER) });
      const messageId = await saveAnswer(NO_CONTEXT_ANSWER, { model: null, sources: [] });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId, model: null, sources: [], fromCache: false }) });
      return;
    }

    let answer = "";
    try {
      for await (const ev of streamChat(buildMessages(body.question, hits, history, web), plan?.llmModels ?? [], signal)) {
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
          void notifyQuota(ctx.tenantId); // aviso por correo al 80 % / al agotar el límite (una vez al día)
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
      void sqlOwner`INSERT INTO usage_events (tenant_id, user_id, kind) VALUES (${ctx.tenantId}, ${ctx.userId}, 'llm_error')`.catch(() => {});
      if (answer) await saveAnswer(`${answer}\n\n_(respuesta interrumpida)_`, { model: null, sources }).catch(() => {});
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
    }
  });
});

// ---------------------------------------------------------------------------
// Conversaciones (cada usuario ve solo las suyas; lo garantiza RLS)
// ---------------------------------------------------------------------------

const ConversationsQuery = z.object({ q: z.string().trim().max(100).optional() });

/** Conversaciones del usuario, con búsqueda opcional (`q`) en el título y en el texto de los mensajes. */
chatRoutes.get("/conversations", async (c) => {
  const { q } = parse(ConversationsQuery, c.req.query());
  // Se escapan «%», «_» y «\» para que se busquen como texto literal.
  const pattern = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const conversations = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt"
      FROM conversations c
     WHERE ${pattern}::text IS NULL
        OR c.title ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content ILIKE ${pattern})
     ORDER BY c.updated_at DESC LIMIT 200`);
  return c.json({ conversations });
});

const RenameConversationBody = z.object({ title: z.string().trim().min(1).max(120) });

chatRoutes.patch("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const { title } = parse(RenameConversationBody, await c.req.json().catch(() => ({})));
  const [row] = await withTenant(tenantCtx(c), (tx) => tx`UPDATE conversations SET title = ${title} WHERE id = ${id} RETURNING id`);
  if (!row) throw notFound("Conversación no encontrada");
  return c.json({ ok: true });
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

/** Descarga la conversación en Markdown, con las fuentes de cada respuesta. */
chatRoutes.get("/conversations/:id/export", userRateLimit(20, 60_000, "exportaciones"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const { conversation, messages } = await withTenant(tenantCtx(c), async (tx) => {
    const [conversation] = await tx<{ title: string }[]>`SELECT title FROM conversations WHERE id = ${id}`;
    if (!conversation) throw notFound("Conversación no encontrada");
    const messages = await tx<ExportMessage[]>`
      SELECT role, content, sources, model, created_at AS "createdAt"
        FROM messages WHERE conversation_id = ${id} ORDER BY created_at`;
    return { conversation, messages };
  });
  const markdown = conversationToMarkdown({ title: conversation.title, appName: config.APP_NAME, exportedAt: new Date(), messages });
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(conversation.title)}"; filename*=UTF-8''${encodeURIComponent(`${conversation.title}.md`)}`,
      "x-content-type-options": "nosniff",
    },
  });
});

chatRoutes.delete("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await withTenant(tenantCtx(c), (tx) => tx`DELETE FROM conversations WHERE id = ${id} RETURNING id`);
  if (!row) throw notFound("Conversación no encontrada");
  return c.json({ ok: true });
});
