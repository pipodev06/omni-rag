import { Hono } from "hono";
import { z } from "zod";
import { sqlOwner, withTenant } from "../db/client.js";
import { requireAuth, requireRole, requireSuperadmin, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
import { issueSession } from "../auth/session.js";
import { audit, auditLog } from "../lib/audit.js";
import { clientIp } from "../lib/request.js";
import { checkModels } from "../lib/modelCatalog.js";
import { getTenantPlan, questionsToday } from "../lib/plans.js";
import { removeStored } from "../storage/local.js";
import { createUserLink, emailLink } from "../lib/tokens.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { OptionalEmailSchema, parse, UsernameSchema, UUID_RE } from "../lib/validate.js";
import { tenantExportEntries } from "../lib/tenantExport.js";
import { zipHeaders, zipStream } from "../lib/zipStream.js";

// ---------------------------------------------------------------------------
// Consumo de la organización (administradores)
// ---------------------------------------------------------------------------
export const usageRoutes = new Hono<AppEnv>();
usageRoutes.use("*", requireAuth, requireRole("admin"));

usageRoutes.get("/", async (c) => {
  const data = await withTenant(tenantCtx(c), async (tx) => {
    const daily = await tx`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE kind = 'question')::int AS questions,
             count(*) FILTER (WHERE kind = 'cache_hit')::int AS "cacheHits",
             coalesce(sum(prompt_tokens), 0)::int AS "promptTokens",
             coalesce(sum(completion_tokens), 0)::int AS "completionTokens"
        FROM usage_events
       WHERE kind IN ('question', 'cache_hit') AND created_at > now() - interval '30 days'
       GROUP BY 1 ORDER BY 1 DESC`;
    const byModel = await tx`
      SELECT model, count(*)::int AS questions FROM usage_events
       WHERE kind = 'question' AND created_at > now() - interval '30 days'
       GROUP BY model ORDER BY 2 DESC`;
    const [totals] = await tx`
      SELECT (SELECT count(*)::int FROM documents WHERE deleted_at IS NULL) AS documents,
             (SELECT count(*)::int FROM chunks) AS chunks,
             (SELECT count(*)::int FROM users WHERE support_for IS NULL) AS users`;
    return { daily, byModel, totals };
  });
  const plan = await getTenantPlan(tenantCtx(c).tenantId);
  const usedToday = await questionsToday(tenantCtx(c).tenantId);
  return c.json({
    ...data,
    plan: {
      name: plan.name,
      dailyQuestionLimit: plan.dailyQuestionLimit,
      userDailyQuestionLimit: plan.userDailyQuestionLimit,
      maxUsers: plan.maxUsers,
      maxDocuments: plan.maxDocuments,
      usedToday,
    },
  });
});

// ---------------------------------------------------------------------------
// Plataforma: crear y gestionar organizaciones (solo superadministrador)
// Usa la conexión propietaria porque opera sobre varias organizaciones.
// ---------------------------------------------------------------------------
export const platformRoutes = new Hono<AppEnv>();
platformRoutes.use("*", requireAuth, requireSuperadmin);

platformRoutes.get("/tenants", async (c) => {
  const tenants = await sqlOwner`
    SELECT t.id, t.name, t.slug, t.is_active AS "isActive", t.daily_question_limit AS "dailyQuestionLimit",
           t.created_at AS "createdAt",
           p.id AS "planId", p.name AS "planName", p.daily_question_limit AS "planDailyQuestionLimit",
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.support_for IS NULL) AS users,
           (SELECT count(*)::int FROM documents d WHERE d.tenant_id = t.id AND d.deleted_at IS NULL) AS documents,
           (SELECT count(*)::int FROM usage_events e
             WHERE e.tenant_id = t.id AND e.kind = 'question' AND e.created_at > now() - interval '30 days') AS "questions30d"
      FROM tenants t
      JOIN plans p ON p.id = coalesce(t.plan_id, (SELECT id FROM plans WHERE is_default))
     WHERE NOT t.is_platform
     ORDER BY t.created_at`;
  return c.json({ tenants });
});

// ---------------------------------------------------------------------------
// Planes: modelos de lenguaje y topes por organización
// ---------------------------------------------------------------------------
const MODEL_RE = /^[A-Za-z0-9][\w.\-:/]{1,119}$/;

const PlanBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(""),
  // Orden de preferencia: si el primero falla o está saturado se prueba el siguiente.
  llmModels: z.array(z.string().trim().regex(MODEL_RE, "nombre de modelo no válido")).min(1).max(8),
  dailyQuestionLimit: z.number().int().min(0).max(1_000_000),
  maxUsers: z.number().int().min(1).max(1_000_000).nullable(),
  maxDocuments: z.number().int().min(1).max(10_000_000).nullable(),
  userDailyQuestionLimit: z.number().int().min(1).max(1_000_000).nullable(),
  // Búsqueda en internet (modo híbrido): el usuario la activa en el chat; requiere WEB_SEARCH_PROVIDER en el servidor.
  webSearch: z.boolean().default(false),
});

/** Deja constancia, en la auditoría del cliente afectado, de un cambio hecho desde la plataforma. */
const auditTenant = (tenantId: string, action: string, details: Record<string, unknown>) =>
  auditLog({ tenantId, userId: null, username: "Plataforma" }, action, { targetType: "tenant", targetId: tenantId, details });

/** Avisa en la auditoría de cada organización que usa el plan (asignado o por defecto) de que sus condiciones cambiaron. */
async function auditPlanTenants(planId: string, planName: string): Promise<void> {
  const tenants = await sqlOwner<{ id: string }[]>`
    SELECT id FROM tenants WHERE NOT is_platform AND coalesce(plan_id, (SELECT id FROM plans WHERE is_default)) = ${planId}`;
  await Promise.all(tenants.map((t) => auditTenant(t.id, "plan.edited", { plan: planName })));
}

/**
 * Rechaza los modelos de un plan cuyo proveedor no tiene clave configurada o que no existen en el catálogo de su
 * proveedor (si el catálogo no responde, no bloquea). Cada modelo puede llevar prefijo: `groq:openai/gpt-oss-120b`.
 */
async function assertModelsExist(models: string[]): Promise<void> {
  const { unconfigured, unknown } = await checkModels(models);
  if (unconfigured.length > 0) {
    throw badRequest(`Falta configurar en el servidor: ${unconfigured.join(", ")}. Añade la clave al .env y ejecuta «docker compose up -d».`);
  }
  if (unknown.length > 0) {
    throw badRequest(
      `${unknown.length === 1 ? "Este modelo no existe" : "Estos modelos no existen"} en su proveedor: ${unknown.join(", ")}. Copia el nombre exacto del catálogo (sin prefijo = OpenRouter; con prefijo, p. ej. groq:openai/gpt-oss-120b). Para ver los que tienen tus claves: docker compose exec api node dist/scripts/models.js.`,
    );
  }
}

const planConflict = (err: { code?: string }): never => {
  if (err.code === "23505") throw new HttpError(409, "Ya existe un plan con ese nombre");
  throw err;
};

platformRoutes.get("/plans", async (c) => {
  const plans = await sqlOwner`
    SELECT p.id, p.name, p.description, p.llm_models AS "llmModels", p.daily_question_limit AS "dailyQuestionLimit",
           p.max_users AS "maxUsers", p.max_documents AS "maxDocuments", p.user_daily_question_limit AS "userDailyQuestionLimit", p.web_search AS "webSearch", p.is_default AS "isDefault",
           (SELECT count(*)::int FROM tenants t WHERE NOT t.is_platform AND coalesce(t.plan_id, (SELECT id FROM plans WHERE is_default)) = p.id) AS tenants
      FROM plans p ORDER BY p.is_default DESC, p.created_at`;
  return c.json({ plans });
});

platformRoutes.post("/plans", async (c) => {
  const body = parse(PlanBody, await c.req.json().catch(() => ({})));
  const models = [...new Set(body.llmModels)];
  await assertModelsExist(models);
  const [row] = await sqlOwner<{ id: string }[]>`
    INSERT INTO plans (name, description, llm_models, daily_question_limit, max_users, max_documents, user_daily_question_limit, web_search)
    VALUES (${body.name}, ${body.description}, ${models}, ${body.dailyQuestionLimit}, ${body.maxUsers}, ${body.maxDocuments}, ${body.userDailyQuestionLimit}, ${body.webSearch})
    RETURNING id`.catch(planConflict);
  await audit(c, "plan.created", { targetType: "plan", targetId: row!.id, details: { name: body.name } });
  return c.json({ id: row!.id }, 201);
});

platformRoutes.put("/plans/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(PlanBody, await c.req.json().catch(() => ({})));
  const models = [...new Set(body.llmModels)];
  await assertModelsExist(models);
  const [row] = await sqlOwner<{ id: string }[]>`
    UPDATE plans SET name = ${body.name}, description = ${body.description}, llm_models = ${models},
           daily_question_limit = ${body.dailyQuestionLimit}, max_users = ${body.maxUsers}, max_documents = ${body.maxDocuments},
           user_daily_question_limit = ${body.userDailyQuestionLimit}, web_search = ${body.webSearch}
     WHERE id = ${id} RETURNING id`.catch(planConflict);
  if (!row) throw notFound("Plan no encontrado");
  await audit(c, "plan.updated", { targetType: "plan", targetId: id, details: { name: body.name } });
  await auditPlanTenants(id, body.name);
  return c.json({ ok: true });
});

/** Marca un plan como el que reciben las organizaciones nuevas y las que no tienen plan asignado. */
platformRoutes.post("/plans/:id/default", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const ok = await sqlOwner.begin(async (tx) => {
    const [exists] = await tx`SELECT id FROM plans WHERE id = ${id}`;
    if (!exists) return false;
    await tx`UPDATE plans SET is_default = false WHERE is_default`;
    await tx`UPDATE plans SET is_default = true WHERE id = ${id}`;
    return true;
  });
  if (!ok) throw notFound("Plan no encontrado");
  await audit(c, "plan.updated", { targetType: "plan", targetId: id, details: { isDefault: true } });
  const [plan] = await sqlOwner<{ name: string }[]>`SELECT name FROM plans WHERE id = ${id}`;
  // Las organizaciones sin plan asignado pasan a regirse por este.
  const inherit = await sqlOwner<{ id: string }[]>`SELECT id FROM tenants WHERE plan_id IS NULL`;
  await Promise.all(inherit.map((t) => auditTenant(t.id, "plan.edited", { plan: plan?.name ?? "" })));
  return c.json({ ok: true });
});

platformRoutes.delete("/plans/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const [plan] = await sqlOwner<{ name: string; is_default: boolean }[]>`SELECT name, is_default FROM plans WHERE id = ${id}`;
  if (!plan) throw notFound("Plan no encontrado");
  if (plan.is_default) throw badRequest("No se puede borrar el plan por defecto; marca otro como defecto primero");
  await sqlOwner`DELETE FROM plans WHERE id = ${id}`.catch((err: { code?: string }) => {
    if (err.code === "23503") throw new HttpError(409, "Hay organizaciones con este plan; cámbiales el plan antes de borrarlo");
    throw err;
  });
  await audit(c, "plan.deleted", { targetType: "plan", targetId: id, details: { name: plan.name } });
  return c.json({ ok: true });
});

const CreateTenant = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "solo minúsculas, números y guiones"),
  dailyQuestionLimit: z.number().int().min(0).nullable().optional(),
  planId: z.string().regex(UUID_RE).optional(), // sin plan = el plan por defecto
  admin: z.object({
    username: UsernameSchema,
    email: OptionalEmailSchema,
    name: z.string().trim().min(1).max(120),
    // Sin contraseña = se envía una invitación (requiere email) al administrador de la organización.
    password: z.string().optional(),
  }),
});

/** Crea una organización con su primer administrador y una colección "General". */
platformRoutes.post("/tenants", async (c) => {
  const body = parse(CreateTenant, await c.req.json().catch(() => ({})));
  const adminEmail = body.admin.email?.toLowerCase() ?? null;
  if (!body.admin.password && !adminEmail) throw badRequest("Sin email hay que definir una contraseña inicial");
  if (body.admin.password) {
    const problem = passwordProblem(body.admin.password);
    if (problem) throw badRequest(problem);
  }
  const hash = body.admin.password ? await hashPassword(body.admin.password) : null;

  const result = await sqlOwner
    .begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO tenants (name, slug, daily_question_limit, plan_id)
        VALUES (${body.name}, ${body.slug}, ${body.dailyQuestionLimit ?? null}, ${body.planId ?? null}) RETURNING id`;
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO users (tenant_id, username, email, name, password_hash, role)
        VALUES (${t!.id}, ${body.admin.username}, ${adminEmail}, ${body.admin.name}, ${hash}, 'admin') RETURNING id`;
      await tx`INSERT INTO collections (tenant_id, name, description) VALUES (${t!.id}, 'General', 'Colección por defecto')`;
      return { tenantId: t!.id, adminId: u!.id };
    })
    .catch((err: { code?: string; constraint_name?: string }) => {
      if (err.code === "23503") throw badRequest("El plan indicado no existe");
      if (err.code === "23505") throw new HttpError(409, "Ya existe una organización con ese identificador o un usuario con ese nombre de usuario o email");
      throw err;
    });

  let inviteUrl: string | null = null;
  let emailSent = false;
  if (!hash && adminEmail) {
    inviteUrl = await createUserLink({ tenantId: result.tenantId, userId: result.adminId, kind: "invite", createdBy: c.get("user").id });
    emailSent = await emailLink("invite", { email: adminEmail, name: body.admin.name }, inviteUrl, body.name);
  }
  await audit(c, "tenant.created", {
    targetType: "tenant",
    targetId: result.tenantId,
    details: { name: body.name, slug: body.slug, admin: body.admin.username, invited: !hash, emailSent },
  });
  return c.json({ ...result, inviteUrl, emailSent }, 201);
});

const UpdateTenant = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "solo minúsculas, números y guiones").optional(),
  isActive: z.boolean().optional(),
  dailyQuestionLimit: z.number().int().min(0).nullable().optional(),
  planId: z.string().regex(UUID_RE).optional(),
});

/** La organización interna «Plataforma» (donde vive el superadministrador) no se modifica, desactiva ni borra desde aquí. */
async function assertNotPlatform(id: string, action: string): Promise<void> {
  const [t] = await sqlOwner<{ is_platform: boolean }[]>`SELECT is_platform FROM tenants WHERE id = ${id}`;
  if (t?.is_platform) throw badRequest(`La organización Plataforma es interna: no se puede ${action}`);
}

platformRoutes.patch("/tenants/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(UpdateTenant, await c.req.json().catch(() => ({})));
  await assertNotPlatform(id, "modificar");
  if (id === c.get("user").tenantId && body.isActive === false) {
    throw badRequest("No puedes desactivar tu propia organización");
  }
  const [before] = await sqlOwner<{ plan: string; limit: number | null }[]>`
    SELECT p.name AS plan, t.daily_question_limit AS "limit"
      FROM tenants t JOIN plans p ON p.id = coalesce(t.plan_id, (SELECT id FROM plans WHERE is_default))
     WHERE t.id = ${id}`;
  const [row] = await sqlOwner`
    UPDATE tenants SET
      name = coalesce(${body.name ?? null}, name),
      slug = coalesce(${body.slug ?? null}, slug),
      is_active = coalesce(${body.isActive ?? null}::boolean, is_active),
      plan_id = coalesce(${body.planId ?? null}::uuid, plan_id),
      daily_question_limit = CASE WHEN ${body.dailyQuestionLimit !== undefined}
                                  THEN ${body.dailyQuestionLimit ?? null}::int ELSE daily_question_limit END
    WHERE id = ${id} RETURNING id`.catch((err: { code?: string }) => {
    if (err.code === "23503") throw badRequest("El plan indicado no existe");
    if (err.code === "23505") throw new HttpError(409, "Ya existe una organización con ese identificador");
    throw err;
  });
  if (!row) throw notFound("Organización no encontrada");
  await audit(c, "tenant.updated", { targetType: "tenant", targetId: id, details: body });
  if (body.planId !== undefined) {
    const [after] = await sqlOwner<{ name: string }[]>`SELECT name FROM plans WHERE id = ${body.planId}`;
    if (after && after.name !== before?.plan) await auditTenant(id, "tenant.plan_changed", { de: before?.plan ?? "", a: after.name });
  }
  if (body.dailyQuestionLimit !== undefined && body.dailyQuestionLimit !== (before?.limit ?? null)) {
    await auditTenant(id, "tenant.limit_changed", { límite: body.dailyQuestionLimit === null ? "el de su plan" : body.dailyQuestionLimit === 0 ? "sin límite" : `${body.dailyQuestionLimit} / día` });
  }
  return c.json({ ok: true });
});

const DeleteTenant = z.object({ confirmSlug: z.string().min(1).max(80) });

/**
 * Borra una organización y todos sus datos (usuarios, documentos, conversaciones,
 * archivos, auditoría). Solo si ya está desactivada y se escribe su identificador.
 * No se puede deshacer; las copias de seguridad la conservan hasta que caducan.
 */
platformRoutes.delete("/tenants/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(DeleteTenant, await c.req.json().catch(() => ({})));
  await assertNotPlatform(id, "borrar");
  if (id === c.get("user").tenantId) throw badRequest("No puedes borrar la organización en la que estás. Sal del modo soporte (o muévete a Plataforma con move-superadmin.js) y vuelve a intentarlo");
  const [t] = await sqlOwner<{ name: string; slug: string; is_active: boolean; users: number; documents: number }[]>`
    SELECT t.name, t.slug, t.is_active,
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.support_for IS NULL) AS users,
           (SELECT count(*)::int FROM documents d WHERE d.tenant_id = t.id) AS documents
      FROM tenants t WHERE t.id = ${id}`;
  if (!t) throw notFound("Organización no encontrada");
  if (t.is_active) throw badRequest("Desactiva la organización antes de borrarla");
  if (body.confirmSlug !== t.slug) throw badRequest("El identificador escrito no coincide");
  await sqlOwner`DELETE FROM tenants WHERE id = ${id}`;
  await removeStored(id).catch((err) => console.error(`[plataforma] no se pudieron borrar los archivos de ${id}:`, err));
  await audit(c, "tenant.deleted", { targetType: "tenant", targetId: id, details: { name: t.name, slug: t.slug, users: t.users, documents: t.documents } });
  return c.json({ ok: true });
});

/**
 * Exporta todos los datos de una organización en un ZIP (portabilidad): JSON con organización, usuarios, colecciones,
 * documentos, conversaciones, valoraciones, uso y auditoría, más los archivos originales. Sin contraseñas ni secretos.
 * Es un GET para que el navegador lo guarde directamente en disco; el ZIP se arma en streaming.
 */
platformRoutes.get("/tenants/:id/export", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  await assertNotPlatform(id, "exportar");
  const [t] = await sqlOwner<{ name: string; slug: string }[]>`SELECT name, slug FROM tenants WHERE id = ${id}`;
  if (!t) throw notFound("Organización no encontrada");
  await audit(c, "tenant.exported", { targetType: "tenant", targetId: id, details: { name: t.name, slug: t.slug } });
  await auditTenant(id, "tenant.exported", { por: "Plataforma" });
  return new Response(zipStream(tenantExportEntries(id)), { headers: zipHeaders(`${t.slug}-exportacion-${new Date().toISOString().slice(0, 10)}.zip`) });
});

/**
 * Entra en una organización como soporte, con permisos de administrador.
 * Usa (o crea) la cuenta de soporte del superadministrador en esa organización
 * y deja constancia en la auditoría del cliente.
 */
platformRoutes.post("/tenants/:id/enter", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const me = c.get("user");
  await assertNotPlatform(id, "usar como organización de soporte");
  if (id === me.tenantId) throw badRequest("Ya estás en tu organización");
  const [tenant] = await sqlOwner<{ id: string; name: string; is_active: boolean }[]>`
    SELECT id, name, is_active FROM tenants WHERE id = ${id}`;
  if (!tenant) throw notFound("Organización no encontrada");
  if (!tenant.is_active) throw badRequest("La organización está desactivada; actívala para entrar");

  const [support] = await sqlOwner<{ id: string }[]>`
    INSERT INTO users (tenant_id, username, email, name, password_hash, role, support_for)
    VALUES (${id}, 'soporte-' || substr(md5(${me.id} || ${id}), 1, 12), ${`soporte.${me.id}.${id}@soporte.invalid`}, ${`${me.name} (soporte)`}, NULL, 'admin', ${me.id})
    ON CONFLICT (support_for, tenant_id) WHERE support_for IS NOT NULL
      DO UPDATE SET name = EXCLUDED.name, role = 'admin', is_active = true
    RETURNING id`;

  await issueSession(c, { userId: support!.id, tenantId: id, role: "admin", actorId: me.id });
  await auditLog({ tenantId: id, userId: support!.id, username: `${me.username} (soporte)`, ip: clientIp(c) }, "support.entered");
  await audit(c, "support.entered", { targetType: "tenant", targetId: id, details: { name: tenant.name } });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Auditoría de la organización (administradores)
// ---------------------------------------------------------------------------
export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use("*", requireAuth, requireRole("admin"));

const AuditQuery = z.object({
  category: z.string().regex(/^[a-z_]+$/).optional(),
  userId: z.string().regex(UUID_RE).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Registro de actividad, del más reciente al más antiguo (paginado con `before`). */
auditRoutes.get("/", async (c) => {
  const q = parse(AuditQuery, c.req.query());
  const items = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT id::int, action, user_id AS "userId", user_email AS "userLabel", target_type AS "targetType",
           target_id AS "targetId", details, ip, created_at AS "createdAt"
      FROM audit_log
     WHERE (${q.category ?? null}::text IS NULL OR action LIKE ${(q.category ?? "") + ".%"})
       AND (${q.userId ?? null}::uuid IS NULL OR user_id = ${q.userId ?? null}::uuid)
       AND (${q.before ?? null}::bigint IS NULL OR id < ${q.before ?? null}::bigint)
     ORDER BY id DESC
     LIMIT ${q.limit}`);
  return c.json({ items, nextBefore: items.length === q.limit ? items[items.length - 1]!.id : null });
});
