import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config } from "../config.js";
import { sqlOwner, type Role } from "../db/client.js";
import { signSession } from "../auth/jwt.js";
import { requireAuth, SESSION_COOKIE, type AppEnv } from "../auth/middleware.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password.js";
import { badRequest, HttpError, unauthorized } from "../lib/errors.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";

export const authRoutes = new Hono<AppEnv>();

const loginLimiter = new RateLimiter(10, 15 * 60 * 1000); // 10 intentos cada 15 min

const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

// Hash de relleno para que el tiempo de respuesta no revele si el email existe.
const dummyHash = hashPassword("contraseña-de-relleno");

authRoutes.post("/login", async (c) => {
  const body = parse(LoginBody, await c.req.json().catch(() => ({})));
  const email = body.email.toLowerCase();
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!loginLimiter.hit(`${ip}|${email}`)) {
    throw new HttpError(429, "Demasiados intentos. Espera unos minutos.");
  }

  const [user] = await sqlOwner<
    { id: string; tenant_id: string; name: string; email: string; role: Role; password_hash: string; is_superadmin: boolean }[]
  >`
    SELECT u.id, u.tenant_id, u.name, u.email, u.role, u.password_hash, u.is_superadmin
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE lower(u.email) = ${email} AND u.is_active AND t.is_active`;

  const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash));
  if (!user || !ok) throw unauthorized("Email o contraseña incorrectos");

  loginLimiter.reset(`${ip}|${email}`);
  await sqlOwner`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;

  const token = await signSession({ userId: user.id, tenantId: user.tenant_id, role: user.role });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return c.json({
    token, // para clientes que no usan cookies (scripts, integraciones)
    user: { id: user.id, email: user.email, name: user.name, role: user.role, isSuperadmin: user.is_superadmin },
  });
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const u = c.get("user");
  const [tenant] = await sqlOwner<{ name: string; slug: string }[]>`SELECT name, slug FROM tenants WHERE id = ${u.tenantId}`;
  return c.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role, isSuperadmin: u.isSuperadmin }, tenant });
});

const ChangePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string() });

authRoutes.post("/change-password", requireAuth, async (c) => {
  const body = parse(ChangePasswordBody, await c.req.json().catch(() => ({})));
  const problem = passwordProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const u = c.get("user");
  const [row] = await sqlOwner<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${u.id}`;
  if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
    throw badRequest("La contraseña actual no es correcta");
  }
  await sqlOwner`UPDATE users SET password_hash = ${await hashPassword(body.newPassword)} WHERE id = ${u.id}`;
  return c.json({ ok: true });
});
