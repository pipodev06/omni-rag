import { Hono } from "hono";
import { z } from "zod";
import { sqlOwner, withTenant } from "../db/client.js";
import { requireAuth, requireRole, requireSuperadmin, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
import { issueSession } from "../auth/session.js";
import { audit, auditLog } from "../lib/audit.js";
import { clientIp } from "../lib/request.js";
import { createUserLink, emailLink } from "../lib/tokens.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { parse, UUID_RE } from "../lib/validate.js";

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
      SELECT (SELECT count(*)::int FROM documents) AS documents,
             (SELECT count(*)::int FROM chunks) AS chunks,
             (SELECT count(*)::int FROM users WHERE support_for IS NULL) AS users`;
    return { daily, byModel, totals };
  });
  return c.json(data);
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
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.support_for IS NULL) AS users,
           (SELECT count(*)::int FROM documents d WHERE d.tenant_id = t.id) AS documents
      FROM tenants t ORDER BY t.created_at`;
  return c.json({ tenants });
});

const CreateTenant = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "solo minúsculas, números y guiones"),
  dailyQuestionLimit: z.number().int().min(0).nullable().optional(),
  admin: z.object({
    email: z.string().email().max(254),
    name: z.string().trim().min(1).max(120),
    // Sin contraseña = se envía una invitación al administrador de la organización.
    password: z.string().optional(),
  }),
});

/** Crea una organización con su primer administrador y una colección "General". */
platformRoutes.post("/tenants", async (c) => {
  const body = parse(CreateTenant, await c.req.json().catch(() => ({})));
  if (body.admin.password) {
    const problem = passwordProblem(body.admin.password);
    if (problem) throw badRequest(problem);
  }
  const hash = body.admin.password ? await hashPassword(body.admin.password) : null;

  const result = await sqlOwner
    .begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO tenants (name, slug, daily_question_limit)
        VALUES (${body.name}, ${body.slug}, ${body.dailyQuestionLimit ?? null}) RETURNING id`;
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO users (tenant_id, email, name, password_hash, role)
        VALUES (${t!.id}, ${body.admin.email.toLowerCase()}, ${body.admin.name}, ${hash}, 'admin') RETURNING id`;
      await tx`INSERT INTO collections (tenant_id, name, description) VALUES (${t!.id}, 'General', 'Colección por defecto')`;
      return { tenantId: t!.id, adminId: u!.id };
    })
    .catch((err: { code?: string; constraint_name?: string }) => {
      if (err.code === "23505") throw new HttpError(409, "Ya existe una organización con ese slug o un usuario con ese email");
      throw err;
    });

  let inviteUrl: string | null = null;
  let emailSent = false;
  if (!hash) {
    inviteUrl = await createUserLink({ tenantId: result.tenantId, userId: result.adminId, kind: "invite", createdBy: c.get("user").id });
    emailSent = await emailLink("invite", { email: body.admin.email, name: body.admin.name }, inviteUrl, body.name);
  }
  await audit(c, "tenant.created", {
    targetType: "tenant",
    targetId: result.tenantId,
    details: { name: body.name, slug: body.slug, admin: body.admin.email.toLowerCase(), invited: !hash, emailSent },
  });
  return c.json({ ...result, inviteUrl, emailSent }, 201);
});

const UpdateTenant = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  dailyQuestionLimit: z.number().int().min(0).nullable().optional(),
});

platformRoutes.patch("/tenants/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(UpdateTenant, await c.req.json().catch(() => ({})));
  if (id === c.get("user").tenantId && body.isActive === false) {
    throw badRequest("No puedes desactivar tu propia organización");
  }
  const [row] = await sqlOwner`
    UPDATE tenants SET
      name = coalesce(${body.name ?? null}, name),
      is_active = coalesce(${body.isActive ?? null}::boolean, is_active),
      daily_question_limit = CASE WHEN ${body.dailyQuestionLimit !== undefined}
                                  THEN ${body.dailyQuestionLimit ?? null}::int ELSE daily_question_limit END
    WHERE id = ${id} RETURNING id`;
  if (!row) throw notFound("Organización no encontrada");
  await audit(c, "tenant.updated", { targetType: "tenant", targetId: id, details: body });
  return c.json({ ok: true });
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
  if (id === me.tenantId) throw badRequest("Ya estás en tu organización");
  const [tenant] = await sqlOwner<{ id: string; name: string; is_active: boolean }[]>`
    SELECT id, name, is_active FROM tenants WHERE id = ${id}`;
  if (!tenant) throw notFound("Organización no encontrada");
  if (!tenant.is_active) throw badRequest("La organización está desactivada; actívala para entrar");

  const [support] = await sqlOwner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, name, password_hash, role, support_for)
    VALUES (${id}, ${`soporte.${me.id}.${id}@soporte.invalid`}, ${`${me.name} (soporte)`}, NULL, 'admin', ${me.id})
    ON CONFLICT (support_for, tenant_id) WHERE support_for IS NOT NULL
      DO UPDATE SET name = EXCLUDED.name, role = 'admin', is_active = true
    RETURNING id`;

  await issueSession(c, { userId: support!.id, tenantId: id, role: "admin", actorId: me.id });
  await auditLog({ tenantId: id, userId: support!.id, email: `${me.email} (soporte)`, ip: clientIp(c) }, "support.entered");
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
    SELECT id::int, action, user_id AS "userId", user_email AS "userEmail", target_type AS "targetType",
           target_id AS "targetId", details, ip, created_at AS "createdAt"
      FROM audit_log
     WHERE (${q.category ?? null}::text IS NULL OR action LIKE ${(q.category ?? "") + ".%"})
       AND (${q.userId ?? null}::uuid IS NULL OR user_id = ${q.userId ?? null}::uuid)
       AND (${q.before ?? null}::bigint IS NULL OR id < ${q.before ?? null}::bigint)
     ORDER BY id DESC
     LIMIT ${q.limit}`);
  return c.json({ items, nextBefore: items.length === q.limit ? items[items.length - 1]!.id : null });
});
