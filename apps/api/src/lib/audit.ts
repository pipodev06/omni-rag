import type { Context } from "hono";
import { sqlOwner } from "../db/client.js";
import type { AppEnv } from "../auth/middleware.js";
import { clientIp } from "./request.js";

/**
 * Registro de auditoría. Se escribe con la conexión propietaria y nunca hace
 * fallar la petición: si no se puede guardar, solo se avisa en el registro.
 *
 * Acciones (`categoría.verbo`): auth.login, auth.login_failed, auth.password_changed,
 * auth.reset_requested, auth.link_used, auth.login_mfa_failed, auth.totp_enabled, auth.totp_disabled,
 * auth.totp_reset, auth.sessions_revoked, user.created, user.invited, user.updated,
 * user.link_created, collection.created, collection.updated, collection.deleted,
 * collection.members_updated, document.uploaded, document.deleted, document.bulk_deleted, document.infected, document.renamed, document.moved, document.reprocessed,
 * document.summary, quality.cache_cleared, quality.feedback_resolved,
 * tenant.created, tenant.updated, tenant.deleted, tenant.plan_changed, tenant.limit_changed, plan.edited, plan.created, plan.updated, plan.deleted, support.entered, support.exited.
 */
export interface AuditActor {
  tenantId: string | null;
  userId: string | null;
  /** Quién actúa, tal como se mostrará en la auditoría (se guarda en `user_email`). */
  username: string | null;
  ip?: string;
}

export interface AuditEntry {
  targetType?: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export async function auditLog(actor: AuditActor, action: string, entry: AuditEntry = {}): Promise<void> {
  try {
    await sqlOwner`
      INSERT INTO audit_log (tenant_id, user_id, user_email, action, target_type, target_id, details, ip)
      VALUES (${actor.tenantId}, ${actor.userId}, ${actor.username}, ${action}, ${entry.targetType ?? null},
              ${entry.targetId ?? null}, ${sqlOwner.json((entry.details ?? {}) as never)}, ${actor.ip ?? null})`;
  } catch (err) {
    console.error(`[auditoría] no se pudo registrar ${action}:`, err);
  }
}

/** Atajo para rutas autenticadas: el actor es el usuario de la sesión. */
export function audit(c: Context<AppEnv>, action: string, entry: AuditEntry = {}): Promise<void> {
  const u = c.get("user");
  // En modo soporte se registra el usuario real del superadministrador.
  const username = u.support ? `${u.support.username} (soporte)` : u.username;
  return auditLog({ tenantId: u.tenantId, userId: u.id, username, ip: clientIp(c) }, action, entry);
}
