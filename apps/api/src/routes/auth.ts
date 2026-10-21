import { Hono, type Context } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { sqlOwner, type Role } from "../db/client.js";
import { issueSession } from "../auth/session.js";
import { requireAuth, SESSION_COOKIE, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password.js";
import { audit, auditLog } from "../lib/audit.js";
import { badRequest, HttpError, notFound, unauthorized } from "../lib/errors.js";
import { emailEnabled } from "../lib/mailer.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { clientIp } from "../lib/request.js";
import { createUserLink, emailLink, findValidToken } from "../lib/tokens.js";
import { parse } from "../lib/validate.js";

export const authRoutes = new Hono<AppEnv>();

// Frenos contra fuerza bruta: por IP+email y, además, por email (por si la IP se falsea).
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
const loginEmailLimiter = new RateLimiter(30, 15 * 60 * 1000);
const forgotLimiter = new RateLimiter(5, 60 * 60 * 1000);
const tokenLimiter = new RateLimiter(30, 15 * 60 * 1000);

// Hash de relleno para que el tiempo de respuesta no revele si el email existe.
const dummyHash = hashPassword("contraseña-de-relleno");

interface SessionUser {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: Role;
  is_superadmin: boolean;
}

/** Firma la sesión, pone la cookie y devuelve el cuerpo de respuesta del login. */
async function startSession(c: Context<AppEnv>, user: SessionUser) {
  const token = await issueSession(c, { userId: user.id, tenantId: user.tenant_id, role: user.role });
  return {
    token, // para clientes que no usan cookies (scripts, integraciones)
    user: { id: user.id, email: user.email, name: user.name, role: user.role, isSuperadmin: user.is_superadmin },
  };
}

/** Configuración pública que necesita la pantalla de login. */
authRoutes.get("/config", (c) => c.json({ emailEnabled: emailEnabled() }));

const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

authRoutes.post("/login", async (c) => {
  const body = parse(LoginBody, await c.req.json().catch(() => ({})));
  const email = body.email.toLowerCase();
  const ip = clientIp(c);
  if (!loginLimiter.hit(`${ip}|${email}`) || !loginEmailLimiter.hit(email)) {
    throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  }

  const [user] = await sqlOwner<(SessionUser & { password_hash: string | null })[]>`
    SELECT u.id, u.tenant_id, u.name, u.email, u.role, u.password_hash, u.is_superadmin
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE lower(u.email) = ${email} AND u.is_active AND t.is_active`;

  // Los usuarios invitados que aún no aceptaron no tienen contraseña.
  const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash));
  if (!user || !user.password_hash || !ok) {
    if (user) {
      await auditLog({ tenantId: user.tenant_id, userId: user.id, email: user.email, ip }, "auth.login_failed");
    }
    throw unauthorized("Email o contraseña incorrectos");
  }

  loginLimiter.reset(`${ip}|${email}`);
  const session = await startSession(c, user);
  await auditLog({ tenantId: user.tenant_id, userId: user.id, email: user.email, ip }, "auth.login");
  return c.json(session);
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const u = c.get("user");
  const [tenant] = await sqlOwner<{ name: string; slug: string }[]>`SELECT name, slug FROM tenants WHERE id = ${u.tenantId}`;
  return c.json({
    user: { id: u.id, email: u.email, name: u.name, role: u.role, isSuperadmin: u.isSuperadmin },
    tenant,
    support: u.support ? { name: u.support.name, email: u.support.email } : null,
  });
});

/** Sale del modo soporte y vuelve a la sesión normal del superadministrador. */
authRoutes.post("/exit-support", requireAuth, async (c) => {
  const u = c.get("user");
  if (!u.support) throw badRequest("No estás en modo soporte");
  const [actor] = await sqlOwner<SessionUser[]>`
    SELECT id, tenant_id, name, email, role, is_superadmin FROM users WHERE id = ${u.support.id}`;
  if (!actor) throw unauthorized();
  await audit(c, "support.exited");
  return c.json(await startSession(c, actor));
});

const ChangePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string() });

authRoutes.post("/change-password", requireAuth, async (c) => {
  const body = parse(ChangePasswordBody, await c.req.json().catch(() => ({})));
  const problem = passwordProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const u = c.get("user");
  if (u.support) throw badRequest("En modo soporte no se puede cambiar la contraseña");
  const [row] = await sqlOwner<{ password_hash: string | null }[]>`SELECT password_hash FROM users WHERE id = ${u.id}`;
  if (!row?.password_hash || !(await verifyPassword(body.currentPassword, row.password_hash))) {
    throw badRequest("La contraseña actual no es correcta");
  }
  await sqlOwner`UPDATE users SET password_hash = ${await hashPassword(body.newPassword)} WHERE id = ${u.id}`;
  await audit(c, "auth.password_changed", { targetType: "user", targetId: u.id });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Recuperación de contraseña e invitaciones (enlaces de un solo uso)
// ---------------------------------------------------------------------------

const ForgotBody = z.object({ email: z.string().email().max(254) });

/**
 * Pide un enlace para restablecer la contraseña. Responde siempre lo mismo,
 * exista o no el email, para no revelar quién tiene cuenta.
 */
authRoutes.post("/forgot", async (c) => {
  const { email } = parse(ForgotBody, await c.req.json().catch(() => ({})));
  const ip = clientIp(c);
  const generic = {
    ok: true,
    emailEnabled: emailEnabled(),
    message: emailEnabled()
      ? "Si el email corresponde a una cuenta activa, recibirás un enlace para elegir una nueva contraseña."
      : "El envío de correos no está configurado. Pide a un administrador que restablezca tu contraseña.",
  };
  if (!emailEnabled() || !forgotLimiter.hit(`${ip}|${email.toLowerCase()}`)) return c.json(generic);

  const [user] = await sqlOwner<{ id: string; tenant_id: string; name: string; email: string; tenant_name: string }[]>`
    SELECT u.id, u.tenant_id, u.name, u.email, t.name AS tenant_name
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE lower(u.email) = ${email.toLowerCase()} AND u.is_active AND t.is_active AND u.password_hash IS NOT NULL`;
  if (user) {
    const url = await createUserLink({ tenantId: user.tenant_id, userId: user.id, kind: "reset", createdBy: null });
    await emailLink("reset", user, url, user.tenant_name);
    await auditLog({ tenantId: user.tenant_id, userId: user.id, email: user.email, ip }, "auth.reset_requested");
  }
  return c.json(generic);
});

/** Comprueba un enlace antes de mostrar el formulario. */
authRoutes.get("/link", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!tokenLimiter.hit(clientIp(c))) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  const valid = await findValidToken(token);
  if (!valid) throw notFound("El enlace no es válido o ha caducado. Pide uno nuevo.");
  return c.json({ kind: valid.kind, email: valid.email, name: valid.name });
});

const AcceptBody = z.object({
  token: z.string().min(10).max(200),
  password: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
});

/** Usa el enlace: fija la contraseña (y el nombre, si es una invitación) e inicia sesión. */
authRoutes.post("/link", async (c) => {
  const body = parse(AcceptBody, await c.req.json().catch(() => ({})));
  if (!tokenLimiter.hit(clientIp(c))) throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  const problem = passwordProblem(body.password);
  if (problem) throw badRequest(problem);
  const valid = await findValidToken(body.token);
  if (!valid) throw notFound("El enlace no es válido o ha caducado. Pide uno nuevo.");

  const hash = await hashPassword(body.password);
  const user = await sqlOwner.begin(async (tx) => {
    // Marcar como usado de forma atómica: si dos peticiones llegan a la vez, solo una gana.
    const [used] = await tx`UPDATE user_tokens SET used_at = now() WHERE id = ${valid.id} AND used_at IS NULL RETURNING id`;
    if (!used) throw notFound("El enlace ya se ha utilizado.");
    const [u] = await tx<SessionUser[]>`
      UPDATE users SET password_hash = ${hash},
             name = CASE WHEN ${valid.kind} = 'invite' THEN coalesce(${body.name ?? null}, name) ELSE name END
       WHERE id = ${valid.userId}
      RETURNING id, tenant_id, name, email, role, is_superadmin`;
    // Anular cualquier otro enlace pendiente de este usuario.
    await tx`UPDATE user_tokens SET used_at = now() WHERE user_id = ${valid.userId} AND used_at IS NULL`;
    return u!;
  });

  const session = await startSession(c, user);
  await auditLog(
    { tenantId: user.tenant_id, userId: user.id, email: user.email, ip: clientIp(c) },
    "auth.link_used",
    { details: { kind: valid.kind } },
  );
  return c.json(session);
});
