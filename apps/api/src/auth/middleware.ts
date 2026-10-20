import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sqlOwner, type Role, type TenantContext } from "../db/client.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { verifySession } from "./jwt.js";

export const SESSION_COOKIE = "rag_session";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  isSuperadmin: boolean;
}

export type AppEnv = { Variables: { user: AuthUser } };

/**
 * Exige sesión válida. Acepta la cookie httpOnly (navegador) o
 * `Authorization: Bearer <token>` (scripts / integraciones).
 *
 * Además del JWT, consulta la base de datos en cada petición: así, desactivar
 * un usuario o cambiar su rol tiene efecto inmediato.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
  if (!token) throw unauthorized();

  const claims = await verifySession(token);
  if (!claims) throw unauthorized("Sesión inválida o expirada");

  const [row] = await sqlOwner<
    { id: string; tenant_id: string; email: string; name: string; role: Role; is_superadmin: boolean }[]
  >`
    SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.is_superadmin
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = ${claims.userId} AND u.is_active AND t.is_active
  `;
  if (!row || row.tenant_id !== claims.tenantId) throw unauthorized("Usuario inactivo o inexistente");

  c.set("user", {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    isSuperadmin: row.is_superadmin,
  });
  await next();
};

/** Restringe una ruta a ciertos roles (se usa después de requireAuth). */
export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!roles.includes(c.get("user").role)) throw forbidden();
    await next();
  };

export const requireSuperadmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user").isSuperadmin) throw forbidden("Solo el administrador de la plataforma");
  await next();
};

/** Contexto para withTenant() a partir del usuario autenticado. */
export const tenantCtx = (c: Context<AppEnv>): TenantContext => {
  const u = c.get("user");
  return { tenantId: u.tenantId, userId: u.id, role: u.role };
};
