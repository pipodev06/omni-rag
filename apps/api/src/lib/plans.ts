import { sqlOwner } from "../db/client.js";
import { HttpError, notFound } from "./errors.js";

/**
 * Plan efectivo de una organización: modelos de lenguaje y topes.
 * Sin plan asignado (`tenants.plan_id` NULL) rige el plan por defecto.
 */
export interface TenantPlan {
  id: string;
  name: string;
  llmModels: string[];
  /** Preguntas por día; 0 = sin límite. Ya incluye la excepción puntual de la organización, si la hay. */
  dailyQuestionLimit: number;
  maxUsers: number | null;
  maxDocuments: number | null;
  /** Preguntas por día de cada usuario; null = sin tope por usuario. */
  userDailyQuestionLimit: number | null;
}

export async function getTenantPlan(tenantId: string): Promise<TenantPlan> {
  const [row] = await sqlOwner<(Omit<TenantPlan, "dailyQuestionLimit"> & { planLimit: number; override: number | null })[]>`
    SELECT p.id, p.name, p.llm_models AS "llmModels", p.daily_question_limit AS "planLimit",
           p.max_users AS "maxUsers", p.max_documents AS "maxDocuments",
           p.user_daily_question_limit AS "userDailyQuestionLimit", t.daily_question_limit AS override
      FROM tenants t
      JOIN plans p ON p.id = coalesce(t.plan_id, (SELECT id FROM plans WHERE is_default))
     WHERE t.id = ${tenantId}`;
  if (!row) throw notFound("Organización no encontrada");
  const { planLimit, override, ...plan } = row;
  return { ...plan, dailyQuestionLimit: override ?? planLimit };
}

/** Falla si la organización ya tiene todos los usuarios activos que permite su plan. */
export async function assertUserSlot(tenantId: string): Promise<void> {
  const { maxUsers } = await getTenantPlan(tenantId);
  if (maxUsers === null) return;
  const [{ n } = { n: 0 }] = await sqlOwner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users WHERE tenant_id = ${tenantId} AND support_for IS NULL AND is_active`;
  if (n >= maxUsers) throw new HttpError(403, `Tu plan permite hasta ${maxUsers} usuarios activos. Desactiva alguno o pide un plan mayor.`);
}

/** Cuántos documentos más puede subir la organización (`null` = sin tope). */
export async function documentSlots(tenantId: string): Promise<{ left: number | null; max: number | null }> {
  const { maxDocuments } = await getTenantPlan(tenantId);
  if (maxDocuments === null) return { left: null, max: null };
  const [{ n } = { n: 0 }] = await sqlOwner<{ n: number }[]>`SELECT count(*)::int AS n FROM documents WHERE tenant_id = ${tenantId} AND deleted_at IS NULL`;
  return { left: Math.max(0, maxDocuments - n), max: maxDocuments };
}

/** Llamadas al LLM (preguntas y resúmenes) hechas hoy (día en UTC) por la organización o, con `userId`, por un usuario. */
export async function questionsToday(tenantId: string, userId?: string): Promise<number> {
  const [row] = await sqlOwner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM usage_events
     WHERE tenant_id = ${tenantId} AND kind IN ('question', 'summary')
       AND (${userId ?? null}::uuid IS NULL OR user_id = ${userId ?? null}::uuid)
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  return row?.n ?? 0;
}

export type QuotaLevel = "ok" | "warn" | "full" | "unlimited";

/** Estado de la cuota diaria: sin límite, normal, cerca del tope (`warn`) o agotada (`full`). */
export function quotaLevel(used: number, limit: number, warnPercent: number): QuotaLevel {
  if (limit === 0) return "unlimited";
  if (used >= limit) return "full";
  return used * 100 >= limit * warnPercent ? "warn" : "ok";
}
