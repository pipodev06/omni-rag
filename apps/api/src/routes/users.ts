import { Hono } from "hono";
import { z } from "zod";
import { sqlOwner, withTenant } from "../db/client.js";
import { requireAuth, requireRole, tenantCtx, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
import { audit } from "../lib/audit.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { revokeSessions } from "../auth/session.js";
import { assertUserSlot } from "../lib/plans.js";
import { createUserLink, emailLink } from "../lib/tokens.js";
import { OptionalEmailSchema, parse, UsernameSchema, UUID_RE } from "../lib/validate.js";

/** Gestión de usuarios de la organización (solo administradores). */
export const userRoutes = new Hono<AppEnv>();
userRoutes.use("*", requireAuth, requireRole("admin"));

const RoleSchema = z.enum(["admin", "editor", "viewer"]);

const tenantName = async (tenantId: string) =>
  (await sqlOwner<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${tenantId}`)[0]?.name ?? "";

userRoutes.get("/", async (c) => {
  const users = await withTenant(tenantCtx(c), (tx) => tx`
    SELECT u.id, u.username, u.email, u.name, u.role, u.is_active AS "isActive", u.last_login_at AS "lastLoginAt",
           u.created_at AS "createdAt", (u.password_hash IS NULL) AS "pendingInvite",
           (u.totp_enabled_at IS NOT NULL) AS "totpEnabled",
           coalesce(array_agg(m.collection_id) FILTER (WHERE m.collection_id IS NOT NULL), '{}') AS "collectionIds"
      FROM users u
      LEFT JOIN collection_members m ON m.user_id = u.id
     WHERE u.support_for IS NULL
     GROUP BY u.id
     ORDER BY u.created_at`);
  return c.json({ users });
});

const CreateUser = z.object({
  username: UsernameSchema,
  // El email es opcional: sin él no hay invitación ni recuperación por correo.
  email: OptionalEmailSchema,
  name: z.string().trim().min(1).max(120),
  // Sin contraseña = se envía una invitación (requiere email) para que la elija el propio usuario.
  password: z.string().optional(),
  role: RoleSchema.default("viewer"),
  collectionIds: z.array(z.string().regex(UUID_RE)).default([]),
});

userRoutes.post("/", async (c) => {
  const body = parse(CreateUser, await c.req.json().catch(() => ({})));
  const email = body.email?.toLowerCase() ?? null;
  const invite = !body.password;
  if (invite && !email) throw badRequest("Sin email hay que definir una contraseña inicial");
  if (body.password) {
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest(problem);
  }
  const hash = body.password ? await hashPassword(body.password) : null;
  const ctx = tenantCtx(c);
  await assertUserSlot(ctx.tenantId);

  const user = await withTenant(ctx, async (tx) => {
    const [u] = await tx<{ id: string }[]>`
      INSERT INTO users (tenant_id, username, email, name, password_hash, role)
      VALUES (${ctx.tenantId}, ${body.username}, ${email}, ${body.name}, ${hash}, ${body.role})
      RETURNING id`;
    for (const cid of body.collectionIds) {
      await tx`INSERT INTO collection_members (tenant_id, collection_id, user_id) VALUES (${ctx.tenantId}, ${cid}, ${u!.id})`;
    }
    return u!;
  }).catch((err: { code?: string }) => {
    if (err.code === "23505") throw new HttpError(409, "Ya existe un usuario con ese nombre de usuario o email");
    if (err.code === "23503") throw badRequest("Alguna colección no existe");
    throw err;
  });

  let inviteUrl: string | null = null;
  let emailSent = false;
  if (invite && email) {
    inviteUrl = await createUserLink({ tenantId: ctx.tenantId, userId: user.id, kind: "invite", createdBy: ctx.userId });
    emailSent = await emailLink("invite", { email, name: body.name }, inviteUrl, await tenantName(ctx.tenantId));
  }
  await audit(c, invite ? "user.invited" : "user.created", {
    targetType: "user",
    targetId: user.id,
    details: { username: body.username, ...(email && { email }), role: body.role, emailSent },
  });
  return c.json({ id: user.id, inviteUrl, emailSent }, 201);
});

/**
 * Genera un enlace para el usuario: invitación (si aún no tiene contraseña) o
 * restablecimiento de contraseña. Lo envía por correo si está configurado y
 * siempre lo devuelve al administrador para que pueda compartirlo.
 */
userRoutes.post("/:id/link", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const ctx = tenantCtx(c);
  const [u] = await withTenant(ctx, (tx) => tx<{ id: string; email: string | null; name: string; pending: boolean; is_active: boolean }[]>`
    SELECT id, email, name, (password_hash IS NULL) AS pending, is_active FROM users WHERE id = ${id} AND is_superadmin = false AND support_for IS NULL`);
  if (!u) throw notFound("Usuario no encontrado");
  if (!u.is_active) throw badRequest("El usuario está desactivado");
  const kind = u.pending ? "invite" : "reset";
  const url = await createUserLink({ tenantId: ctx.tenantId, userId: u.id, kind, createdBy: ctx.userId });
  const emailSent = u.email ? await emailLink(kind, { email: u.email, name: u.name }, url, await tenantName(ctx.tenantId)) : false;
  await audit(c, "user.link_created", { targetType: "user", targetId: u.id, details: { kind, emailSent } });
  return c.json({ kind, url, emailSent });
});

/** Quita la verificación en dos pasos de un usuario (p. ej. perdió el teléfono). No aplica a superadministradores. */
userRoutes.post("/:id/totp/reset", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const ctx = tenantCtx(c);
  const [u] = await sqlOwner`
    UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery_hashes = '{}'
     WHERE id = ${id} AND tenant_id = ${ctx.tenantId} AND is_superadmin = false AND support_for IS NULL
    RETURNING id`;
  if (!u) throw notFound("Usuario no encontrado");
  await revokeSessions(id);
  await audit(c, "auth.totp_reset", { targetType: "user", targetId: id });
  return c.json({ ok: true });
});

const UpdateUser = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  username: UsernameSchema.optional(),
  // null o vacío = quitar el email (solo si el usuario ya tiene contraseña).
  email: OptionalEmailSchema,
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
  password: z.string().optional(),
});

userRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw notFound();
  const body = parse(UpdateUser, await c.req.json().catch(() => ({})));
  const me = c.get("user");
  if (id === me.id && body.role !== undefined && body.role !== "admin") {
    throw badRequest("No puedes quitarte tu propio rol de administrador");
  }
  if (id === me.id && body.isActive === false) throw badRequest("No puedes desactivar tu propia cuenta");
  if (body.isActive === true) await assertUserSlot(me.tenantId);
  if (body.password !== undefined) {
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest(problem);
  }
  const hash = body.password !== undefined ? await hashPassword(body.password) : null;
  const email = body.email === undefined ? undefined : (body.email?.toLowerCase() ?? null);

  const updated = await withTenant(tenantCtx(c), async (tx) => {
    const [u] = await tx`
      UPDATE users SET
        name = coalesce(${body.name ?? null}, name),
        username = coalesce(${body.username ?? null}, username),
        email = CASE WHEN ${email !== undefined} THEN ${email ?? null} ELSE email END,
        role = coalesce(${body.role ?? null}::user_role, role),
        is_active = coalesce(${body.isActive ?? null}::boolean, is_active),
        password_hash = coalesce(${hash}, password_hash)
      WHERE id = ${id} AND is_superadmin = false AND support_for IS NULL
      RETURNING id`;
    return u;
  }).catch((err: { code?: string }) => {
    if (err.code === "23505") throw new HttpError(409, "Ya existe un usuario con ese nombre de usuario o email");
    if (err.code === "23514") throw badRequest("Un usuario invitado sin contraseña necesita email");
    throw err;
  });
  if (!updated) throw notFound("Usuario no encontrado");
  if (body.password !== undefined) await revokeSessions(id);
  await audit(c, "user.updated", {
    targetType: "user",
    targetId: id,
    details: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.username !== undefined && { username: body.username }),
      ...(email !== undefined && { email }),
      ...(body.role !== undefined && { role: body.role }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.password !== undefined && { passwordReset: true }),
    },
  });
  return c.json({ ok: true });
});
