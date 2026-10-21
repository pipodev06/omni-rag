import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sqlOwner, type Role, type TenantContext } from "../db/client.js";
import { HttpError, forbidden, unauthorized } from "../lib/errors.js";
import { superadmin2faRequired } from "../lib/limits.js";
import { verifySession } from "./jwt.js";

export const SESSION_COOKIE = "rag_session";

export interface AuthUser {
  id: string;
  tenantId: string;
  username: string;
  email: string | null;
  name: string;
  role: Role;
  isSuperadmin: boolean;
  /** Superadministrador que está dentro de esta organización como soporte. */
  support: { id: string; username: string; name: string } | null;
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
    { id: string; tenant_id: string; username: string; email: string | null; name: string; role: Role; is_superadmin: boolean; support_for: string | null; valid_after: string; totp: boolean }[]
  >`
    SELECT u.id, u.tenant_id, u.username, u.email, u.name, u.role, u.is_superadmin, u.support_for,
           extract(epoch FROM u.sessions_valid_after)::bigint AS valid_after, (u.totp_enabled_at IS NOT NULL) AS totp
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = ${claims.userId} AND u.is_active AND t.is_active
  `;
  if (!row || row.tenant_id !== claims.tenantId) throw unauthorized("Usuario inactivo o inexistente");
  // Sesión anterior a un cambio de contraseña, un restablecimiento o «cerrar todas las sesiones».
  if (claims.iat !== undefined && claims.iat < Number(row.valid_after)) throw unauthorized("La sesión se cerró. Inicia sesión de nuevo.");

  // Cuenta de soporte: solo vale dentro de la sesión del superadministrador al
  // que pertenece, y solo mientras siga activo y siendo superadministrador.
  let support: AuthUser["support"] = null;
  if (row.support_for || claims.actorId) {
    if (row.support_for !== claims.actorId) throw unauthorized("Sesión de soporte no válida");
    const [actor] = await sqlOwner<{ id: string; username: string; name: string; valid_after: string }[]>`
      SELECT u.id, u.username, u.name, extract(epoch FROM u.sessions_valid_after)::bigint AS valid_after
        FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = ${claims.actorId} AND u.is_superadmin AND u.is_active AND t.is_active`;
    if (!actor || (claims.iat !== undefined && claims.iat < Number(actor.valid_after))) throw unauthorized("Sesión de soporte no válida");
    support = { id: actor.id, username: actor.username, name: actor.name };
  }

  // El superadministrador sin verificación en dos pasos solo puede configurarla (rutas /api/auth).
  if (row.is_superadmin && !row.totp && !support && superadmin2faRequired() && !c.req.path.startsWith("/api/auth/")) {
    throw new HttpError(403, "Activa la verificación en dos pasos en Mi cuenta para continuar.", "mfa_setup_required");
  }

  c.set("user", {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    email: row.email,
    name: row.name,
    role: row.role,
    isSuperadmin: row.is_superadmin,
    support,
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
