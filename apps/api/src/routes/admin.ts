import { Hono } from "hono";
import { z } from "zod";
import { sqlOwner, withTenant } from "../db/client.js";
import { requireAuth, requireRole, requireSuperadmin, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
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
             (SELECT count(*)::int FROM users) AS users`;
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
           (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
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
    password: z.string(),
  }),
});

/** Crea una organización con su primer administrador y una colección "General". */
platformRoutes.post("/tenants", async (c) => {
  const body = parse(CreateTenant, await c.req.json().catch(() => ({})));
  const problem = passwordProblem(body.admin.password);
  if (problem) throw badRequest(problem);
  const hash = await hashPassword(body.admin.password);

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
  return c.json(result, 201);
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
  return c.json({ ok: true });
});
