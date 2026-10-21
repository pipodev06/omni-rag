import { createHash } from "node:crypto";
import { config } from "../config.js";
import { toPgVector, type Tx } from "../db/client.js";

/**
 * Caché de respuestas en PostgreSQL.
 *
 * Reglas (conservadoras a propósito, ver docs/decisiones.md §13):
 *  - Solo se cachean primeras preguntas de una conversación (sin historial).
 *  - Una entrada solo sirve para el MISMO conjunto de colecciones consultables
 *    (scope) dentro de la misma organización → respeta los permisos.
 *  - Coincide si la pregunta normalizada es idéntica, o si es casi idéntica
 *    (distancia ≤ CACHE_MAX_DISTANCE) Y contiene los mismos números/códigos.
 *  - Se invalida al cambiar documentos de esas colecciones o al recibir un 👎.
 */

// --------------------------- funciones puras ---------------------------

/** "¿Cuántos DÍAS de vacaciones?" → "cuantos dias de vacaciones" */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Números y códigos de la pregunta, ordenados: "factura 2026-0457 de 3.870 €" → ["2026-0457", "3.870"] */
export function questionNumbers(q: string): string[] {
  const found = q.toLowerCase().match(/[\p{L}\d]*\d[\p{L}\d.,\-/]*/gu) ?? [];
  return [...new Set(found.map((t) => t.replace(/[.,\-/]+$/, "")))].sort();
}

/** Clave estable para un conjunto de colecciones. */
export function scopeKey(collectionIds: string[]): string {
  return createHash("sha256").update([...collectionIds].sort().join(",")).digest("hex").slice(0, 32);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// ------------------------------ base de datos ------------------------------

export interface CachedAnswer {
  id: string;
  answer: string;
  sources: unknown[];
  model: string | null;
}

export async function findCachedAnswer(
  tx: Tx,
  opts: { tenantId: string; scope: string; question: string; vector: number[] },
): Promise<CachedAnswer | null> {
  const norm = normalizeQuestion(opts.question);
  const numbers = questionNumbers(opts.question);
  const ttl = `${config.CACHE_TTL_HOURS} hours`;

  const [exact] = await tx<CachedAnswer[]>`
    SELECT id, answer, sources, model FROM answer_cache
     WHERE tenant_id = ${opts.tenantId} AND scope_key = ${opts.scope} AND question_norm = ${norm}
       AND created_at > now() - ${ttl}::interval
     ORDER BY created_at DESC LIMIT 1`;
  if (exact) return exact;

  const candidates = await tx<(CachedAnswer & { question_numbers: string[]; distance: number })[]>`
    SELECT id, answer, sources, model, question_numbers,
           (embedding <=> ${toPgVector(opts.vector)}::vector)::float8 AS distance
      FROM answer_cache
     WHERE tenant_id = ${opts.tenantId} AND scope_key = ${opts.scope}
       AND created_at > now() - ${ttl}::interval
     ORDER BY embedding <=> ${toPgVector(opts.vector)}::vector
     LIMIT 3`;
  const hit = candidates.find((c) => c.distance <= config.CACHE_MAX_DISTANCE && sameSet(c.question_numbers, numbers));
  return hit ? { id: hit.id, answer: hit.answer, sources: hit.sources, model: hit.model } : null;
}

export async function markCacheHit(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE answer_cache SET hits = hits + 1, last_hit_at = now() WHERE id = ${id}`;
}

export async function storeCachedAnswer(
  tx: Tx,
  opts: {
    tenantId: string;
    scope: string;
    collectionIds: string[];
    question: string;
    vector: number[];
    answer: string;
    sources: unknown[];
    model: string | null;
    messageId: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO answer_cache (tenant_id, scope_key, collection_ids, question, question_norm, question_numbers,
                              embedding, answer, sources, model, message_id)
    VALUES (${opts.tenantId}, ${opts.scope}, ${opts.collectionIds}::uuid[], ${opts.question},
            ${normalizeQuestion(opts.question)}, ${questionNumbers(opts.question)}::text[],
            ${toPgVector(opts.vector)}::vector, ${opts.answer}, ${tx.json(opts.sources as never)},
            ${opts.model}, ${opts.messageId})`;
}

/** Borra las respuestas que dependían de estas colecciones (sus documentos cambiaron). */
export async function invalidateCollections(tx: Tx, collectionIds: string[]): Promise<number> {
  if (collectionIds.length === 0) return 0;
  const rows = await tx`DELETE FROM answer_cache WHERE collection_ids && ${collectionIds}::uuid[] RETURNING id`;
  return rows.length;
}

/** Borra la entrada asociada a un mensaje (original o servido desde la caché). */
export async function invalidateForMessage(tx: Tx, messageId: string, cacheId: string | null): Promise<void> {
  await tx`DELETE FROM answer_cache WHERE message_id = ${messageId} OR id = ${cacheId}`;
}
