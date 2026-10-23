import { config } from "./config.js";
import { sqlOwner } from "./db/client.js";
import { removeStored } from "./storage/local.js";

export const MAINTENANCE_QUEUE = "mantenimiento";

/**
 * Limpieza periódica (la programa el worker una vez al día):
 *  - auditoría más antigua que AUDIT_RETENTION_DAYS;
 *  - enlaces de invitación/restablecimiento usados o caducados hace más de 7 días;
 *  - respuestas en caché más antiguas que CACHE_TTL_HOURS (ya no se usarían);
 *  - documentos en la papelera desde hace más de TRASH_RETENTION_DAYS días (se eliminan con su archivo).
 */
export async function runMaintenance() {
  const audit = await sqlOwner`
    DELETE FROM audit_log WHERE created_at < now() - ${`${config.AUDIT_RETENTION_DAYS} days`}::interval RETURNING id`;
  const tokens = await sqlOwner`
    DELETE FROM user_tokens
     WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '7 days' RETURNING id`;
  const cache = await sqlOwner`
    DELETE FROM answer_cache WHERE created_at < now() - ${`${config.CACHE_TTL_HOURS} hours`}::interval RETURNING id`;
  const trash = await sqlOwner<{ id: string; tenant_id: string }[]>`
    DELETE FROM documents
     WHERE deleted_at IS NOT NULL AND deleted_at < now() - ${`${config.TRASH_RETENTION_DAYS} days`}::interval
    RETURNING id, tenant_id`;
  await Promise.all(trash.map((d) => removeStored(`${d.tenant_id}/${d.id}`).catch(() => {})));
  return { auditDeleted: audit.length, tokensDeleted: tokens.length, cacheDeleted: cache.length, trashPurged: trash.length };
}
